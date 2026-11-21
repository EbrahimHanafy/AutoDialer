import { describe, expect, it } from 'vitest';
import { amiField, parseAmiPacket, serializeAmiAction, splitAmiStream, type AmiFields } from '../telephony/amiProtocol.js';
import type { AmiConnection } from '../telephony/ami.js';
import { AmiPredictiveAdapter, causeFromOriginateReason } from '../telephony/amiAdapter.js';
import { OriginateError } from '../telephony/types.js';

/* Sample packets as emitted by Asterisk 20 AMI (recorded shapes). */

const LOGIN_OK = 'Response: Success\r\nActionID: login-1\r\nMessage: Authentication accepted\r\n\r\n';

const ORIGINATE_QUEUED = 'Response: Success\r\nActionID: pd-out-1\r\nMessage: Originate successfully queued\r\n\r\n';

const ORIGINATE_RESPONSE_OK = [
  'Event: OriginateResponse',
  'Privilege: call,all',
  'ActionID: pd-out-1',
  'Response: Success',
  'Channel: Dongle/dongle0-0100000007',
  'Context: predictive',
  'Exten: s',
  'Reason: 4',
  'Uniqueid: 1795295074.3580',
  'CallerIDNum: +201001234567',
  'CallerIDName: <unknown>',
  '',
  '',
].join('\r\n');

const ORIGINATE_RESPONSE_BUSY = [
  'Event: OriginateResponse',
  'Privilege: call,all',
  'ActionID: pd-out-1',
  'Response: Failure',
  'Channel: Dongle/dongle0-0100000008',
  'Reason: 17',
  'Uniqueid: 1795295099.3581',
  '',
  '',
].join('\r\n');

const HANGUP = [
  'Event: Hangup',
  'Privilege: call,all',
  'Channel: Dongle/dongle0-0100000007',
  'AccountCode: ',
  'Cause: 16',
  'Cause-txt: Normal Clearing',
  'Uniqueid: 1795295074.3580',
  '',
  '',
].join('\r\n');

describe('AMI protocol', () => {
  it('parses a packet into lower-cased multi-value fields', () => {
    const msg = parseAmiPacket(LOGIN_OK.replace(/\r\n\r\n$/, ''));
    expect(amiField(msg, 'response')).toBe('Success');
    expect(amiField(msg, 'actionid')).toBe('login-1');
    expect(amiField(msg, 'Message')).toBe('Authentication accepted');
  });

  it('keeps repeated keys (Variable) in order', () => {
    const msg = parseAmiPacket('Action: Originate\r\nVariable: A=1\r\nVariable: B=2');
    expect(msg.get('variable')).toEqual(['A=1', 'B=2']);
  });

  it('serializes actions with repeated keys and rejects line breaks', () => {
    const wire = serializeAmiAction({ Action: 'Originate', Variable: ['A=1', 'B=2'] });
    expect(wire).toBe('Action: Originate\r\nVariable: A=1\r\nVariable: B=2\r\n\r\n');
    expect(() => serializeAmiAction({ Action: 'X', Bad: 'a\r\nAction: Logoff' })).toThrow();
  });

  it('splits a stream, strips the greeting, and keeps the partial tail', () => {
    const stream = 'Asterisk Call Manager/2.10.4\r\n' + LOGIN_OK + ORIGINATE_QUEUED + 'Event: Partial';
    const { packets, rest } = splitAmiStream(stream);
    expect(packets).toHaveLength(2);
    expect(amiField(parseAmiPacket(packets[0]), 'message')).toBe('Authentication accepted');
    expect(rest).toBe('Event: Partial');
  });

  it('maps OriginateResponse reasons to causes', () => {
    expect(causeFromOriginateReason('17')).toBe('busy');
    expect(causeFromOriginateReason('18')).toBe('no-answer');
    expect(causeFromOriginateReason('19')).toBe('no-answer');
    expect(causeFromOriginateReason('0')).toBe('failed');
    expect(causeFromOriginateReason(undefined, 'User busy')).toBe('busy');
  });
});

