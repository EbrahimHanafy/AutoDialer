import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectAgent, createAgent, createCampaignWithLeads, login, setupAdmin, startTestServer, type AgentClient, type TestServer } from './helpers.js';

const phone = '+14155550101';
const masked = '*******0101';
let t: TestServer;
let admin: string;
let supervisor: string;
let agent: string;
let supervisorId: number;
let agentId: number;
let campaignId: number;
let listId: number;
let leadId: number;
let callId: number;
const sockets: AgentClient[] = [];

beforeAll(async () => {
  t = await startTestServer();
  admin = await setupAdmin(t);
  const supervisorUser = await createAgent(t, admin, 'privacy-supervisor', 'supervisor');
  supervisor = supervisorUser.token;
  supervisorId = supervisorUser.user.id;
  const agentUser = await createAgent(t, admin, 'privacy-agent', 'agent');
  agent = agentUser.token;
  agentId = agentUser.user.id;

  const created = await createCampaignWithLeads(t, admin, { phones: [phone], agentIds: [agentId] });
  campaignId = created.campaignId;
  listId = created.listId;
  leadId = created.leads[0].id;

  const agentSocket = await connectAgent(t, agent);
  sockets.push(agentSocket);
  expect((await agentSocket.call('agent:join', { campaignId })).ok).toBe(true);
  expect((await agentSocket.call('agent:ready')).ok).toBe(true);
  const assignment = await agentSocket.next<any>('lead:assigned');
  expect(assignment.lead.phone).toBe(phone);
  expect(assignment.dialString).toContain(phone);
  const dial = await agentSocket.call<{ callId: number }>('lead:dial', { leadId });
  expect(dial.ok).toBe(true);
  callId = dial.data!.callId;
  const started = await agentSocket.next<any>('call:started');
  expect(started.call.phone).toBe(phone);

  t.app.ctx.db.prepare(
    `INSERT INTO callbacks (lead_id, campaign_id, user_id, scheduled_at, note, created_by)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(leadId, campaignId, agentId, new Date(Date.now() + 3600_000).toISOString(), 'privacy callback', supervisorId);
  await t.api('POST', '/api/dnc', { phone: '+14155550999', note: 'privacy dnc' }, admin);
  t.app.ctx.db.prepare(
    `INSERT INTO audit_log (user_id, action, entity, entity_id, details) VALUES (?, ?, ?, ?, ?)`,
  ).run(supervisorId, 'privacy.test', 'lead', leadId, JSON.stringify({ phone }));
});

afterAll(async () => {
  sockets.forEach((socket) => socket.close());
  await t.close();
});

describe('table phone privacy permission', () => {
  it('defaults to full for Admin and masked for Supervisor and Agent tables', async () => {
    const adminLeads = await t.api('GET', `/api/leads?campaignId=${campaignId}`, undefined, admin);
    const supervisorLeads = await t.api('GET', `/api/leads?campaignId=${campaignId}`, undefined, supervisor);
    const agentLeads = await t.api('GET', `/api/leads?campaignId=${campaignId}`, undefined, agent);
    expect(adminLeads.body.items[0].phone).toBe(phone);
    expect(supervisorLeads.body.items[0].phone).toBe(masked);
    expect(supervisorLeads.body.items[0].rawPhone).toBe(masked);
    expect(agentLeads.body.items[0].phone).toBe(masked);

    const supervisorCalls = await t.api('GET', `/api/calls?campaignId=${campaignId}`, undefined, supervisor);
    expect(supervisorCalls.body.items[0]).toMatchObject({ id: callId, phone: masked });
    const callbacks = await t.api('GET', '/api/callbacks?scope=all', undefined, supervisor);
    expect(callbacks.body[0].lead.phone).toBe(masked);
    const dnc = await t.api('GET', '/api/dnc', undefined, supervisor);
    expect(dnc.body.items[0].phone).toBe('*******0999');
    const audit = await t.api('GET', '/api/audit', undefined, supervisor);
    expect(audit.body.items.find((entry: any) => entry.action === 'privacy.test').details).toContain(masked);
    expect(JSON.stringify({ supervisorLeads: supervisorLeads.body, supervisorCalls: supervisorCalls.body, callbacks: callbacks.body })).not.toContain(phone);
  });

  it('masks CSV exports and import preview without the permission', async () => {
    const callsCsv = await t.api('GET', `/api/reports/export/calls.csv?campaignId=${campaignId}`, undefined, supervisor);
    const leadsCsv = await t.api('GET', `/api/reports/export/leads.csv?campaignId=${campaignId}`, undefined, supervisor);
    expect(callsCsv.body).toContain(masked);
    expect(leadsCsv.body).toContain(masked);
    expect(callsCsv.body).not.toContain(phone);
    expect(leadsCsv.body).not.toContain(phone);

    const preview = await t.upload(
      `/api/lists/${listId}/import/preview`,
      supervisor,
      {},
      { name: 'preview.csv', content: `phone,name\n${phone},Customer` },
    );
    expect(preview.status).toBe(200);
    expect(preview.body.rows[0].phone).toBe(masked);
  });

  it('returns masked wallboard data over REST and Socket.IO for a supervisor', async () => {
    const rest = await t.api('GET', '/api/wallboard', undefined, supervisor);
    expect(rest.body.agents.find((item: any) => item.userId === agentId).phone).toBe(masked);

    const supervisorSocket = await connectAgent(t, supervisor);
    sockets.push(supervisorSocket);
    const sub = await supervisorSocket.call<any>('wallboard:subscribe');
    expect(sub.data.agents.find((item: any) => item.userId === agentId).phone).toBe(masked);

    const adminSocket = await connectAgent(t, admin);
    sockets.push(adminSocket);
    const adminSub = await adminSocket.call<any>('wallboard:subscribe');
    expect(adminSub.data.agents.find((item: any) => item.userId === agentId).phone).toBe(phone);
  });

  it('allows built-in role grants and revocations to take effect immediately', async () => {
    const granted = await t.api(
      'PATCH', '/api/roles/system:supervisor/permissions/leads.viewFullPhoneNumbers', { enabled: true }, admin,
    );
    expect(granted.status).toBe(200);
    expect(granted.body.permissions).toContain('leads.viewFullPhoneNumbers');
    expect((await t.api('GET', `/api/leads?campaignId=${campaignId}`, undefined, supervisor)).body.items[0].phone).toBe(phone);
    expect((await t.api('GET', `/api/reports/export/leads.csv?campaignId=${campaignId}`, undefined, supervisor)).body).toContain(phone);

    const revoked = await t.api(
      'PATCH', '/api/roles/system:supervisor/permissions/leads.viewFullPhoneNumbers', { enabled: false }, admin,
    );
    expect(revoked.status).toBe(200);
    expect((await t.api('GET', `/api/leads?campaignId=${campaignId}`, undefined, supervisor)).body.items[0].phone).toBe(masked);

    await t.api('PATCH', '/api/roles/system:agent/permissions/leads.viewFullPhoneNumbers', { enabled: true }, admin);
    expect((await t.api('GET', `/api/leads?campaignId=${campaignId}`, undefined, agent)).body.items[0].phone).toBe(phone);
    await t.api('PATCH', '/api/roles/system:agent/permissions/leads.viewFullPhoneNumbers', { enabled: false }, admin);
    expect((await t.api('GET', `/api/leads?campaignId=${campaignId}`, undefined, agent)).body.items[0].phone).toBe(masked);
  });

  it('keeps new custom roles disabled until the permission is explicitly assigned', async () => {
    const role = await t.api('POST', '/api/roles', { name: 'Privacy table viewer', permissions: ['leads.work'] }, admin);
    expect(role.body.permissions).not.toContain('leads.viewFullPhoneNumbers');
    await t.api('POST', '/api/users', {
      username: 'privacy-custom', password: 'password123', displayName: 'Privacy Custom', roleKey: role.body.key,
    }, admin);
    const token = await login(t, 'privacy-custom', 'password123');
    expect((await t.api('GET', `/api/leads?campaignId=${campaignId}`, undefined, token)).body.items[0].phone).toBe(masked);

    await t.api('PATCH', `/api/roles/${role.body.key}`, {
      permissions: ['leads.work', 'leads.viewFullPhoneNumbers'],
    }, admin);
    expect((await t.api('GET', `/api/leads?campaignId=${campaignId}`, undefined, token)).body.items[0].phone).toBe(phone);
  });

  it('preserves full phone numbers for Agent Console tables and dialing paths', async () => {
    const calls = await t.api('GET', '/api/calls?view=agent', undefined, agent);
    expect(calls.body.items[0].phone).toBe(phone);
    const callbacks = await t.api('GET', '/api/callbacks?view=agent&scope=mine', undefined, agent);
    expect(callbacks.body[0].lead.phone).toBe(phone);

    const ordinaryCalls = await t.api('GET', '/api/calls', undefined, agent);
    expect(ordinaryCalls.body.items[0].phone).toBe(masked);
    const denied = await t.api('GET', '/api/calls?view=agent', undefined, supervisor);
    expect(denied.status).toBe(200);
    expect(denied.body.items.every((item: any) => item.userId === supervisorId)).toBe(true);
  });
});
