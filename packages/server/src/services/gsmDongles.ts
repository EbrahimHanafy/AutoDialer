import { EventEmitter } from 'node:events';
import net from 'node:net';
import crypto from 'node:crypto';
import type { GsmDongleDevice, GsmDongleSnapshot } from '@opendialer/shared';
import type { Config } from '../config.js';
import type { Logger } from '../logger.js';

export interface DongleInventory {
  total: number;
  ready: number;
  devices: GsmDongleDevice[];
}

type AmiFields = Map<string, string[]>;

function field(message: AmiFields, name: string): string | undefined {
  return message.get(name.toLowerCase())?.[0];
}

function parseAmiMessage(raw: string): AmiFields {
  const fields: AmiFields = new Map();
  for (const line of raw.split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    fields.set(key, [...(fields.get(key) ?? []), value]);
  }
  return fields;
}

function isReadyState(state: string): boolean {
  return /^(free|ready|connected)$/i.test(state.trim());
}

function optionalField(message: AmiFields, name: string): string | null {
  const value = field(message, name)?.trim();
  return value && !/^(unknown|none)$/i.test(value) ? value : null;
}

function optionalFieldAny(message: AmiFields, ...names: string[]): string | null {
  for (const name of names) {
    const value = optionalField(message, name);
    if (value) return value;
  }
  return null;
}

function imeiLast4(value: string | null): string | null {
  const digits = value?.replace(/\D/g, '') ?? '';
  return digits.length >= 4 ? digits.slice(-4) : null;
}

/** Final outbound boundary: copy only approved fields and truncate IMEI again. */
function exposedDevice(device: GsmDongleDevice): GsmDongleDevice {
  return {
    name: device.name,
    state: device.state,
    imeiLast4: imeiLast4(device.imeiLast4),
    group: device.group ?? null,
    rssi: device.rssi ?? null,
    mode: device.mode ?? null,
    submode: device.submode ?? null,
    provider: device.provider ?? null,
    model: device.model ?? null,
    firmware: device.firmware ?? null,
  };
}

export function inventoryFromAmiEntries(entries: readonly AmiFields[]): DongleInventory {
  const devices = new Map<string, GsmDongleDevice>();
  for (const entry of entries) {
    const name = field(entry, 'device')?.trim();
    const state = field(entry, 'state')?.trim();
    if (!name || !state) continue;
    devices.set(name, {
      name,
      state,
      imeiLast4: imeiLast4(optionalFieldAny(entry, 'imeistate', 'imei')),
      group: optionalField(entry, 'group'),
      rssi: optionalField(entry, 'rssi'),
      mode: optionalField(entry, 'mode'),
      submode: optionalField(entry, 'submode'),
      provider: optionalFieldAny(entry, 'providername', 'provider'),
      model: optionalField(entry, 'model'),
      firmware: optionalField(entry, 'firmware'),
    });
  }
  const list = [...devices.values()];
  return { total: list.length, ready: list.filter((device) => isReadyState(device.state)).length, devices: list };
}

function valueAt(line: string, start: number, end: number): string | null {
  if (start < 0) return null;
  const value = line.slice(start, end < 0 ? undefined : end).trim();
  return value && !/^(unknown|none)$/i.test(value) ? value : null;
}

