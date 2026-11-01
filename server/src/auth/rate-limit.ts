// Sliding-window counters for login (5 failed / 15 min / IP, 30 / h overall) and claims (5 / min / IP, 20 / h).

export class SlidingWindow {
  private readonly hits = new Map<string, number[]>();

  constructor(
    readonly limit: number,
    readonly windowMs: number,
    private readonly clock: () => number,
  ) {}

  private prune(key: string): number[] {
    const cutoff = this.clock() - this.windowMs;
    const list = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (list.length) this.hits.set(key, list);
    else this.hits.delete(key);
    return list;
  }

  count(key: string): number {
    return this.prune(key).length;
  }

  isLimited(key: string): boolean {
    return this.count(key) >= this.limit;
  }

  hit(key: string): void {
    const list = this.prune(key);
    list.push(this.clock());
    this.hits.set(key, list);
  }

  /** Drops keys whose hits have all expired. */
  sweep(): void {
    for (const key of [...this.hits.keys()]) this.prune(key);
  }
}

/** A per-key window plus one overall window; `limited()` is true if either is full. */
export class DualLimiter {
  private readonly perKey: SlidingWindow;
  private readonly overall: SlidingWindow;

  constructor(perKey: { limit: number; windowMs: number }, overall: { limit: number; windowMs: number }, clock: () => number) {
    this.perKey = new SlidingWindow(perKey.limit, perKey.windowMs, clock);
    this.overall = new SlidingWindow(overall.limit, overall.windowMs, clock);
  }

  limited(key: string): boolean {
    return this.perKey.isLimited(key) || this.overall.isLimited("*");
  }

  hit(key: string): void {
    this.perKey.hit(key);
    this.overall.hit("*");
  }

  sweep(): void {
    this.perKey.sweep();
    this.overall.sweep();
  }
}

const MINUTE = 60_000;

export function loginLimiter(clock: () => number): DualLimiter {
  return new DualLimiter({ limit: 5, windowMs: 15 * MINUTE }, { limit: 30, windowMs: 60 * MINUTE }, clock);
}

export function claimLimiter(clock: () => number): DualLimiter {
  return new DualLimiter({ limit: 5, windowMs: MINUTE }, { limit: 20, windowMs: 60 * MINUTE }, clock);
}
