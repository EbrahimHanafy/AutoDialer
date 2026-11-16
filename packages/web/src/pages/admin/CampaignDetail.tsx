import { useEffect, useState } from 'react';
import { Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { CAMPAIGN_TAB_PERMISSIONS, type Campaign, type CampaignStats, type CampaignStatus, type LeadList, type LeadStatus, type Permission, type Script, type User } from '@opendialer/shared';
import { Empty, ErrorBox, Loading, Modal, Tabs, confirmDialog, useLoad } from '../../components/ui';
import { api, describeError, downloadFile } from '../../lib/api';
import { fmtDateTime, fmtDuration } from '../../lib/format';
import { hasPermission, useAuth } from '../../store/auth';
import { toast } from '../../store/toasts';
import { CampaignForm, DAY_NAMES, campaignToInput } from './CampaignForm';
import { StatusBadge } from './Campaigns';
import { ImportWizard } from './ImportWizard';
import { LEAD_STATUSES, LeadsTable } from './LeadsTable';

type CampaignHeader = Pick<Campaign, 'id' | 'name' | 'status' | 'createdAt' | 'updatedAt'> & { agentCount?: number };
type CampaignDetailData = { campaign: Campaign; script: Script | null };
type Tab = keyof typeof CAMPAIGN_TAB_PERMISSIONS;
const CAMPAIGN_TABS: { id: Tab; label: string; permission: Permission }[] = [
  { id: 'overview', label: 'Overview', permission: CAMPAIGN_TAB_PERMISSIONS.overview },
  { id: 'lists', label: 'Lists & import', permission: CAMPAIGN_TAB_PERMISSIONS.lists },
  { id: 'leads', label: 'Leads', permission: CAMPAIGN_TAB_PERMISSIONS.leads },
  { id: 'agents', label: 'Agents', permission: CAMPAIGN_TAB_PERMISSIONS.agents },
  { id: 'settings', label: 'Settings', permission: CAMPAIGN_TAB_PERMISSIONS.settings },
];

function Overview({ campaignId }: { campaignId: number }) {
  const details = useLoad(() => api.get<CampaignDetailData>(`/campaigns/${campaignId}/overview`), [campaignId]);
  const { data, error, reload } = useLoad(() => api.get<CampaignStats>(`/campaigns/${campaignId}/stats`), [campaignId]);
  useEffect(() => {
    const t = setInterval(() => void reload(), 10000);
    return () => clearInterval(t);
  }, [reload]);
  const s = data;
  const c = details.data ? { ...details.data.campaign, script: details.data.script } : null;
  const stat = (label: string, value: string | number) => (
    <div className="stat">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
    </div>
  );
  return (
    <div className="stack">
      <ErrorBox error={details.error} onRetry={details.reload} />
      <ErrorBox error={error} onRetry={reload} />
      {s && (
        <>
          <div className="grid cols-4">
            {stat('Leads', s.leadsTotal)}
            {stat('Dialable now', s.dialable)}
            {stat('Calls today', s.callsToday)}
            {stat('Agents online', s.agentsOnline)}
            {stat('Calls total', s.callsTotal)}
            {stat('Answered', s.callsAnswered)}
            {stat('Contacts / sales', `${s.contacts} / ${s.sales}`)}
            {stat('Avg talk', fmtDuration(s.avgTalkSec))}
          </div>
          <div className="card">
            <h3>Lead status</h3>
            <div className="grid cols-3 small">
              <span>New: {s.leadsNew}</span>
              <span>In progress: {s.leadsInProgress}</span>
              <span>Callback: {s.leadsCallback}</span>
              <span>Done: {s.leadsDone}</span>
              <span>DNC: {s.leadsDnc}</span>
              <span>Invalid: {s.leadsInvalid}</span>
            </div>
          </div>
        </>
      )}
      {c && <div className="card">
        <h3>Configuration</h3>
        <dl className="kv">
          <dt>Dial mode</dt>
          <dd>{c.dialMode}</dd>
          <dt>Calling hours</dt>
          <dd>
            {c.callingHoursStart === c.callingHoursEnd ? 'All day' : `${c.callingHoursStart}–${c.callingHoursEnd}`} on {c.callingDays.map((d) => DAY_NAMES[d]).join(', ')} ({c.timezoneMode === 'lead' ? "lead's timezone" : c.fixedTimezone})
          </dd>
          <dt>Attempts</dt>
          <dd>
            max {c.maxAttempts}, retry after {c.retryMinutes} min
          </dd>
          <dt>Preview / wrap-up</dt>
          <dd>
            {c.previewTimeoutSec ? `${c.previewTimeoutSec}s auto-dial` : 'manual dial'} / {c.wrapupTimeoutSec ? `${c.wrapupTimeoutSec}s` : 'unlimited'}
          </dd>
          <dt>Recording</dt>
          <dd>{c.recording}</dd>
          <dt>Script</dt>
          <dd>{c.script?.name ?? '—'}</dd>
          {c.description && (
            <>
              <dt>Description</dt>
              <dd>{c.description}</dd>
            </>
          )}
        </dl>
      </div>}
    </div>
  );
}

function ResetDialog({ campaignId, lists, onClose }: { campaignId: number; lists: LeadList[]; onClose: () => void }) {
  const [listId, setListId] = useState('');
  const [statuses, setStatuses] = useState<LeadStatus[]>(['done', 'callback', 'invalid']);
  const [busy, setBusy] = useState(false);
  return (
    <Modal title="Reset leads" onClose={onClose}>
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            const r = await api.post<{ changed: number }>(`/campaigns/${campaignId}/reset-leads`, {
              listId: listId ? Number(listId) : undefined,
              onlyStatus: statuses.length ? statuses : undefined,
            });
            toast.success(`${r.changed} leads reset to "new"`);
            onClose();
          } catch (err) {
            toast.error(describeError(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <p className="muted">Matching leads go back to status "new" with zero attempts. DNC leads are never reset.</p>
        <label className="field">
          <span>List</span>
          <select value={listId} onChange={(e) => setListId(e.target.value)}>
            <option value="">All lists</option>
            {lists.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </label>
        <fieldset>
          <legend>Only leads with status</legend>
          <div className="days">
            {LEAD_STATUSES.filter((s) => s !== 'dnc').map((s) => (
              <label key={s}>
                <input type="checkbox" checked={statuses.includes(s)} onChange={(e) => setStatuses(e.target.checked ? [...statuses, s] : statuses.filter((x) => x !== s))} />
                {s}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn danger" disabled={busy}>
            Reset leads
          </button>
        </div>
      </form>
    </Modal>
  );
}

function Lists({ campaignId }: { campaignId: number }) {
  const user = useAuth((s) => s.user);
  const canView = hasPermission(user, 'campaigns.lists.view');
  const canCreate = hasPermission(user, 'campaigns.lists.create');
  const canEdit = hasPermission(user, 'campaigns.lists.edit');
  const canDelete = hasPermission(user, 'campaigns.lists.delete');
  const canImport = hasPermission(user, 'campaigns.lists.import');
  const canReset = hasPermission(user, 'campaigns.leads.reset');
  const { data, error, reload } = useLoad(() => canView ? api.get<LeadList[]>(`/campaigns/${campaignId}/lists`) : Promise.resolve([]), [campaignId, canView]);
  const [name, setName] = useState('');
  const [importing, setImporting] = useState<LeadList | null>(null);
  const [resetting, setResetting] = useState(false);
  const lists = data ?? [];

  const create = async () => {
    if (!name.trim()) return;
    try {
      await api.post(`/campaigns/${campaignId}/lists`, { name: name.trim() });
      setName('');
      toast.success('List created');
      void reload();
    } catch (err) {
      toast.error(describeError(err));
    }
  };

  return (
    <div className="stack">
      <ErrorBox error={error} onRetry={reload} />
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        {canCreate && (
          <>
            <input aria-label="New list name" style={{ maxWidth: 280 }} placeholder="New list name" value={name} onChange={(e) => setName(e.target.value)} />
            <button type="submit" className="btn primary" disabled={!name.trim()}>
              Create list
            </button>
          </>
        )}
        <span className="grow" />
        {canReset && (
          <button type="button" className="btn" onClick={() => setResetting(true)}>
            Reset leads…
          </button>
        )}
        {hasPermission(user, 'leads.export') && (
          <button type="button" className="btn" onClick={() => void downloadFile('/reports/export/leads.csv', { campaignId }, `leads-${campaignId}.csv`).catch((e) => toast.error(describeError(e)))}>
            Export leads CSV
          </button>
        )}
      </form>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>List</th>
              <th>Leads</th>
              <th>Active</th>
              <th>Created</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {lists.map((l) => (
              <tr key={l.id}>
                <td>{l.name}</td>
                <td>{l.leadCount}</td>
                <td>
                  <input
                    type="checkbox"
                    aria-label={`List ${l.name} active`}
                    checked={l.active}
                    disabled={!canEdit}
                    onChange={async (e) => {
                      try {
                        await api.patch(`/lists/${l.id}`, { active: e.target.checked });
                        void reload();
                      } catch (err) {
                        toast.error(describeError(err));
                      }
                    }}
                  />
                </td>
                <td className="nowrap">{fmtDateTime(l.createdAt)}</td>
                <td className="actions">
                  {canImport && (
                    <button type="button" className="btn small primary" onClick={() => setImporting(l)}>
                      Import CSV
                    </button>
                  )}
                  {canDelete && (
                    <button
                      type="button"
                      className="btn small ghost"
                      onClick={async () => {
                        if (!(await confirmDialog({ title: `Delete list "${l.name}"?`, message: `All ${l.leadCount} leads in it are deleted.`, confirmLabel: 'Delete', danger: true }))) return;
                        try {
                          await api.del(`/lists/${l.id}`);
                          void reload();
                        } catch (err) {
                          toast.error(describeError(err));
                        }
                      }}
                    >
                      Delete
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {lists.length === 0 && <Empty>{canView ? (canCreate ? 'No lists yet. Create a list, then import a CSV into it.' : 'No lists yet.') : 'You do not have permission to view campaign lists.'}</Empty>}
      </div>
      {importing && <ImportWizard list={importing} onClose={() => setImporting(null)} onDone={() => void reload()} />}
      {resetting && <ResetDialog campaignId={campaignId} lists={lists} onClose={() => setResetting(false)} />}
    </div>
  );
}

function LeadsTab({ campaignId }: { campaignId: number }) {
  const user = useAuth((s) => s.user);
  const canView = hasPermission(user, 'campaigns.leads.view');
  const canViewLists = hasPermission(user, 'campaigns.lists.view');
  const lists = useLoad(() => canViewLists ? api.get<LeadList[]>(`/campaigns/${campaignId}/lists`) : Promise.resolve([]), [campaignId, canViewLists]);
  if (!canView) return <Empty>You do not have permission to view campaign leads.</Empty>;
  return <LeadsTable campaignId={campaignId} lists={lists.data ?? []} />;
}

function Agents({ campaignId }: { campaignId: number }) {
  const user = useAuth((s) => s.user);
  const canView = hasPermission(user, 'campaigns.agents.view');
  const canAssign = hasPermission(user, 'campaigns.agents.assign');
  const canUnassign = hasPermission(user, 'campaigns.agents.unassign');
  const { data, error, reload } = useLoad(
    () => canView ? api.get<{ agentIds: number[]; agents: User[] }>(`/campaigns/${campaignId}/agents`) : Promise.resolve({ agentIds: [], agents: [] }),
    [campaignId, canView],
  );
  const agents = data?.agents ?? [];
  const [sel, setSel] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => setSel(data?.agentIds ?? []), [data]);
  if (!canView) return <Empty>You do not have permission to view assigned agents.</Empty>;
  return (
    <div className="stack">
      <ErrorBox error={error} onRetry={reload} />
      <p className="muted">Agents assigned here can join this campaign. Supervisors and admins can always join.</p>
      <div className="card">
        {agents.length === 0 && <p className="muted">No agent users yet – create them under Users.</p>}
        <div className="stack tight">
          {agents.map((u) => {
            const wasAssigned = Boolean(data?.agentIds.includes(u.id));
            return (
              <label key={u.id} className="check">
                <input type="checkbox" checked={sel.includes(u.id)} disabled={wasAssigned ? !canUnassign : !canAssign} onChange={(e) => setSel(e.target.checked ? [...sel, u.id] : sel.filter((x) => x !== u.id))} />
                {u.displayName} <span className="muted small">({u.username})</span>
                {!u.active && <span className="badge red">inactive</span>}
              </label>
            );
          })}
        </div>
        {(canAssign || canUnassign) && agents.length > 0 && (
          <div className="row" style={{ marginTop: '0.75rem' }}>
            <button type="button" className="btn small" disabled={!canAssign} onClick={() => setSel(agents.map((a) => a.id))}>
              Select all
            </button>
            <button type="button" className="btn small" disabled={!canUnassign} onClick={() => setSel([])}>
              Clear
            </button>
          </div>
        )}
      </div>
      {(canAssign || canUnassign) && <div className="form-actions">
        <button
          type="button"
          className="btn primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await api.put(`/campaigns/${campaignId}/agents`, { userIds: sel });
              toast.success('Agents saved');
              void reload();
            } catch (err) {
              toast.error(describeError(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          Save agents
        </button>
      </div>}
    </div>
  );
}

function CampaignSettings({ campaignId }: { campaignId: number }) {
  const user = useAuth((s) => s.user);
  const canEdit = hasPermission(user, 'campaigns.edit');
  const details = useLoad(() => api.get<CampaignDetailData>(`/campaigns/${campaignId}/settings`), [campaignId]);
  const c = details.data?.campaign;
  return (
    <div className="stack">
      <ErrorBox error={details.error} onRetry={details.reload} />
      {c && canEdit && (
        <div className="card">
          <CampaignForm
            key={c.updatedAt}
            initial={campaignToInput(c)}
            submitLabel="Save settings"
            onSubmit={async (value) => {
              await api.patch(`/campaigns/${c.id}`, value);
              toast.success('Campaign saved');
              void details.reload();
            }}
          />
        </div>
      )}
      {c && !canEdit && (
        <div className="card">
          <dl className="kv">
            <dt>Description</dt><dd>{c.description || '—'}</dd>
            <dt>Dial mode</dt><dd>{c.dialMode}</dd>
            <dt>Caller ID</dt><dd>{c.callerId || '—'}</dd>
            <dt>Dial prefix</dt><dd>{c.dialPrefix || '—'}</dd>
            <dt>Script</dt><dd>{details.data?.script?.name ?? '—'}</dd>
            <dt>Calling hours</dt><dd>{c.callingHoursStart === c.callingHoursEnd ? 'All day' : `${c.callingHoursStart}–${c.callingHoursEnd}`}</dd>
            <dt>Calling days</dt><dd>{c.callingDays.map((day) => DAY_NAMES[day]).join(', ')}</dd>
            <dt>Timezone</dt><dd>{c.timezoneMode === 'lead' ? `Lead timezone (fallback ${c.fixedTimezone})` : c.fixedTimezone}</dd>
            <dt>Max attempts</dt><dd>{c.maxAttempts}</dd>
            <dt>Retry after</dt><dd>{c.retryMinutes} minutes</dd>
            <dt>Preview timeout</dt><dd>{c.previewTimeoutSec} seconds</dd>
            <dt>Wrap-up timeout</dt><dd>{c.wrapupTimeoutSec} seconds</dd>
            <dt>Recording</dt><dd>{c.recording}</dd>
          </dl>
        </div>
      )}
    </div>
  );
}

export default function CampaignDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const user = useAuth((s) => s.user);
  const allowedTabs = CAMPAIGN_TABS.filter((item) => hasPermission(user, item.permission));
  const requestedTab = searchParams.get('tab') as Tab | null;
  const tab = allowedTabs.some((item) => item.id === requestedTab) ? requestedTab! : allowedTabs[0]?.id;
  const { data: c, error, reload, loading } = useLoad(() => api.get<CampaignHeader>(`/campaigns/${id}`), [id]);
  const canActivate = hasPermission(user, 'campaigns.status.activate');
  const canPause = hasPermission(user, 'campaigns.status.pause');
  const canComplete = hasPermission(user, 'campaigns.status.complete');

  useEffect(() => {
    if (tab && requestedTab !== tab) setSearchParams({ tab }, { replace: true });
  }, [requestedTab, setSearchParams, tab]);

  if (!tab) return <Navigate to="/admin/campaigns" replace />;

  if (!c) return loading ? <Loading /> : <ErrorBox error={error ?? 'Not found'} onRetry={reload} />;

  const setStatus = async (status: CampaignStatus) => {
    try {
      await api.post(`/campaigns/${c.id}/status`, { status });
      toast.success(`Campaign ${status === 'active' ? 'activated' : status}`);
      void reload();
    } catch (err) {
      toast.error(describeError(err));
    }
  };

  return (
    <div className="stack">
      <div className="page-head">
        <div className="row">
          <h1>{c.name}</h1>
          <StatusBadge status={c.status} />
        </div>
        <div className="row">
          {canActivate && c.status !== 'active' && (
            <button type="button" className="btn success" onClick={() => void setStatus('active')}>
              Activate
            </button>
          )}
          {canPause && c.status === 'active' && (
            <button type="button" className="btn warning" onClick={() => void setStatus('paused')}>
              Pause
            </button>
          )}
          {canComplete && c.status !== 'completed' && (
            <button
              type="button"
              className="btn"
              onClick={async () => {
                if (await confirmDialog({ title: 'Complete campaign?', message: 'Agents can no longer join it. You can re-activate it later.', confirmLabel: 'Complete' })) void setStatus('completed');
              }}
            >
              Complete
            </button>
          )}
          {hasPermission(user, 'campaigns.delete') && (
            <button
              type="button"
              className="btn ghost"
              onClick={async () => {
                if (!(await confirmDialog({ title: `Delete "${c.name}"?`, message: 'All lists, leads and callbacks of this campaign are deleted. Call history is kept.', confirmLabel: 'Delete', danger: true }))) return;
                try {
                  await api.del(`/campaigns/${c.id}`);
                  nav('/admin/campaigns');
                } catch (err) {
                  toast.error(describeError(err));
                }
              }}
            >
              Delete
            </button>
          )}
        </div>
      </div>
      <Tabs<Tab>
        value={tab}
        onChange={(next) => setSearchParams({ tab: next })}
        tabs={allowedTabs.map(({ id: tabId, label }) => ({ id: tabId, label: tabId === 'agents' && c.agentCount != null ? `${label} (${c.agentCount})` : label }))}
      />
      {tab === 'overview' && <Overview campaignId={c.id} />}
      {tab === 'lists' && <Lists campaignId={c.id} />}
      {tab === 'leads' && <LeadsTab campaignId={c.id} />}
      {tab === 'agents' && <Agents campaignId={c.id} />}
      {tab === 'settings' && <CampaignSettings campaignId={c.id} />}
    </div>
  );
}
