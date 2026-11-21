/**
 * Dialer engine: keeps every logged-in agent's state in memory, hands out
 * leads, enforces the compliance gate before each dial and records calls.
 * It knows nothing about sockets – a Transport is injected by the realtime layer.
 */
import {
  normalizePhone,
  type AgentSnapshot,
  type AgentState,
  type AgentStatePayload,
  type CallUpdatePayload,
  type Campaign,
  type DisposePayload,
  type Lead,
  type LeadAssignedPayload,
  type Role,
  type ServerToClientEvents,
  type WallboardSnapshot,
} from '@opendialer/shared';
import type { Ctx } from './context.js';
import { HttpError, badRequest, conflict, forbidden, notFound } from './errors.js';
import { audit } from './services/audit.js';
import { campaignStats, findCampaign, isAgentOnCampaign, listCampaigns } from './services/campaigns.js';
import { createCallback, dueCallbacksFor, upcomingPersonalCallbacks } from './services/callbacks.js';
import { assignCallToAgent, disposeCall, endCall, findCall, markAnswered, markAnsweredWaiting, markCallAbandoned, setCallChannel, startCall } from './services/calls.js';
import { getDisposition, listDispositions } from './services/dispositions.js';
import { addDnc } from './services/dnc.js';
import { applyDispositionToLead, checkDialable, claimNextLead, claimNextLeadForDialer, findLead, getLead, leadName, PREDICTIVE_LOCK, releaseLead, releaseLeadsOf } from './services/leads.js';
import { todaySummary } from './services/reports.js';
import { findScript } from './services/scripts.js';
import { getSettings } from './services/settings.js';
import { getUserRow } from './services/users.js';
import { OriginateError, type TelephonyAdapter } from './telephony/types.js';

export interface Transport {
  toUser<K extends keyof ServerToClientEvents>(userId: number, event: K, ...args: Parameters<ServerToClientEvents[K]>): void;
  toSupervisors<K extends keyof ServerToClientEvents>(event: K, ...args: Parameters<ServerToClientEvents[K]>): void;
  /** number of clients subscribed to the wallboard (snapshot is skipped when 0) */
  supervisorCount?: () => number;
}

export interface AgentSession {
  userId: number;
  username: string;
  displayName: string;
  role: Role;
  state: AgentState;
  pauseCode: string | null;
  campaignId: number | null;
  leadId: number | null;
  callId: number | null;
  callbackId: number | null;
  stateSince: string;
  /** pause requested while busy – applied after wrap-up */
  pendingPause: string | null;
  /** disposition already chosen while the call was still up */
  disposedDuringCall: boolean;
  /** set when the socket dropped; the session survives a short grace period */
  disconnectedAt: number | null;
  noLeadsNotified: boolean;
  wrapupStartedAt: number | null;
}

const BUSY: AgentState[] = ['assigned', 'dialing', 'talking', 'wrapup'];
const IN_CALL: AgentState[] = ['dialing', 'talking'];
export const DISCONNECT_GRACE_MS = 60_000;
/** How long predictive dialing pauses (progressive fallback) after the abandon cap is breached. */
export const PREDICTIVE_SUSPEND_MS = 5 * 60_000;

interface PredictiveCall {
  callId: number;
  campaignId: number;
  leadId: number;
  channelId: string | null;
  state: 'dialing' | 'waiting' | 'bridged';
  originatedAt: number;
  answeredAt: number | null;
  agentUserId: number | null;
  bridgeInFlight: boolean;
  lastBridgeAttemptAt: number;
}

export class Engine {
  readonly sessions = new Map<number, AgentSession>();
  private transport: Transport = { toUser: () => {}, toSupervisors: () => {} };
  private timer: NodeJS.Timeout | null = null;
  private remindedCallbacks = new Set<number>();
  private lastWallboard = 0;
  private wallboardTimer: NodeJS.Timeout | null = null;
  private unsub: (() => void)[] = [];
  /* predictive dialing state */
  private predictive = new Map<number, PredictiveCall>();
  private predictiveByChannel = new Map<string, number>();
  /** rolling answered-call outcomes per campaign (true = abandoned), last 50 */
  private predictiveOutcomes = new Map<number, boolean[]>();
  private predictiveSuspendedUntil = new Map<number, number>();
  private predictiveWarnedNoAdapter = new Set<number>();

  constructor(
    private ctx: Ctx,
    private telephony: TelephonyAdapter | null = null,
  ) {
    if (this.telephony) {
      this.telephony.onEnded((e) => this.onPredictiveChannelEnded(e.channelId, e.cause));
    }
  }

  setTransport(t: Transport) {
    this.transport = t;
  }

