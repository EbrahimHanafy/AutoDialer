import net from 'node:net';
import type { AddressInfo } from 'node:net';
import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GsmDongleDevice } from '@opendialer/shared';
import { AsteriskDongleClient, GsmDongleMonitor, parseDongleShowDevices, type DongleInventory } from '../services/gsmDongles.js';

const log = pino({ level: 'silent' });
const config = {
  enabled: true,
  host: '127.0.0.1',
  port: 5038,
  username: 'monitor',
  password: 'secret',
  intervalMs: 10_000,
  timeoutMs: 100,
  allowCommandFallback: false,
};

const cliWidths = [12, 7, 14, 6, 7, 10, 18, 12, 18, 18, 18, 15];

function tableLine(values: string[]) {
  return values.map((value, index) => value.padEnd(cliWidths[index] ?? 1)).join(' ');
}

function cliHeader() {
  return tableLine(['ID', 'Group', 'State', 'RSSI', 'Mode', 'Submode', 'Provider Name', 'Model', 'Firmware', 'IMEI', 'IMSI', 'Number']);
}

function cliLine(id: string, group: string, state: string, rssi = '20', imei = '123456789012345') {
  return tableLine([id, group, state, rssi, '5', '7', 'Vodafone', 'E173', '11.126.85.00', imei, 'sensitive', 'sensitive']);
}

function device(name: string, state: string, imeiLast4: string | null = null): GsmDongleDevice {
  return { name, state, imeiLast4, group: null, rssi: null, mode: null, submode: null, provider: null, model: null, firmware: null };
}

function inventory(...states: string[]): DongleInventory {
  const devices = states.map((state, index) => device(`dongle${index}`, state));
  return { total: devices.length, ready: devices.filter((item) => /^(free|ready|connected)$/i.test(item.state)).length, devices };
}

afterEach(() => vi.useRealTimers());

describe('GSM Dongle response parsing', () => {
  it('returns operational devices, counts ready states, and keeps only the last four IMEI digits', () => {
    const fullImei = '123456789012345';
    const output = [
      cliHeader(),
      cliLine('dongle0', '0', 'Free', '20', fullImei),
      cliLine('dongle1', '0', 'Not connec', '0'),
      cliLine('dongle2', '1', 'Ready'),
    ];
    const result = parseDongleShowDevices(output);
    expect(result).toMatchObject({ total: 3, ready: 2 });
    expect(result.devices[0]).toMatchObject({ name: 'dongle0', state: 'Free', imeiLast4: '2345', provider: 'Vodafone' });
    expect(JSON.stringify(result)).not.toContain(fullImei);
  });

  it('accepts a valid empty device table as zero', () => {
    expect(parseDongleShowDevices([cliHeader(), '--END COMMAND--'])).toEqual({ total: 0, ready: 0, devices: [] });
  });

  it('rejects malformed output instead of reporting a false zero', () => {
    expect(() => parseDongleShowDevices('Asterisk module unavailable')).toThrow(/Unexpected dongle device response/);
    expect(() => parseDongleShowDevices([cliHeader(), 'malformed device row'])).toThrow(/Unexpected dongle device row/);
  });
});

describe('GSM Dongle shared monitor', () => {
  it('keeps the last successful count and marks it stale after a failure', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce(inventory('Free', 'Ready', 'Connected', 'Not connected'))
      .mockRejectedValueOnce(new Error('connection failed'));
    const monitor = new GsmDongleMonitor(config, log, query);
    await monitor.pollNow();
    const fresh = monitor.getSnapshot();
    expect(fresh).toMatchObject({ status: 'available', total: 4, ready: 3 });
    expect(fresh.refreshedAt).toBeTruthy();

    await monitor.pollNow();
    expect(monitor.getSnapshot()).toEqual({ ...fresh, status: 'stale' });
  });

  it('reports unavailable without inventing zero when the first request fails', async () => {
    const monitor = new GsmDongleMonitor(config, log, async () => { throw new Error('timeout'); });
    await monitor.pollNow();
    expect(monitor.getSnapshot()).toEqual({ status: 'unavailable', total: null, ready: null, devices: [], refreshedAt: null });
  });

  it('enforces last-four-only IMEI at the outbound snapshot boundary', async () => {
    const fullImei = '123456789012345';
    const unsafeDevice = { ...device('dongle0', 'Free', fullImei), fullImei } as GsmDongleDevice;
    const monitor = new GsmDongleMonitor(config, log, async () => ({ total: 1, ready: 1, devices: [unsafeDevice] }));
    await monitor.pollNow();
    const snapshot = monitor.getSnapshot();
    expect(snapshot.devices[0].imeiLast4).toBe('2345');
    expect(JSON.stringify(snapshot)).not.toContain(fullImei);
  });

  it('prevents overlapping requests and shares one result with multiple listeners', async () => {
    let resolve!: (value: DongleInventory) => void;
    const pending = new Promise<DongleInventory>((done) => { resolve = done; });
    const query = vi.fn(() => pending);
    const monitor = new GsmDongleMonitor(config, log, query);
    const firstListener = vi.fn();
    const secondListener = vi.fn();
    monitor.onUpdate(firstListener);
    monitor.onUpdate(secondListener);
    const first = monitor.pollNow();
    const second = monitor.pollNow();
    expect(query).toHaveBeenCalledTimes(1);
    resolve(inventory('Free', 'Not connected'));
    await Promise.all([first, second]);
    expect(firstListener).toHaveBeenCalledTimes(1);
    expect(secondListener).toHaveBeenCalledTimes(1);
  });

  it('refreshes on the configured interval', async () => {
    vi.useFakeTimers();
    const query = vi.fn().mockResolvedValue(inventory('Free'));
    const monitor = new GsmDongleMonitor(config, log, query);
    monitor.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(query).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(query).toHaveBeenCalledTimes(2);
    monitor.stop();
  });
});