/* A fake AmiConnection: records actions, lets the test inject events. */
class FakeConn {
  handlers = new Set<(m: AmiFields) => void>();
  sent: Record<string, string | string[]>[] = [];
  private seq = 0;
  nextId(prefix: string) {
    return `${prefix}-${++this.seq}`;
  }
  onEvent(h: (m: AmiFields) => void) {
    this.handlers.add(h);
    return () => {
      this.handlers.delete(h);
    };
  }
  async sendAction(fields: Record<string, string | string[]>): Promise<AmiFields> {
    this.sent.push(fields);
    return parseAmiPacket('Response: Success\r\nMessage: Originate successfully queued');
  }
  emit(raw: string) {
    const msg = parseAmiPacket(raw.replace(/\r\n\r\n$/, ''));
    for (const h of [...this.handlers]) h(msg);
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0));

function setup() {
  const conn = new FakeConn();
  const adapter = new AmiPredictiveAdapter(conn as unknown as AmiConnection, { channelPrefix: 'Dongle/r0/' });
  return { conn, adapter };
}

const ORIGIN = { callId: 42, campaignId: 1, leadId: 7, phone: '+201001234567', callerId: '', ringTimeoutSec: 35, bridgeWaitSec: 25 };

describe('AmiPredictiveAdapter', () => {
  it('originates into BridgeWait and resolves with the channel on OriginateResponse success', async () => {
    const { conn, adapter } = setup();
    const p = adapter.originate(ORIGIN);
    await tick();
    const action = conn.sent[0];
    expect(action.Channel).toBe('Dongle/r0/+201001234567');
    expect(action.Application).toBe('BridgeWait');
    expect(action.Data).toBe('predictive,participant,e(r)S(25)');
    expect(action.Timeout).toBe('35000');
    expect(action.Variable).toEqual(['OPENDIALER_CALL_ID=42', 'OPENDIALER_LEAD_ID=7', 'OPENDIALER_CAMPAIGN_ID=1']);
    conn.emit(ORIGINATE_RESPONSE_OK);
    await expect(p).resolves.toEqual({ channelId: 'Dongle/dongle0-0100000007' });
  });

  it('rejects with a busy OriginateError on OriginateResponse failure (reason 17)', async () => {
    const { conn, adapter } = setup();
    const p = adapter.originate(ORIGIN);
    await tick();
    conn.emit(ORIGINATE_RESPONSE_BUSY);
    const err = await p.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OriginateError);
    expect((err as OriginateError).reason).toBe('busy');
  });

  it('reports onEnded when an answered channel hangs up', async () => {
    const { conn, adapter } = setup();
    const ended: { channelId: string; cause: string }[] = [];
    adapter.onEnded((e) => ended.push(e));
    const p = adapter.originate(ORIGIN);
    await tick();
    conn.emit(ORIGINATE_RESPONSE_OK);
    await p;
    conn.emit(HANGUP);
    expect(ended).toEqual([{ channelId: 'Dongle/dongle0-0100000007', cause: 'Normal Clearing' }]);
    // a second hangup for the same channel is not reported twice
    conn.emit(HANGUP);
    expect(ended).toHaveLength(1);
  });

  it('bridges by originating the agent endpoint into the Bridge application', async () => {
    const { conn, adapter } = setup();
    const p = adapter.bridgeToAgent('Dongle/dongle0-0100000007', '111');
    await tick();
    const action = conn.sent[0];
    expect(action.Channel).toBe('PJSIP/111');
    expect(action.Application).toBe('Bridge');
    expect(action.Data).toBe('Dongle/dongle0-0100000007');
    conn.emit(ORIGINATE_RESPONSE_OK.replace('pd-out-1', 'pd-bridge-1'));
    await expect(p).resolves.toBeUndefined();
  });
});
