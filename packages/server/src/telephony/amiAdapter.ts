import { amiField, type AmiFields } from './amiProtocol.js';
import type { AmiConnection } from './ami.js';
import { OriginateError, type AnsweredEvent, type EndedEvent, type OriginateCause, type OriginateOptions, type TelephonyAdapter } from './types.js';

export interface AmiAdapterConfig {
  /**
   * Dial string prefix for customer calls. The phone number is appended.
   * Default 'Dongle/r0/' = chan_dongle round-robin over group 0 (the syntax
   * validated on the production VitalPBX). Use e.g. 'Dongle/dongle0/' to pin
   * one device, or a SIP trunk prefix such as 'PJSIP/' where applicable.
   */
  channelPrefix: string;
  /** Dial string prefix for the agent leg (default 'PJSIP/'). */
  agentChannelPrefix?: string;
  /** BridgeWait holding-bridge name (default 'predictive'). */
  bridgeName?: string;
}

/** Map an OriginateResponse Reason (Q.850-flavoured on chan_dongle) to a cause. */
export function causeFromOriginateReason(reason: string | undefined, message?: string): OriginateCause {
  const text = (message ?? '').toLowerCase();
  if (text.includes('busy')) return 'busy';
  switch (reason) {
    case '17':
      return 'busy';
    case '1': // no answer (AMI originate reason)
    case '18': // no user responding
    case '19': // no answer from user
      return 'no-answer';
    default:
      return 'failed';
  }
}

interface Waiter {
  resolve: (msg: AmiFields) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Predictive adapter on a persistent AMI connection.
 *
 * Customer leg: Originate <prefix><phone> -> BridgeWait(<bridge>,participant,
 * e(r)S(<bridgeWaitSec>)) with Timeout = ring timeout. AMI answers the action
 * immediately ("queued"); the later OriginateResponse *event* (matched by
 * ActionID) is the answer signal – Success means the customer picked up and
 * the channel is parked in BridgeWait, Failure ends the attempt.
 *
 * Agent leg: Originate PJSIP/<ext> -> Bridge(<customer channel>). Its
 * OriginateResponse settles bridgeToAgent().
 */
export class AmiPredictiveAdapter implements TelephonyAdapter {
  private waiters = new Map<string, Waiter>();
  /** channels that answered and are parked or bridged */
  private live = new Set<string>();
  private answeredCbs: ((e: AnsweredEvent) => void)[] = [];
  private endedCbs: ((e: EndedEvent) => void)[] = [];
  private unsub: () => void;

  constructor(
    private readonly conn: AmiConnection,
    private readonly config: AmiAdapterConfig,
  ) {
    this.unsub = conn.onEvent((msg) => this.onEvent(msg));
  }

  onAnswered(cb: (e: AnsweredEvent) => void): void {
    this.answeredCbs.push(cb);
  }

  onEnded(cb: (e: EndedEvent) => void): void {
    this.endedCbs.push(cb);
  }

  private onEvent(msg: AmiFields) {
    const event = amiField(msg, 'event') ?? '';
    if (/^OriginateResponse$/i.test(event)) {
      const actionId = amiField(msg, 'actionid');
      const waiter = actionId ? this.waiters.get(actionId) : undefined;
      if (waiter && actionId) {
        this.waiters.delete(actionId);
        clearTimeout(waiter.timer);
        waiter.resolve(msg);
      }
      return;
    }
    if (/^Hangup$/i.test(event)) {
      const channel = amiField(msg, 'channel');
      if (channel && this.live.delete(channel)) {
        const cause = amiField(msg, 'cause-txt') ?? amiField(msg, 'cause') ?? '';
        for (const cb of this.endedCbs) cb({ channelId: channel, cause });
      }
    }
  }

