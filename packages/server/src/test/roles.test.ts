import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SYSTEM_ROLE_PERMISSIONS } from '@opendialer/shared';
import { openDatabase } from '../db.js';
import { connectAgent, createAgent, login, setupAdmin, startTestServer, type AgentClient, type TestServer } from './helpers.js';

let t: TestServer;
let admin: string;
let supervisor: string;
let agent: string;
const sockets: AgentClient[] = [];

beforeAll(async () => {
  t = await startTestServer();
  admin = await setupAdmin(t);
  supervisor = (await createAgent(t, admin, 'role-supervisor', 'supervisor')).token;
  agent = (await createAgent(t, admin, 'role-agent', 'agent')).token;
});

afterAll(async () => {
  sockets.forEach((socket) => socket.close());
  await t.close();
});

describe('custom roles and permissions', () => {
  it('keeps the three system roles and their existing permissions', async () => {
    const roles = await t.api('GET', '/api/roles', undefined, admin);
    expect(roles.status).toBe(200);
    for (const name of ['admin', 'supervisor', 'agent'] as const) {
      const role = roles.body.find((item: any) => item.key === `system:${name}`);
      expect(role).toMatchObject({ system: true, systemRole: name });
      expect(role.permissions).toEqual(SYSTEM_ROLE_PERMISSIONS[name]);
    }
    expect((await t.api('GET', '/api/reports/summary', undefined, supervisor)).status).toBe(200);
    expect((await t.api('GET', '/api/reports/summary', undefined, agent)).status).toBe(403);
    expect((await t.api('GET', '/api/reports/export/calls.csv', undefined, supervisor)).status).toBe(200);
    expect((await t.api('GET', '/api/reports/export/leads.csv', undefined, supervisor)).status).toBe(200);
    expect((await t.api('GET', '/api/reports/export/calls.csv', undefined, agent)).status).toBe(403);
    expect((await t.api('GET', '/api/reports/export/leads.csv', undefined, agent)).status).toBe(403);
  });

  it('allows viewing without exporting and enforces grants and revocations on direct API requests', async () => {
    const created = await t.api('POST', '/api/roles', {
      name: 'Export tester',
      permissions: ['reports.view', 'system.manage'],
    }, admin);
    expect(created.status).toBe(201);
    expect(created.body.permissions).not.toContain('calls.export');
    expect(created.body.permissions).not.toContain('leads.export');
    expect(created.body.permissions).not.toContain('backups.export');

    const user = await t.api('POST', '/api/users', {
      username: 'export-tester', password: 'password123', displayName: 'Export Tester', roleKey: created.body.key,
    }, admin);
    expect(user.status).toBe(201);
    const token = await login(t, 'export-tester', 'password123');

    expect((await t.api('GET', '/api/reports/summary', undefined, token)).status).toBe(200);
    expect((await t.api('GET', '/api/admin/system', undefined, token)).status).toBe(200);
    expect((await t.api('GET', '/api/reports/export/calls.csv', undefined, token)).status).toBe(403);
    expect((await t.api('GET', '/api/reports/export/leads.csv', undefined, token)).status).toBe(403);
    const backup = await t.api('POST', '/api/admin/backup', undefined, token);
    expect(backup.status).toBe(200);
    expect((await t.api('GET', `/api/admin/backups/${encodeURIComponent(backup.body.file)}`, undefined, token)).status).toBe(403);

    const granted = await t.api('PATCH', `/api/roles/${created.body.key}`, {
      permissions: ['reports.view', 'system.manage', 'calls.export', 'leads.export', 'backups.export'],
    }, admin);
    expect(granted.status).toBe(200);
    expect((await t.api('GET', '/api/reports/export/calls.csv', undefined, token)).status).toBe(200);
    expect((await t.api('GET', '/api/reports/export/leads.csv', undefined, token)).status).toBe(200);
    expect((await t.api('GET', `/api/admin/backups/${encodeURIComponent(backup.body.file)}`, undefined, token)).status).toBe(200);

    const revoked = await t.api('PATCH', `/api/roles/${created.body.key}`, {
      permissions: ['reports.view', 'system.manage'],
    }, admin);
    expect(revoked.status).toBe(200);
    expect((await t.api('GET', '/api/reports/export/calls.csv', undefined, token)).status).toBe(403);
    expect((await t.api('GET', '/api/reports/export/leads.csv', undefined, token)).status).toBe(403);
    expect((await t.api('GET', `/api/admin/backups/${encodeURIComponent(backup.body.file)}`, undefined, token)).status).toBe(403);
  });

  it('creates, updates, assigns, and enforces a custom role in REST and Socket.IO', async () => {
    const created = await t.api('POST', '/api/roles', {
      name: 'Reporting operator',
      description: 'Reports without campaign management',
      permissions: ['reports.view'],
    }, admin);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: 'Reporting operator', system: false, permissions: ['reports.view'] });

    const listed = await t.api('GET', '/api/roles', undefined, admin);
    expect(listed.body.some((role: any) => role.key === created.body.key)).toBe(true);

    const user = await t.api('POST', '/api/users', {
      username: 'report-user',
      password: 'password123',
      displayName: 'Report User',
      roleKey: created.body.key,
    }, admin);
    expect(user.status).toBe(201);
    expect(user.body).toMatchObject({ roleKey: created.body.key, roleName: 'Reporting operator', customRoleId: created.body.id });
    const token = await login(t, 'report-user', 'password123');
    const me = await t.api('GET', '/api/auth/me', undefined, token);
    expect(me.body.user.permissions).toEqual(['reports.view']);
    expect((await t.api('GET', '/api/reports/summary', undefined, token)).status).toBe(200);
    expect((await t.api('POST', '/api/campaigns', { name: 'Denied' }, token)).status).toBe(403);

    const socket = await connectAgent(t, token);
    sockets.push(socket);
    const deniedJoin = await socket.call('agent:join', { campaignId: null });
    expect(deniedJoin).toMatchObject({ ok: false, error: 'Insufficient permission' });
    const deniedWallboard = await socket.call('wallboard:subscribe');
    expect(deniedWallboard).toMatchObject({ ok: false, error: 'Insufficient permission' });

    const updated = await t.api('PATCH', `/api/roles/${created.body.key}`, {
      name: 'Campaign operator',
      permissions: ['reports.view', 'campaigns.create', 'dashboard.view'],
    }, admin);
    expect(updated.status).toBe(200);
    expect(updated.body.permissions).toContain('campaigns.create');

    // The same login token resolves permissions from the live database on every request.
    const campaign = await t.api('POST', '/api/campaigns', { name: 'Allowed after update' }, token);
    expect(campaign.status).toBe(201);
    const wallboard = await socket.call('wallboard:subscribe');
    expect(wallboard.ok).toBe(true);
  });

  it('allows only system admins to manage roles and never mutates system roles', async () => {
    expect((await t.api('POST', '/api/roles', { name: 'Nope', permissions: [] }, supervisor)).status).toBe(403);
    expect((await t.api('POST', '/api/roles', { name: 'Nope', permissions: [] }, agent)).status).toBe(403);
    expect((await t.api('PATCH', '/api/roles/system:admin', { name: 'Changed' }, admin)).status).toBe(409);
    expect((await t.api('DELETE', '/api/roles/system:agent', undefined, admin)).status).toBe(409);
    const roles = await t.api('GET', '/api/roles', undefined, admin);
    expect(roles.body.find((role: any) => role.key === 'system:admin').name).toBe('Admin');
    expect(roles.body.find((role: any) => role.key === 'system:agent').name).toBe('Agent');
  });

  it('persists GSM monitoring grants and revocations for built-in roles across REST and Socket.IO', async () => {
    expect((await t.api('GET', '/api/gsm-dongles', undefined, admin)).status).toBe(200);
    expect((await t.api('GET', '/api/gsm-dongles', undefined, supervisor)).status).toBe(403);
    expect((await t.api('GET', '/api/gsm-dongles', undefined, agent)).status).toBe(403);

    const forbiddenChange = await t.api(
      'PATCH', '/api/roles/system:supervisor/permissions/dashboard.view_gsm_dongles', { enabled: true }, supervisor,
    );
    expect(forbiddenChange.status).toBe(403);

    const granted = await t.api(
      'PATCH', '/api/roles/system:supervisor/permissions/dashboard.view_gsm_dongles', { enabled: true }, admin,
    );
    expect(granted.status).toBe(200);
    expect(granted.body.permissions).toContain('dashboard.view_gsm_dongles');
    expect((await t.api('GET', '/api/gsm-dongles', undefined, supervisor)).status).toBe(200);

    const socket = await connectAgent(t, supervisor);
    sockets.push(socket);
    expect((await socket.call('gsm-dongles:subscribe')).ok).toBe(true);

    const revoked = await t.api(
      'PATCH', '/api/roles/system:supervisor/permissions/dashboard.view_gsm_dongles', { enabled: false }, admin,
    );
    expect(revoked.status).toBe(200);
    expect(revoked.body.permissions).not.toContain('dashboard.view_gsm_dongles');
    expect((await t.api('GET', '/api/gsm-dongles', undefined, supervisor)).status).toBe(403);
    expect(await socket.call('gsm-dongles:subscribe')).toMatchObject({ ok: false, error: 'Insufficient permission' });

    t.app.gsmDongles.emit('update', { status: 'available', total: 9, ready: 8, devices: [], refreshedAt: new Date().toISOString() });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(socket.received('gsm-dongles:update')).toHaveLength(0);
  });

  it('returns the latest cached monitoring snapshot to reconnecting authorized clients', async () => {
    const first = await connectAgent(t, admin);
    const initial = await first.call('gsm-dongles:subscribe');
    expect(initial).toMatchObject({ ok: true, data: { status: 'unavailable', total: null } });
    first.close();

    const reconnected = await connectAgent(t, admin);
    sockets.push(reconnected);
    expect(await reconnected.call('gsm-dongles:subscribe')).toEqual(initial);
  });

  it('does not let a custom user manager escalate to System Admin', async () => {
    const role = await t.api('POST', '/api/roles', { name: 'User manager', permissions: ['users.manage'] }, admin);
    const user = await t.api('POST', '/api/users', {
      username: 'user-manager', password: 'password123', displayName: 'User Manager', roleKey: role.body.key,
    }, admin);
    expect(user.status).toBe(201);
    const token = await login(t, 'user-manager', 'password123');
    expect((await t.api('GET', '/api/roles', undefined, token)).status).toBe(200);
    expect((await t.api('POST', '/api/roles', { name: 'Escalated', permissions: [] }, token)).status).toBe(403);
    expect((await t.api('POST', '/api/users', {
      username: 'new-admin', password: 'password123', displayName: 'New Admin', roleKey: 'system:admin',
    }, token)).status).toBe(403);
    expect((await t.api('POST', '/api/users', {
      username: 'managed-agent', password: 'password123', displayName: 'Managed Agent', roleKey: 'system:agent',
    }, token)).status).toBe(201);
  });
});

