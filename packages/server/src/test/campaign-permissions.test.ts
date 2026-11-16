import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Permission } from '@opendialer/shared';
import { createAgent, createCampaignWithLeads, login, setupAdmin, startTestServer, type TestServer } from './helpers.js';

let t: TestServer;
let admin: string;
let campaignId: number;
let listId: number;
let leadId: number;
let sequence = 0;

beforeAll(async () => {
  t = await startTestServer();
  admin = await setupAdmin(t);
  const campaign = await createCampaignWithLeads(t, admin, { name: 'Granular permissions', activate: false });
  campaignId = campaign.campaignId;
  listId = campaign.listId;
  leadId = campaign.leads[0].id;
});

afterAll(async () => {
  await t.close();
});

async function customUser(permissions: Permission[], assign = false) {
  sequence += 1;
  const role = await t.api('POST', '/api/roles', { name: `Campaign permission role ${sequence}`, permissions }, admin);
  expect(role.status).toBe(201);
  const username = `campaign-permission-${sequence}`;
  const user = await t.api('POST', '/api/users', {
    username,
    password: 'password123',
    displayName: `Campaign Permission ${sequence}`,
    roleKey: role.body.key,
  }, admin);
  expect(user.status).toBe(201);
  if (assign) {
    const current = await t.api('GET', `/api/campaigns/${campaignId}/agents`, undefined, admin);
    await t.api('PUT', `/api/campaigns/${campaignId}/agents`, { userIds: [...current.body.agentIds, user.body.id] }, admin);
  }
  return { user: user.body, token: await login(t, username, 'password123') };
}

describe('granular campaign access and status permissions', () => {
  it('keeps view, create, edit, and delete independent', async () => {
    const viewer = await customUser(['campaigns.view']);
    expect((await t.api('GET', '/api/campaigns', undefined, viewer.token)).status).toBe(200);
    expect((await t.api('POST', '/api/campaigns', { name: 'Denied create' }, viewer.token)).status).toBe(403);
    expect((await t.api('PATCH', `/api/campaigns/${campaignId}`, { description: 'Denied edit' }, viewer.token)).status).toBe(403);
    expect((await t.api('DELETE', `/api/campaigns/${campaignId}`, undefined, viewer.token)).status).toBe(403);

    const creator = await customUser(['campaigns.create']);
    expect((await t.api('GET', '/api/campaigns', undefined, creator.token)).status).toBe(403);
    expect((await t.api('POST', '/api/campaigns', { name: 'Create only' }, creator.token)).status).toBe(201);
    expect((await t.api('PATCH', `/api/campaigns/${campaignId}`, { description: 'Denied edit' }, creator.token)).status).toBe(403);

    const editor = await customUser(['campaigns.edit']);
    expect((await t.api('GET', '/api/campaigns', undefined, editor.token)).status).toBe(403);
    expect((await t.api('PATCH', `/api/campaigns/${campaignId}`, { description: 'Edit only' }, editor.token)).status).toBe(200);
    expect((await t.api('POST', '/api/campaigns', { name: 'Denied create' }, editor.token)).status).toBe(403);

    const disposable = await t.api('POST', '/api/campaigns', { name: 'Delete only target' }, admin);
    const deleter = await customUser(['campaigns.delete']);
    expect((await t.api('GET', '/api/campaigns', undefined, deleter.token)).status).toBe(403);
    expect((await t.api('PATCH', `/api/campaigns/${disposable.body.id}`, { description: 'Denied edit' }, deleter.token)).status).toBe(403);
    expect((await t.api('DELETE', `/api/campaigns/${disposable.body.id}`, undefined, deleter.token)).status).toBe(200);
  });

  it('authorizes each status value separately, including the existing draft API operation', async () => {
    const activator = await customUser(['campaigns.status.activate']);
    expect((await t.api('POST', `/api/campaigns/${campaignId}/status`, { status: 'active' }, activator.token)).status).toBe(200);
    expect((await t.api('POST', `/api/campaigns/${campaignId}/status`, { status: 'paused' }, activator.token)).status).toBe(403);

    const pauser = await customUser(['campaigns.status.pause']);
    expect((await t.api('POST', `/api/campaigns/${campaignId}/status`, { status: 'paused' }, pauser.token)).status).toBe(200);
    expect((await t.api('POST', `/api/campaigns/${campaignId}/status`, { status: 'completed' }, pauser.token)).status).toBe(403);

    const completer = await customUser(['campaigns.status.complete']);
    expect((await t.api('POST', `/api/campaigns/${campaignId}/status`, { status: 'completed' }, completer.token)).status).toBe(200);
    expect((await t.api('POST', `/api/campaigns/${campaignId}/status`, { status: 'draft' }, completer.token)).status).toBe(403);

    const drafter = await customUser(['campaigns.status.draft']);
    expect((await t.api('POST', `/api/campaigns/${campaignId}/status`, { status: 'draft' }, drafter.token)).status).toBe(200);
    expect((await t.api('POST', `/api/campaigns/${campaignId}/status`, { status: 'active' }, drafter.token)).status).toBe(403);
  });
});

