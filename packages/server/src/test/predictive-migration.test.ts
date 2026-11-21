import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, describe, expect, it } from 'vitest';
import { MIGRATIONS, openDatabase } from '../db.js';

/**
 * Migration 6 rebuilds campaigns + calls. This builds a real pre-6 database
 * (migrations 1–5 applied by hand, with data), then opens it through
 * openDatabase() so migration 6 runs exactly as it would on a production copy.
 */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendialer-mig6-'));
const file = path.join(dir, 'old.sqlite');

function buildOldDatabase() {
  const db = new Database(file);
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)`);
  for (const m of MIGRATIONS) {
    if (m.id >= 6 || !('sql' in m)) continue;
    db.exec(m.sql);
    db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run(m.id, new Date().toISOString());
  }
  db.prepare(`INSERT INTO users (id, username, display_name, password_hash, role) VALUES (1, 'agent1', 'Agent One', 'x', 'agent')`).run();
  db.prepare(`INSERT INTO campaigns (id, name, dial_mode, status) VALUES (1, 'Legacy', 'progressive', 'active')`).run();
  db.prepare(`INSERT INTO lists (id, campaign_id, name) VALUES (1, 1, 'Main')`).run();
  db.prepare(`INSERT INTO leads (id, list_id, campaign_id, phone) VALUES (1, 1, 1, '+201001234567')`).run();
  db.prepare(
    `INSERT INTO calls (id, lead_id, campaign_id, user_id, phone, started_at, result) VALUES (1, 1, 1, 1, '+201001234567', '2026-11-01T10:00:00.000Z', 'answered')`,
  ).run();
  db.close();
}

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('migration 6 (predictive)', () => {
  buildOldDatabase();
  const db = openDatabase(file);

  it('preserves existing campaigns and calls', () => {
    const c = db.prepare('SELECT * FROM campaigns WHERE id = 1').get() as Record<string, unknown>;
    expect(c.name).toBe('Legacy');
    expect(c.dial_mode).toBe('progressive');
    const call = db.prepare('SELECT * FROM calls WHERE id = 1').get() as Record<string, unknown>;
    expect(call.user_id).toBe(1);
    expect(call.result).toBe('answered');
    expect(call.abandoned).toBe(0);
    expect(call.channel_id).toBeNull();
  });

  it('applies the predictive pacing defaults to old campaigns', () => {
    const c = db.prepare('SELECT * FROM campaigns WHERE id = 1').get() as Record<string, unknown>;
    expect(c.pacing_ratio).toBe(1.5);
    expect(c.max_abandon_rate).toBe(0.03);
    expect(c.abandon_timeout_sec).toBe(25);
    expect(c.buffer_calls).toBe(1);
    expect(c.launch_ahead_sec).toBe(19);
    expect(c.ring_timeout_sec).toBe(35);
    expect(c.amd_enabled).toBe(0);
  });

  it("accepts dial_mode = 'predictive' after the rebuild", () => {
    const r = db.prepare(`INSERT INTO campaigns (name, dial_mode) VALUES ('P', 'predictive')`).run();
    expect(r.changes).toBe(1);
    expect(() => db.prepare(`INSERT INTO campaigns (name, dial_mode) VALUES ('X', 'bogus')`).run()).toThrow();
  });

  it('makes calls.user_id nullable but keeps the foreign key', () => {
    const cols = db.pragma('table_info(calls)') as { name: string; notnull: number }[];
    expect(cols.find((c) => c.name === 'user_id')?.notnull).toBe(0);
    const r = db
      .prepare(`INSERT INTO calls (lead_id, campaign_id, user_id, phone, started_at) VALUES (1, 1, NULL, '+201001234567', '2026-11-21T10:00:00.000Z')`)
      .run();
    expect(r.changes).toBe(1);
    expect(() =>
      db.prepare(`INSERT INTO calls (user_id, phone, started_at) VALUES (999, '+201001234567', '2026-11-21T10:00:00.000Z')`).run(),
    ).toThrow();
  });

  it('leaves foreign keys intact and enforced', () => {
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    const applied = db.prepare('SELECT id FROM schema_migrations ORDER BY id').all() as { id: number }[];
    expect(applied.map((r) => r.id)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});
