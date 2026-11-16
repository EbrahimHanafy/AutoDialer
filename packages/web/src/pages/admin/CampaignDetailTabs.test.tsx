import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { Permission, User } from '@opendialer/shared';
import CampaignDetail from './CampaignDetail';
import { useAuth } from '../../store/auth';

vi.mock('../../lib/api', () => ({
  api: {
    get: vi.fn(async (path: string) => {
      if (path === '/campaigns/1') return { id: 1, name: 'Permission campaign', status: 'draft', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
      if (path === '/campaigns/1/lists') return [];
      if (path === '/leads') return { items: [], page: 1, pageSize: 50, total: 0 };
      return {};
    }),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    del: vi.fn(),
  },
  downloadFile: vi.fn(),
  describeError: (error: unknown) => String(error),
}));

function userWith(permissions: Permission[]): User {
  return {
    id: 20,
    username: 'tab-user',
    displayName: 'Tab User',
    role: 'agent',
    customRoleId: 20,
    roleKey: 'custom:20',
    roleName: 'Tab role',
    permissions,
    active: true,
    sipUsername: null,
    sipAuthUsername: null,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

function LocationProbe() {
  const location = useLocation();
  return <span data-testid="location">{location.pathname + location.search}</span>;
}

function renderDetail(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <LocationProbe />
      <Routes>
        <Route path="/admin/campaigns" element={<div>Campaign list</div>} />
        <Route path="/admin/campaigns/:id" element={<CampaignDetail />} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  act(() => useAuth.setState({ user: null }));
});

describe('Campaign Details tabs', () => {
  it('shows a single permitted tab and redirects an unauthorized direct tab URL', async () => {
    useAuth.setState({ user: userWith(['campaigns.tabs.lists.view']) });
    renderDetail('/admin/campaigns/1?tab=settings');

    expect(await screen.findByRole('heading', { name: 'Permission campaign' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Lists & import' })).toBeTruthy();
    expect(screen.queryByRole('tab', { name: 'Overview' })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Settings' })).toBeNull();
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/admin/campaigns/1?tab=lists'));
    expect(screen.queryByRole('button', { name: 'Create list' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Reset leads/ })).toBeNull();
  });

  it('shows only the selected subset of tabs', async () => {
    useAuth.setState({ user: userWith(['campaigns.tabs.overview.view', 'campaigns.tabs.leads.view']) });
    renderDetail('/admin/campaigns/1?tab=leads');

    expect(await screen.findByRole('tab', { name: 'Overview' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Leads' })).toBeTruthy();
    expect(screen.queryByRole('tab', { name: 'Lists & import' })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Agents' })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Settings' })).toBeNull();
    expect(screen.getByTestId('location').textContent).toBe('/admin/campaigns/1?tab=leads');
  });

  it('redirects away from Campaign Details when no tab permission exists', async () => {
    useAuth.setState({ user: userWith([]) });
    renderDetail('/admin/campaigns/1?tab=overview');
    expect(await screen.findByText('Campaign list')).toBeTruthy();
    expect(screen.getByTestId('location').textContent).toBe('/admin/campaigns');
  });

  it('shows only the independently granted campaign status action', async () => {
    useAuth.setState({ user: userWith(['campaigns.tabs.lists.view', 'campaigns.lists.view', 'campaigns.status.activate']) });
    renderDetail('/admin/campaigns/1?tab=lists');

    expect(await screen.findByRole('button', { name: 'Activate' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Complete' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
  });

  it('separates list creation and lead reset controls', async () => {
    useAuth.setState({ user: userWith(['campaigns.tabs.lists.view', 'campaigns.lists.view', 'campaigns.lists.create']) });
    const first = renderDetail('/admin/campaigns/1?tab=lists');
    expect(await screen.findByRole('button', { name: 'Create list' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Reset leads/ })).toBeNull();
    first.unmount();

    useAuth.setState({ user: userWith(['campaigns.tabs.lists.view', 'campaigns.lists.view', 'campaigns.leads.reset']) });
    renderDetail('/admin/campaigns/1?tab=lists');
    expect(await screen.findByRole('button', { name: /Reset leads/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Create list' })).toBeNull();
  });
});
