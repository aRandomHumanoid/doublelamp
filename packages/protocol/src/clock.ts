// Sync-clock estimation, the same algorithm the lamps use (03 §12).
//   offset = ((t1 − t0) + (t2 − t3)) / 2      delay = (t3 − t0) − (t2 − t1)
// Keep the last 8 samples, trust the one with the smallest delay, drop delay > 1000 ms.
// Steps of 250 ms or more apply at once; smaller corrections slew at most 1 ms per 100 ms.

export interface ClockSample {
  offset: number;
  delay: number;
}

export class SyncClock {
  private samples: ClockSample[] = [];
  private offset = 0;
  private target = 0;
  private lastSlewAt = 0;
  private synced = false;

  constructor(private readonly local: () => number = () => performance.timeOrigin + performance.now()) {}

  /** Feed one ping/pong exchange. t3 defaults to now. */
  addSample(t0: number, t1: number, t2: number, t3: number = this.localNow()): ClockSample | null {
    const delay = t3 - t0 - (t2 - t1);
    if (delay < 0 || delay > 1000) return null;
    const offset = (t1 - t0 + (t2 - t3)) / 2;
    this.samples.push({ offset, delay });
    if (this.samples.length > 8) this.samples.shift();
    const best = this.samples.reduce((a, b) => (b.delay < a.delay ? b : a));
    this.target = best.offset;
    if (!this.synced || Math.abs(this.target - this.offset) >= 250) {
      this.offset = this.target;
      this.synced = true;
    }
    return { offset, delay };
  }

  /** Smallest round-trip delay among the kept samples, or null before the first sample. */
  get bestDelay(): number | null {
    if (this.samples.length === 0) return null;
    return Math.min(...this.samples.map((s) => s.delay));
  }

  get isSynced(): boolean {
    return this.synced;
  }

  /** Current estimate of the server's clock, in ms. */
  now(): number {
    this.slew();
    return this.localNow() + this.offset;
  }

  private localNow(): number {
    return this.local();
  }

  private slew(): void {
    const t = this.localNow();
    const elapsed = t - this.lastSlewAt;
    this.lastSlewAt = t;
    if (this.offset === this.target || elapsed <= 0) return;
    const maxStep = Math.min(elapsed, 10_000) / 100; // 1 ms per 100 ms
    const diff = this.target - this.offset;
    this.offset += Math.sign(diff) * Math.min(Math.abs(diff), maxStep);
  }
}
