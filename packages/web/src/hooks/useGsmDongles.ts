import { useEffect, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { RT_NAMESPACE, type Ack, type GsmDongleSnapshot } from '@opendialer/shared';
import { ApiError, api } from '../lib/api';
import { getServerUrl, getToken } from '../lib/config';
import { useAuth } from '../store/auth';

type Mode = 'socket' | 'polling';

/** Live cached GSM inventory over Socket.IO, with REST polling as a fallback. */
export function useGsmDongles(enabled = true) {
  const [snapshot, setSnapshot] = useState<GsmDongleSnapshot | null>(null);
  const [mode, setMode] = useState<Mode>('socket');

  useEffect(() => {
    if (!enabled || mode !== 'socket') return;
    const socket: Socket = io(getServerUrl() + RT_NAMESPACE, { auth: { token: getToken() ?? '' } });
    socket.on('connect', () => {
      socket.emit('gsm-dongles:subscribe', {}, (result: Ack<GsmDongleSnapshot>) => {
        if (result.ok && result.data) setSnapshot(result.data);
        else setMode('polling');
      });
    });
    socket.on('gsm-dongles:update', (next: GsmDongleSnapshot) => setSnapshot(next));
    socket.on('permissions:changed', () => void useAuth.getState().refreshMe().catch(() => undefined));
    return () => {
      if (socket.connected) socket.emit('gsm-dongles:unsubscribe', {}, () => undefined);
      socket.removeAllListeners();
      socket.disconnect();
    };
  }, [enabled, mode]);

  useEffect(() => {
    if (!enabled || mode !== 'polling') return;
    let stopped = false;
    const tick = async () => {
      try {
        const next = await api.get<GsmDongleSnapshot>('/gsm-dongles');
        if (!stopped) setSnapshot(next);
      } catch (error) {
        if (error instanceof ApiError && error.status === 403) void useAuth.getState().refreshMe().catch(() => undefined);
        if (!stopped) setSnapshot((current) => current?.refreshedAt ? { ...current, status: 'stale' } : {
          status: 'unavailable', total: null, ready: null, devices: [], refreshedAt: null,
        });
      }
    };
    void tick();
    const timer = setInterval(tick, 5_000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [enabled, mode]);

  return { snapshot, mode };
}