  private waitForOriginate(actionId: string, timeoutMs: number, timeoutCause: OriginateCause): Promise<AmiFields> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(actionId);
        reject(new OriginateError(timeoutCause, 'Originate timed out waiting for an answer'));
      }, timeoutMs);
      timer.unref?.();
      this.waiters.set(actionId, { resolve, reject, timer });
    });
  }

  async originate(opts: OriginateOptions): Promise<{ channelId: string }> {
    const actionId = this.conn.nextId('pd-out');
    const result = this.waitForOriginate(actionId, (opts.ringTimeoutSec + 15) * 1000, 'no-answer');
    // If the action itself is refused (bad channel, AMI down) don't leak the waiter.
    result.catch(() => {});
    let queued: AmiFields;
    try {
      queued = await this.conn.sendAction(
        {
          Action: 'Originate',
          ActionID: actionId,
          Channel: `${this.config.channelPrefix}${opts.phone}`,
          Application: 'BridgeWait',
          Data: `${this.config.bridgeName ?? 'predictive'},participant,e(r)S(${opts.bridgeWaitSec})`,
          Timeout: String(opts.ringTimeoutSec * 1000),
          CallerID: opts.callerId || 'predictive',
          Async: 'true',
          Variable: [`OPENDIALER_CALL_ID=${opts.callId}`, `OPENDIALER_LEAD_ID=${opts.leadId}`, `OPENDIALER_CAMPAIGN_ID=${opts.campaignId}`],
        },
        10_000,
      );
    } catch (err) {
      const w = this.waiters.get(actionId);
      if (w) {
        this.waiters.delete(actionId);
        clearTimeout(w.timer);
      }
      throw new OriginateError('failed', `AMI Originate refused: ${(err as Error).message}`);
    }
    if (!/^success$/i.test(amiField(queued, 'response') ?? '')) {
      const w = this.waiters.get(actionId);
      if (w) {
        this.waiters.delete(actionId);
        clearTimeout(w.timer);
      }
      throw new OriginateError('failed', `AMI Originate refused: ${amiField(queued, 'message') ?? 'unknown error'}`);
    }
    const response = await result;
    if (!/^success$/i.test(amiField(response, 'response') ?? '')) {
      throw new OriginateError(
        causeFromOriginateReason(amiField(response, 'reason'), amiField(response, 'message')),
        `Originate failed (reason ${amiField(response, 'reason') ?? '?'})`,
      );
    }
    const channelId = amiField(response, 'channel');
    if (!channelId) throw new OriginateError('failed', 'Originate succeeded without a channel');
    this.live.add(channelId);
    for (const cb of this.answeredCbs) cb({ channelId });
    return { channelId };
  }

  async bridgeToAgent(channelId: string, agentSipUsername: string): Promise<void> {
    const actionId = this.conn.nextId('pd-bridge');
    const result = this.waitForOriginate(actionId, 20_000, 'failed');
    result.catch(() => {});
    let queued: AmiFields;
    try {
      queued = await this.conn.sendAction(
        {
          Action: 'Originate',
          ActionID: actionId,
          Channel: `${this.config.agentChannelPrefix ?? 'PJSIP/'}${agentSipUsername}`,
          Application: 'Bridge',
          Data: channelId,
          Timeout: '20000',
          CallerID: 'predictive',
          Async: 'true',
        },
        10_000,
      );
    } catch (err) {
      const w = this.waiters.get(actionId);
      if (w) {
        this.waiters.delete(actionId);
        clearTimeout(w.timer);
      }
      throw new Error(`AMI bridge Originate refused: ${(err as Error).message}`);
    }
    if (!/^success$/i.test(amiField(queued, 'response') ?? '')) {
      const w = this.waiters.get(actionId);
      if (w) {
        this.waiters.delete(actionId);
        clearTimeout(w.timer);
      }
      throw new Error(`AMI bridge Originate refused: ${amiField(queued, 'message') ?? 'unknown error'}`);
    }
    const response = await result;
    if (!/^success$/i.test(amiField(response, 'response') ?? '')) {
      throw new Error(`Bridge to agent failed (reason ${amiField(response, 'reason') ?? '?'})`);
    }
  }

  async hangup(channelId: string): Promise<void> {
    this.live.delete(channelId);
    try {
      await this.conn.sendAction({ Action: 'Hangup', Channel: channelId }, 5000);
    } catch {
      /* channel already gone – that was the goal */
    }
  }

  close(): void {
    this.unsub();
    for (const w of this.waiters.values()) {
      clearTimeout(w.timer);
      w.reject(new Error('AMI adapter closed'));
    }
    this.waiters.clear();
    this.live.clear();
  }
}
