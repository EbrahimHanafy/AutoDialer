import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Permission, User } from '@opendialer/shared';
import Reports from './Reports';
import System from './System';
import { useAuth } from '../../store/auth';

vi.mock('../../lib/api', () => ({
  api: {
    get: vi.fn(async (path: string) => {
      if (path === '/reports/dispositions') return { dispositions: [], undisposed: 0 };
      if (path === '/admin/system') return { version: '1', node: 'test', uptimeSec: 1, dataDir: '/data', dbBytes: 1, agentsOnline: 0, memoryMb: 1 };
      if (path === '/admin/backups') return [{ file: 'backup.sqlite', bytes: 1, at: '2026-01-01T00:00:00.000Z' }];
      return [];
    }),
    post: vi.fn(),
  },
  downloadFile: vi.fn(),
  describeError: (error: unknown) => String(error),
}));

function userWith(permissions: Permission[]): User {
  return {
    id: 10,
    username: 'custom',
    displayName: 'Custom User',
    role: 'agent',
    customRoleId: 1,
    roleKey: 'custom:1',
    roleName: 'Custom',
    permissions,
    active: true,
    sipUsername: null,
    sipAuthUsername: null,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

afterEach(() => {
  cleanup();
  useAuth.setState({ user: null });
});

describe('export button visibility', () => {
  it('allows reports to remain visible while independently hiding, granting, and revoking each CSV export', () => {
    useAuth.setState({ user: userWith(['reports.view']) });
    render(<Reports />);

    expect(screen.getByRole('heading', { name: 'Reports' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Export calls CSV' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Export leads CSV' })).toBeNull();

    act(() => useAuth.setState({ user: userWith(['reports.view', 'calls.export']) }));
    expect(screen.getByRole('button', { name: 'Export calls CSV' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Export leads CSV' })).toBeNull();

    act(() => useAuth.setState({ user: userWith(['reports.view', 'calls.export', 'leads.export']) }));
    expect(screen.getByRole('button', { name: 'Export leads CSV' })).toBeTruthy();

    act(() => useAuth.setState({ user: userWith(['reports.view']) }));
    expect(screen.queryByRole('button', { name: 'Export calls CSV' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Export leads CSV' })).toBeNull();
  });

  it('keeps backup management visible while independently hiding, granting, and revoking backup downloads', async () => {
    useAuth.setState({ user: userWith(['system.manage']) });
    render(<System />);

    expect(await screen.findByText('backup.sqlite')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Back up now' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Download' })).toBeNull();

    act(() => useAuth.setState({ user: userWith(['system.manage', 'backups.export']) }));
    expect(screen.getByRole('button', { name: 'Download' })).toBeTruthy();

    act(() => useAuth.setState({ user: userWith(['system.manage']) }));
    expect(screen.queryByRole('button', { name: 'Download' })).toBeNull();
  });
});
