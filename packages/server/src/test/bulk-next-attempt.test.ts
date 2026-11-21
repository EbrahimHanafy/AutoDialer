import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCampaignWithLeads, setupAdmin, startTestServer, type TestServer } from './helpers.js';

let t: TestServer;
let admin: string;

beforeAll(async () => {
  t = await startTestServer();
  admin = await setupAdmin(t);
});

afterAll(async () => {
  await t.close();
});

describe('bulk next-attempt updates', () => {
  it('enforces the independent permission and updates only selected leads', async () => {
    const { leads } = await createCampaignWithLeads(t, admin, { activate: false });
    const individualAt = '2026-12-01T09:30:00.000Z';

    // Existing individual queue editing still uses leads.manage, not the new permission.
    const individual = await t.api('PATCH', `/api/leads/${leads[2].id}`, { nextAttemptAt: individualAt }, admin);
    expect(individual.status).toBe(200);
    expect(individual.body.nextAttemptAt).toBe(individualAt);

    const denied = await t.api('PATCH', '/api/leads/bulk/next-attempt', {
      leadIds: [leads[0].id, leads[1].id], nextAttemptAt: '2026-12-02T10:45:00.000Z',
    }, admin);
    expect(denied.status).toBe(403);

    const granted = await t.api(
      'PATCH', '/api/roles/system:admin/permissions/leads.bulkEditNextAttempt', { enabled: true }, admin,
    );
    expect(granted.status).toBe(200);
    expect(granted.body.permissions).toContain('leads.bulkEditNextAttempt');

    const nextAttemptAt = '2026-12-02T10:45:00.000Z';
    const updated = await t.api('PATCH', '/api/leads/bulk/next-attempt', {
      leadIds: [leads[0].id, leads[1].id], nextAttemptAt,
    }, admin);
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({ successCount: 2, failureCount: 0, updatedLeadIds: [leads[0].id, leads[1].id], failures: [] });

    const first = await t.api('GET', `/api/leads/${leads[0].id}`, undefined, admin);
    const second = await t.api('GET', `/api/leads/${leads[1].id}`, undefined, admin);
    const unselected = await t.api('GET', `/api/leads/${leads[2].id}`, undefined, admin);
    expect(first.body.nextAttemptAt).toBe(nextAttemptAt);
    expect(second.body.nextAttemptAt).toBe(nextAttemptAt);
    expect(unselected.body.nextAttemptAt).toBe(individualAt);
    expect(first.body.firstName).toBe(leads[0].firstName);
    expect(first.body.status).toBe(leads[0].status);
    expect(first.body.attempts).toBe(leads[0].attempts);

    const revoked = await t.api(
      'PATCH', '/api/roles/system:admin/permissions/leads.bulkEditNextAttempt', { enabled: false }, admin,
    );
    expect(revoked.status).toBe(200);
    expect((await t.api('PATCH', '/api/leads/bulk/next-attempt', {
      leadIds: [leads[0].id], nextAttemptAt: null,
    }, admin)).status).toBe(403);
  });

  it('validates the request and reports partial failures accurately', async () => {
    const { leads } = await createCampaignWithLeads(t, admin, { name: 'Partial bulk update', activate: false });
    await t.api('PATCH', '/api/roles/system:admin/permissions/leads.bulkEditNextAttempt', { enabled: true }, admin);

    expect((await t.api('PATCH', '/api/leads/bulk/next-attempt', {
      leadIds: [], nextAttemptAt: 'not-a-date',
    }, admin)).status).toBe(400);
    expect((await t.api('PATCH', '/api/leads/bulk/next-attempt', {
      leadIds: [leads[0].id, leads[0].id], nextAttemptAt: null,
    }, admin)).status).toBe(400);

    const missingId = 999_999;
    const partial = await t.api('PATCH', '/api/leads/bulk/next-attempt', {
      leadIds: [leads[0].id, missingId], nextAttemptAt: null,
    }, admin);
    expect(partial.status).toBe(200);
    expect(partial.body).toEqual({
      successCount: 1,
      failureCount: 1,
      updatedLeadIds: [leads[0].id],
      failures: [{ leadId: missingId, error: 'Lead not found' }],
    });
  });
});

describe('bulk lead-status updates', () => {
  it('enforces its independent permission and preserves individual status editing', async () => {
    const { leads } = await createCampaignWithLeads(t, admin, { name: 'Bulk status permission', activate: false });

    const individual = await t.api('PATCH', `/api/leads/${leads[2].id}`, { status: 'done' }, admin);
    expect(individual.status).toBe(200);
    expect(individual.body.status).toBe('done');

    const denied = await t.api('PATCH', '/api/leads/bulk/status', {
      leadIds: [leads[0].id, leads[1].id], status: 'invalid',
    }, admin);
    expect(denied.status).toBe(403);

    const granted = await t.api(
      'PATCH', '/api/roles/system:admin/permissions/leads.bulkEditStatus', { enabled: true }, admin,
    );
    expect(granted.status).toBe(200);
    expect(granted.body.permissions).toContain('leads.bulkEditStatus');

    const updated = await t.api('PATCH', '/api/leads/bulk/status', {
      leadIds: [leads[0].id, leads[1].id], status: 'invalid',
    }, admin);
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({ successCount: 2, failureCount: 0, updatedLeadIds: [leads[0].id, leads[1].id], failures: [] });

    const first = await t.api('GET', `/api/leads/${leads[0].id}`, undefined, admin);
    const second = await t.api('GET', `/api/leads/${leads[1].id}`, undefined, admin);
    const unselected = await t.api('GET', `/api/leads/${leads[2].id}`, undefined, admin);
    expect(first.body.status).toBe('invalid');
    expect(second.body.status).toBe('invalid');
    expect(unselected.body.status).toBe('done');
    expect(first.body.firstName).toBe(leads[0].firstName);
    expect(first.body.attempts).toBe(leads[0].attempts);

    const revoked = await t.api(
      'PATCH', '/api/roles/system:admin/permissions/leads.bulkEditStatus', { enabled: false }, admin,
    );
    expect(revoked.status).toBe(200);
    expect((await t.api('PATCH', '/api/leads/bulk/status', {
      leadIds: [leads[0].id], status: 'new',
    }, admin)).status).toBe(403);
  });

  it('validates status changes and reports partial failures', async () => {
    const { leads } = await createCampaignWithLeads(t, admin, { name: 'Partial status update', activate: false });
    await t.api('PATCH', '/api/roles/system:admin/permissions/leads.bulkEditStatus', { enabled: true }, admin);

    expect((await t.api('PATCH', '/api/leads/bulk/status', {
      leadIds: [leads[0].id], status: 'unknown',
    }, admin)).status).toBe(400);

    const missingId = 999_998;
    const partial = await t.api('PATCH', '/api/leads/bulk/status', {
      leadIds: [leads[0].id, missingId], status: 'done',
    }, admin);
    expect(partial.status).toBe(200);
    expect(partial.body).toEqual({
      successCount: 1,
      failureCount: 1,
      updatedLeadIds: [leads[0].id],
      failures: [{ leadId: missingId, error: 'Lead not found' }],
    });
  });
});
