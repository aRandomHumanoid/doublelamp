// apply_at calculation and per-lamp delay tracking (05 §4 "Calculating apply_at").

export const APPLY_AT = {
  marginMs: 40,
  minLeadMs: 80,
  maxLeadMs: 500,
  /** Assumed one-way delay for a lamp with no time.ping samples yet. */
  defaultOneWayMs: 100,
} as const;

/** Samples kept per lamp: the last 20 time.ping exchanges. */
export const DELAY_WINDOW = 20;
/** Samples outside this range are clock garbage (e.g. a lamp that hasn't synced yet). */
export const PLAUSIBLE_DELAY_MS = { min: -1000, max: 5000 } as const;

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Nearest-rank percentile; null for no values. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = clamp(Math.ceil((p / 100) * sorted.length), 1, sorted.length);
  return sorted[rank - 1]!;
}

/**
 * One-way delay samples for one lamp.
 *
 * The server sees `t0` (the lamp's sync-clock send time, 04 §5) and `t1` (its own receive time). Once the lamp
 * has synced its clock from the lowest-delay exchange, `t1 − t0` equals half that lamp's round trip (the NTP
 * offset error cancels the path asymmetry), so `t1 − t0` per time.ping is our "half the RTT" sample.
 */
export class DelayTracker {
  private samples: number[] = [];

  constructor(private readonly window = DELAY_WINDOW) {}

  /** Returns false when the sample was rejected as implausible. */
  add(oneWayMs: number): boolean {
    if (!Number.isFinite(oneWayMs) || oneWayMs < PLAUSIBLE_DELAY_MS.min || oneWayMs > PLAUSIBLE_DELAY_MS.max) return false;
    this.samples.push(Math.max(0, oneWayMs));
    if (this.samples.length > this.window) this.samples.shift();
    return true;
  }

  get size(): number {
    return this.samples.length;
  }

  p90(): number | null {
    return percentile(this.samples, 90);
  }

  p50(): number | null {
    return percentile(this.samples, 50);
  }

  clear(): void {
    this.samples = [];
  }
}

/** clamp(max(oneWayDelayP90 over members) + 40, 80, 500). Members without samples count as `defaultOneWayMs`. */
export function applyLeadMs(p90s: readonly (number | null)[]): number {
  const worst = Math.max(0, ...p90s.map((d) => d ?? APPLY_AT.defaultOneWayMs));
  return clamp(Math.round(worst) + APPLY_AT.marginMs, APPLY_AT.minLeadMs, APPLY_AT.maxLeadMs);
}

/** `apply_at` for a change that more than one online lamp follows; undefined for a single lamp (react ASAP). */
export function computeApplyAt(now: number, onlineMemberP90s: readonly (number | null)[]): number | undefined {
  if (onlineMemberP90s.length < 2) return undefined;
  return now + applyLeadMs(onlineMemberP90s);
}
