import { SYSTEM_ROLE_PERMISSIONS, type Permission, type Role, type User, type UserCreateInput, type UserUpdateInput } from '@opendialer/shared';
import type { DB } from '../db.js';
import { buildSet, fromBool } from '../db.js';
import { hashPassword } from '../auth.js';
import { conflict, notFound } from '../errors.js';
import { parsePermissions, resolveRoleKey } from './roles.js';

export interface UserRow {
  id: number;
  username: string;
  display_name: string;
  password_hash: string;
  role: Role;
  custom_role_id: number | null;
  custom_role_name?: string | null;
  custom_role_permissions?: string | null;
  active: number;
  sip_username: string | null;
  sip_auth_username: string | null;
  sip_password: string | null;
  created_at: string;
}

export function mapUser(r: UserRow, includeSipPassword = false): User {
  const custom = r.custom_role_id != null;
  const permissions: Permission[] = custom ? parsePermissions(r.custom_role_permissions) : [...SYSTEM_ROLE_PERMISSIONS[r.role]];
  return {
    id: r.id,
    username: r.username,
    displayName: r.display_name,
    role: r.role,
    customRoleId: r.custom_role_id,
    roleKey: custom ? `custom:${r.custom_role_id}` : `system:${r.role}`,
    roleName: custom ? r.custom_role_name ?? 'Custom role' : r.role === 'admin' ? 'Admin' : r.role === 'supervisor' ? 'Supervisor' : 'Agent',
    permissions,
    active: fromBool(r.active),
    sipUsername: r.sip_username,
    sipAuthUsername: r.sip_auth_username,
    ...(includeSipPassword ? { sipPassword: r.sip_password } : {}),
    createdAt: r.created_at,
  };
}

export function listUsers(db: DB): User[] {
  return (db.prepare(`SELECT u.*, cr.name AS custom_role_name, cr.permissions AS custom_role_permissions
                        FROM users u LEFT JOIN custom_roles cr ON cr.id = u.custom_role_id
                       ORDER BY u.role, u.username`).all() as UserRow[]).map((r) => mapUser(r));
}

export function getUserRow(db: DB, id: number): UserRow | undefined {
  return db.prepare(`SELECT u.*, cr.name AS custom_role_name, cr.permissions AS custom_role_permissions
                       FROM users u LEFT JOIN custom_roles cr ON cr.id = u.custom_role_id WHERE u.id = ?`).get(id) as UserRow | undefined;
}

export function getUser(db: DB, id: number, includeSipPassword = false): User {
  const r = getUserRow(db, id);
  if (!r) throw notFound('User');
  return mapUser(r, includeSipPassword);
}

export function findByUsername(db: DB, username: string): UserRow | undefined {
  return db.prepare(`SELECT u.*, cr.name AS custom_role_name, cr.permissions AS custom_role_permissions
                       FROM users u LEFT JOIN custom_roles cr ON cr.id = u.custom_role_id WHERE u.username = ?`).get(username) as UserRow | undefined;
}

export function countUsers(db: DB): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
}

export function createUser(db: DB, input: UserCreateInput): User {
  if (findByUsername(db, input.username)) throw conflict('Username already exists');
  const assignment = input.roleKey ? resolveRoleKey(db, input.roleKey) : { role: input.role, customRoleId: null };
  const r = db
    .prepare(
      `INSERT INTO users (username, display_name, password_hash, role, custom_role_id, active, sip_username, sip_auth_username, sip_password)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.username,
      input.displayName,
      hashPassword(input.password),
      assignment.role,
      assignment.customRoleId,
      input.active ? 1 : 0,
      input.sipUsername ?? null,
      input.sipAuthUsername ?? null,
      input.sipPassword ?? null,
    );
  return getUser(db, Number(r.lastInsertRowid));
}

export function updateUser(db: DB, id: number, patch: UserUpdateInput): User {
  const existing = getUserRow(db, id);
  if (!existing) throw notFound('User');
  if (patch.username && patch.username.toLowerCase() !== existing.username.toLowerCase() && findByUsername(db, patch.username)) {
    throw conflict('Username already exists');
  }
  const fields: Record<string, unknown> = { ...patch };
  if (patch.roleKey) {
    const assignment = resolveRoleKey(db, patch.roleKey);
    fields.role = assignment.role;
    fields.customRoleId = assignment.customRoleId;
  } else if (patch.role) {
    fields.customRoleId = null;
  }
  delete fields.roleKey;
  if (patch.password) fields.passwordHash = hashPassword(patch.password);
  delete fields.password;
  if (typeof patch.active === 'boolean') fields.active = patch.active ? 1 : 0;
  const { clause, params } = buildSet(fields, [
    'username',
    'displayName',
    'passwordHash',
    'role',
    'customRoleId',
    'active',
    'sipUsername',
    'sipAuthUsername',
    'sipPassword',
  ]);
  if (clause) db.prepare(`UPDATE users SET ${clause} WHERE id = @id`).run({ ...params, id });
  return getUser(db, id);
}

export function deleteUser(db: DB, id: number) {
  const admins = (db.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1`).get() as { n: number }).n;
  const target = getUserRow(db, id);
  if (!target) throw notFound('User');
  if (target.role === 'admin' && admins <= 1) throw conflict('Cannot delete the last admin');
  // keep call history: deactivate instead of hard delete when calls exist
  const calls = (db.prepare('SELECT COUNT(*) AS n FROM calls WHERE user_id = ?').get(id) as { n: number }).n;
  if (calls > 0) {
    db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(id);
    return { deleted: false, deactivated: true };
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  return { deleted: true, deactivated: false };
}

export function setPassword(db: DB, id: number, password: string) {
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), id);
}
