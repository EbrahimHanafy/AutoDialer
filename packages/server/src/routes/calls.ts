import fs from 'node:fs';
import { Router } from 'express';
import multer from 'multer';
import { callbackUpdateSchema, paginationSchema } from '@opendialer/shared';
import { hasPermission, requireAnyPermission } from '../auth.js';
import type { Ctx } from '../context.js';
import { badRequest, forbidden, idParam, parse, wrap } from '../errors.js';
import { audit } from '../services/audit.js';
import { getCallback, listCallbacks, updateCallback } from '../services/callbacks.js';
import { getCall, listCalls, recordingFile, saveRecording } from '../services/calls.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });

export function callRoutes(ctx: Ctx) {
  const r = Router();
  const { db } = ctx;

  r.get(
    '/calls',
    requireAnyPermission('calls.own', 'calls.manage'),
    wrap((req, res) => {
      const { page, pageSize } = parse(paginationSchema, req.query);
      const q = req.query as Record<string, string | undefined>;
      const u = req.user!;
      res.json(
        listCalls(
          db,
          {
            campaignId: q.campaignId ? Number(q.campaignId) : undefined,
            // agents only see their own calls
            userId: hasPermission(u, 'calls.manage') ? (q.userId ? Number(q.userId) : undefined) : u.id,
            leadId: q.leadId ? Number(q.leadId) : undefined,
            from: q.from || undefined,
            to: q.to || undefined,
            result: q.result || undefined,
            dispositionId: q.dispositionId ? Number(q.dispositionId) : undefined,
            phone: q.phone || undefined,
          },
          page,
          pageSize,
        ),
      );
    }),
  );

  r.get(
    '/calls/:id',
    requireAnyPermission('calls.own', 'calls.manage'),
    wrap((req, res) => {
      const call = getCall(db, idParam(req));
      if (!hasPermission(req.user, 'calls.manage') && call.userId !== req.user!.id) throw forbidden();
      res.json(call);
    }),
  );

  /** Upload the browser-side recording for a call (multipart "file"). */
  r.post(
    '/calls/:id/recording',
    requireAnyPermission('calls.own', 'calls.manage'),
    upload.single('file'),
    wrap((req, res) => {
      const id = idParam(req);
      const call = getCall(db, id);
      if (!hasPermission(req.user, 'calls.manage') && call.userId !== req.user!.id) throw forbidden();
      if (!req.file || !req.file.buffer.length) throw badRequest('No audio uploaded');
      const rel = saveRecording(db, ctx.config.dataDir, id, req.file.buffer, req.file.mimetype || 'audio/webm');
      audit(db, req.user!.id, 'recording.upload', 'call', id, { bytes: req.file.size });
      res.status(201).json({ ok: true, path: rel });
    }),
  );

  r.get(
    '/calls/:id/recording',
    requireAnyPermission('calls.own', 'calls.manage'),
    wrap((req, res) => {
      const id = idParam(req);
      const call = getCall(db, id);
      if (!hasPermission(req.user, 'calls.manage') && call.userId !== req.user!.id) throw forbidden();
      const rec = recordingFile(db, ctx.config.dataDir, id);
      if (!rec) return res.status(404).json({ error: 'No recording' });
      const stat = fs.statSync(rec.file);
      res.setHeader('Content-Type', rec.mime);
      res.setHeader('Content-Length', stat.size);
      res.setHeader('Content-Disposition', `inline; filename="call-${id}.${rec.file.split('.').pop()}"`);
      fs.createReadStream(rec.file).pipe(res);
    }),
  );

  /* ---------- callbacks ---------- */

  r.get(
    '/callbacks',
    requireAnyPermission('callbacks.own', 'callbacks.manage'),
    wrap((req, res) => {
      const q = req.query as Record<string, string | undefined>;
      const u = req.user!;
      const mine = q.scope !== 'all' || !hasPermission(u, 'callbacks.manage');
      res.json(
        listCallbacks(db, {
          userId: mine ? u.id : q.userId ? Number(q.userId) : undefined,
          mine,
          status: q.status ?? 'pending',
          campaignId: q.campaignId ? Number(q.campaignId) : undefined,
        }),
      );
    }),
  );

  r.get('/callbacks/:id', requireAnyPermission('callbacks.own', 'callbacks.manage'), wrap((req, res) => res.json(getCallback(db, idParam(req)))));

  r.patch(
    '/callbacks/:id',
    requireAnyPermission('callbacks.own', 'callbacks.manage'),
    wrap((req, res) => {
      const id = idParam(req);
      const existing = getCallback(db, id);
      const u = req.user!;
      if (!hasPermission(u, 'callbacks.manage') && existing.userId !== null && existing.userId !== u.id) throw forbidden('Not your callback');
      const patch = parse(callbackUpdateSchema, req.body);
      if (!hasPermission(u, 'callbacks.manage') && patch.userId !== undefined && patch.userId !== u.id && patch.userId !== null) throw forbidden('You cannot reassign callbacks');
      const cb = updateCallback(db, id, patch);
      audit(db, u.id, 'callback.update', 'callback', id, Object.keys(patch));
      ctx.bus.emitDomain('leads.available', { campaignId: cb.campaignId });
      res.json(cb);
    }),
  );

  return r;
}
