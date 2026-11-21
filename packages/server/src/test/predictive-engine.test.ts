import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { Bus, type Ctx } from '../context.js';
import { loadConfig } from '../config.js';
import { openDatabase, type DB } from '../db.js';
import { Engine } from '../engine.js';
import { claimNextLeadForDialer, getLead, PREDICTIVE_LOCK } from '../services/leads.js';
import { getSettings } from '../services/settings.js';
import { findCampaign } from '../services/campaigns.js';
import { SimPredictiveAdapter } from '../telephony/simAdapter.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Harness {
  ctx: Ctx;
  db: DB;
  engine: Engine;
  sim: SimPredictiveAdapter;
  events: { userId: number; event: string; args: unknown[] }[];
}

function makeHarness(campaignExtra: Record<string, unknown> = {}): Harness {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendialer-pred-'));
  const db = openDatabase(':memory:');
  const config = loadConfig({
    dataDir,
    jwtSecret: 'test-secret-'.repeat(4),
    engineInterval: 0,
    gsmDongleMonitor: { enabled: false, host: '127.0.0.1', port: 5038, username: '', password: '', intervalMs: 10_000, timeoutMs: 500, allowCommandFallback: false },
    predictive: { enabled: false, host: '127.0.0.1', port: 5038, username: '', password: '', channelPrefix: 'Dongle/r0/' },
  });
  const ctx: Ctx = { db, config, log: pino({ level: 'silent' }), bus: new Bus() };
  db.prepare(`INSERT INTO users (id, username, display_name, password_hash, role, sip_username) VALUES (1, 'agent1', 'Agent One', 'x', 'agent', '111')`).run();
  const cols: Record<string, unknown> = {
    id: 1, name: 'Predictive', status: 'active', dial_mode: 'predictive',
    calling_hours_start: '00:00', calling_hours_end: '00:00', calling_days: '[0,1,2,3,4,5,6]',
    timezone_mode: 'fixed', fixed_timezone: 'UTC', ...campaignExtra,
  };
  const keys = Object.keys(cols);
  db.prepare(`INSERT INTO campaigns (${keys.join(',')}) VALUES (${keys.map((k) => '@' + k).join(',')})`).run(cols);
  db.prepare(`INSERT INTO campaign_agents (campaign_id, user_id) VALUES (1, 1)`).run();
  db.prepare(`INSERT INTO lists (id, campaign_id, name, active) VALUES (1, 1, 'Main', 1)`).run();
  const insLead = db.prepare(`INSERT INTO leads (list_id, campaign_id, phone, first_name) VALUES (1, 1, @phone, @name)`);
  ['+201001111111', '+201002222222', '+201003333333', '+201004444444', '+201005555555'].forEach((phone, i) => insLead.run({ phone, name: `Lead${i + 1}` }));

  const sim = new SimPredictiveAdapter();
  sim.ringMs = 20;
  const engine = new Engine(ctx, sim);
  const events: Harness['events'] = [];
  engine.setTransport({
    toUser: (userId, event, ...args) => events.push({ userId, event: String(event), args }),
    toSupervisors: () => {},
  });
  return { ctx, db, engine, sim, events };
}

function joinReady(h: Harness) {
  h.engine.join({ id: 1, username: 'agent1', displayName: 'Agent One', role: 'agent' }, 1);
  h.engine.ready(1);
}

describe('claimNextLeadForDialer', () => {
  it('locks the lead with the PREDICTIVE_LOCK sentinel, not an agent id', () => {
    const h = makeHarness();
    const campaign = findCampaign(h.db, 1)!;
    const lead = claimNextLeadForDialer(h.db, campaign, getSettings(h.db));
    expect(lead).not.toBeNull();
    expect(lead!.lockedBy).toBe(PREDICTIVE_LOCK);
    expect(getLead(h.db, lead!.id).lockedBy).toBe(-1);
  });
});

