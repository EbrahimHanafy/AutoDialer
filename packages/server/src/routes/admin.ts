import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { apiKeyCreateSchema, paginationSchema, webhookCreateSchema, webhookUpdateSchema, WEBHOOK_EVENTS } from '@opendialer/shared';
import { hasPermission, requirePermission } from '../auth.js';
import type { Ctx } from '../context.js';
import type { Engine } from '../engine.js';
import { idParam, notFound, parse, wrap } from '../errors.js';
import { createApiKey, deleteApiKey, listApiKeys } from '../services/apikeys.js';
import { audit, listAudit } from '../services/audit.js';
import { createWebhook, deleteWebhook, deliver, getWebhook, listWebhooks, updateWebhook } from '../services/webhooks.js';
import { tableAgent, tableAuditPage } from '../services/phonePrivacy.js';

export function adminRoutes(ctx: Ctx, engine: Engine) {
  const r = Router();
  const { db } = ctx;

  /* ---------- webhooks ---------- */
  r.get('/webhooks', requirePermission('integrations.manage'), (_req, res) => res.json({ items: listWebhooks(db), events: WEBHOOK_EVENTS }));
  r.post(
    '/webhooks',
    requirePermission('integrations.manage'),
    wrap((req, res) => {
      const h = createWebhook(db, parse(webhookCreateSchema, req.body));
      audit(db, req.user!.id, 'webhook.create', 'webhook', h.id, { url: h.url });
      res.status(201).json(h);
    }),
  );
  r.patch(
    '/webhooks/:id',
    requirePermission('integrations.manage'),
    wrap((req, res) => {
      const id = idParam(req);
      const h = updateWebhook(db, id, parse(webhookUpdateSchema, req.body));
      audit(db, req.user!.id, 'webhook.update', 'webhook', id);
      res.json(h);
    }),
  );
  r.delete(
    '/webhooks/:id',
    requirePermission('integrations.manage'),
    wrap((req, res) => {
      const id = idParam(req);
      deleteWebhook(db, id);
      audit(db, req.user!.id, 'webhook.delete', 'webhook', id);
      res.json({ ok: true });
    }),
  );
  r.post(
    '/webhooks/:id/test',
    requirePermission('integrations.manage'),
    wrap(async (req, res) => {
      const h = getWebhook(db, idParam(req));
      const ok = await deliver(h, 'test', { message: 'OpenDialer webhook test', by: req.user!.username }, ctx.log);
      res.json({ ok });
    }),
  );

  /* ---------- API keys ---------- */
  r.get('/api-keys', requirePermission('integrations.manage'), (_req, res) => res.json(listApiKeys(db)));
  r.post(
    '/api-keys',
    requirePermission('integrations.manage'),
    wrap((req, res) => {
      const { name } = parse(apiKeyCreateSchema, req.body);
      const { key, plaintext } = createApiKey(db, name);
      audit(db, req.user!.id, 'apikey.create', 'apikey', key.id, { name });
      res.status(201).json({ ...key, plaintext });
    }),
  );
  r.delete(
    '/api-keys/:id',
    requirePermission('integrations.manage'),
    wrap((req, res) => {
      const id = idParam(req);
      deleteApiKey(db, id);
      audit(db, req.user!.id, 'apikey.delete', 'apikey', id);
      res.json({ ok: true });
    }),
  );

  /* ---------- audit ---------- */
  r.get(
    '/audit',
    requirePermission('audit.view'),
    wrap((req, res) => {
      const { page, pageSize } = parse(paginationSchema, req.query);
      const q = req.query as Record<string, string | undefined>;
      res.json(tableAuditPage(
        listAudit(db, page, pageSize, { entity: q.entity || undefined, userId: q.userId ? Number(q.userId) : undefined }),
        hasPermission(req.user, 'leads.viewFullPhoneNumbers'),
      ));
    }),
  );

  /* ---------- agents (supervisor control) ---------- */
  r.get('/agents', requirePermission('dashboard.view'), (req, res) => res.json(
    engine.snapshot().agents.map((agent) => tableAgent(agent, hasPermission(req.user, 'leads.viewFullPhoneNumbers'))),
  ));
  r.post(
    '/agents/:id/logout',
    requirePermission('dashboard.view'),
    wrap((req, res) => {
      const id = idParam(req);
      if (!engine.getSession(id)) throw notFound('Agent session');
      engine.leave(id);
      audit(db, req.user!.id, 'agent.force_logout', 'user', id);
      res.json({ ok: true });
    }),
  );

  /* ---------- backup & health ---------- */
  r.post(
    '/admin/backup',
    requirePermission('system.manage'),
    wrap(async (req, res) => {
      const dir = path.join(ctx.config.dataDir, 'backups');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `opendialer-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`);
      await db.backup(file);
      audit(db, req.user!.id, 'backup', 'db', null, { file: path.basename(file) });
      res.json({ ok: true, file: path.basename(file), bytes: fs.statSync(file).size });
    }),
  );
  r.get('/admin/backups', requirePermission('system.manage'), (_req, res) => {
    const dir = path.join(ctx.config.dataDir, 'backups');
    const files = fs.existsSync(dir)
      ? fs
          .readdirSync(dir)
          .filter((f) => f.endsWith('.sqlite'))
          .map((f) => ({ file: f, bytes: fs.statSync(path.join(dir, f)).size, at: fs.statSync(path.join(dir, f)).mtime.toISOString() }))
          .sort((a, b) => (a.at < b.at ? 1 : -1))
      : [];
    res.json(files);
  });
  r.get(
    '/admin/backups/:file',
    requirePermission('backups.export'),
    wrap((req, res) => {
      const name = path.basename(String(req.params.file));
      const file = path.join(ctx.config.dataDir, 'backups', name);
      if (!name.endsWith('.sqlite') || !fs.existsSync(file)) throw notFound('Backup');
      res.download(file, name);
    }),
  );

  r.get('/admin/system', requirePermission('system.manage'), (_req, res) => {
    const dbFile = path.join(ctx.config.dataDir, 'opendialer.sqlite');
    res.json({
      version: ctx.config.version,
      node: process.version,
      uptimeSec: Math.round(process.uptime()),
      dataDir: ctx.config.dataDir,
      dbBytes: fs.existsSync(dbFile) ? fs.statSync(dbFile).size : 0,
      agentsOnline: engine.sessions.size,
      memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    });
  });

  return r;
}
