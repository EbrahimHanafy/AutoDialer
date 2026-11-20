import type { Server as HttpServer } from 'node:http';
import type { Server as HttpsServer } from 'node:https';
import { Server, type Socket } from 'socket.io';
import { RT_NAMESPACE, type Ack, type ClientToServerEvents, type ServerToClientEvents } from '@opendialer/shared';
import type { AuthUser } from './auth.js';
import { hasPermission, userFromToken } from './auth.js';
import type { Ctx } from './context.js';
import type { Engine } from './engine.js';
import type { GsmDongleMonitor } from './services/gsmDongles.js';
import { HttpError } from './errors.js';
import { tableWallboard } from './services/phonePrivacy.js';

type RtSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, { user: AuthUser; token: string; replaced?: boolean }>;

export function createRealtime(ctx: Ctx, engine: Engine, gsmDongles: GsmDongleMonitor, servers: (HttpServer | HttpsServer)[]) {
  const io = new Server<ClientToServerEvents, ServerToClientEvents>({
    cors: { origin: ctx.config.corsOrigins.length ? ctx.config.corsOrigins : true, credentials: true },
    pingInterval: 10000,
    pingTimeout: 20000,
    maxHttpBufferSize: 1e6,
  });
  for (const s of servers) io.attach(s);
  const nsp = io.of(RT_NAMESPACE);
  /**
   * The one socket per user that acts as the agent console (set on agent:join).
   * A user may hold other sockets at the same time (e.g. a supervisor's wallboard tab);
   * those never receive agent events and never replace the console.
   */
  const sockets = new Map<number, RtSocket>();

  gsmDongles.onUpdate((snapshot) => {
    const subscribers = nsp.adapter.rooms.get('gsm-dongles');
    if (!subscribers) return;
    for (const socketId of [...subscribers]) {
      const socket = nsp.sockets.get(socketId) as RtSocket | undefined;
      if (!socket) continue;
      const live = userFromToken(ctx, socket.data.token);
      if (!live || !hasPermission(live, 'dashboard.view_gsm_dongles')) {
        socket.leave('gsm-dongles');
        continue;
      }
      Object.assign(socket.data.user, live);
      socket.emit('gsm-dongles:update', snapshot);
    }
  });

  ctx.bus.onDomain('roles.changed', () => {
    for (const raw of nsp.sockets.values()) {
      const socket = raw as RtSocket;
      const live = userFromToken(ctx, socket.data.token);
      if (!live) continue;
      Object.assign(socket.data.user, live);
      if (!hasPermission(live, 'dashboard.view_gsm_dongles')) socket.leave('gsm-dongles');
      socket.emit('permissions:changed');
    }
  });

  nsp.use((socket, next) => {
    const token = (socket.handshake.auth as { token?: string })?.token;
    const user = userFromToken(ctx, token);
    if (!user) return next(new Error('unauthorized'));
    (socket as RtSocket).data.user = user;
    (socket as RtSocket).data.token = token!;
    next();
  });

  engine.setTransport({
    toUser: (userId, event, ...args) => {
      const s = sockets.get(userId);
      if (s) (s.emit as (...a: unknown[]) => void)(event, ...args);
    },
    toSupervisors: (event, ...args) => {
      const subscribers = nsp.adapter.rooms.get('wallboard');
      if (!subscribers) return;
      for (const socketId of [...subscribers]) {
        const socket = nsp.sockets.get(socketId) as RtSocket | undefined;
        if (!socket) continue;
        const live = userFromToken(ctx, socket.data.token);
        if (!live || !hasPermission(live, 'dashboard.view')) {
          socket.leave('wallboard');
          continue;
        }
        Object.assign(socket.data.user, live);
        const protectedArgs = event === 'wallboard:update'
          ? [tableWallboard(args[0] as Parameters<ServerToClientEvents['wallboard:update']>[0], hasPermission(live, 'leads.viewFullPhoneNumbers'))]
          : args;
        (socket.emit as (...a: unknown[]) => void)(event, ...protectedArgs);
      }
    },
    supervisorCount: () => nsp.adapter.rooms.get('wallboard')?.size ?? 0,
  });

  const handle =
    <P, R>(socket: RtSocket, fn: (p: P) => R) =>
    (p: P, ack?: (r: Ack<R>) => void) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      try {
        const live = userFromToken(ctx, socket.data.token);
        if (!live) throw new HttpError(401, 'unauthorized');
        Object.assign(socket.data.user, live);
        reply({ ok: true, data: fn(p ?? ({} as P)) });
      } catch (err) {
        const msg = err instanceof HttpError ? err.message : (err as Error)?.message ?? 'error';
        if (!(err instanceof HttpError)) ctx.log.error({ err, user: socket.data.user.username }, 'socket handler failed');
        reply({ ok: false, error: msg });
      }
    };

  nsp.on('connection', (raw) => {
    const socket = raw as RtSocket;
    const user = socket.data.user;
    ctx.log.info({ user: user.username, socket: socket.id }, 'socket connected');

    /** Only the current console socket may drive the agent session. */
    const console_ = <P, R>(fn: (p: P) => R) =>
      handle(socket, (p: P) => {
        if (!hasPermission(user, 'agent.use')) throw new HttpError(403, 'Insufficient permission');
        if (sockets.get(user.id) !== socket) throw new HttpError(409, 'This tab is no longer the active agent console – join again');
        return fn(p);
      });

    socket.on(
      'agent:join',
      handle(socket, (p: { campaignId: number | null }) => {
        if (!hasPermission(user, 'agent.use')) throw new HttpError(403, 'Insufficient permission');
        const previous = sockets.get(user.id);
        if (previous && previous.id !== socket.id) {
          previous.emit('session:replaced');
          previous.data.replaced = true;
          sockets.delete(user.id);
        }
        sockets.set(user.id, socket);
        engine.reconnected(user.id);
        return engine.join(user, p.campaignId ?? null);
      }),
    );
    socket.on('agent:ready', console_(() => engine.ready(user.id)));
    socket.on('agent:pause', console_((p: { code: string }) => engine.pause(user.id, String(p.code ?? 'Pause').slice(0, 40))));
    socket.on(
      'agent:leave',
      console_(() => {
        engine.leave(user.id);
        sockets.delete(user.id);
      }),
    );
    socket.on('lead:skip', console_((p: { leadId: number; requeue: boolean }) => engine.skip(user.id, Number(p.leadId), p.requeue !== false)));
    socket.on('lead:dial', console_((p: { leadId: number }) => engine.dial(user.id, Number(p.leadId))));
    socket.on(
      'manual:dial',
      console_((p: { phone: string; campaignId?: number | null; leadId?: number | null }) =>
        engine.manualDial(user.id, String(p.phone ?? ''), p.campaignId ?? null, p.leadId ?? null),
      ),
    );
    socket.on('call:update', console_((p: Parameters<ClientToServerEvents['call:update']>[0]) => engine.callUpdate(user.id, p)));
    socket.on('call:dispose', console_((p: Parameters<ClientToServerEvents['call:dispose']>[0]) => engine.dispose(user.id, p)));
    socket.on(
      'wallboard:subscribe',
      handle(socket, () => {
        if (!hasPermission(user, 'dashboard.view')) throw new HttpError(403, 'Insufficient permission');
        socket.join('wallboard');
        return tableWallboard(engine.snapshot(), hasPermission(user, 'leads.viewFullPhoneNumbers'));
      }),
    );
    socket.on(
      'wallboard:unsubscribe',
      handle(socket, () => {
        socket.leave('wallboard');
        return undefined;
      }),
    );
    socket.on(
      'gsm-dongles:subscribe',
      handle(socket, () => {
        if (!hasPermission(user, 'dashboard.view_gsm_dongles')) throw new HttpError(403, 'Insufficient permission');
        socket.join('gsm-dongles');
        return gsmDongles.getSnapshot();
      }),
    );
    socket.on(
      'gsm-dongles:unsubscribe',
      handle(socket, () => {
        socket.leave('gsm-dongles');
        return undefined;
      }),
    );

    socket.on('disconnect', (reason) => {
      // only the active console socket owns the agent session; dashboards and replaced tabs just go away
      if (socket.data.replaced || sockets.get(user.id) !== socket) return;
      sockets.delete(user.id);
      ctx.log.info({ user: user.username, reason }, 'agent console disconnected');
      engine.disconnected(user.id);
    });
  });

  return { io, nsp, sockets };
}
