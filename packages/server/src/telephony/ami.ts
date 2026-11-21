import net from 'node:net';
import crypto from 'node:crypto';
import { amiField, parseAmiPacket, serializeAmiAction, splitAmiStream, type AmiFields } from './amiProtocol.js';

export interface AmiConnectionConfig {
  host: string;
  port: number;
  username: string;
  secret: string;
  /** ms to wait before reconnecting after a drop (default 5000) */
  reconnectMs?: number;
  /** ms an action may take before it is rejected (default 10000) */
  actionTimeoutMs?: number;
}

type EventHandler = (msg: AmiFields) => void;

interface Pending {
  resolve: (msg: AmiFields) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Minimal persistent AMI client: login once, correlate action responses by
 * ActionID, fan out unsolicited events, reconnect with a fixed delay.
 * OriginateResponse arrives as an *event* (not a plain response), so callers
 * that need it subscribe via onEvent and match ActionID themselves.
 */
export class AmiConnection {
  private socket: net.Socket | null = null;
  private buffer = '';
  private loggedIn = false;
  private connecting: Promise<void> | null = null;
  private pending = new Map<string, Pending>();
  private handlers = new Set<EventHandler>();
  private reconnectTimer: NodeJS.Timeout | null = null;
  private closed = false;
  private seq = 0;

  constructor(
    private readonly config: AmiConnectionConfig,
    private readonly log: (msg: string, err?: unknown) => void = () => {},
  ) {}

  get connected(): boolean {
    return this.loggedIn;
  }

  onEvent(handler: EventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  /** Idempotent: resolves once logged in (now or after the next reconnect). */
  connect(): Promise<void> {
    if (this.loggedIn) return Promise.resolve();
    if (!this.connecting) {
      this.connecting = this.open().finally(() => {
        this.connecting = null;
      });
    }
    return this.connecting;
  }

  private open(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new Error('AMI connection closed'));
      const socket = net.createConnection({ host: this.config.host, port: this.config.port });
      this.socket = socket;
      socket.setNoDelay(true);
      let settled = false;
      const fail = (err: Error) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
        this.onSocketDown(err);
      };
      socket.once('error', fail);
      socket.once('close', () => fail(new Error('AMI connection closed')));
      socket.once('connect', () => {
        const actionId = this.nextId('login');
        const timer = setTimeout(() => fail(new Error('AMI login timed out')), this.config.actionTimeoutMs ?? 10_000);
        timer.unref?.();
        this.pending.set(actionId, {
          timer,
          resolve: (msg) => {
            if (!/^success$/i.test(amiField(msg, 'response') ?? '')) {
              fail(new Error(`AMI login failed: ${amiField(msg, 'message') ?? 'unknown error'}`));
              return;
            }
            this.loggedIn = true;
            settled = true;
            resolve();
          },
          reject: fail,
        });
        socket.write(serializeAmiAction({ Action: 'Login', ActionID: actionId, Username: this.config.username, Secret: this.config.secret, Events: 'on' }));
      });
      socket.on('data', (chunk) => this.onData(chunk));
    });
  }

  private onSocketDown(err: Error) {
    const wasLoggedIn = this.loggedIn;
    this.loggedIn = false;
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
    if (wasLoggedIn) this.log('AMI connection lost – will reconnect', err);
    if (!this.closed && !this.reconnectTimer) {
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        if (!this.closed) void this.connect().catch((e) => this.log('AMI reconnect failed', e));
      }, this.config.reconnectMs ?? 5000);
      this.reconnectTimer.unref?.();
    }
  }

  private onData(chunk: Buffer) {
    this.buffer += chunk.toString('utf8');
    const { packets, rest } = splitAmiStream(this.buffer);
    this.buffer = rest;
    for (const raw of packets) {
      const msg = parseAmiPacket(raw);
      const actionId = amiField(msg, 'actionid');
      const pending = actionId ? this.pending.get(actionId) : undefined;
      // A packet with a Response field answers a pending action; events
      // (including OriginateResponse, which also carries Response) are fanned
      // out first so subscribers never miss one.
      const isEvent = Boolean(amiField(msg, 'event'));
      if (isEvent) for (const h of [...this.handlers]) {
        try {
          h(msg);
        } catch (err) {
          this.log('AMI event handler failed', err);
        }
      }
      if (pending && amiField(msg, 'response')) {
        this.pending.delete(actionId!);
        clearTimeout(pending.timer);
        pending.resolve(msg);
      }
    }
  }

  nextId(prefix: string): string {
    return `${prefix}-${++this.seq}-${crypto.randomUUID().slice(0, 8)}`;
  }

  /** Send an action and resolve with its response packet. */
  async sendAction(fields: Record<string, string | string[]>, timeoutMs?: number): Promise<AmiFields> {
    await this.connect();
    if (!this.socket || !this.loggedIn) throw new Error('AMI is not connected');
    const actionId = fields.ActionID ? String(fields.ActionID) : this.nextId(String(fields.Action ?? 'action').toLowerCase());
    const timeout = timeoutMs ?? this.config.actionTimeoutMs ?? 10_000;
    return new Promise<AmiFields>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(actionId);
        reject(new Error(`AMI action ${String(fields.Action)} timed out`));
      }, timeout);
      timer.unref?.();
      this.pending.set(actionId, { resolve, reject, timer });
      this.socket!.write(serializeAmiAction({ ...fields, ActionID: actionId }));
    });
  }

  close() {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('AMI connection closed'));
    }
    this.pending.clear();
    this.socket?.destroy();
    this.socket = null;
    this.loggedIn = false;
  }
}
