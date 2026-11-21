import { OriginateError, type AnsweredEvent, type EndedEvent, type OriginateOptions, type TelephonyAdapter } from './types.js';

export type SimPredictiveOutcome = 'answer' | 'no-answer' | 'busy' | 'failed';

/**
 * In-memory predictive adapter with the same contract as the AMI one:
 * originate() resolves at the simulated answer and rejects for busy /
 * no-answer / failed, so pacing, bridging and abandon logic can be tested
 * with no PBX. Outcomes can be queued deterministically per instance.
 */
export class SimPredictiveAdapter implements TelephonyAdapter {
  private seq = 0;
  private outcomes: SimPredictiveOutcome[] = [];
  private timers = new Set<NodeJS.Timeout>();
  private live = new Map<string, { bridgedTo: string | null }>();
  private answeredCbs: ((e: AnsweredEvent) => void)[] = [];
  private endedCbs: ((e: EndedEvent) => void)[] = [];
  /** ms until the simulated customer outcome (kept tiny for tests) */
  ringMs = 10;
  random: () => number = Math.random;

  /** Queue outcomes for the next originates (consumed in order). */
  setOutcomes(list: SimPredictiveOutcome[]) {
    this.outcomes = [...list];
  }

  onAnswered(cb: (e: AnsweredEvent) => void): void {
    this.answeredCbs.push(cb);
  }

  onEnded(cb: (e: EndedEvent) => void): void {
    this.endedCbs.push(cb);
  }

  private later(fn: () => void, ms: number) {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    t.unref?.();
    this.timers.add(t);
    return t;
  }

  async originate(_opts: OriginateOptions): Promise<{ channelId: string }> {
    const channelId = `Sim/predictive-${++this.seq}`;
    const outcome = this.outcomes.shift() ?? (this.random() < 0.25 ? 'answer' : 'no-answer');
    return new Promise((resolve, reject) => {
      this.later(() => {
        if (outcome === 'answer') {
          this.live.set(channelId, { bridgedTo: null });
          for (const cb of this.answeredCbs) cb({ channelId });
          resolve({ channelId });
        } else {
          reject(new OriginateError(outcome === 'busy' ? 'busy' : outcome === 'failed' ? 'failed' : 'no-answer', `simulated ${outcome}`));
        }
      }, this.ringMs);
    });
  }

  async bridgeToAgent(channelId: string, agentSipUsername: string): Promise<void> {
    const ch = this.live.get(channelId);
    if (!ch) throw new Error(`Unknown channel ${channelId}`);
    ch.bridgedTo = agentSipUsername;
  }

  async hangup(channelId: string): Promise<void> {
    if (this.live.delete(channelId)) {
      for (const cb of this.endedCbs) cb({ channelId, cause: 'Normal Clearing' });
    }
  }

  /** Test helper: the simulated customer hangs up while waiting/bridged. */
  simulateCustomerHangup(channelId: string) {
    if (this.live.delete(channelId)) {
      for (const cb of this.endedCbs) cb({ channelId, cause: 'Normal Clearing' });
    }
  }

  close(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.live.clear();
  }
}
