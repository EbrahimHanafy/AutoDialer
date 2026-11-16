import { Router } from 'express';
import multer from 'multer';
import { CAMPAIGN_TAB_PERMISSIONS, importMappingSchema, leadCreateSchema, leadUpdateSchema, paginationSchema } from '@opendialer/shared';
import { hasPermission, requireAnyPermission, requirePermission } from '../auth.js';
import type { Ctx } from '../context.js';
import { badRequest, forbidden, idParam, parse, wrap } from '../errors.js';
import { audit } from '../services/audit.js';
import { listCalls } from '../services/calls.js';
import { isAgentOnCampaign } from '../services/campaigns.js';
import { getList } from '../services/lists.js';
import { createLead, deleteLead, getLead, guessMapping, importLeads, listLeads, parseCsvText, updateLead } from '../services/leads.js';
import { getSettings } from '../services/settings.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

export function leadRoutes(ctx: Ctx) {
  const r = Router();
  const { db } = ctx;
  const assertTabLeadAccess = (campaignId: number, userId: number) => {
    if (!isAgentOnCampaign(db, campaignId, userId, 'agent')) throw forbidden('Campaign is not assigned to this user');
  };

  r.get(
    '/leads',
    requireAnyPermission('leads.work', 'leads.manage', 'campaigns.leads.view'),
    wrap((req, res) => {
      const { page, pageSize } = parse(paginationSchema, req.query);
      const q = req.query as Record<string, string | undefined>;
      if (!hasPermission(req.user, 'leads.work') && !hasPermission(req.user, 'leads.manage')) {
        if (!hasPermission(req.user, CAMPAIGN_TAB_PERMISSIONS.leads)) throw forbidden('Insufficient permission');
        const campaignId = q.campaignId ? Number(q.campaignId) : q.listId ? getList(db, Number(q.listId)).campaignId : 0;
        if (!campaignId) throw forbidden('A campaign filter is required for campaign-tab access');
        assertTabLeadAccess(campaignId, req.user!.id);
      }
      res.json(
        listLeads(
          db,
          {
            campaignId: q.campaignId ? Number(q.campaignId) : undefined,
            listId: q.listId ? Number(q.listId) : undefined,
            status: q.status || undefined,
            q: q.q?.trim() || undefined,
          },
          page,
          pageSize,
        ),
      );
    }),
  );

  r.get(
    '/leads/:id',
    requireAnyPermission('leads.work', 'leads.manage', 'campaigns.leads.view'),
    wrap((req, res) => {
      const id = idParam(req);
      const lead = getLead(db, id);
      if (!hasPermission(req.user, 'leads.work') && !hasPermission(req.user, 'leads.manage')) {
        if (!hasPermission(req.user, CAMPAIGN_TAB_PERMISSIONS.leads)) throw forbidden('Insufficient permission');
        assertTabLeadAccess(lead.campaignId, req.user!.id);
      }
      const calls = listCalls(db, { leadId: id }, 1, 100).items;
      const callbacks = db.prepare('SELECT * FROM callbacks WHERE lead_id = ? ORDER BY scheduled_at DESC').all(id);
      res.json({ ...lead, calls, callbacks });
    }),
  );

  r.post(
    '/leads',
    requireAnyPermission('leads.work', 'leads.manage'),
    wrap((req, res) => {
      const input = parse(leadCreateSchema, req.body);
      const list = getList(db, input.listId);
      const lead = createLead(db, input, list.campaignId, getSettings(db).defaultCountry);
      audit(db, req.user!.id, 'lead.create', 'lead', lead.id);
      ctx.bus.emitDomain('leads.available', { campaignId: list.campaignId });
      res.status(201).json(lead);
    }),
  );

  r.patch(
    '/leads/:id',
    requireAnyPermission('leads.work', 'leads.manage'),
    wrap((req, res) => {
      const id = idParam(req);
      const patch = parse(leadUpdateSchema, req.body);
      // agents may only edit contact details / notes, not queue state
      if (!hasPermission(req.user, 'leads.manage') && (patch.status || patch.attempts !== undefined || patch.nextAttemptAt !== undefined)) {
        throw badRequest('Agents cannot change lead queue state');
      }
      const lead = updateLead(db, id, patch, getSettings(db).defaultCountry);
      audit(db, req.user!.id, 'lead.update', 'lead', id, Object.keys(patch));
      if (patch.status === 'new') ctx.bus.emitDomain('leads.available', { campaignId: lead.campaignId });
      res.json(lead);
    }),
  );

  r.delete(
    '/leads/:id',
    requirePermission('leads.manage'),
    wrap((req, res) => {
      const id = idParam(req);
      deleteLead(db, id);
      audit(db, req.user!.id, 'lead.delete', 'lead', id);
      res.json({ ok: true });
    }),
  );

  /** Step 1 of the import wizard: upload the CSV, get headers + a guessed mapping + a preview. */
  r.post(
    '/lists/:id/import/preview',
    requirePermission('campaigns.lists.import'),
    upload.single('file'),
    wrap((req, res) => {
      getList(db, idParam(req));
      const text = req.file ? req.file.buffer.toString('utf8') : typeof req.body?.csv === 'string' ? req.body.csv : '';
      if (!text.trim()) throw badRequest('No CSV data');
      const { headers, rows } = parseCsvText(text);
      res.json({ headers, mapping: guessMapping(headers), rows: rows.slice(0, 10), total: rows.length });
    }),
  );

  /** Step 2: import with a confirmed mapping (multipart "file" + "mapping" JSON, or JSON body {csv, mapping}). */
  r.post(
    '/lists/:id/import',
    requirePermission('campaigns.lists.import'),
    upload.single('file'),
    wrap((req, res) => {
      const listId = idParam(req);
      const list = getList(db, listId);
      const text = req.file ? req.file.buffer.toString('utf8') : typeof req.body?.csv === 'string' ? req.body.csv : '';
      if (!text.trim()) throw badRequest('No CSV data');
      const rawMapping = typeof req.body?.mapping === 'string' ? JSON.parse(req.body.mapping) : req.body?.mapping;
      const { headers, rows } = parseCsvText(text);
      const mapping = parse(importMappingSchema, rawMapping ?? guessMapping(headers));
      if (!headers.includes(mapping.phone)) throw badRequest(`Phone column "${mapping.phone}" not found in CSV`);
      const result = importLeads(db, listId, list.campaignId, rows, mapping, getSettings(db));
      audit(db, req.user!.id, 'leads.import', 'list', listId, { imported: result.imported, total: result.total });
      ctx.bus.emitDomain('leads.available', { campaignId: list.campaignId });
      res.json(result);
    }),
  );

  return r;
}
