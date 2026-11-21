import {
  PERMISSION_KEYS,
  SYSTEM_ROLE_PERMISSIONS,
  type CustomRoleCreateInput,
  type CustomRoleUpdateInput,
  type Permission,
  type Role,
  type RoleDefinition,
} from '@opendialer/shared';
import type { DB } from '../db.js';
import { buildSet } from '../db.js';
import { conflict, notFound } from '../errors.js';

export interface CustomRoleRow {
  id: number;
  name: string;
  description: string;
  permissions: string;
  created_at: string;
  updated_at: string;
}

const allowed = new Set<string>(PERMISSION_KEYS);
export const MUTABLE_SYSTEM_PERMISSIONS = ['dashboard.view_gsm_dongles', 'leads.viewFullPhoneNumbers', 'leads.bulkEditNextAttempt', 'leads.bulkEditStatus'] as const satisfies readonly Permission[];
export function parsePermissions(value: unknown): Permission[] {
  try {
    const raw = typeof value === 'string' ? JSON.parse(value) : value;
    if (!Array.isArray(raw)) return [];
    return [...new Set(raw.filter((p): p is Permission => typeof p === 'string' && allowed.has(p)))];
  } catch {
    return [];
  }
}

const SYSTEM_NAMES: Record<Role, string> = { admin: 'Admin', supervisor: 'Supervisor', agent: 'Agent' };
const SYSTEM_DESCRIPTIONS: Record<Role, string> = {
  admin: 'Full system access with all current administrative permissions.',
  supervisor: 'Current supervisor access to operations, reporting, and campaign management.',
  agent: 'Current agent access to assigned campaigns, leads, calls, and callbacks.',
};

export function getSystemRolePermissions(db: DB, role: Role): Permission[] {
  const permissions = new Set<Permission>(SYSTEM_ROLE_PERMISSIONS[role]);
  const rows = db.prepare('SELECT permission, allowed FROM system_role_permission_overrides WHERE role = ?').all(role) as {
    permission: string;
    allowed: number;
  }[];
  for (const row of rows) {
    if (!allowed.has(row.permission)) continue;
    if (row.allowed) permissions.add(row.permission as Permission);
    else permissions.delete(row.permission as Permission);
  }
  return [...permissions];
}

export function updateSystemRolePermission(db: DB, role: Role, permission: Permission, enabled: boolean): RoleDefinition {
  if (!(MUTABLE_SYSTEM_PERMISSIONS as readonly Permission[]).includes(permission)) throw conflict('This system-role permission cannot be changed');
  db.prepare(
    `INSERT INTO system_role_permission_overrides (role, permission, allowed, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(role, permission) DO UPDATE SET allowed = excluded.allowed, updated_at = excluded.updated_at`,
  ).run(role, permission, enabled ? 1 : 0, new Date().toISOString());
  return listRoles(db).find((item) => item.key === `system:${role}`)!;
}

function mapCustom(r: CustomRoleRow, userCount = 0): RoleDefinition {
  return {
    key: `custom:${r.id}`,
    id: r.id,
    name: r.name,
    description: r.description,
    system: false,
    systemRole: null,
    permissions: parsePermissions(r.permissions),
    userCount,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function listRoles(db: DB): RoleDefinition[] {
  const system = (['admin', 'supervisor', 'agent'] as Role[]).map((role): RoleDefinition => ({
    key: `system:${role}`,
    id: null,
    name: SYSTEM_NAMES[role],
    description: SYSTEM_DESCRIPTIONS[role],
    system: true,
    systemRole: role,
    permissions: getSystemRolePermissions(db, role),
    mutablePermissions: [...MUTABLE_SYSTEM_PERMISSIONS],
    userCount: (db.prepare('SELECT COUNT(*) AS n FROM users WHERE role = ? AND custom_role_id IS NULL').get(role) as { n: number }).n,
    createdAt: null,
    updatedAt: null,
  }));
  const rows = db.prepare(
    `SELECT cr.*, COUNT(u.id) AS user_count
       FROM custom_roles cr LEFT JOIN users u ON u.custom_role_id = cr.id
      GROUP BY cr.id ORDER BY cr.name COLLATE NOCASE`,
  ).all() as (CustomRoleRow & { user_count: number })[];
  return [...system, ...rows.map((r) => mapCustom(r, r.user_count))];
}

export function getCustomRoleRow(db: DB, id: number): CustomRoleRow | undefined {
  return db.prepare('SELECT * FROM custom_roles WHERE id = ?').get(id) as CustomRoleRow | undefined;
}

export function getCustomRole(db: DB, id: number): RoleDefinition {
  const row = getCustomRoleRow(db, id);
  if (!row) throw notFound('Role');
  const count = (db.prepare('SELECT COUNT(*) AS n FROM users WHERE custom_role_id = ?').get(id) as { n: number }).n;
  return mapCustom(row, count);
}

export function createCustomRole(db: DB, input: CustomRoleCreateInput): RoleDefinition {
  if (db.prepare('SELECT 1 FROM custom_roles WHERE name = ? COLLATE NOCASE').get(input.name)) throw conflict('Role name already exists');
  const r = db.prepare('INSERT INTO custom_roles (name, description, permissions) VALUES (?, ?, ?)').run(
    input.name,
    input.description,
    JSON.stringify(parsePermissions(input.permissions)),
  );
  return getCustomRole(db, Number(r.lastInsertRowid));
}

export function updateCustomRole(db: DB, id: number, patch: CustomRoleUpdateInput): RoleDefinition {
  getCustomRole(db, id);
  if (patch.name && db.prepare('SELECT 1 FROM custom_roles WHERE name = ? COLLATE NOCASE AND id <> ?').get(patch.name, id)) throw conflict('Role name already exists');
  const fields: Record<string, unknown> = { ...patch };
  if (patch.permissions) fields.permissions = JSON.stringify(parsePermissions(patch.permissions));
  const { clause, params } = buildSet(fields, ['name', 'description', 'permissions']);
  if (clause) db.prepare(`UPDATE custom_roles SET ${clause}, updated_at = @updatedAt WHERE id = @id`).run({ ...params, id, updatedAt: new Date().toISOString() });
  return getCustomRole(db, id);
}

export function deleteCustomRole(db: DB, id: number) {
  getCustomRole(db, id);
  db.transaction(() => {
    db.prepare(`UPDATE users SET custom_role_id = NULL, role = 'agent' WHERE custom_role_id = ?`).run(id);
    db.prepare('DELETE FROM custom_roles WHERE id = ?').run(id);
  })();
}

export function parseCustomRoleKey(key: string): number {
  if (key.startsWith('system:')) throw conflict('System roles cannot be modified or deleted');
  const m = /^custom:([1-9]\d*)$/.exec(key);
  if (!m) throw notFound('Role');
  return Number(m[1]);
}

export function resolveRoleKey(db: DB, key: string): { role: Role; customRoleId: number | null } {
  const system = /^system:(admin|supervisor|agent)$/.exec(key);
  if (system) return { role: system[1] as Role, customRoleId: null };
  const id = parseCustomRoleKey(key);
  getCustomRole(db, id);
  return { role: 'agent', customRoleId: id };
}

