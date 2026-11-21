import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Lead, Permission, User } from '@opendialer/shared';
import { DialogHost } from '../../components/ui';
import { api } from '../../lib/api';
import { useAuth } from '../../store/auth';
import { LeadsTable } from './LeadsTable';

vi.mock('../../lib/api', () => ({
  api: {
    get: vi.fn(),
    patch: vi.fn(),
    del: vi.fn(),
  },
  describeError: (error: unknown) => String(error),
}));

const leads: Lead[] = [1, 2, 3].map((id) => ({
  id,
  listId: 1,
  campaignId: 1,
  phone: `+1415555010${id}`,
  rawPhone: `+1415555010${id}`,
  firstName: `Lead${id}`,
  lastName: 'Test',
  company: '',
  email: '',
  timezone: null,
  custom: {},
  status: 'new',
  attempts: 0,
  lastDispositionId: null,
  lastAttemptAt: null,
  nextAttemptAt: null,
  priority: 0,
  notes: '',
  lockedBy: null,
  lockedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
}));

function userWith(permissions: Permission[]): User {
  return {
    id: 10, username: 'lead-user', displayName: 'Lead User', role: 'agent', customRoleId: 10,
    roleKey: 'custom:10', roleName: 'Lead role', permissions, active: true,
    sipUsername: null, sipAuthUsername: null, createdAt: '2026-01-01T00:00:00.000Z',
  };
}

function renderTable() {
  return render(<><LeadsTable campaignId={1} /><DialogHost /></>);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  act(() => useAuth.setState({ user: null }));
});

describe('Leads bulk next-attempt action', () => {
  it('is hidden without the independent permission', async () => {
    vi.mocked(api.get).mockResolvedValue({ items: leads, page: 1, pageSize: 50, total: leads.length });
    useAuth.setState({ user: userWith(['leads.manage']) });
    renderTable();
    await screen.findByText('Lead1 Test');
    expect(screen.queryByLabelText('Bulk actions')).toBeNull();
    expect(screen.queryByLabelText('Select Lead1 Test')).toBeNull();
  });

  it('updates selected leads, confirms the count, and refreshes the table data', async () => {
    vi.mocked(api.get).mockResolvedValue({ items: leads, page: 1, pageSize: 50, total: leads.length });
    vi.mocked(api.patch).mockResolvedValue({ successCount: 2, failureCount: 0, updatedLeadIds: [1, 2], failures: [] });
    useAuth.setState({ user: userWith(['leads.manage', 'leads.bulkEditNextAttempt']) });
    renderTable();

    fireEvent.click(await screen.findByLabelText('Select Lead1 Test'));
    fireEvent.click(screen.getByLabelText('Select Lead2 Test'));
    expect(screen.getByText('2 selected')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Bulk actions'), { target: { value: 'next-attempt' } });
    const dialog = screen.getByRole('dialog', { name: 'Update Next Attempt' });
    expect(dialog.textContent).toContain('2 leads selected.');
    fireEvent.change(within(dialog).getByLabelText(/Next attempt/), { target: { value: '2026-12-05T14:30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByText(/Update 2 selected leads to/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Update leads' }));
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/leads/bulk/next-attempt', {
      leadIds: [1, 2],
      nextAttemptAt: new Date('2026-12-05T14:30').toISOString(),
    }));
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
  });

  it('keeps failed leads selected after a partial update', async () => {
    vi.mocked(api.get).mockResolvedValue({ items: leads, page: 1, pageSize: 50, total: leads.length });
    vi.mocked(api.patch).mockResolvedValue({
      successCount: 1, failureCount: 1, updatedLeadIds: [1], failures: [{ leadId: 2, error: 'Lead not found' }],
    });
    useAuth.setState({ user: userWith(['leads.manage', 'leads.bulkEditNextAttempt']) });
    renderTable();

    fireEvent.click(await screen.findByLabelText('Select Lead1 Test'));
    fireEvent.click(screen.getByLabelText('Select Lead2 Test'));
    fireEvent.change(screen.getByLabelText('Bulk actions'), { target: { value: 'next-attempt' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Update leads' }));

    await waitFor(() => expect((screen.getByLabelText('Select Lead1 Test') as HTMLInputElement).checked).toBe(false));
    expect((screen.getByLabelText('Select Lead2 Test') as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText('1 selected')).toBeTruthy();
  });

  it('bulk-updates status only when the status permission is granted', async () => {
    vi.mocked(api.get).mockResolvedValue({ items: leads, page: 1, pageSize: 50, total: leads.length });
    vi.mocked(api.patch).mockResolvedValue({ successCount: 2, failureCount: 0, updatedLeadIds: [1, 2], failures: [] });
    useAuth.setState({ user: userWith(['leads.manage', 'leads.bulkEditStatus']) });
    renderTable();

    fireEvent.click(await screen.findByLabelText('Select Lead1 Test'));
    fireEvent.click(screen.getByLabelText('Select Lead2 Test'));
    const actions = screen.getByLabelText('Bulk actions');
    expect(within(actions).queryByRole('option', { name: 'Update Next Attempt' })).toBeNull();
    fireEvent.change(actions, { target: { value: 'status' } });

    const dialog = screen.getByRole('dialog', { name: 'Update Status' });
    expect(dialog.textContent).toContain('2 leads selected.');
    fireEvent.change(within(dialog).getByLabelText(/Status/), { target: { value: 'done' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('Change 2 selected leads to “done”?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Update leads' }));

    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/leads/bulk/status', {
      leadIds: [1, 2], status: 'done',
    }));
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
  });
});