describe('granular campaign list, agent, and lead permissions', () => {
  it('allows viewing lists without create, edit, delete, import, or reset', async () => {
    const viewer = await customUser(['campaigns.tabs.lists.view', 'campaigns.lists.view'], true);
    expect((await t.api('GET', `/api/campaigns/${campaignId}/lists`, undefined, viewer.token)).status).toBe(200);
    expect((await t.api('POST', `/api/campaigns/${campaignId}/lists`, { name: 'Denied' }, viewer.token)).status).toBe(403);
    expect((await t.api('PATCH', `/api/lists/${listId}`, { active: false }, viewer.token)).status).toBe(403);
    expect((await t.api('DELETE', `/api/lists/${listId}`, undefined, viewer.token)).status).toBe(403);
    expect((await t.upload(`/api/lists/${listId}/import/preview`, viewer.token, {}, { name: 'leads.csv', content: 'phone\n+14155550999' })).status).toBe(403);
    expect((await t.api('POST', `/api/campaigns/${campaignId}/reset-leads`, {}, viewer.token)).status).toBe(403);
  });

  it('enforces create, edit, delete, and import list permissions independently', async () => {
    const creator = await customUser(['campaigns.lists.create']);
    const created = await t.api('POST', `/api/campaigns/${campaignId}/lists`, { name: 'Created independently' }, creator.token);
    expect(created.status).toBe(201);
    expect((await t.api('PATCH', `/api/lists/${created.body.id}`, { active: false }, creator.token)).status).toBe(403);

    const editor = await customUser(['campaigns.lists.edit']);
    expect((await t.api('PATCH', `/api/lists/${created.body.id}`, { active: false }, editor.token)).status).toBe(200);
    expect((await t.api('DELETE', `/api/lists/${created.body.id}`, undefined, editor.token)).status).toBe(403);

    const importer = await customUser(['campaigns.lists.import']);
    expect((await t.upload(`/api/lists/${listId}/import/preview`, importer.token, {}, { name: 'leads.csv', content: 'phone\n+14155550999' })).status).toBe(200);
    expect((await t.api('PATCH', `/api/lists/${listId}`, { active: false }, importer.token)).status).toBe(403);

    const deleter = await customUser(['campaigns.lists.delete']);
    expect((await t.api('DELETE', `/api/lists/${created.body.id}`, undefined, deleter.token)).status).toBe(200);
    expect((await t.api('POST', `/api/campaigns/${campaignId}/lists`, { name: 'Denied' }, deleter.token)).status).toBe(403);
  });

  it('separates assigning agents from unassigning them', async () => {
    const target = await createAgent(t, admin, `assignment-target-${sequence}`);
    const assigner = await customUser(['campaigns.agents.assign'], true);
    const beforeAssign = await t.api('GET', `/api/campaigns/${campaignId}/agents`, undefined, admin);
    const assignedIds = beforeAssign.body.agentIds as number[];
    expect((await t.api('PUT', `/api/campaigns/${campaignId}/agents`, { userIds: [...assignedIds, target.user.id] }, assigner.token)).status).toBe(200);
    expect((await t.api('PUT', `/api/campaigns/${campaignId}/agents`, { userIds: [target.user.id] }, assigner.token)).status).toBe(403);

    const unassigner = await customUser(['campaigns.agents.unassign'], true);
    const beforeUnassign = await t.api('GET', `/api/campaigns/${campaignId}/agents`, undefined, admin);
    const withoutTarget = (beforeUnassign.body.agentIds as number[]).filter((id) => id !== target.user.id);
    expect((await t.api('PUT', `/api/campaigns/${campaignId}/agents`, { userIds: withoutTarget }, unassigner.token)).status).toBe(200);
    expect((await t.api('PUT', `/api/campaigns/${campaignId}/agents`, { userIds: [...withoutTarget, target.user.id] }, unassigner.token)).status).toBe(403);
  });

  it('allows campaign lead viewing without reset or export and allows reset without viewing', async () => {
    const viewer = await customUser(['campaigns.tabs.leads.view', 'campaigns.leads.view'], true);
    expect((await t.api('GET', `/api/leads?campaignId=${campaignId}`, undefined, viewer.token)).status).toBe(200);
    expect((await t.api('GET', `/api/leads/${leadId}`, undefined, viewer.token)).status).toBe(200);
    expect((await t.api('POST', `/api/campaigns/${campaignId}/reset-leads`, {}, viewer.token)).status).toBe(403);
    expect((await t.api('GET', `/api/reports/export/leads.csv?campaignId=${campaignId}`, undefined, viewer.token)).status).toBe(403);

    const resetter = await customUser(['campaigns.leads.reset']);
    expect((await t.api('GET', `/api/leads?campaignId=${campaignId}`, undefined, resetter.token)).status).toBe(403);
    expect((await t.api('POST', `/api/campaigns/${campaignId}/reset-leads`, {}, resetter.token)).status).toBe(200);
    expect((await t.api('GET', `/api/reports/export/leads.csv?campaignId=${campaignId}`, undefined, resetter.token)).status).toBe(403);
  });
});
