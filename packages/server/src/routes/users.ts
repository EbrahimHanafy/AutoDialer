import { Router } from 'express';
import { userCreateSchema, userUpdateSchema } from '@opendialer/shared';
import { hasPermission, isSystemAdmin, requirePermission } from '../auth.js';
import type { Ctx } from '../context.js';
import { conflict, forbidden, idParam, parse, wrap } from '../errors.js';
import { audit } from '../services/audit.js';
import { createUser, deleteUser, getUser, listUsers, updateUser } from '../services/users.js';

export function userRoutes(ctx: Ctx) {
  const r = Router();
  const { db } = ctx;

  // supervisors need the list to assign agents to campaigns / read reports
  r.get('/users', requirePermission('users.view'), (_req, res) => res.json(listUsers(db)));

  r.get(
    '/users/:id',
    requirePermission('users.view'),
    wrap((req, res) => res.json(getUser(db, idParam(req), hasPermission(req.user, 'users.manage')))),
  );

  r.post(
    '/users',
    requirePermission('users.manage'),
    wrap((req, res) => {
      const input = parse(userCreateSchema, req.body);
      const roleKey = input.roleKey ?? `system:${input.role}`;
      if (roleKey === 'system:admin' && !isSystemAdmin(req.user)) throw forbidden('Only a system administrator can assign the Admin role');
      const user = createUser(db, input);
      audit(db, req.user!.id, 'user.create', 'user', user.id, { username: user.username, role: user.role });
      res.status(201).json(user);
    }),
  );

  r.patch(
    '/users/:id',
    requirePermission('users.manage'),
    wrap((req, res) => {
      const id = idParam(req);
      const patch = parse(userUpdateSchema, req.body);
      const roleKey = patch.roleKey ?? (patch.role ? `system:${patch.role}` : undefined);
      const target = getUser(db, id);
      if (!isSystemAdmin(req.user) && (target.roleKey === 'system:admin' || roleKey === 'system:admin')) throw forbidden('Only a system administrator can manage Admin users');
      if (id === req.user!.id && (roleKey && roleKey !== 'system:admin' || patch.active === false)) {
        throw conflict('You cannot demote or deactivate yourself');
      }
      const user = updateUser(db, id, patch);
      audit(db, req.user!.id, 'user.update', 'user', id, Object.keys(patch));
      res.json(user);
    }),
  );

  r.delete(
    '/users/:id',
    requirePermission('users.manage'),
    wrap((req, res) => {
      const id = idParam(req);
      if (id === req.user!.id) throw conflict('You cannot delete yourself');
      if (!isSystemAdmin(req.user) && getUser(db, id).roleKey === 'system:admin') throw forbidden('Only a system administrator can manage Admin users');
      const result = deleteUser(db, id);
      audit(db, req.user!.id, 'user.delete', 'user', id, result);
      res.json(result);
    }),
  );

  return r;
}
