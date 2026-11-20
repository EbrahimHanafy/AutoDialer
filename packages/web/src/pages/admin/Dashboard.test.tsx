import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { User, WallboardSnapshot } from '@opendialer/shared';
import { useAuth } from '../../store/auth';
import Dashboard from './Dashboard';

const socketState = vi.hoisted(() => ({
  sockets: [] as { listeners: Map<string, (...args: any[]) => void>; connected: boolean }[],
}));

vi.mock('socket.io-client', () => ({
  io: vi.fn(() => {
    const state = { listeners: new Map<string, (...args: any[]) => void>(), connected: true };
    socketState.sockets.push(state);
    const socket = {
      connected: true,
      on(event: string, listener: (...args: any[]) => void) {
        state.listeners.set(event, listener);
        if (event === 'connect') queueMicrotask(listener);
        return socket;
      },
      emit(event: string, _payload: unknown, ack?: (result: unknown) => void) {
        if (event === 'wallboard:subscribe') ack?.({ ok: true, data: wallboard });
        if (event === 'gsm-dongles:subscribe') ack?.({ ok: true, data: { status: 'available', total: 3, ready: 2, devices: [], refreshedAt: '2026-11-18T10:00:00.000Z' } });
        return socket;
      },
      removeAllListeners() { state.listeners.clear(); return socket; },
      disconnect() { state.connected = false; return socket; },
    };
    return socket;
  }),
}));

vi.mock('../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api')>();
  return { ...actual, api: { ...actual.api, get: vi.fn().mockResolvedValue([]), post: vi.fn() } };
});

const wallboard: WallboardSnapshot = {
  at: '2026-11-18T10:00:00.000Z',
  agents: [],
  campaigns: [],
  today: { calls: 0, answered: 0, contacts: 0, sales: 0, talkSec: 0 },
};

function user(permissions: User['permissions']): User {
  return {
    id: 1, username: 'viewer', displayName: 'Viewer', role: 'admin', customRoleId: null,
    roleKey: 'system:admin', roleName: 'Admin', permissions, active: true,
    sipUsername: null, sipAuthUsername: null, createdAt: '2026-11-18T00:00:00.000Z',
  };
}

afterEach(() => {
  cleanup();
  socketState.sockets.length = 0;
  useAuth.setState({ user: null });
});

describe('GSM Dongles dashboard card', () => {
  it('appears only with its dedicated permission and receives live aggregate updates', async () => {
    useAuth.setState({ user: user(['dashboard.view', 'dashboard.view_gsm_dongles']) });
    render(<MemoryRouter><Dashboard /></MemoryRouter>);
    expect((await screen.findByTestId('gsm-dongles-card')).textContent).toContain('3');
    expect(screen.getByTestId('gsm-dongles-card').textContent).toContain('2 ready');
    expect(screen.getByTestId('gsm-dongles-card').getAttribute('href')).toBe('/admin/gsm-dongles');

    const gsmSocket = socketState.sockets.find((socket) => socket.listeners.has('gsm-dongles:update'))!;
    await act(async () => gsmSocket.listeners.get('gsm-dongles:update')?.({
      status: 'stale', total: 3, ready: 1, devices: [], refreshedAt: '2026-11-18T10:00:10.000Z',
    }));
    expect(screen.getByTestId('gsm-dongles-card').textContent).toContain('Stale');
    expect(screen.getByTestId('gsm-dongles-card').textContent).toContain('1 ready');
  });

  it('is absent without the dedicated permission', () => {
    useAuth.setState({ user: user(['dashboard.view']) });
    render(<MemoryRouter><Dashboard /></MemoryRouter>);
    expect(screen.queryByTestId('gsm-dongles-card')).toBeNull();
  });
});
