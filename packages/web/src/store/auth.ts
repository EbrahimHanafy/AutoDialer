import { create } from 'zustand';
import { CAMPAIGN_TAB_PERMISSIONS, grantsPermission, SYSTEM_ROLE_PERMISSIONS, type Permission, type PublicSettings, type Settings, type User } from '@opendialer/shared';
import { api, request } from '../lib/api';
import { getToken, setToken } from '../lib/config';

interface AuthStore {
  token: string | null;
  user: User | null;
  settings: Settings | null;
  publicSettings: PublicSettings | null;
  /** null = not checked yet */
  serverError: string | null;
  booted: boolean;
  boot: () => Promise<void>;
  loadPublic: () => Promise<PublicSettings | null>;
  login: (username: string, password: string) => Promise<User>;
  acceptSession: (token: string, user: User) => Promise<void>;
  refreshMe: () => Promise<void>;
  setSettings: (s: Settings) => void;
  logout: () => void;
  /** called by the API layer on 401 */
  expire: () => void;
}

export const useAuth = create<AuthStore>((set, get) => ({
  token: getToken(),
  user: null,
  settings: null,
  publicSettings: null,
  serverError: null,
  booted: false,

  boot: async () => {
    await get().loadPublic();
    if (getToken()) {
      try {
        await get().refreshMe();
      } catch {
        /* expired / unreachable – login page */
      }
    }
    set({ booted: true });
  },

  loadPublic: async () => {
    try {
      const p = await api.get<PublicSettings>('/settings/public');
      set({ publicSettings: p, serverError: null });
      return p;
    } catch (err) {
      set({ serverError: (err as Error).message });
      return null;
    }
  },

  login: async (username, password) => {
    const r = await request<{ token: string; user: User }>('POST', '/auth/login', { body: { username, password }, noAuthRedirect: true });
    await get().acceptSession(r.token, r.user);
    return r.user;
  },

  acceptSession: async (token, user) => {
    setToken(token);
    set({ token, user });
    await get().refreshMe();
  },

  refreshMe: async () => {
    const me = await api.get<{ user: User; settings: Settings | null }>('/auth/me');
    set({ user: me.user, settings: me.settings, token: getToken() });
  },

  setSettings: (s) => set({ settings: s }),

  logout: () => {
    setToken(null);
    set({ token: null, user: null, settings: null });
  },

  expire: () => {
    if (!get().token && !get().user) return;
    set({ token: null, user: null, settings: null });
  },
}));

export const hasPermission = (user: Pick<User, 'role' | 'permissions'> | null | undefined, permission: Permission) =>
  Boolean(user && grantsPermission(user.permissions ?? SYSTEM_ROLE_PERMISSIONS[user.role], permission));
export const isSystemAdmin = (user: Pick<User, 'role' | 'customRoleId'> | null | undefined) => Boolean(user && user.role === 'admin' && user.customRoleId == null);

const ADMIN_LANDING: { permission: Permission; path: string }[] = [
  { permission: 'dashboard.view', path: '/admin/dashboard' },
  { permission: 'campaigns.view', path: '/admin/campaigns' },
  { permission: 'campaigns.create', path: '/admin/campaigns' },
  ...Object.values(CAMPAIGN_TAB_PERMISSIONS).map((permission) => ({ permission, path: '/admin/campaigns' })),
  { permission: 'leads.manage', path: '/admin/leads' },
  { permission: 'callbacks.manage', path: '/admin/callbacks' },
  { permission: 'calls.manage', path: '/admin/calls' },
  { permission: 'reports.view', path: '/admin/reports' },
  { permission: 'scripts.manage', path: '/admin/scripts' },
  { permission: 'dispositions.view', path: '/admin/dispositions' },
  { permission: 'dispositions.manage', path: '/admin/dispositions' },
  { permission: 'dnc.manage', path: '/admin/dnc' },
  { permission: 'users.view', path: '/admin/users' },
  { permission: 'users.manage', path: '/admin/users' },
  { permission: 'settings.view', path: '/admin/settings' },
  { permission: 'settings.manage', path: '/admin/settings' },
  { permission: 'integrations.manage', path: '/admin/integrations' },
  { permission: 'audit.view', path: '/admin/audit' },
  { permission: 'system.manage', path: '/admin/system' },
];
export const adminPathFor = (user: User | null | undefined) => ADMIN_LANDING.find((x) => hasPermission(user, x.permission))?.path ?? null;