/** Parse operational columns from the fixed-width `dongle show devices` table. */
export function parseDongleShowDevices(output: string | readonly string[]): DongleInventory {
  const lines = (Array.isArray(output) ? [...output] : String(output).split(/\r?\n/)).map((line) => line.replace(/^Output:\s*/i, ''));
  const headerIndex = lines.findIndex((line) => /^\s*ID\s+Group\s+State\s+RSSI\b/i.test(line));
  if (headerIndex < 0) throw new Error('Unexpected dongle device response');
  const header = lines[headerIndex];
  const idAt = header.search(/\bID\b/i);
  const groupAt = header.search(/\bGroup\b/i);
  const stateAt = header.search(/\bState\b/i);
  const rssiAt = header.search(/\bRSSI\b/i);
  if (idAt < 0 || groupAt <= idAt || stateAt <= groupAt || rssiAt <= stateAt) throw new Error('Unexpected dongle device columns');

  const modeAt = header.search(/\bMode\b/i);
  const submodeAt = header.search(/\bSubmode\b/i);
  const providerAt = header.search(/\bProvider Name\b/i);
  const modelAt = header.search(/\bModel\b/i);
  const firmwareAt = header.search(/\bFirmware\b/i);
  const imeiAt = header.search(/\bIMEI\b/i);
  const imsiAt = header.search(/\bIMSI\b/i);
  const devices = new Map<string, GsmDongleDevice>();
  for (const line of lines.slice(headerIndex + 1)) {
    if (!line.trim() || /^--END COMMAND--$/i.test(line.trim())) continue;
    const name = line.slice(idAt, groupAt).trim();
    const group = line.slice(groupAt, stateAt).trim();
    const state = line.slice(stateAt, rssiAt).trim();
    if (!name || !/^-?\d+$/.test(group) || !state) throw new Error('Unexpected dongle device row');
    devices.set(name, {
      name,
      state,
      group,
      rssi: valueAt(line, rssiAt, modeAt),
      mode: valueAt(line, modeAt, submodeAt),
      submode: valueAt(line, submodeAt, providerAt),
      provider: valueAt(line, providerAt, modelAt),
      model: valueAt(line, modelAt, firmwareAt),
      firmware: valueAt(line, firmwareAt, imeiAt),
      imeiLast4: imeiLast4(valueAt(line, imeiAt, imsiAt)),
    });
  }
  const list = [...devices.values()];
  return { total: list.length, ready: list.filter((device) => isReadyState(device.state)).length, devices: list };
}

class AmiActionError extends Error {}

function safeActionValue(value: string): string {
  if (/\r|\n/.test(value)) throw new Error('Invalid AMI configuration');
  return value;
}

function amiAction(fields: Record<string, string>): string {
  return Object.entries(fields).map(([key, value]) => `${key}: ${safeActionValue(value)}`).join('\r\n') + '\r\n\r\n';
}

interface AmiMonitorConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  timeoutMs: number;
  allowCommandFallback: boolean;
}

export class AsteriskDongleClient {
  private dedicatedSupported: boolean | null = null;

  constructor(private readonly config: AmiMonitorConfig) {}

  async query(): Promise<DongleInventory> {
    if (this.dedicatedSupported !== false) {
      try {
        const counts = await this.run('dedicated');
        this.dedicatedSupported = true;
        return counts;
      } catch (error) {
        const unsupported = error instanceof AmiActionError && /invalid|unknown|not registered|does not exist/i.test(error.message);
        if (!unsupported || !this.config.allowCommandFallback) throw error;
        this.dedicatedSupported = false;
      }
    }
    if (!this.config.allowCommandFallback) throw new Error('DongleShowDevices is unavailable');
    return this.run('command');
  }

