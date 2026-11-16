import { lazy, Suspense } from 'react';
import { Loading } from '../../components/ui';
import { Navigate, NavLink, Route, Routes } from 'react-router-dom';
import { CAMPAIGN_TAB_PERMISSIONS, type Permission } from '@opendialer/shared';
import { TopBar } from '../../components/Chrome';
import { hasPermission, isSystemAdmin, useAuth } from '../../store/auth';
import Dashboard from './Dashboard';
import Campaigns from './Campaigns';
import CampaignDetail from './CampaignDetail';

const Leads = lazy(() => import('./Leads'));
const Dnc = lazy(() => import('./Dnc'));
const Dispositions = lazy(() => import('./Dispositions'));
const Scripts = lazy(() => import('./Scripts'));
const Users = lazy(() => import('./Users'));
const SettingsPage = lazy(() => import('./Settings'));
const Reports = lazy(() => import('./Reports'));
const Calls = lazy(() => import('./Calls'));
const Callbacks = lazy(() => import('./Callbacks'));
const Integrations = lazy(() => import('./Integrations'));
const Audit = lazy(() => import('./Audit'));
const System = lazy(() => import('./System'));
const Roles = lazy(() => import('./Roles'));

const campaignDetailPermissions = Object.values(CAMPAIGN_TAB_PERMISSIONS);
const campaignPagePermissions: Permission[] = ['campaigns.view', 'campaigns.create', ...campaignDetailPermissions];
const NAV: { section?: string; to: string; label: string; permissions: Permission[]; systemAdmin?: boolean }[] = [
  { section: 'Live', to: 'dashboard', label: 'Dashboard', permissions: ['dashboard.view'] },
  { to: 'campaigns', label: 'Campaigns', permissions: campaignPagePermissions },
  { to: 'leads', label: 'Leads', permissions: ['leads.manage'] },
  { to: 'callbacks', label: 'Callbacks', permissions: ['callbacks.manage'] },
  { to: 'calls', label: 'Calls & recordings', permissions: ['calls.manage'] },
  { to: 'reports', label: 'Reports', permissions: ['reports.view'] },
  { section: 'Setup', to: 'scripts', label: 'Scripts', permissions: ['scripts.manage'] },
  { to: 'dispositions', label: 'Dispositions', permissions: ['dispositions.view'] },
  { to: 'dnc', label: 'Do-not-call', permissions: ['dnc.manage'] },
  { to: 'users', label: 'Users', permissions: ['users.view'] },
  { to: 'settings', label: 'Settings', permissions: ['settings.view'] },
  { section: 'System', to: 'roles', label: 'Roles & Permissions', permissions: ['users.manage'], systemAdmin: true },
  { to: 'integrations', label: 'Integrations', permissions: ['integrations.manage'] },
  { to: 'audit', label: 'Audit log', permissions: ['audit.view'] },
  { to: 'system', label: 'System & backup', permissions: ['system.manage'] },
];

export default function AdminApp() {
  const user = useAuth((s) => s.user);
  const allowed = (permission: Permission) => hasPermission(user, permission);
  const canOpenCampaignDetails = campaignDetailPermissions.some(allowed);
  const items = NAV.filter((n) => n.permissions.some(allowed) && (!n.systemAdmin || isSystemAdmin(user)));
  if (!items.length) return <Navigate to="/" replace />;
  return (
    <>
      <TopBar />
      <div className="admin">
        <nav className="sidebar" aria-label="Admin">
          {items.map((n) => (
            <div key={n.to} style={{ display: 'contents' }}>
              {n.section && <div className="section">{n.section}</div>}
              <NavLink to={`/admin/${n.to}`} className={({ isActive }) => (isActive ? 'active' : '')}>
                {n.label}
              </NavLink>
            </div>
          ))}
        </nav>
        <main className="admin-main">
          <Suspense fallback={<Loading />}>
          <Routes>
            {allowed('dashboard.view') && <Route path="dashboard" element={<Dashboard />} />}
            {campaignPagePermissions.some(allowed) && <Route path="campaigns" element={<Campaigns />} />}
            {canOpenCampaignDetails && <Route path="campaigns/:id" element={<CampaignDetail />} />}
            {allowed('leads.manage') && <Route path="leads" element={<Leads />} />}
            {allowed('dnc.manage') && <Route path="dnc" element={<Dnc />} />}
            {(allowed('dispositions.view') || allowed('dispositions.manage')) && <Route path="dispositions" element={<Dispositions />} />}
            {allowed('scripts.manage') && <Route path="scripts" element={<Scripts />} />}
            {(allowed('users.view') || allowed('users.manage')) && <Route path="users" element={<Users />} />}
            {(allowed('settings.view') || allowed('settings.manage')) && <Route path="settings" element={<SettingsPage />} />}
            {allowed('reports.view') && <Route path="reports" element={<Reports />} />}
            {allowed('calls.manage') && <Route path="calls" element={<Calls />} />}
            {allowed('callbacks.manage') && <Route path="callbacks" element={<Callbacks />} />}
            {isSystemAdmin(user) && <Route path="roles" element={<Roles />} />}
            {allowed('integrations.manage') && <Route path="integrations" element={<Integrations />} />}
            {allowed('audit.view') && <Route path="audit" element={<Audit />} />}
            {allowed('system.manage') && <Route path="system" element={<System />} />}
            <Route path="*" element={<Navigate to={items[0].to} replace />} />
          </Routes>
          </Suspense>
        </main>
      </div>
    </>
  );
}
