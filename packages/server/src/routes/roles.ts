import { Router } from 'express';
import { customRoleCreateSchema, customRoleUpdateSchema, type Permission, type Role } from '@opendialer/shared';
import { requirePermission, requireSystemAdmin } from '../auth.js';
import type { Ctx } from '../context.js';
import { badRequest, notFound, parse, wrap } from '../errors.js';
import { audit } from '../services/audit.js';
import { createCustomRole, deleteCustomRole, listRoles, parseCustomRoleKey, updateCustomRole, updateSystemRolePermission } from '../services/roles.js';

export function roleRoutes(ctx: Ctx) {
  const r = Router();
  const { db } = ctx;

  r.get('/roles', requirePermission('users.manage'), (_req, res) => res.json(listRoles(db)));
  r.post('/roles', requireSystemAdmin(), wrap((req, res) => {
    const role = createCustomRole(db, parse(customRoleCreateSchema, req.body));
    audit(db, req.user!.id, 'role.create', 'role', role.id, { name: role.name, permissions: role.permissions });
    res.status(201).json(role);
  }));
  r.patch('/roles/:key', requireSystemAdmin(), wrap((req, res) => {
    const id = parseCustomRoleKey(req.params.key);
    const role = updateCustomRole(db, id, parse(customRoleUpdateSchema, req.body));
    audit(db, req.user!.id, 'role.update', 'role', id, { permissions: role.permissions });
    ctx.bus.emitDomain('roles.changed', { roleKey: role.key });
    res.json(role);
  }));
  r.patch('/roles/:key/permissions/:permission', requireSystemAdmin(), wrap((req, res) => {
    const match = /^system:(admin|supervisor|agent)$/.exec(req.params.key);
    if (!match) throw notFound('System role');
    if (typeof req.body?.enabled !== 'boolean') throw badRequest('enabled must be a boolean');
    const role = updateSystemRolePermission(db, match[1] as Role, req.params.permission as Permission, req.body.enabled);
    audit(db, req.user!.id, 'role.permission.update', 'role', role.key, { permission: req.params.permission, enabled: req.body.enabled });
    ctx.bus.emitDomain('roles.changed', { roleKey: role.key });
    res.json(role);
  }));
  r.delete('/roles/:key', requireSystemAdmin(), wrap((req, res) => {
    const id = parseCustomRoleKey(req.params.key);
    deleteCustomRole(db, id);
    audit(db, req.user!.id, 'role.delete', 'role', id);
    ctx.bus.emitDomain('roles.changed', { roleKey: `custom:${id}` });
    res.json({ ok: true });
  }));
  return r;
}