describe('Asterisk AMI DongleShowDevices integration', () => {
  it('uses the dedicated action and exposes only the last four IMEI digits', async () => {
    const fullImei = '123456789012345';
    const server = net.createServer((socket) => {
      socket.write('Asterisk Call Manager/5.0\r\n');
      let buffer = '';
      socket.on('data', (chunk) => {
        buffer += chunk.toString();
        while (buffer.includes('\r\n\r\n')) {
          const end = buffer.indexOf('\r\n\r\n');
          const action = buffer.slice(0, end);
          buffer = buffer.slice(end + 4);
          const id = /^ActionID:\s*(.+)$/mi.exec(action)?.[1].trim() ?? '';
          if (/^Action:\s*Login$/mi.test(action)) {
            socket.write(`Response: Success\r\nActionID: ${id}\r\n\r\n`);
          } else if (/^Action:\s*DongleShowDevices$/mi.test(action)) {
            socket.write(
              `Response: Success\r\nActionID: ${id}\r\nEventList: start\r\n\r\n` +
              `Event: DongleDeviceEntry\r\nActionID: ${id}\r\nDevice: dongle0\r\nState: Free\r\nIMEIState: ${fullImei}\r\nProviderName: Vodafone\r\n\r\n` +
              `Event: DongleDeviceEntry\r\nActionID: ${id}\r\nDevice: dongle1\r\nState: Not connected\r\nIMSIState: sensitive\r\n\r\n` +
              `Event: DongleShowDevicesComplete\r\nActionID: ${id}\r\nEventList: Complete\r\nListItems: 2\r\n\r\n`,
            );
          }
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const client = new AsteriskDongleClient({ ...config, port });
      const result = await client.query();
      expect(result).toMatchObject({
        total: 2,
        ready: 1,
        devices: [
          { name: 'dongle0', state: 'Free', imeiLast4: '2345', provider: 'Vodafone' },
          { name: 'dongle1', state: 'Not connected', imeiLast4: null },
        ],
      });
      expect(JSON.stringify(result)).not.toContain(fullImei);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('uses the fixed CLI command only when the dedicated action is unavailable and fallback is enabled', async () => {
    let dedicatedActions = 0;
    let commandActions = 0;
    const server = net.createServer((socket) => {
      socket.write('Asterisk Call Manager/5.0\r\n');
      let buffer = '';
      socket.on('data', (chunk) => {
        buffer += chunk.toString();
        while (buffer.includes('\r\n\r\n')) {
          const end = buffer.indexOf('\r\n\r\n');
          const action = buffer.slice(0, end);
          buffer = buffer.slice(end + 4);
          const id = /^ActionID:\s*(.+)$/mi.exec(action)?.[1].trim() ?? '';
          if (/^Action:\s*Login$/mi.test(action)) {
            socket.write(`Response: Success\r\nActionID: ${id}\r\n\r\n`);
          } else if (/^Action:\s*DongleShowDevices$/mi.test(action)) {
            dedicatedActions += 1;
            socket.write(`Response: Error\r\nActionID: ${id}\r\nMessage: Invalid/unknown command\r\n\r\n`);
          } else if (/^Action:\s*Command$/mi.test(action)) {
            commandActions += 1;
            socket.write(
              `Response: Follows\r\nActionID: ${id}\r\nPrivilege: Command\r\n` +
              `Output: ${cliHeader()}\r\n` +
              `Output: ${cliLine('dongle0', '0', 'Free')}\r\n` +
              `Output: --END COMMAND--\r\n\r\n`,
            );
          }
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const client = new AsteriskDongleClient({ ...config, port, allowCommandFallback: true });
      expect(await client.query()).toMatchObject({ total: 1, ready: 1, devices: [{ name: 'dongle0', imeiLast4: '2345' }] });
      expect(dedicatedActions).toBe(1);
      expect(commandActions).toBe(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('times out when Asterisk accepts a connection but does not respond', async () => {
    const connections = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      connections.add(socket);
      socket.once('close', () => connections.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const client = new AsteriskDongleClient({ ...config, port, timeoutMs: 30 });
      await expect(client.query()).rejects.toThrow(/timed out/);
    } finally {
      for (const socket of connections) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