  private run(kind: 'dedicated' | 'command'): Promise<DongleInventory> {
    const cfg = this.config;
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: cfg.host, port: cfg.port });
      const loginId = `gsm-login-${crypto.randomUUID()}`;
      const queryId = `gsm-query-${crypto.randomUUID()}`;
      const entries: AmiFields[] = [];
      let buffer = '';
      let loggedIn = false;
      let settled = false;

      const finish = (error?: Error, value?: DongleInventory) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (error) reject(error);
        else resolve(value!);
      };

      const timer = setTimeout(() => finish(new Error('Asterisk AMI request timed out')), cfg.timeoutMs);
      timer.unref?.();
      socket.setNoDelay(true);
      socket.once('error', (error) => finish(error));
      socket.once('close', () => finish(new Error('Asterisk AMI connection closed')));
      socket.once('connect', () => {
        socket.write(amiAction({ Action: 'Login', ActionID: loginId, Username: cfg.username, Secret: cfg.password, Events: 'off' }));
      });

      const handleMessage = (message: AmiFields) => {
        const actionId = field(message, 'actionid');
        const response = field(message, 'response');
        const event = field(message, 'event');

        if (!loggedIn && response && (!actionId || actionId === loginId)) {
          if (!/^success$/i.test(response)) return finish(new Error('Asterisk AMI login failed'));
          loggedIn = true;
          socket.write(kind === 'dedicated'
            ? amiAction({ Action: 'DongleShowDevices', ActionID: queryId })
            : amiAction({ Action: 'Command', ActionID: queryId, Command: 'dongle show devices' }));
          return;
        }
        if (!loggedIn || (actionId && actionId !== queryId)) return;
        if (/^error$/i.test(response ?? '')) return finish(new AmiActionError(field(message, 'message') ?? 'AMI action failed'));

        if (kind === 'command' && response) {
          const output = message.get('output') ?? [];
          try {
            finish(undefined, parseDongleShowDevices(output));
          } catch (error) {
            finish(error as Error);
          }
          return;
        }
        if (/^DongleDeviceEntry$/i.test(event ?? '')) entries.push(message);
        if (/^DongleShowDevicesComplete$/i.test(event ?? '')) {
          const listed = Number(field(message, 'listitems'));
          const inventory = inventoryFromAmiEntries(entries);
          if (!Number.isInteger(listed) || listed < 0 || listed !== inventory.total) return finish(new Error('Unexpected DongleShowDevices result'));
          finish(undefined, inventory);
        }
      };

      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        while (true) {
          const crlf = buffer.indexOf('\r\n\r\n');
          const lf = buffer.indexOf('\n\n');
          const end = crlf < 0 ? lf : lf < 0 ? crlf : Math.min(crlf, lf);
          if (end < 0) break;
          const delimiterLength = end === crlf ? 4 : 2;
          const raw = buffer.slice(0, end);
          buffer = buffer.slice(end + delimiterLength);
          handleMessage(parseAmiMessage(raw));
        }
      });
    });
  }
}

export type DongleQuery = () => Promise<DongleInventory>;

export class GsmDongleMonitor extends EventEmitter {
  private snapshot: GsmDongleSnapshot;
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  private stopped = true;
  private readonly query: DongleQuery;

  constructor(
    private readonly config: Config['gsmDongleMonitor'],
    private readonly log: Logger,
    query?: DongleQuery,
  ) {
    super();
    const client = query ? null : new AsteriskDongleClient(config);
    this.query = query ?? client!.query.bind(client);
    this.snapshot = {
      status: config.enabled ? 'loading' : 'unavailable',
      total: null,
      ready: null,
      devices: [],
      refreshedAt: null,
    };
  }

  getSnapshot(): GsmDongleSnapshot {
    return { ...this.snapshot, devices: this.snapshot.devices.map((device) => ({ ...device })) };
  }

  start() {
    if (!this.config.enabled || !this.stopped) return;
    this.stopped = false;
    void this.pollNow();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  pollNow(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.poll().finally(() => {
      this.inFlight = null;
      if (!this.stopped) {
        this.timer = setTimeout(() => void this.pollNow(), this.config.intervalMs);
        this.timer.unref?.();
      }
    });
    return this.inFlight;
  }

  private async poll() {
    try {
      const inventory = await this.query();
      if (!Number.isInteger(inventory.total) || inventory.total < 0 || !Number.isInteger(inventory.ready) || inventory.ready < 0 || inventory.ready > inventory.total || !Array.isArray(inventory.devices) || inventory.devices.length !== inventory.total) {
        throw new Error('Invalid GSM Dongle counts');
      }
      const devices = inventory.devices.map(exposedDevice);
      this.snapshot = { status: 'available', total: inventory.total, ready: inventory.ready, devices, refreshedAt: new Date().toISOString() };
    } catch (error) {
      this.log.warn({ err: error }, 'GSM Dongle monitoring refresh failed');
      this.snapshot = {
        ...this.snapshot,
        status: this.snapshot.refreshedAt ? 'stale' : 'unavailable',
        total: this.snapshot.refreshedAt ? this.snapshot.total : null,
        ready: this.snapshot.refreshedAt ? this.snapshot.ready : null,
        devices: this.snapshot.refreshedAt ? this.snapshot.devices : [],
      };
    }
    this.emit('update', this.getSnapshot());
  }

  onUpdate(handler: (snapshot: GsmDongleSnapshot) => void) {
    this.on('update', handler);
    return () => this.off('update', handler);
  }
}
