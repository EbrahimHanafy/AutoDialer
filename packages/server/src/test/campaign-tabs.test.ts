import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CAMPAIGN_TAB_PERMISSIONS, type Permission } from '@opendialer/shared';
import { createAgent, createCampaignWithLeads, login, setupAdmin, startTestServer, type TestServer } from './helpers.js';

let t: TestServer;
let admin: string;
let campaignId: number;
let listId: number;
let leadId: number;
let userSequence = 0;

beforeAll(async () => {
  t = await startTestServer();
  admin = await setupAdmin(t);
  const created = await createCampaignWithLeads(t, admin, { name: 'Tab permissions', activate: false });
  campaignId = created.campaignId;
  listId = created.listId;
  leadId = created.leads[0].id;
});

afterAll(async () => {
  await t.close();
});

async function customUser(permissions: Permission[]) {
  userSequence += 1;
  const role = await t.api('POST', '/api/roles', { name: `Tab role ${userSequence}`, permissions }, admin);
  const username = `tab-user-${userSequence}`;
  const user = await t.api('POST', '/api/users', {
    username,
    password: 'password123',
    displayName: `Tab User ${userSequence}`,
    roleKey: role.body.key,
  }, admin);
  await t.api('PUT', `/api/campaigns/${campaignId}/agents`, { userIds: [user.body.id] }, admin);
  return { user: user.body, token: await login(t, username, 'password123') };
}

const tabEndpoint: Record<keyof typeof CAMPAIGN_TAB_PERMISSIONS, (id: number) => string> = {
  overview: (id) => `/api/campaigns/${id}/overview`,
  lists: (id) => `/api/campaigns/${id}/lists`,
  leads: (id) => `/api/leads?campaignId=${id}`,
  agents: (id) => `/api/campaigns/${id}/agents`,
  settings: (id) => `/api/campaigns/${id}/settings`,
};

const tabDataPermissions: Record<keyof typeof CAMPAIGN_TAB_PERMISSIONS, Permission[]> = {
  overview: [],
  lists: ['campaigns.lists.view'],
  leads: ['campaigns.leads.view', 'campaigns.lists.view'],
  agents: ['campaigns.agents.view'],
  settings: [],
};

describe('campaign detail tab permissions', () => {
  for (const tab of Object.keys(CAMPAIGN_TAB_PERMISSIONS) as (keyof typeof CAMPAIGN_TAB_PERMISSIONS)[]) {
    it(`allows only the ${tab} tab data for a user with that single tab permission`, async () => {
      const { token } = await customUser([CAMPAIGN_TAB_PERMISSIONS[tab], ...tabDataPermissions[tab]]);

      const header = await t.api('GET', `/api/campaigns/${campaignId}`, undefined, token);
      expect(header.status).toBe(200);
      expect(header.body).toMatchObject({ id: campaignId, name: 'Tab permissions' });
      expect(header.body).not.toHaveProperty('dialMode');
      expect(header.body).not.toHaveProperty('agentIds');

      const campaigns = await t.api('GET', '/api/campaigns', undefined, token);
      expect(campaigns.status).toBe(200);
      expect(campaigns.body.map((campaign: any) => campaign.id)).toContain(campaignId);
      expect(campaigns.body[0]).not.toHaveProperty('dialMode');

      for (const other of Object.keys(CAMPAIGN_TAB_PERMISSIONS) as (keyof typeof CAMPAIGN_TAB_PERMISSIONS)[]) {
        const response = await t.api('GET', tabEndpoint[other](campaignId), undefined, token);
        const auxiliaryListsForLeads = tab === 'leads' && other === 'lists';
        expect(response.status, `${tab} user requesting ${other}`).toBe(other === tab || auxiliaryListsForLeads ? 200 : 403);
      }
    });
  }

  it('supports a subset of tabs and rejects an unassigned campaign', async () => {
    const { token } = await customUser([CAMPAIGN_TAB_PERMISSIONS.overview, CAMPAIGN_TAB_PERMISSIONS.leads, 'campaigns.leads.view']);
    expect((await t.api('GET', tabEndpoint.overview(campaignId), undefined, token)).status).toBe(200);
    expect((await t.api('GET', tabEndpoint.leads(campaignId), undefined, token)).status).toBe(200);
    expect((await t.api('GET', tabEndpoint.settings(campaignId), undefined, token)).status).toBe(403);

    const other = await createCampaignWithLeads(t, admin, { name: 'Not assigned', activate: false });
    expect((await t.api('GET', `/api/campaigns/${other.campaignId}`, undefined, token)).status).toBe(403);
    expect((await t.api('GET', tabEndpoint.overview(other.campaignId), undefined, token)).status).toBe(403);
  });

  it('does not let tab view permissions perform existing management, import, edit, assignment, or export actions', async () => {
    const permissions = Object.values(CAMPAIGN_TAB_PERMISSIONS);
    const { token } = await customUser(permissions);

    expect((await t.api('POST', `/api/campaigns/${campaignId}/status`, { status: 'active' }, token)).status).toBe(403);
    expect((await t.api('POST', `/api/campaigns/${campaignId}/lists`, { name: 'Denied' }, token)).status).toBe(403);
    expect((await t.upload(`/api/lists/${listId}/import/preview`, token, {}, { name: 'leads.csv', content: 'phone\n+14155550199' })).status).toBe(403);
    expect((await t.api('PATCH', `/api/leads/${leadId}`, { notes: 'Denied' }, token)).status).toBe(403);
    expect((await t.api('DELETE', `/api/leads/${leadId}`, undefined, token)).status).toBe(403);
    expect((await t.api('PUT', `/api/campaigns/${campaignId}/agents`, { userIds: [] }, token)).status).toBe(403);
    expect((await t.api('PATCH', `/api/campaigns/${campaignId}`, { description: 'Denied' }, token)).status).toBe(403);
    expect((await t.api('GET', `/api/reports/export/leads.csv?campaignId=${campaignId}`, undefined, token)).status).toBe(403);
  });

  it('keeps system role behavior and the agent-console campaign endpoint intact', async () => {
    const supervisor = await createAgent(t, admin, 'tab-supervisor', 'supervisor');
    await t.api('PUT', `/api/campaigns/${campaignId}/agents`, { userIds: [supervisor.user.id] }, admin);
    for (const endpoint of Object.values(tabEndpoint)) {
      expect((await t.api('GET', endpoint(campaignId), undefined, supervisor.token)).status).toBe(200);
    }

    const agent = await createAgent(t, admin, 'tab-agent', 'agent');
    await t.api('PUT', `/api/campaigns/${campaignId}/agents`, { userIds: [agent.user.id] }, admin);
    expect((await t.api('GET', `/api/campaigns/${campaignId}/work`, undefined, agent.token)).status).toBe(200);
    expect((await t.api('GET', `/api/campaigns/${campaignId}`, undefined, agent.token)).status).toBe(403);
  });
});
