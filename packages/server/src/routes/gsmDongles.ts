import { Router } from 'express';
import { requirePermission } from '../auth.js';
import type { GsmDongleMonitor } from '../services/gsmDongles.js';

export function gsmDongleRoutes(monitor: GsmDongleMonitor) {
  const router = Router();
  router.get('/gsm-dongles', requirePermission('dashboard.view_gsm_dongles'), (_req, res) => res.json(monitor.getSnapshot()));
  return router;
}