  start(intervalMs = this.ctx.config.engineInterval) {
    if (this.timer) return;
    if (intervalMs > 0) {
      this.timer = setInterval(() => this.tick(), intervalMs);
      this.timer.unref?.();
    }
    this.unsub.push(this.ctx.bus.onDomain('leads.available', () => this.assignAll()));
    this.unsub.push(this.ctx.bus.onDomain('campaign.status', ({ campaignId, status }) => this.onCampaignStatus(campaignId, status)));
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.wallboardTimer) clearTimeout(this.wallboardTimer);
    this.wallboardTimer = null;
    this.unsub.forEach((u) => u());
    this.unsub = [];
  }

  /* ------------------------------------------------------------------ */
  /* session lifecycle                                                   */
  /* ------------------------------------------------------------------ */

  getSession(userId: number): AgentSession | undefined {
    return this.sessions.get(userId);
  }

  private requireSession(userId: number): AgentSession {
    const s = this.sessions.get(userId);
    if (!s) throw new HttpError(409, 'Not joined – call agent:join first');
    return s;
  }

  join(user: { id: number; username: string; displayName: string; role: Role }, campaignId: number | null): AgentStatePayload {
    let campaign: Campaign | null = null;
    if (campaignId != null) {
      campaign = findCampaign(this.ctx.db, campaignId);
      if (!campaign) throw notFound('Campaign');
      if (!isAgentOnCampaign(this.ctx.db, campaignId, user.id, user.role)) throw forbidden('You are not assigned to this campaign');
      if (campaign.status === 'completed' || campaign.status === 'draft') throw conflict(`Campaign is ${campaign.status}`);
    }
    const existing = this.sessions.get(user.id);
    if (existing) {
      existing.disconnectedAt = null;
      if (existing.campaignId === campaignId) {
        // reconnect / re-join: resend the lead and call if the agent still holds one
        if (existing.leadId && existing.campaignId != null) this.resendAssignment(existing);
        return this.payload(existing);
      }
      if (BUSY.includes(existing.state)) throw conflict('Finish the current call and wrap-up before switching campaign');
      // switching campaign while idle
      this.releaseCurrentLead(existing, 'campaign switch');
      existing.campaignId = campaignId;
      this.setState(existing, 'paused', null);
      return this.payload(existing);
    }
    const s: AgentSession = {
      userId: user.id,
      username: user.username,
      displayName: user.displayName,
      role: user.role,
      state: 'paused',
      pauseCode: null,
      campaignId,
      leadId: null,
      callId: null,
      callbackId: null,
      stateSince: new Date().toISOString(),
      pendingPause: null,
      disposedDuringCall: false,
      disconnectedAt: null,
      noLeadsNotified: false,
      wrapupStartedAt: null,
    };
    this.sessions.set(user.id, s);
    releaseLeadsOf(this.ctx.db, user.id);
    this.logState(s);
    this.ctx.bus.emitDomain('agent.state', { userId: s.userId, state: s.state, campaignId: s.campaignId });
    this.scheduleWallboard();
    return this.payload(s);
  }

  leave(userId: number) {
    const s = this.sessions.get(userId);
    if (!s) return;
    this.abortCall(s, 'agent left');
    this.releaseCurrentLead(s, 'agent left');
    this.setState(s, 'offline', null);
    this.sessions.delete(userId);
    this.scheduleWallboard();
  }

  /**
   * Socket dropped. The session (state, lead, call) survives for DISCONNECT_GRACE_MS so a
   * flaky network does not lose a call or force the agent to re-join; no new leads are
   * handed out until the client is back. tick() expires it afterwards.
   */
  disconnected(userId: number) {
    const s = this.sessions.get(userId);
    if (!s) return;
    s.disconnectedAt = Date.now();
    this.scheduleWallboard();
  }

  /** Socket is back. The client re-sends agent:join, which resends the lead/call – only the state goes out here. */
  reconnected(userId: number) {
    const s = this.sessions.get(userId);
    if (!s) return;
    s.disconnectedAt = null;
    this.transport.toUser(userId, 'agent:state', this.payload(s));
  }

  /* ------------------------------------------------------------------ */
  /* agent commands                                                      */
  /* ------------------------------------------------------------------ */

  ready(userId: number): AgentStatePayload {
    const s = this.requireSession(userId);
    if (BUSY.includes(s.state)) throw conflict(`Cannot go ready while ${s.state}`);
    s.pendingPause = null;
    s.noLeadsNotified = false;
    this.setState(s, 'ready', null);
    this.tryAssign(s);
    return this.payload(s);
  }

  pause(userId: number, code: string): AgentStatePayload {
    const s = this.requireSession(userId);
    if (s.state === 'assigned') {
      // preview lead not yet dialed: hand it back
      this.releaseCurrentLead(s, 'agent paused', true);
      this.setState(s, 'paused', code);
    } else if (BUSY.includes(s.state)) {
      s.pendingPause = code;
    } else {
      this.setState(s, 'paused', code);
    }
    return this.payload(s);
  }

  skip(userId: number, leadId: number, requeue: boolean): AgentStatePayload {
    const s = this.requireSession(userId);
    if (s.state !== 'assigned' || s.leadId !== leadId) throw conflict('No such lead assigned');
    const campaign = s.campaignId ? findCampaign(this.ctx.db, s.campaignId) : null;
    const delay = campaign?.retryMinutes ?? 240;
    if (s.callbackId) {
      // lead came from a scheduled callback: push the callback out (or drop it) so it is not re-offered at once
      if (requeue) {
        this.ctx.db
          .prepare(`UPDATE callbacks SET scheduled_at = ? WHERE id = ? AND status = 'pending'`)
          .run(new Date(Date.now() + delay * 60 * 1000).toISOString(), s.callbackId);
        releaseLead(this.ctx.db, leadId);
      } else {
        this.ctx.db.prepare(`UPDATE callbacks SET status = 'cancelled' WHERE id = ?`).run(s.callbackId);
        this.ctx.db.prepare(`UPDATE leads SET status = 'done', locked_by = NULL, locked_at = NULL WHERE id = ?`).run(leadId);
      }
    } else if (requeue) {
      releaseLead(this.ctx.db, leadId, { delayMinutes: delay });
    } else {
      // "skip for good": mark done without a call
      this.ctx.db.prepare(`UPDATE leads SET status = 'done', locked_by = NULL, locked_at = NULL WHERE id = ?`).run(leadId);
    }
    audit(this.ctx.db, userId, 'lead.skip', 'lead', leadId, { requeue });
    s.leadId = null;
    s.callbackId = null;
    this.setState(s, 'ready', null);
    this.tryAssign(s);
    return this.payload(s);
  }

  dial(userId: number, leadId: number): { callId: number } {
    const s = this.requireSession(userId);
    if (s.state !== 'assigned' || s.leadId !== leadId) throw conflict('Lead is not assigned to you');
    const lead = getLead(this.ctx.db, leadId);
    const campaign = s.campaignId ? findCampaign(this.ctx.db, s.campaignId) : null;
    const settings = getSettings(this.ctx.db);
    const check = checkDialable(this.ctx.db, lead, lead.phone, campaign, settings, new Date(), { ignoreHours: Boolean(s.callbackId), ignoreAttempts: Boolean(s.callbackId) });
    if (!check.ok) {
      this.releaseCurrentLead(s, check.reason ?? 'not dialable', true);
      this.setState(s, 'ready', null);
      this.transport.toUser(userId, 'notice', { level: 'warning', message: `Lead skipped: ${check.reason}` });
      this.tryAssign(s);
      throw conflict(check.reason ?? 'Lead is not dialable');
    }
    const call = startCall(this.ctx.db, { leadId, campaignId: s.campaignId, userId, phone: lead.phone });
    s.callId = call.id;
    s.disposedDuringCall = false;
    this.setState(s, 'dialing', null);
    this.transport.toUser(userId, 'call:started', { call });
    this.ctx.bus.emitDomain('call.started', { callId: call.id });
    return { callId: call.id };
  }

  manualDial(userId: number, rawPhone: string, campaignId: number | null, leadId: number | null) {
    const s = this.requireSession(userId);
    if (BUSY.includes(s.state)) throw conflict(`Cannot dial while ${s.state}`);
    const settings = getSettings(this.ctx.db);
    const n = normalizePhone(rawPhone, settings.defaultCountry);
    if (!n.e164) throw badRequest('Invalid phone number');
    let lead: Lead | null = leadId ? findLead(this.ctx.db, leadId) : null;
    const cid = campaignId ?? lead?.campaignId ?? s.campaignId;
    const campaign = cid ? findCampaign(this.ctx.db, cid) : null;
    const check = checkDialable(this.ctx.db, lead, n.e164, campaign, settings, new Date(), { ignoreAttempts: true });
    if (!check.ok) throw conflict(check.reason ?? 'Not dialable');
    if (lead) {
      if (lead.lockedBy && lead.lockedBy !== userId && this.sessions.has(lead.lockedBy)) throw conflict('Lead is being worked by another agent');
      this.ctx.db
        .prepare(`UPDATE leads SET locked_by = ?, locked_at = ?, status = CASE WHEN status IN ('new','done') THEN 'in_progress' ELSE status END WHERE id = ?`)
        .run(userId, new Date().toISOString(), lead.id);
      lead = getLead(this.ctx.db, lead.id);
      s.leadId = lead.id;
    } else {
      s.leadId = null;
    }
    s.callbackId = null;
    // a paused agent stays paused after a manual call instead of dropping into auto-dialing
    if (s.state === 'paused') s.pendingPause = s.pauseCode ?? 'Pause';
    const call = startCall(this.ctx.db, { leadId: lead?.id ?? null, campaignId: campaign?.id ?? null, userId, phone: n.e164 });
    s.callId = call.id;
    s.disposedDuringCall = false;
    this.setState(s, 'dialing', null);
    this.transport.toUser(userId, 'call:started', { call });
    this.ctx.bus.emitDomain('call.started', { callId: call.id });
    audit(this.ctx.db, userId, 'call.manual', 'call', call.id, { phone: n.e164 });
    return { callId: call.id, dialString: (campaign?.dialPrefix ?? '') + n.e164, lead };
  }

  callUpdate(userId: number, p: CallUpdatePayload): AgentStatePayload {
    const s = this.requireSession(userId);
    if (s.callId !== p.callId) throw conflict('Unknown call');
    if (p.state === 'ringing') {
      if (s.state !== 'dialing') throw conflict(`Unexpected ringing in state ${s.state}`);
      return this.payload(s);
    }
    if (p.state === 'answered') {
      if (s.state !== 'dialing' && s.state !== 'talking') throw conflict(`Unexpected answer in state ${s.state}`);
      markAnswered(this.ctx.db, p.callId, p.providerCallId);
      this.setState(s, 'talking', null);
      return this.payload(s);
    }
    // ended
    if (s.state === 'wrapup') return this.payload(s); // duplicate hangup report – idempotent
    if (!IN_CALL.includes(s.state)) throw conflict(`Unexpected hangup in state ${s.state}`);
    // A bridged predictive call ends here too: make sure the PBX leg is dropped.
    this.teardownPredictive(p.callId, true);
    const call = endCall(this.ctx.db, p.callId, p.cause, p.providerCallId);
    this.transport.toUser(userId, 'call:ended', { call });
    this.ctx.bus.emitDomain('call.ended', { callId: call.id });
    if (call.result === 'no_answer' || call.result === 'failed') {
      s.wrapupStartedAt = Date.now();
      this.setState(s, 'wrapup', null);
      this.autoDispose(s, call.result === 'failed' ? 'call failed' : 'no answer');
    } else if (s.disposedDuringCall) {
      this.finishWrapup(s);
    } else {
      s.wrapupStartedAt = Date.now();
      this.setState(s, 'wrapup', null);
    }
    return this.payload(s);
  }

  dispose(userId: number, p: DisposePayload): AgentStatePayload {
    const s = this.requireSession(userId);
    if (s.callId !== p.callId) throw conflict('Unknown call');
    if (!['wrapup', 'talking', 'dialing'].includes(s.state)) throw conflict(`Cannot dispose in state ${s.state}`);
    const call = findCall(this.ctx.db, p.callId);
    if (!call) throw notFound('Call');
    const disposition = getDisposition(this.ctx.db, p.dispositionId);
    const campaign = s.campaignId ? findCampaign(this.ctx.db, s.campaignId) : call.campaignId ? findCampaign(this.ctx.db, call.campaignId) : null;
    const tx = this.ctx.db.transaction(() => {
      disposeCall(this.ctx.db, p.callId, disposition.id, p.notes ?? '');
      let callbackId: number | null = null;
      if (call.leadId) {
        const lead = findLead(this.ctx.db, call.leadId);
        if (lead) {
          if (p.callback) {
            const cb = createCallback(this.ctx.db, {
              leadId: lead.id,
              campaignId: lead.campaignId,
              userId: p.callback.personal ? userId : null,
              scheduledAt: p.callback.scheduledAt,
              note: p.callback.note ?? '',
              createdBy: userId,
            });
            callbackId = cb.id;
          }
          if (campaign && lead.campaignId === campaign.id) {
            applyDispositionToLead(this.ctx.db, lead.id, disposition, campaign, Boolean(p.callback));
          } else {
            // lead from another campaign (manual dial) – just unlock and record the attempt
            this.ctx.db
              .prepare(`UPDATE leads SET attempts = attempts + 1, last_attempt_at = ?, last_disposition_id = ?, locked_by = NULL, locked_at = NULL WHERE id = ?`)
              .run(new Date().toISOString(), disposition.id, lead.id);
          }
          if (p.callback) {
            // createCallback already moved the lead to 'callback'; make sure the disposition update did not undo it
            this.ctx.db.prepare(`UPDATE leads SET status = 'callback' WHERE id = ?`).run(lead.id);
          }
          if (s.callbackId) {
            this.ctx.db.prepare(`UPDATE callbacks SET status = 'done' WHERE id = ? AND status = 'pending'`).run(s.callbackId);
          }
        }
      }
      if (disposition.category === 'dnc') {
        addDnc(this.ctx.db, call.phone, `agent:${s.username}`, p.notes ?? '');
      }
      return callbackId;
    });
    const callbackId = tx();
    audit(this.ctx.db, userId, 'call.dispose', 'call', call.id, { disposition: disposition.code, leadId: call.leadId });
    this.ctx.bus.emitDomain('call.disposed', { callId: call.id, dispositionId: disposition.id });
    if (disposition.category === 'dnc') this.ctx.bus.emitDomain('lead.dnc', { leadId: call.leadId, phone: call.phone });
    if (callbackId) this.ctx.bus.emitDomain('callback.created', { callbackId });
    if (p.pauseAfter) s.pendingPause = p.pauseAfter;

    if (s.state === 'wrapup') {
      this.finishWrapup(s);
    } else {
      s.disposedDuringCall = true; // call still up – finish when it ends
    }
    return this.payload(s);
  }

  /* ------------------------------------------------------------------ */
  /* assignment                                                          */
  /* ------------------------------------------------------------------ */

  private tryAssign(s: AgentSession) {
    if (s.state !== 'ready' || s.campaignId == null || s.disconnectedAt) return;
    const campaign = findCampaign(this.ctx.db, s.campaignId);
    if (!campaign || campaign.status !== 'active' || campaign.dialMode === 'manual') return;
    // Predictive campaigns are served by the predictive loop (tickPredictive),
    // which bridges already-answered calls to ready agents. Only when the
    // abandon guard has suspended predictive dialing do agents fall back to
    // ordinary progressive assignment.
    if (campaign.dialMode === 'predictive' && !this.predictiveSuspended(campaign.id)) return;
    const settings = getSettings(this.ctx.db);

    // 1. due callbacks (personal first)
    for (const cb of dueCallbacksFor(this.ctx.db, s.userId, campaign.id)) {
      const lead = findLead(this.ctx.db, cb.lead_id);
      if (!lead || lead.status === 'dnc' || (lead.lockedBy && lead.lockedBy !== s.userId)) continue;
      const check = checkDialable(this.ctx.db, lead, lead.phone, campaign, settings, new Date(), { ignoreHours: true, ignoreAttempts: true });
      if (!check.ok) {
        this.ctx.db.prepare(`UPDATE callbacks SET status = 'cancelled' WHERE id = ?`).run(cb.id);
        continue;
      }
      this.ctx.db.prepare(`UPDATE leads SET locked_by = ?, locked_at = ? WHERE id = ?`).run(s.userId, new Date().toISOString(), lead.id);
      this.assign(s, getLead(this.ctx.db, lead.id), campaign, cb.id);
      return;
    }

    // 2. regular queue
    const lead = claimNextLead(this.ctx.db, campaign, s.userId, settings);
    if (lead) {
      this.assign(s, lead, campaign, null);
      return;
    }
    if (!s.noLeadsNotified) {
      s.noLeadsNotified = true;
      this.transport.toUser(s.userId, 'notice', { level: 'info', message: 'No leads available right now – waiting for new leads or callbacks.' });
    }
  }

  private assign(s: AgentSession, lead: Lead, campaign: Campaign, callbackId: number | null) {
    s.leadId = lead.id;
    s.callbackId = callbackId;
    s.noLeadsNotified = false;
    this.setState(s, 'assigned', null);
    this.transport.toUser(s.userId, 'lead:assigned', this.assignmentPayload(lead, campaign, callbackId));
  }

  private assignmentPayload(lead: Lead, campaign: Campaign, callbackId: number | null): LeadAssignedPayload {
    const cbRow = callbackId
      ? (this.ctx.db.prepare('SELECT * FROM callbacks WHERE id = ?').get(callbackId) as Record<string, unknown> | undefined)
      : undefined;
    return {
      lead,
      campaign,
      script: findScript(this.ctx.db, campaign.scriptId),
      autoDial: campaign.dialMode === 'progressive',
      callback: cbRow
        ? {
            id: cbRow.id as number,
            leadId: cbRow.lead_id as number,
            campaignId: cbRow.campaign_id as number,
            userId: (cbRow.user_id as number | null) ?? null,
            scheduledAt: cbRow.scheduled_at as string,
            note: cbRow.note as string,
            status: cbRow.status as 'pending',
            createdBy: cbRow.created_by as number,
            createdAt: cbRow.created_at as string,
          }
        : null,
      dialString: campaign.dialPrefix + lead.phone,
      previewTimeoutSec: campaign.previewTimeoutSec,
    };
  }

  private resendAssignment(s: AgentSession) {
    if (!s.leadId || s.campaignId == null) return;
    const lead = findLead(this.ctx.db, s.leadId);
    const campaign = findCampaign(this.ctx.db, s.campaignId);
    if (!lead || !campaign) return;
    const payload = this.assignmentPayload(lead, campaign, s.callbackId);
    // a call is already in progress – the softphone must not dial again
    if (s.callId) payload.autoDial = false;
    this.transport.toUser(s.userId, 'lead:assigned', payload);
    if (s.callId) {
      const call = findCall(this.ctx.db, s.callId);
      if (call) this.transport.toUser(s.userId, 'call:started', { call });
    }
  }

  /** Re-run assignment for every idle ready agent (new leads, campaign activated, tick). */
  assignAll() {
    for (const s of this.sessions.values()) if (s.state === 'ready') this.tryAssign(s);
  }

  /* ------------------------------------------------------------------ */
  /* predictive dialing                                                  */
  /* ------------------------------------------------------------------ */

  private predictiveSuspended(campaignId: number): boolean {
    return (this.predictiveSuspendedUntil.get(campaignId) ?? 0) > Date.now();
  }

  /** Stop tracking a predictive call; optionally hang its PBX channel up. */
  private teardownPredictive(callId: number, hangupChannel: boolean) {
    const pc = this.predictive.get(callId);
    if (!pc) return;
    this.predictive.delete(callId);
    if (pc.channelId) {
      this.predictiveByChannel.delete(pc.channelId);
      if (hangupChannel) void this.telephony?.hangup(pc.channelId).catch(() => {});
    }
  }

  private tickPredictiveAll(now: number) {
    for (const campaign of listCampaigns(this.ctx.db)) {
      if (campaign.dialMode !== 'predictive' || campaign.status !== 'active') continue;
      this.sweepPredictive(campaign, now);
      if (this.predictiveSuspended(campaign.id)) continue;
      if (!this.telephony) {
        if (!this.predictiveWarnedNoAdapter.has(campaign.id)) {
          this.predictiveWarnedNoAdapter.add(campaign.id);
          this.ctx.log.warn(
            { campaignId: campaign.id },
            'predictive campaign is active but predictive telephony is not configured (PREDICTIVE_ENABLED / AMI_USER / AMI_SECRET) – not dialing',
          );
        }
        continue;
      }
      this.tickPredictiveCampaign(campaign, now);
    }
  }

  /**
   * Anticipatory pacing: keep enough calls ringing so that an answered call is
   * ready when an agent frees up. The pipeline target is driven by the ready
   * agents plus agents expected to free within the launch-ahead window
   * (wrap-up agents, and talking agents past avgTalk - launchAhead), scaled by
   * the pacing ratio, and capped by the answered-call buffer.
   */
  private tickPredictiveCampaign(campaign: Campaign, now: number) {
    const sessions = [...this.sessions.values()].filter((s) => s.campaignId === campaign.id && !s.disconnectedAt);
    const ready = sessions.filter((s) => s.state === 'ready');
    const tracked = [...this.predictive.values()].filter((p) => p.campaignId === campaign.id);
    const ringing = tracked.filter((p) => p.state === 'dialing').length;
    const waiting = tracked.filter((p) => p.state === 'waiting').length;
    if (waiting >= ready.length + campaign.bufferCalls && ready.length === 0) return; // buffer full, nobody to serve
    const avgTalk = campaignStats(this.ctx.db, campaign.id).avgTalkSec || 37;
    const freeingSoon = sessions.filter((s) => {
      if (s.state === 'wrapup') return true;
      if (s.state === 'talking') return (now - Date.parse(s.stateSince)) / 1000 >= Math.max(0, avgTalk - campaign.launchAheadSec);
      return false;
    }).length;
    const targetRinging = Math.ceil((ready.length + freeingSoon) * campaign.pacingRatio);
    const pipelineCap = ready.length + freeingSoon + campaign.bufferCalls + targetRinging;
    let toDial = Math.min(targetRinging - ringing, pipelineCap - tracked.length);
    if (waiting >= ready.length + campaign.bufferCalls) toDial = Math.min(toDial, 0);
    if (toDial <= 0) return;
    const settings = getSettings(this.ctx.db);
    while (toDial-- > 0) {
      const lead = claimNextLeadForDialer(this.ctx.db, campaign, settings);
      if (!lead) break;
      this.startPredictiveCall(campaign, lead);
    }
  }

  private startPredictiveCall(campaign: Campaign, lead: Lead) {
    const call = startCall(this.ctx.db, { leadId: lead.id, campaignId: campaign.id, userId: null, phone: lead.phone });
    const pc: PredictiveCall = {
      callId: call.id,
      campaignId: campaign.id,
      leadId: lead.id,
      channelId: null,
      state: 'dialing',
      originatedAt: Date.now(),
      answeredAt: null,
      agentUserId: null,
      bridgeInFlight: false,
      lastBridgeAttemptAt: 0,
    };
    this.predictive.set(call.id, pc);
    this.ctx.bus.emitDomain('call.started', { callId: call.id });
    void this.telephony!
      .originate({
        callId: call.id,
        campaignId: campaign.id,
        leadId: lead.id,
        phone: lead.phone,
        callerId: campaign.callerId,
        ringTimeoutSec: campaign.ringTimeoutSec,
        bridgeWaitSec: campaign.abandonTimeoutSec,
      })
      .then(({ channelId }) => this.onPredictiveAnswered(pc, channelId))
      .catch((err: unknown) => this.onPredictiveOriginateFailed(pc, err));
  }

  private onPredictiveAnswered(pc: PredictiveCall, channelId: string) {
    if (!this.predictive.has(pc.callId)) {
      // torn down while ringing (campaign paused, call ended) – drop the leg
      void this.telephony?.hangup(channelId).catch(() => {});
      return;
    }
    pc.channelId = channelId;
    pc.state = 'waiting';
    pc.answeredAt = Date.now();
    this.predictiveByChannel.set(channelId, pc.callId);
    setCallChannel(this.ctx.db, pc.callId, channelId);
    markAnsweredWaiting(this.ctx.db, pc.callId);
    const campaign = findCampaign(this.ctx.db, pc.campaignId);
    if (!campaign || campaign.status !== 'active') {
      this.teardownPredictive(pc.callId, true);
      const call = endCall(this.ctx.db, pc.callId, 'cancelled');
      this.ctx.bus.emitDomain('call.ended', { callId: call.id });
      releaseLead(this.ctx.db, pc.leadId);
      return;
    }
    this.tryBridgePredictive(pc, campaign);
  }

  /** Bridge a waiting answered call to the longest-ready agent, if any. */
  private tryBridgePredictive(pc: PredictiveCall, campaign: Campaign) {
    if (pc.state !== 'waiting' || !pc.channelId || pc.bridgeInFlight) return;
    if (Date.now() - pc.lastBridgeAttemptAt < 5000 && pc.lastBridgeAttemptAt > 0) return;
    const agent = [...this.sessions.values()]
      .filter((s) => s.campaignId === campaign.id && s.state === 'ready' && !s.disconnectedAt)
      .sort((a, b) => (a.stateSince < b.stateSince ? -1 : 1))[0];
    if (!agent) return;
    const sip = getUserRow(this.ctx.db, agent.userId)?.sip_username;
    if (!sip) {
      this.ctx.log.warn({ userId: agent.userId }, 'predictive: agent has no SIP username – cannot bridge');
      return;
    }
    pc.bridgeInFlight = true;
    pc.lastBridgeAttemptAt = Date.now();
    void this.telephony!
      .bridgeToAgent(pc.channelId, sip)
      .then(() => {
        pc.bridgeInFlight = false;
        this.onPredictiveBridged(pc, agent, campaign);
      })
      .catch((err: unknown) => {
        pc.bridgeInFlight = false;
        this.ctx.log.warn({ err, callId: pc.callId }, 'predictive: bridge to agent failed – call stays in the hold');
      });
  }

  private onPredictiveBridged(pc: PredictiveCall, agent: AgentSession, campaign: Campaign) {
    if (!this.predictive.has(pc.callId)) {
      if (pc.channelId) void this.telephony?.hangup(pc.channelId).catch(() => {});
      return;
    }
    if (agent.state !== 'ready' || agent.disconnectedAt || agent.campaignId !== campaign.id) {
      // the agent went away while the bridge was being set up; the customer
      // is still parked in BridgeWait – the sweep will retry / abandon it
      pc.state = 'waiting';
      return;
    }
    pc.state = 'bridged';
    pc.agentUserId = agent.userId;
    assignCallToAgent(this.ctx.db, pc.callId, agent.userId);
    markAnswered(this.ctx.db, pc.callId, pc.channelId ?? undefined);
    // hand the lead lock to the agent so orphan-lock cleanup keeps it
    this.ctx.db.prepare('UPDATE leads SET locked_by = ? WHERE id = ?').run(agent.userId, pc.leadId);
    const lead = getLead(this.ctx.db, pc.leadId);
    agent.leadId = pc.leadId;
    agent.callId = pc.callId;
    agent.callbackId = null;
    agent.disposedDuringCall = false;
    this.setState(agent, 'talking', null);
    const payload = this.assignmentPayload(lead, campaign, null);
    payload.autoDial = false;
    payload.predictive = true;
    payload.callId = pc.callId;
    this.transport.toUser(agent.userId, 'lead:assigned', payload);
    const call = findCall(this.ctx.db, pc.callId);
    if (call) this.transport.toUser(agent.userId, 'call:started', { call });
    this.recordPredictiveOutcome(campaign.id, false);
  }

  private onPredictiveOriginateFailed(pc: PredictiveCall, err: unknown) {
    if (!this.predictive.delete(pc.callId)) return; // already handled elsewhere
    const cause = err instanceof OriginateError ? err.reason : 'failed';
    this.finishPredictiveCall(pc, cause, false);
  }

  private onPredictiveChannelEnded(channelId: string, _cause: string) {
    const callId = this.predictiveByChannel.get(channelId);
    if (callId == null) return;
    const pc = this.predictive.get(callId);
    this.predictiveByChannel.delete(channelId);
    if (!pc) return;
    if (pc.state === 'waiting') {
      // the customer hung up while waiting for an agent – that is an abandon
      this.predictive.delete(callId);
      this.recordPredictiveOutcome(pc.campaignId, true);
      this.finishPredictiveCall(pc, 'cancelled', true);
    } else if (pc.state === 'bridged') {
      // the media leg is gone; the agent client reports the call end through
      // call:update as usual – just stop tracking it here
      this.predictive.delete(callId);
    }
  }

  /** Per-tick sweep: retry bridges for waiting calls, abandon stale ones. */
  private sweepPredictive(campaign: Campaign, now: number) {
    for (const pc of [...this.predictive.values()].filter((p) => p.campaignId === campaign.id)) {
      if (pc.state === 'waiting') {
        this.tryBridgePredictive(pc, campaign);
        if (pc.state === 'waiting' && pc.answeredAt && now - pc.answeredAt > campaign.abandonTimeoutSec * 1000) {
          this.teardownPredictive(pc.callId, true);
          this.recordPredictiveOutcome(campaign.id, true);
          this.finishPredictiveCall(pc, 'cancelled', true);
        }
      } else if (pc.state === 'dialing' && now - pc.originatedAt > (campaign.ringTimeoutSec + 30) * 1000) {
        // the originate promise never settled (adapter lost the channel)
        this.predictive.delete(pc.callId);
        this.finishPredictiveCall(pc, 'no-answer', false);
      }
    }
  }

  /**
   * End a predictive call that never reached an agent and auto-dispose it the
   * same way agent calls are (BUSY / NO_ANSWER), so attempts and retry timing
   * update exactly like a progressive no-contact.
   */
  private finishPredictiveCall(pc: PredictiveCall, cause: 'busy' | 'no-answer' | 'failed' | 'cancelled', abandoned: boolean) {
    if (abandoned) markCallAbandoned(this.ctx.db, pc.callId);
    const call = endCall(this.ctx.db, pc.callId, cause);
    this.ctx.bus.emitDomain('call.ended', { callId: call.id });
    const code = !abandoned && call.result === 'busy' ? 'BUSY' : 'NO_ANSWER';
    const d = listDispositions(this.ctx.db).find((x) => x.code === code) ?? listDispositions(this.ctx.db).find((x) => x.category === 'no_contact');
    if (!d) return;
    disposeCall(this.ctx.db, pc.callId, d.id, abandoned ? 'auto: predictive abandoned (no agent in time)' : `auto: predictive ${cause}`);
    const lead = findLead(this.ctx.db, pc.leadId);
    const campaign = findCampaign(this.ctx.db, pc.campaignId);
    if (lead && campaign) applyDispositionToLead(this.ctx.db, lead.id, d, campaign, false);
  }

  /**
   * Rolling abandon guard: when the abandoned share of the last 50 answered
   * predictive calls exceeds the campaign cap, predictive dialing suspends
   * for a while and agents fall back to progressive assignment (tryAssign).
   */
  private recordPredictiveOutcome(campaignId: number, abandoned: boolean) {
    const arr = this.predictiveOutcomes.get(campaignId) ?? [];
    arr.push(abandoned);
    if (arr.length > 50) arr.shift();
    this.predictiveOutcomes.set(campaignId, arr);
    if (!abandoned || arr.length < 10) return;
    const campaign = findCampaign(this.ctx.db, campaignId);
    if (!campaign) return;
    const rate = arr.filter(Boolean).length / arr.length;
    if (rate > campaign.maxAbandonRate) {
      this.predictiveSuspendedUntil.set(campaignId, Date.now() + PREDICTIVE_SUSPEND_MS);
      this.ctx.log.warn(
        { campaignId, abandonRate: rate, cap: campaign.maxAbandonRate },
        'predictive: abandon rate above cap – suspending predictive dialing, agents fall back to progressive',
      );
    }
  }

  /* ------------------------------------------------------------------ */
  /* housekeeping                                                        */
  /* ------------------------------------------------------------------ */

  tick(now = Date.now()) {
    for (const s of [...this.sessions.values()]) {
      // reconnect grace expired
      if (s.disconnectedAt && now - s.disconnectedAt > DISCONNECT_GRACE_MS) {
        this.ctx.log.info({ user: s.username }, 'agent session expired after disconnect');
        this.leave(s.userId);
        continue;
      }
      // wrap-up timeout: only unanswered calls are auto-dispositioned
      if (s.state === 'wrapup' && s.campaignId != null && s.wrapupStartedAt) {
        const campaign = findCampaign(this.ctx.db, s.campaignId);
        if (campaign && campaign.wrapupTimeoutSec > 0 && now - s.wrapupStartedAt > campaign.wrapupTimeoutSec * 1000) {
          this.autoDispose(s);
        }
      }
      if (s.state === 'ready') this.tryAssign(s);
      // callback reminders
      for (const cb of upcomingPersonalCallbacks(this.ctx.db, s.userId, 5)) {
        if (this.remindedCallbacks.has(cb.id)) continue;
        this.remindedCallbacks.add(cb.id);
        this.transport.toUser(s.userId, 'callback:due', { callback: cb });
      }
    }
    if (this.remindedCallbacks.size > 5000) this.remindedCallbacks.clear();
    this.releaseOrphanLocks();
    this.tickPredictiveAll(now);
    this.scheduleWallboard();
  }

  private autoDispose(s: AgentSession, reason = 'wrap-up timeout') {
    if (!s.callId) return;
    const call = findCall(this.ctx.db, s.callId);
    if (!call) return;
    if (call.result === 'answered') return; // agent must choose
    const code = call.result === 'busy' ? 'BUSY' : 'NO_ANSWER';
    const d = listDispositions(this.ctx.db).find((x) => x.code === code) ?? listDispositions(this.ctx.db).find((x) => x.category === 'no_contact');
    if (!d) return;
    try {
      this.dispose(s.userId, {
        callId: s.callId,
        dispositionId: d.id,
        notes: `auto: ${reason}`,
      });
      this.transport.toUser(s.userId, 'notice', {
        level: 'info',
        message: `Call auto-dispositioned as ${d.label} (${reason})`,
      });
    } catch (err) {
      this.ctx.log.warn({ err }, 'auto dispose failed');
    }
  }

  /** Leads locked by someone who is not online or not holding that lead are released. */
  private releaseOrphanLocks() {
    const rows = this.ctx.db.prepare('SELECT id, locked_by FROM leads WHERE locked_by IS NOT NULL').all() as { id: number; locked_by: number }[];
    for (const r of rows) {
      if (r.locked_by === PREDICTIVE_LOCK) continue; // owned by the predictive loop
      const s = this.sessions.get(r.locked_by);
      if (!s || s.leadId !== r.id) releaseLead(this.ctx.db, r.id);
    }
  }

  private onCampaignStatus(campaignId: number, status: string) {
    if (status !== 'active') {
      // stop predictive dialing for this campaign: drop in-flight calls and
      // re-queue their leads without consuming an attempt
      for (const pc of [...this.predictive.values()].filter((p) => p.campaignId === campaignId)) {
        this.teardownPredictive(pc.callId, true);
        const call = endCall(this.ctx.db, pc.callId, 'cancelled');
        this.ctx.bus.emitDomain('call.ended', { callId: call.id });
        releaseLead(this.ctx.db, pc.leadId);
      }
    }
    for (const s of this.sessions.values()) {
      if (s.campaignId !== campaignId) continue;
      this.transport.toUser(s.userId, 'campaign:changed', { campaignId });
      if (status !== 'active' && s.state === 'assigned') {
        this.releaseCurrentLead(s, `campaign ${status}`, true);
        this.setState(s, 'paused', 'Campaign ' + status);
      } else if (status === 'active' && s.state === 'ready') {
        this.tryAssign(s);
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* internals                                                           */
  /* ------------------------------------------------------------------ */

  private finishWrapup(s: AgentSession) {
    s.callId = null;
    s.leadId = null;
    s.callbackId = null;
    s.disposedDuringCall = false;
    s.wrapupStartedAt = null;
    if (s.pendingPause) {
      const code = s.pendingPause;
      s.pendingPause = null;
      this.setState(s, 'paused', code);
    } else {
      this.setState(s, 'ready', null);
      this.tryAssign(s);
    }
  }

  private abortCall(s: AgentSession, reason: string) {
    if (s.callId) this.teardownPredictive(s.callId, true);
    if (s.callId && IN_CALL.includes(s.state)) {
      const call = endCall(this.ctx.db, s.callId, reason);
      this.ctx.bus.emitDomain('call.ended', { callId: call.id });
    }
    s.callId = null;
    s.disposedDuringCall = false;
    s.wrapupStartedAt = null;
  }

  private releaseCurrentLead(s: AgentSession, reason: string, notify = false) {
    if (s.leadId) {
      releaseLead(this.ctx.db, s.leadId);
      if (notify) this.transport.toUser(s.userId, 'lead:released', { leadId: s.leadId, reason });
    }
    s.leadId = null;
    s.callbackId = null;
  }

  private setState(s: AgentSession, state: AgentState, pauseCode: string | null) {
    s.state = state;
    s.pauseCode = pauseCode;
    s.stateSince = new Date().toISOString();
    this.logState(s);
    this.transport.toUser(s.userId, 'agent:state', this.payload(s));
    this.ctx.bus.emitDomain('agent.state', { userId: s.userId, state, campaignId: s.campaignId });
    this.scheduleWallboard();
  }

  private logState(s: AgentSession) {
    this.ctx.db
      .prepare('INSERT INTO agent_state_log (user_id, state, pause_code, campaign_id) VALUES (?, ?, ?, ?)')
      .run(s.userId, s.state, s.pauseCode, s.campaignId);
  }

  payload(s: AgentSession): AgentStatePayload {
    const campaign = s.campaignId != null ? findCampaign(this.ctx.db, s.campaignId) : null;
    return {
      state: s.state,
      pauseCode: s.pauseCode,
      campaignId: s.campaignId,
      since: s.stateSince,
      leadId: s.leadId,
      callId: s.callId,
      wrapupTimeoutSec: campaign?.wrapupTimeoutSec ?? 0,
    };
  }

  /* ------------------------------------------------------------------ */
  /* wallboard                                                           */
  /* ------------------------------------------------------------------ */

  snapshot(): WallboardSnapshot {
    const today = new Date().toISOString().slice(0, 10);
    const agents: AgentSnapshot[] = [];
    const onlinePerCampaign = new Map<number, number>();
    for (const s of this.sessions.values()) {
      if (s.campaignId != null) onlinePerCampaign.set(s.campaignId, (onlinePerCampaign.get(s.campaignId) ?? 0) + 1);
      const lead = s.leadId ? findLead(this.ctx.db, s.leadId) : null;
      const campaign = s.campaignId != null ? findCampaign(this.ctx.db, s.campaignId) : null;
      const t = this.ctx.db
        .prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(talk_sec),0) AS talk FROM calls WHERE user_id = ? AND started_at >= ?`)
        .get(s.userId, today) as { n: number; talk: number };
      agents.push({
        userId: s.userId,
        username: s.username,
        displayName: s.displayName,
        state: s.state,
        pauseCode: s.pauseCode,
        campaignId: s.campaignId,
        campaignName: campaign?.name ?? null,
        leadId: s.leadId,
        leadName: lead ? leadName(lead) : null,
        phone: lead?.phone ?? (s.callId ? (findCall(this.ctx.db, s.callId)?.phone ?? null) : null),
        callId: s.callId,
        stateSince: s.stateSince,
        callsToday: t.n,
        talkSecToday: t.talk,
      });
    }
    const campaigns = listCampaigns(this.ctx.db)
      .filter((c) => c.status === 'active' || c.status === 'paused')
      .map((c) => campaignStats(this.ctx.db, c.id, onlinePerCampaign.get(c.id) ?? 0));
    return { at: new Date().toISOString(), agents, campaigns, today: todaySummary(this.ctx.db) };
  }

  /** Push a wallboard update to supervisors, at most once per second (skipped when nobody is watching). */
  private scheduleWallboard() {
    if (this.wallboardTimer) return;
    if (this.transport.supervisorCount && this.transport.supervisorCount() === 0) return;
    const wait = Math.max(0, 1000 - (Date.now() - this.lastWallboard));
    this.wallboardTimer = setTimeout(() => {
      this.wallboardTimer = null;
      this.lastWallboard = Date.now();
      try {
        this.transport.toSupervisors('wallboard:update', this.snapshot());
      } catch (err) {
        this.ctx.log.warn({ err }, 'wallboard snapshot failed');
      }
    }, wait);
    this.wallboardTimer.unref?.();
  }
}
