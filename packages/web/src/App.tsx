import { lazy, Suspense, useEffect, type ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import type { Permission } from '@opendialer/shared';
import { DialogHost, Loading } from './components/ui';
import { Toasts } from './components/Toasts';
import { setUnauthorizedHandler } from './lib/api';
import { adminPathFor, hasPermission, useAuth } from './store/auth';
import { LoginPage } from './pages/Login';
import { SetupPage } from './pages/Setup';

const AgentConsole = lazy(() => import('./pages/agent/AgentConsole'));
const AdminApp = lazy(() => import('./pages/admin/AdminApp'));

function RequireAuth({ children, permission }: { children: ReactNode; permission?: Permission }) {
  const user = useAuth((s) => s.user);
  const loc = useLocation();
  if (!user) return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
  if (permission && !hasPermission(user, permission)) return <Navigate to="/" replace />;
  return <>{children}</>;
}

function Home() {
  const user = useAuth((s) => s.user);
  if (!user) return <Navigate to="/login" replace />;
  const admin = adminPathFor(user);
  return <Navigate to={admin ?? (hasPermission(user, 'agent.use') ? '/agent' : '/no-access')} replace />;
}

function NoAccess() {
  const user = useAuth((s) => s.user);
  const logout = useAuth((s) => s.logout);
  if (!user) return <Navigate to="/login" replace />;
  return (
    <div className="auth-page">
      <div className="card auth-card stack">
        <h1>No access assigned</h1>
        <p className="muted">Your role does not currently include access to an AutoDialer workspace. Contact an administrator.</p>
        <button type="button" className="btn primary" onClick={logout}>Sign out</button>
      </div>
    </div>
  );
}

function SetupGate({ children }: { children: ReactNode }) {
  const needsSetup = useAuth((s) => s.publicSettings?.needsSetup);
  const loc = useLocation();
  if (needsSetup && loc.pathname !== '/setup') return <Navigate to="/setup" replace />;
  return <>{children}</>;
}

export function App() {
  const booted = useAuth((s) => s.booted);
  useEffect(() => {
    setUnauthorizedHandler(() => useAuth.getState().expire());
    void useAuth.getState().boot();
  }, []);
  if (!booted) return <Loading label="Starting AutoDialer…" />;
  return (
    <BrowserRouter>
      <SetupGate>
        <Suspense fallback={<Loading />}>
          <Routes>
            <Route path="/setup" element={<SetupPage />} />
            <Route path="/login" element={<LoginPage />} />
            <Route path="/no-access" element={<NoAccess />} />
            <Route
              path="/agent"
              element={
                <RequireAuth permission="agent.use">
                  <AgentConsole />
                </RequireAuth>
              }
            />
            <Route
              path="/admin/*"
              element={
                <RequireAuth>
                  <AdminApp />
                </RequireAuth>
              }
            />
            <Route path="*" element={<Home />} />
          </Routes>
        </Suspense>
      </SetupGate>
      <Toasts />
      <DialogHost />
    </BrowserRouter>
  );
}
