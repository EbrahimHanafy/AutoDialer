import { Router, type Request } from 'express';
import { CAMPAIGN_TAB_PERMISSIONS, campaignAgentsSchema, campaignCreateSchema, campaignStatusUpdateSchema, campaignUpdateSchema, listCreateSchema, listUpdateSchema, type CampaignStatus, type Permission } from '@opendialer/shared';
import { hasPermission, requireAnyPermission, requirePermission } from '../auth.js';
import type { Ctx } from '../context.js';
import type { Engine } from '../engine.js';
import { forbidden, idParam, parse, wrap } from '../errors.js';
import { audit } from '../services/audit.js';
import {
  campaignStats,
  campaignsAssignedToUser,
  campaignsForUser,
  createCampaign,
  deleteCampaign,
  getCampaign,
  getCampaignAgentIds,
  isAgentOnCampaign,
  listCampaigns,
  resetLeads,
  setCampaignAgents,
  setCampaignStatus,
  updateCampaign,
} from '../services/campaigns.js';
import { createList, deleteList, getList, listLists, updateList } from '../services/lists.js';
import { findScript } from '../services/scripts.js';
import { listUsers } from '../services/users.js';

export function campaignRoutes(ctx: Ctx, engine: Engine) {
  const r = Router();
  const { db } = ctx;
  const tabPermissions = Object.values(CAMPAIGN_TAB_PERMISSIONS);
  const statusPermissions = {
    draft: 'campaigns.status.draft',
    active: 'campaigns.status.activate',
    paused: 'campaigns.status.pause',
    completed: 'campaigns.status.complete',
  } as const satisfies Record<CampaignStatus, Permission>;

  const onlineCount = (campaignId: number) => [...engine.sessions.values()].filter((s) => s.campaignId === campaignId).length;
  const assertCampaignAccess = (req: Request, campaignId: number) => {
    const user = req.user!;
    getCampaign(db, campaignId);
    if (!hasPermission(user, 'campaigns.view') && !isAgentOnCampaign(db, campaignId, user.id, 'agent')) throw forbidden('Campaign is not assigned to this user');
  };
  const header = (campaignId: number, includeAgentCount = false) => {
    const campaign = getCampaign(db, campaignId);
    return {
      id: campaign.id,
      name: campaign.name,
      status: campaign.status,
      createdAt: campaign.createdAt,
      updatedAt: campaign.updatedAt,
      ...(includeAgentCount ? { agentCount: getCampaignAgentIds(db, campaignId).length } : {}),
    };
  };

  r.get('/campaigns', requireAnyPermission('campaigns.work', 'campaigns.view', ...tabPermissions), (req, res) => {
    const u = req.user!;
    if (hasPermission(u, 'campaigns.view')) return res.json(listCampaigns(db));
    if (hasPermission(u, 'campaigns.work')) return res.json(campaignsForUser(db, u.id, 'agent'));
    res.json(campaignsAssignedToUser(db, u.id).map((campaign) => ({
      id: campaign.id,
      name: campaign.name,
      status: campaign.status,
      createdAt: campaign.createdAt,
      updatedAt: campaign.updatedAt,
    })));
  });

  /** Full campaign data used by the agent console, kept separate from administration tabs. */
  r.get(
    '/campaigns/:id/work',
    requirePermission('campaigns.work'),
    wrap((req, res) => {
      const id = idParam(req);
      const c = getCampaign(db, id);
      if (!isAgentOnCampaign(db, id, req.user!.id, req.user!.role)) throw forbidden('Campaign is not assigned to this user');
      res.json({ ...c, script: findScript(db, c.scriptId), agentIds: getCampaignAgentIds(db, c.id) });
    }),
  );

  /** Common header data; tab-specific content is served by the endpoints below. */
  r.get('/campaigns/:id', requireAnyPermission(...tabPermissions), wrap((req, res) => {
    const id = idParam(req);
    assertCampaignAccess(req, id);
    res.json(header(id, hasPermission(req.user, CAMPAIGN_TAB_PERMISSIONS.agents) && hasPermission(req.user, 'campaigns.agents.view')));
  }));

  r.get('/campaigns/:id/overview', requirePermission(CAMPAIGN_TAB_PERMISSIONS.overview), wrap((req, res) => {
    const id = idParam(req);
    assertCampaignAccess(req, id);
    const campaign = getCampaign(db, id);
    res.json({ campaign, script: findScript(db, campaign.scriptId) });
  }));

  r.get('/campaigns/:id/stats', requirePermission(CAMPAIGN_TAB_PERMISSIONS.overview), wrap((req, res) => {
    const id = idParam(req);
    assertCampaignAccess(req, id);
    res.json(campaignStats(db, id, onlineCount(id)));
  }));

  r.get('/campaigns/:id/agents', requirePermission(CAMPAIGN_TAB_PERMISSIONS.agents), wrap((req, res) => {
    const id = idParam(req);
    if (!hasPermission(req.user, 'campaigns.agents.view')) throw forbidden('Insufficient permission');
    assertCampaignAccess(req, id);
    res.json({
      agentIds: getCampaignAgentIds(db, id),
      agents: listUsers(db).filter((user) => hasPermission(user, 'agent.use')),
    });
  }));

  r.get('/campaigns/:id/settings', requirePermission(CAMPAIGN_TAB_PERMISSIONS.settings), wrap((req, res) => {
    const id = idParam(req);
    assertCampaignAccess(req, id);
    const campaign = getCampaign(db, id);
    res.json({ campaign, script: findScript(db, campaign.scriptId) });
  }));

  r.post(
    '/campaigns',
    requirePermission('campaigns.create'),
    wrap((req, res) => {
      const c = createCampaign(db, parse(campaignCreateSchema, req.body));
      audit(db, req.user!.id, 'campaign.create', 'campaign', c.id, { name: c.name });
      res.status(201).json(c);
    }),
  );

  r.patch(
    '/campaigns/:id',
    requirePermission('campaigns.edit'),
    wrap((req, res) => {
      const id = idParam(req);
      const patch = parse(campaignUpdateSchema, req.body);
      const c = updateCampaign(db, id, patch);
      audit(db, req.user!.id, 'campaign.update', 'campaign', id, Object.keys(patch));
      ctx.bus.emitDomain('leads.available', { campaignId: id });
      res.json(c);
    }),
  );

  r.post(
    '/campaigns/:id/status',
    requireAnyPermission(...Object.values(statusPermissions)),
    wrap((req, res) => {
      const id = idParam(req);
      const { status } = parse(campaignStatusUpdateSchema, req.body);
      if (!hasPermission(req.user, statusPermissions[status])) throw forbidden('Insufficient permission');
      const c = setCampaignStatus(db, id, status);
      audit(db, req.user!.id, 'campaign.status', 'campaign', id, { status });
      ctx.bus.emitDomain('campaign.status', { campaignId: id, status });
      res.json(c);
    }),
  );

  r.put(
    '/campaigns/:id/agents',
    requireAnyPermission('campaigns.agents.assign', 'campaigns.agents.unassign'),
    wrap((req, res) => {
      const id = idParam(req);
      const { userIds } = parse(campaignAgentsSchema, req.body);
      const current = new Set(getCampaignAgentIds(db, id));
      const requested = new Set(userIds);
      const assigns = userIds.filter((userId) => !current.has(userId));
      const unassigns = [...current].filter((userId) => !requested.has(userId));
      if (assigns.length && !hasPermission(req.user, 'campaigns.agents.assign')) throw forbidden('Insufficient permission to assign agents');
      if (unassigns.length && !hasPermission(req.user, 'campaigns.agents.unassign')) throw forbidden('Insufficient permission to unassign agents');
      res.json({ agentIds: setCampaignAgents(db, id, userIds) });
      audit(db, req.user!.id, 'campaign.agents', 'campaign', id, { userIds, assigns, unassigns });
    }),
  );

  r.post(
    '/campaigns/:id/reset-leads',
    requirePermission('campaigns.leads.reset'),
    wrap((req, res) => {
      const id = idParam(req);
      const listId = req.body?.listId ? Number(req.body.listId) : undefined;
      const onlyStatus = Array.isArray(req.body?.onlyStatus) ? (req.body.onlyStatus as string[]) : undefined;
      const changed = resetLeads(db, id, { listId, onlyStatus });
      audit(db, req.user!.id, 'campaign.reset', 'campaign', id, { changed, listId, onlyStatus });
      ctx.bus.emitDomain('leads.available', { campaignId: id });
      res.json({ changed });
    }),
  );

  r.delete(
    '/campaigns/:id',
    requirePermission('campaigns.delete'),
    wrap((req, res) => {
      const id = idParam(req);
      deleteCampaign(db, id);
      audit(db, req.user!.id, 'campaign.delete', 'campaign', id);
      res.json({ ok: true });
    }),
  );

  /* ---------- lists ---------- */

  r.get(
    '/campaigns/:id/lists',
    requireAnyPermission('campaigns.work', CAMPAIGN_TAB_PERMISSIONS.lists, CAMPAIGN_TAB_PERMISSIONS.leads),
    wrap((req, res) => {
      const id = idParam(req);
      if (!hasPermission(req.user, 'campaigns.work') && !hasPermission(req.user, 'campaigns.lists.view')) throw forbidden('Insufficient permission');
      assertCampaignAccess(req, id);
      res.json(listLists(db, id));
    }),
  );

  r.post(
    '/campaigns/:id/lists',
    requirePermission('campaigns.lists.create'),
    wrap((req, res) => {
      const id = idParam(req);
      getCampaign(db, id);
      const l = createList(db, id, parse(listCreateSchema, req.body));
      audit(db, req.user!.id, 'list.create', 'list', l.id, { name: l.name, campaignId: id });
      res.status(201).json(l);
    }),
  );

  r.get(
    '/lists/:id',
    requireAnyPermission('campaigns.work', CAMPAIGN_TAB_PERMISSIONS.lists, CAMPAIGN_TAB_PERMISSIONS.leads),
    wrap((req, res) => {
      const list = getList(db, idParam(req));
      if (!hasPermission(req.user, 'campaigns.work') && !hasPermission(req.user, 'campaigns.lists.view')) throw forbidden('Insufficient permission');
      assertCampaignAccess(req, list.campaignId);
      res.json(list);
    }),
  );

  r.patch(
    '/lists/:id',
    requirePermission('campaigns.lists.edit'),
    wrap((req, res) => {
      const id = idParam(req);
      const l = updateList(db, id, parse(listUpdateSchema, req.body));
      audit(db, req.user!.id, 'list.update', 'list', id);
      ctx.bus.emitDomain('leads.available', { campaignId: l.campaignId });
      res.json(l);
    }),
  );

  r.delete(
    '/lists/:id',
    requirePermission('campaigns.lists.delete'),
    wrap((req, res) => {
      const id = idParam(req);
      deleteList(db, id);
      audit(db, req.user!.id, 'list.delete', 'list', id);
      res.json({ ok: true });
    }),
  );

  return r;
}
