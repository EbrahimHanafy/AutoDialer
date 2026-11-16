import { useMemo, useState } from 'react';
import { PERMISSIONS, customRoleCreateSchema, type Permission, type RoleDefinition } from '@opendialer/shared';
import { Empty, ErrorBox, Field, Modal, confirmDialog, useLoad } from '../../components/ui';
import { api, describeError } from '../../lib/api';
import { zodIssues } from '../../lib/format';
import { toast } from '../../store/toasts';

function PermissionList({ selected, disabled = false, editor = false, onChange }: { selected: Permission[]; disabled?: boolean; editor?: boolean; onChange?: (permissions: Permission[]) => void }) {
  const groups = useMemo(() => {
    const map = new Map<string, typeof PERMISSIONS[number][]>();
    for (const permission of PERMISSIONS) map.set(permission.group, [...(map.get(permission.group) ?? []), permission]);
    return [...map.entries()];
  }, []);
  const chosen = new Set(selected);
  return (
    <div className={editor ? 'role-permission-groups' : 'stack'}>
      {groups.map(([group, permissions]) => (
        <fieldset key={group} className={editor ? 'role-permission-group' : 'stack tight'}>
          <legend>{group}</legend>
          <div className={editor ? 'role-permission-items' : 'grid cols-2'}>
            {permissions.map((permission) => (
              <label key={permission.key} className={editor ? 'check role-permission-item' : 'check'} style={editor ? undefined : { alignItems: 'flex-start' }}>
                <input
                  type="checkbox"
                  checked={chosen.has(permission.key)}
                  disabled={disabled}
                  onChange={(event) => {
                    const next = new Set(chosen);
                    if (event.target.checked) next.add(permission.key);
                    else next.delete(permission.key);
                    onChange?.([...next]);
                  }}
                />
                <span className={editor ? 'role-permission-copy' : undefined}>
                  <strong>{permission.label}</strong>
                  <span className={editor ? 'muted small role-permission-description' : 'muted small'} style={editor ? undefined : { display: 'block' }}>{permission.description}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      ))}
    </div>
  );
}

function RoleEditor({ role, onClose, onSaved }: { role: RoleDefinition | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(role?.name ?? '');
  const [description, setDescription] = useState(role?.description ?? '');
  const [permissions, setPermissions] = useState<Permission[]>(role?.permissions ?? []);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const save = async () => {
    const parsed = customRoleCreateSchema.safeParse({ name, description, permissions });
    if (!parsed.success) return setErrors(zodIssues(parsed.error));
    setErrors({});
    setBusy(true);
    try {
      if (role) await api.patch(`/roles/${role.key}`, parsed.data);
      else await api.post('/roles', parsed.data);
      toast.success(role ? 'Role updated' : 'Role created');
      onSaved();
    } catch (err) {
      toast.error(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const formId = role ? `edit-role-${role.id}` : 'add-new-role';

  return (
    <Modal
      title={role ? `Edit ${role.name}` : 'Add new role'}
      onClose={onClose}
      className="role-editor-modal"
      footer={(
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" form={formId} className="btn primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        </>
      )}
    >
      <form id={formId} className="role-editor-form" onSubmit={(event) => { event.preventDefault(); void save(); }} noValidate>
        <div className="role-editor-fields">
          <Field label="Role name" error={errors.name}>
            <input autoFocus value={name} onChange={(event) => setName(event.target.value)} />
          </Field>
          <Field label="Description (optional)" error={errors.description}>
            <input value={description} onChange={(event) => setDescription(event.target.value)} />
          </Field>
        </div>
        <div className="role-editor-permissions" aria-label="Permissions">
          <PermissionList selected={permissions} onChange={setPermissions} editor />
        </div>
      </form>
    </Modal>
  );
}

export default function Roles() {
  const { data, error, reload } = useLoad(() => api.get<RoleDefinition[]>('/roles'), []);
  const [editing, setEditing] = useState<RoleDefinition | 'new' | null>(null);
  const [viewing, setViewing] = useState<RoleDefinition | null>(null);
  const system = data?.filter((role) => role.system) ?? [];
  const custom = data?.filter((role) => !role.system) ?? [];

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Roles &amp; Permissions</h1>
          <p className="muted">System roles preserve their existing permissions. Custom roles can use only permissions supported by the application.</p>
        </div>
        <button type="button" className="btn primary" onClick={() => setEditing('new')}>+ Add New Role</button>
      </div>
      <ErrorBox error={error} onRetry={reload} />

      <section className="stack">
        <h2>System roles</h2>
        <div className="grid cols-3">
          {system.map((role) => (
            <article key={role.key} className="card stack tight">
              <div className="row between"><h3>{role.name}</h3><span className="badge">System</span></div>
              <p className="muted small">{role.description}</p>
              <div className="row between"><span>{role.permissions.length} permissions</span><span>{role.userCount} users</span></div>
              <button type="button" className="btn small" onClick={() => setViewing(role)}>View permissions</button>
            </article>
          ))}
        </div>
      </section>

      <section className="stack">
        <h2>Custom roles</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Name</th><th>Description</th><th>Permissions</th><th>Users</th><th /></tr></thead>
            <tbody>
              {custom.map((role) => (
                <tr key={role.key}>
                  <td><strong>{role.name}</strong></td>
                  <td>{role.description || <span className="muted">—</span>}</td>
                  <td>{role.permissions.length}</td>
                  <td>{role.userCount}</td>
                  <td className="actions">
                    <button type="button" className="btn small" onClick={() => setEditing(role)}>Edit</button>
                    <button type="button" className="btn small ghost" onClick={async () => {
                      if (!(await confirmDialog({ title: `Delete "${role.name}"?`, message: 'Assigned users will return to the Agent system role.', confirmLabel: 'Delete', danger: true }))) return;
                      try {
                        await api.del(`/roles/${role.key}`);
                        toast.success('Role deleted');
                        void reload();
                      } catch (err) {
                        toast.error(describeError(err));
                      }
                    }}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {data && custom.length === 0 && <Empty>No custom roles yet.</Empty>}
        </div>
      </section>

      {editing && <RoleEditor role={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void reload(); }} />}
      {viewing && (
        <Modal title={`${viewing.name} permissions`} onClose={() => setViewing(null)}>
          <PermissionList selected={viewing.permissions} disabled />
          <div className="form-actions"><button type="button" className="btn" onClick={() => setViewing(null)}>Close</button></div>
        </Modal>
      )}
    </div>
  );
}