describe('role migration compatibility', () => {
  it('adds custom-role storage without changing an existing user role', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autodialer-role-migration-'));
    const file = path.join(dir, 'legacy.sqlite');
    const legacy = new Database(file);
    legacy.exec(`
      CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations (id, applied_at) VALUES (1, '2026-01-01T00:00:00.000Z');
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        display_name TEXT NOT NULL, password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('admin','supervisor','agent')), active INTEGER NOT NULL DEFAULT 1,
        sip_username TEXT, sip_auth_username TEXT, sip_password TEXT, created_at TEXT NOT NULL
      );
      INSERT INTO users (username, display_name, password_hash, role, active, created_at)
      VALUES ('legacy-admin', 'Legacy Admin', 'hash', 'admin', 1, '2026-01-01T00:00:00.000Z');
      CREATE TABLE dispositions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL UNIQUE, label TEXT NOT NULL,
        category TEXT NOT NULL, retry_minutes INTEGER, counts_as_contact INTEGER NOT NULL DEFAULT 0,
        is_sale INTEGER NOT NULL DEFAULT 0, color TEXT NOT NULL DEFAULT '#64748b',
        sort_order INTEGER NOT NULL DEFAULT 100, system INTEGER NOT NULL DEFAULT 0
      );
    `);
    legacy.close();

    const upgraded = openDatabase(file);
    const user = upgraded.prepare('SELECT role, custom_role_id FROM users WHERE username = ?').get('legacy-admin') as { role: string; custom_role_id: number | null };
    expect(user).toEqual({ role: 'admin', custom_role_id: null });
    expect((upgraded.prepare('SELECT COUNT(*) AS n FROM schema_migrations WHERE id = 2').get() as { n: number }).n).toBe(1);
    expect((upgraded.prepare('SELECT COUNT(*) AS n FROM schema_migrations WHERE id = 3').get() as { n: number }).n).toBe(1);
    expect((upgraded.prepare('SELECT COUNT(*) AS n FROM schema_migrations WHERE id = 4').get() as { n: number }).n).toBe(1);
    upgraded.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('backfills all campaign tabs only for existing custom campaign managers', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autodialer-tab-migration-'));
    const file = path.join(dir, 'roles.sqlite');
    const legacy = new Database(file);
    legacy.exec(`
      CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations (id, applied_at) VALUES (1, '2026-01-01T00:00:00.000Z'), (2, '2026-01-02T00:00:00.000Z');
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        display_name TEXT NOT NULL, password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('admin','supervisor','agent')), active INTEGER NOT NULL DEFAULT 1,
        sip_username TEXT, sip_auth_username TEXT, sip_password TEXT, created_at TEXT NOT NULL,
        custom_role_id INTEGER REFERENCES custom_roles(id) ON DELETE SET NULL
      );
      CREATE TABLE custom_roles (
        id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE COLLATE NOCASE,
        description TEXT NOT NULL DEFAULT '', permissions TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT ''
      );
      INSERT INTO custom_roles (name, permissions) VALUES
        ('Existing manager', '["campaigns.manage","leads.export"]'),
        ('Existing deleter', '["campaigns.delete"]'),
        ('Existing lead manager', '["leads.manage"]'),
        ('Existing tab viewer', '["campaigns.tabs.leads.view"]'),
        ('Existing reporter', '["reports.view"]');
      CREATE TABLE dispositions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL UNIQUE, label TEXT NOT NULL,
        category TEXT NOT NULL, retry_minutes INTEGER, counts_as_contact INTEGER NOT NULL DEFAULT 0,
        is_sale INTEGER NOT NULL DEFAULT 0, color TEXT NOT NULL DEFAULT '#64748b',
        sort_order INTEGER NOT NULL DEFAULT 100, system INTEGER NOT NULL DEFAULT 0
      );
    `);
    legacy.close();

    const upgraded = openDatabase(file);
    const manager = JSON.parse((upgraded.prepare(`SELECT permissions FROM custom_roles WHERE name = 'Existing manager'`).get() as { permissions: string }).permissions);
    const deleter = JSON.parse((upgraded.prepare(`SELECT permissions FROM custom_roles WHERE name = 'Existing deleter'`).get() as { permissions: string }).permissions);
    const leadManager = JSON.parse((upgraded.prepare(`SELECT permissions FROM custom_roles WHERE name = 'Existing lead manager'`).get() as { permissions: string }).permissions);
    const tabViewer = JSON.parse((upgraded.prepare(`SELECT permissions FROM custom_roles WHERE name = 'Existing tab viewer'`).get() as { permissions: string }).permissions);
    const reporter = JSON.parse((upgraded.prepare(`SELECT permissions FROM custom_roles WHERE name = 'Existing reporter'`).get() as { permissions: string }).permissions);
    expect(manager).toEqual(expect.arrayContaining([
      'campaigns.view', 'campaigns.create', 'campaigns.edit', 'leads.export',
      'campaigns.tabs.overview.view', 'campaigns.tabs.lists.view', 'campaigns.tabs.leads.view',
      'campaigns.tabs.agents.view', 'campaigns.tabs.settings.view',
    ]));
    expect(manager).not.toContain('campaigns.manage');
    expect(deleter).toEqual(expect.arrayContaining([
      'campaigns.delete', 'campaigns.work', 'campaigns.view', 'campaigns.create', 'campaigns.edit',
      'campaigns.status.activate', 'campaigns.status.pause', 'campaigns.status.complete', 'campaigns.status.draft',
      'campaigns.lists.view', 'campaigns.lists.create', 'campaigns.lists.edit', 'campaigns.lists.delete',
      'campaigns.agents.assign', 'campaigns.agents.unassign', 'campaigns.leads.reset',
    ]));
    expect(deleter).not.toContain('campaigns.manage');
    expect(leadManager).toEqual(expect.arrayContaining(['leads.manage', 'campaigns.lists.import']));
    expect(tabViewer).toEqual(expect.arrayContaining(['campaigns.tabs.leads.view', 'campaigns.leads.view', 'campaigns.lists.view']));
    expect(reporter).toEqual(['reports.view']);
    expect((upgraded.prepare('SELECT COUNT(*) AS n FROM schema_migrations WHERE id = 3').get() as { n: number }).n).toBe(1);
    expect((upgraded.prepare('SELECT COUNT(*) AS n FROM schema_migrations WHERE id = 4').get() as { n: number }).n).toBe(1);
    upgraded.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

