import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { CAMPAIGN_TAB_PERMISSIONS, type Campaign } from '@opendialer/shared';
import { Empty, ErrorBox, Modal, useLoad } from '../../components/ui';
import { api } from '../../lib/api';
import { fmtDateTime } from '../../lib/format';
import { hasPermission, useAuth } from '../../store/auth';
import { toast } from '../../store/toasts';
import { CampaignForm, defaultCampaign } from './CampaignForm';

export function StatusBadge({ status }: { status: string }) {
  const cls = status === 'active' ? 'green' : status === 'paused' ? 'amber' : status === 'completed' ? '' : 'blue';
  return <span className={`badge ${cls}`}>{status}</span>;
}

export default function Campaigns() {
  const user = useAuth((s) => s.user);
  const canView = hasPermission(user, 'campaigns.view');
  const canCreate = hasPermission(user, 'campaigns.create');
  const canOpenDetails = Object.values(CAMPAIGN_TAB_PERMISSIONS).some((permission) => hasPermission(user, permission));
  const canLoadList = canView || canOpenDetails;
  const { data, error, reload } = useLoad(() => canLoadList ? api.get<Campaign[]>('/campaigns') : Promise.resolve([]), [canLoadList]);
  const [creating, setCreating] = useState(false);
  const nav = useNavigate();
  return (
    <div className="stack">
      <div className="page-head">
        <h1>Campaigns</h1>
        {canCreate && (
          <button type="button" className="btn primary" onClick={() => setCreating(true)}>
            + New campaign
          </button>
        )}
      </div>
      <ErrorBox error={error} onRetry={reload} />
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Status</th>
              {canView && <th>Mode</th>}
              {canView && <th>Hours</th>}
              {canView && <th>Recording</th>}
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {(data ?? []).map((c) => (
              <tr key={c.id}>
                <td>
                  {canOpenDetails ? <Link to={`/admin/campaigns/${c.id}`}>{c.name}</Link> : c.name}
                </td>
                <td>
                  <StatusBadge status={c.status} />
                </td>
                {canView && <td>{c.dialMode}</td>}
                {canView && <td className="nowrap">{c.callingHoursStart === c.callingHoursEnd ? 'All day' : `${c.callingHoursStart}–${c.callingHoursEnd}`}</td>}
                {canView && <td>{c.recording}</td>}
                <td className="nowrap">{fmtDateTime(c.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {data && data.length === 0 && <Empty>{canCreate ? 'No campaigns available – create a new one.' : 'No campaigns available.'}</Empty>}
      </div>
      {creating && (
        <Modal title="New campaign" wide onClose={() => setCreating(false)}>
          <CampaignForm
            initial={defaultCampaign()}
            submitLabel="Create campaign"
            onCancel={() => setCreating(false)}
            onSubmit={async (v) => {
              const c = await api.post<Campaign>('/campaigns', v);
              toast.success(`Campaign "${c.name}" created`);
              setCreating(false);
              if (canView && canOpenDetails) nav(`/admin/campaigns/${c.id}`);
              else void reload();
            }}
          />
        </Modal>
      )}
    </div>
  );
}
