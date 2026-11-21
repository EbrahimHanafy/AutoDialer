import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import Roles from './Roles';
import { api } from '../../lib/api';

vi.mock('../../lib/api', () => ({
  api: {
    get: vi.fn().mockResolvedValue([]),
    post: vi.fn(),
    patch: vi.fn(),
    del: vi.fn(),
  },
  describeError: (error: unknown) => String(error),
}));

afterEach(cleanup);

describe('Roles permission groups', () => {
  it('shows every real export permission in its own group and leaves each one unchecked by default', () => {
    render(<Roles />);
    fireEvent.click(screen.getByRole('button', { name: '+ Add New Role' }));

    const group = screen.getByRole('group', { name: 'Data Export' });
    const calls = within(group).getByRole('checkbox', { name: /Export call records/ }) as HTMLInputElement;
    const leads = within(group).getByRole('checkbox', { name: /Export lead records/ }) as HTMLInputElement;
    const backups = within(group).getByRole('checkbox', { name: /Download database backups/ }) as HTMLInputElement;

    expect(calls.checked).toBe(false);
    expect(leads.checked).toBe(false);
    expect(backups.checked).toBe(false);

    fireEvent.click(calls);
    expect(calls.checked).toBe(true);
    fireEvent.click(calls);
    expect(calls.checked).toBe(false);
  });

  it('shows every Campaign Details tab as an independent unchecked permission', () => {
    render(<Roles />);
    fireEvent.click(screen.getByRole('button', { name: '+ Add New Role' }));

    const group = screen.getByRole('group', { name: 'Campaign Tabs' });
    for (const name of [
      'View campaign overview',
      'View campaign lists',
      'View campaign leads',
      'View campaign agents',
      'View campaign settings',
    ]) {
      const checkbox = within(group).getByRole('checkbox', { name: new RegExp(name) }) as HTMLInputElement;
      expect(checkbox.checked).toBe(false);
    }
  });

  it('shows full customer phone access unchecked for a new custom role', () => {
    render(<Roles />);
    fireEvent.click(screen.getByRole('button', { name: '+ Add New Role' }));
    const checkbox = screen.getByRole('checkbox', { name: /View Full Customer Phone Numbers/ }) as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
  });

  it('shows bulk next-attempt editing as an independent unchecked permission', () => {
    render(<Roles />);
    fireEvent.click(screen.getByRole('button', { name: '+ Add New Role' }));
    const group = screen.getByRole('group', { name: 'Leads' });
    const checkbox = within(group).getByRole('checkbox', { name: /Bulk Edit Next Attempt/ }) as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
  });

  it('shows bulk lead-status editing as an independent unchecked permission', () => {
    render(<Roles />);
    fireEvent.click(screen.getByRole('button', { name: '+ Add New Role' }));
    const group = screen.getByRole('group', { name: 'Leads' });
    const checkbox = within(group).getByRole('checkbox', { name: /Bulk Edit Lead Status/ }) as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
  });

  it('organizes granular campaign operations without the legacy manage permission', () => {
    render(<Roles />);
    fireEvent.click(screen.getByRole('button', { name: '+ Add New Role' }));

    const expected: Record<string, string[]> = {
      'Campaign Access': ['View campaigns', 'Create campaigns', 'Edit campaigns', 'Delete campaigns'],
      'Campaign Status': ['Activate campaigns', 'Pause campaigns', 'Complete campaigns', 'Move campaigns to draft'],
      'Campaign Lists': ['View campaign lists', 'Create campaign lists', 'Edit campaign lists', 'Delete campaign lists', 'Import campaign list data'],
      'Campaign Agents': ['View assigned agents', 'Assign agents', 'Unassign agents'],
      'Campaign Leads': ['View campaign leads', 'Reset campaign leads'],
    };

    for (const [groupName, labels] of Object.entries(expected)) {
      const group = screen.getByRole('group', { name: groupName });
      for (const label of labels) {
        expect((within(group).getByRole('checkbox', { name: new RegExp(label) }) as HTMLInputElement).checked).toBe(false);
      }
    }
    expect(screen.queryByRole('checkbox', { name: /Manage campaigns/ })).toBeNull();
  });

  it('lets an administrator toggle the GSM permission for a built-in role', async () => {
    vi.mocked(api.get).mockResolvedValueOnce([{
      key: 'system:supervisor', id: null, name: 'Supervisor', description: 'Supervisor access',
      system: true, systemRole: 'supervisor', permissions: ['dashboard.view'],
      mutablePermissions: ['dashboard.view_gsm_dongles'], userCount: 1, createdAt: null, updatedAt: null,
    }]);
    vi.mocked(api.patch).mockResolvedValueOnce({});
    render(<Roles />);
    fireEvent.click(await screen.findByRole('button', { name: 'Manage configurable permissions' }));
    const checkbox = screen.getByRole('checkbox', { name: /View GSM Dongles/ }) as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    fireEvent.click(checkbox);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith(
      '/roles/system:supervisor/permissions/dashboard.view_gsm_dongles', { enabled: true },
    ));
  });
});
