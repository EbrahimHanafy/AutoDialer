/**
 * Telephony boundary for predictive dialing. The engine talks only to this
 * interface; AMI framing, Asterisk events and the simulator live behind it.
 *
 * Call flow (validated live on VitalPBX 4 / Asterisk 20 with GSM dongles):
 *   originate()  – PBX dials the customer and parks the answered channel in
 *                  BridgeWait (ringback hold). The promise resolves when the
 *                  customer answers; it rejects when the attempt fails.
 *   bridgeToAgent() – PBX originates the agent's PJSIP endpoint into a Bridge
 *                  with the parked channel. Resolves once the agent leg is up.
 *   hangup()     – drops a parked/bridged channel (abandon, campaign pause…).
 *   onEnded      – an answered channel (waiting or bridged) hung up.
 */

export interface OriginateOptions {
  callId: number;
  campaignId: number;
  leadId: number;
  /** E.164 number of the customer */
  phone: string;
  callerId: string;
  /** give up ringing after this many seconds */
  ringTimeoutSec: number;
  /** seconds the answered call may sit in the BridgeWait hold (S() option) */
  bridgeWaitSec: number;
}

export type OriginateCause = 'busy' | 'no-answer' | 'failed';

export class OriginateError extends Error {
  constructor(
    /** why the attempt failed ('busy' | 'no-answer' | 'failed') – named `reason`, not `cause`, to avoid clashing with Error.cause */
    readonly reason: OriginateCause,
    message: string,
  ) {
    super(message);
    this.name = 'OriginateError';
  }
}

export interface AnsweredEvent {
  channelId: string;
}

export interface EndedEvent {
  channelId: string;
  /** PBX hangup cause text (e.g. "Normal Clearing", "User busy") */
  cause: string;
}

export interface TelephonyAdapter {
  /** Dial the customer; resolves with the parked channel once they answer. */
  originate(opts: OriginateOptions): Promise<{ channelId: string }>;
  /** Bridge a parked answered channel to the agent's SIP endpoint. */
  bridgeToAgent(channelId: string, agentSipUsername: string): Promise<void>;
  /** Hang up a channel (safe to call for unknown channels). */
  hangup(channelId: string): Promise<void>;
  /** Fired at the same moment originate() resolves (customer answered). */
  onAnswered(cb: (e: AnsweredEvent) => void): void;
  /** Fired when an answered channel ends while waiting or bridged. */
  onEnded(cb: (e: EndedEvent) => void): void;
  /** Release sockets/timers. */
  close(): void;
}