describe('predictive engine loop', () => {
  it('dials ahead, bridges the answered call to the ready agent, and auto-disposes a no-answer', async () => {
    const h = makeHarness();
    h.sim.setOutcomes(['answer', 'no-answer']);
    joinReady(h);
    expect(h.engine.getSession(1)?.state).toBe('ready'); // tryAssign must not hand out leads in predictive mode

    h.engine.tick();
    await sleep(80);

    // agent is talking on the answered call
    const s = h.engine.getSession(1);
    expect(s?.state).toBe('talking');
    expect(s?.callId).not.toBeNull();

    // the assignment carried the predictive correlation (call id, no auto-dial)
    const assigned = h.events.find((e) => e.event === 'lead:assigned');
    expect(assigned).toBeTruthy();
    const payload = assigned!.args[0] as { predictive?: boolean; callId?: number | null; autoDial: boolean; lead: { id: number } };
    expect(payload.predictive).toBe(true);
    expect(payload.autoDial).toBe(false);
    expect(payload.callId).toBe(s!.callId);

    // call row: agent attached at bridge time, channel recorded, not abandoned
    const call = h.db.prepare('SELECT * FROM calls WHERE id = ?').get(s!.callId) as Record<string, unknown>;
    expect(call.user_id).toBe(1);
    expect(call.channel_id).toBe('Sim/predictive-1');
    expect(call.answered_at).not.toBeNull();
    expect(call.abandoned).toBe(0);

    // lead lock was handed from the dialer sentinel to the agent
    expect(getLead(h.db, payload.lead.id).lockedBy).toBe(1);

    // the no-answer attempt was auto-disposed without touching an agent
    const na = h.db.prepare(`SELECT * FROM calls WHERE id != ?`).get(s!.callId) as Record<string, unknown>;
    expect(na.user_id).toBeNull();
    expect(na.ended_at).not.toBeNull();
    expect(na.result).toBe('no_answer');
    const naDisp = h.db.prepare('SELECT code FROM dispositions WHERE id = ?').get(na.disposition_id as number) as { code: string };
    expect(naDisp.code).toBe('NO_ANSWER');
    const naLead = getLead(h.db, na.lead_id as number);
    expect(naLead.attempts).toBe(1);
    expect(naLead.lockedBy).toBeNull();
  });

  it('keeps dialer-locked leads across ticks (orphan cleanup skips the sentinel)', async () => {
    const h = makeHarness();
    h.sim.ringMs = 5000; // still ringing
    h.sim.setOutcomes(['answer']);
    joinReady(h);
    h.engine.tick();
    const locked = h.db.prepare('SELECT locked_by FROM leads WHERE locked_by = -1').all();
    expect(locked.length).toBeGreaterThan(0);
    h.engine.tick();
    const still = h.db.prepare('SELECT COUNT(*) AS n FROM leads WHERE locked_by = -1').get() as { n: number };
    expect(still.n).toBe(locked.length);
    h.sim.close();
  });

  it('abandons an answered call that waits past abandonTimeoutSec and re-queues the lead', async () => {
    const h = makeHarness();
    h.sim.setOutcomes(['answer', 'answer']);
    joinReady(h);
    h.engine.tick(); // dials 2 (ratio 1.5 x 1 ready agent)
    h.engine.pause(1, 'Break'); // agent unavailable before the answers land
    await sleep(80); // both answered, nobody to bridge to

    const waiting = h.db.prepare('SELECT * FROM calls WHERE answered_waiting_at IS NOT NULL AND ended_at IS NULL').all() as Record<string, unknown>[];
    expect(waiting.length).toBe(2);

    h.engine.tick(Date.now() + 26_000); // past the 25s abandon timeout
    const rows = h.db.prepare('SELECT * FROM calls ORDER BY id').all() as Record<string, unknown>[];
    for (const r of rows) {
      expect(r.abandoned).toBe(1);
      expect(r.ended_at).not.toBeNull();
      const lead = getLead(h.db, r.lead_id as number);
      expect(lead.attempts).toBe(1);
      expect(lead.lockedBy).toBeNull();
    }
  });

  it('suspends predictive dialing when the rolling abandon rate breaches the cap, falling back to progressive assignment', () => {
    const h = makeHarness();
    const rec = (h.engine as unknown as { recordPredictiveOutcome: (c: number, a: boolean) => void }).recordPredictiveOutcome.bind(h.engine);
    for (let i = 0; i < 9; i++) rec(1, false);
    rec(1, true); // 1/10 = 10% > 3% cap
    joinReady(h);
    // suspended: tryAssign now serves the agent a lead the progressive way
    expect(h.engine.getSession(1)?.state).toBe('assigned');
  });
});
