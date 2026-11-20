import { Router } from 'express';
import { maskPhone } from '@opendialer/shared';
import { hasPermission, requirePermission } from '../auth.js';
import type { Ctx } from '../context.js';
import type { Engine } from '../engine.js';
import { wrap } from '../errors.js';
import { iterateCalls } from '../services/calls.js';
import { agentReport, campaignReport, dispositionReport, hourlyReport, toCsv, todaySummary } from '../services/reports.js';
import { tableWallboard } from '../services/phonePrivacy.js';

function range(q: Record<string, string | undefined>) {
  const from = q.from ? new Date(q.from) : undefined;
  const to = q.to ? new Date(q.to) : undefined;
  return {
    from: from && !Number.isNaN(from.getTime()) ? from.toISOString() : undefined,
    to: to && !Number.isNaN(to.getTime()) ? to.toISOString() : undefined,
  };
}

export function reportRoutes(ctx: Ctx, engine: Engine) {
  const r = Router();
  const { db } = ctx;

  r.get('/reports/summary', requirePermission('reports.view'), (_req, res) => res.json(todaySummary(db)));
  r.get('/reports/campaigns', requirePermission('reports.view'), wrap((req, res) => res.json(campaignReport(db, range(req.query as Record<string, string>)))));
  r.get('/reports/agents', requirePermission('reports.view'), wrap((req, res) => res.json(agentReport(db, range(req.query as Record<string, string>)))));
  r.get(
    '/reports/dispositions',
    requirePermission('reports.view'),
    wrap((req, res) => {
      const q = req.query as Record<string, string | undefined>;
      res.json(dispositionReport(db, range(q), q.campaignId ? Number(q.campaignId) : undefined));
    }),
  );
  r.get(
    '/reports/hourly',
    requirePermission('reports.view'),
    wrap((req, res) => {
      const q = req.query as Record<string, string | undefined>;
      res.json(hourlyReport(db, range(q), q.campaignId ? Number(q.campaignId) : undefined));
    }),
  );

  r.get(
    '/reports/export/calls.csv',
    requirePermission('calls.export'),
    wrap((req, res) => {
      const q = req.query as Record<string, string | undefined>;
      const showFull = hasPermission(req.user, 'leads.viewFullPhoneNumbers');
      const rows = iterateCalls(db, {
        ...range(q),
        campaignId: q.campaignId ? Number(q.campaignId) : undefined,
        userId: q.userId ? Number(q.userId) : undefined,
      }).map((c) => ({
        id: c.id,
        startedAt: c.startedAt,
        answeredAt: c.answeredAt ?? '',
        endedAt: c.endedAt ?? '',
        agent: c.agentName ?? '',
        campaign: c.campaignName ?? '',
        phone: showFull ? c.phone : maskPhone(c.phone),
        lead: c.leadName ?? '',
        result: c.result,
        disposition: c.dispositionCode ?? '',
        durationSec: c.durationSec,
        talkSec: c.talkSec,
        notes: c.notes,
        recording: c.hasRecording ? 'yes' : 'no',
      }));
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="calls-${new Date().toISOString().slice(0, 10)}.csv"`);
      res.send(
        toCsv(rows, ['id', 'startedAt', 'answeredAt', 'endedAt', 'agent', 'campaign', 'phone', 'lead', 'result', 'disposition', 'durationSec', 'talkSec', 'notes', 'recording']),
      );
    }),
  );

  r.get(
    '/reports/export/leads.csv',
    requirePermission('leads.export'),
    wrap((req, res) => {
      const q = req.query as Record<string, string | undefined>;
      const showFull = hasPermission(req.user, 'leads.viewFullPhoneNumbers');
      const where: string[] = [];
      const params: Record<string, unknown> = {};
      if (q.campaignId) (where.push('l.campaign_id = @campaignId'), (params.campaignId = Number(q.campaignId)));
      if (q.listId) (where.push('l.list_id = @listId'), (params.listId = Number(q.listId)));
      if (q.status) (where.push('l.status = @status'), (params.status = q.status));
      const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const rows = db
        .prepare(
          `SELECT l.id, l.phone, l.first_name, l.last_name, l.company, l.email, l.timezone, l.status, l.attempts, l.last_attempt_at, l.next_attempt_at,
             d.code AS last_disposition, l.priority, l.notes, l.custom, li.name AS list_name, c.name AS campaign_name
           FROM leads l LEFT JOIN dispositions d ON d.id = l.last_disposition_id
           LEFT JOIN lists li ON li.id = l.list_id LEFT JOIN campaigns c ON c.id = l.campaign_id ${w} ORDER BY l.id LIMIT 200000`,
        )
        .all(params) as Record<string, unknown>[];
      if (!showFull) for (const row of rows) row.phone = maskPhone(String(row.phone ?? ''));
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="leads-${new Date().toISOString().slice(0, 10)}.csv"`);
      res.send(
        toCsv(rows, [
          'id', 'phone', 'first_name', 'last_name', 'company', 'email', 'timezone', 'status', 'attempts', 'last_attempt_at',
          'next_attempt_at', 'last_disposition', 'priority', 'notes', 'custom', 'list_name', 'campaign_name',
        ]),
      );
    }),
  );

  r.get('/wallboard', requirePermission('dashboard.view'), (req, res) => res.json(
    tableWallboard(engine.snapshot(), hasPermission(req.user, 'leads.viewFullPhoneNumbers')),
  ));

  return r;
}
