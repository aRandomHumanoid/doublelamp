// Leading + trailing throttle for slider sends (06 A.4): at most one call per interval, and the newest
// arguments are always delivered, so the lamp ends on the final slider position.

export interface Throttled<A extends unknown[]> {
  (...args: A): void;
  /** Delivers a waiting trailing call now (used when a control unmounts mid-drag). */
  flush(): void;
  /** Drops a waiting trailing call. */
  cancel(): void;
  /** True while a trailing call is waiting. */
  readonly pending: boolean;
}

export function throttle<A extends unknown[]>(fn: (...args: A) => void, intervalMs: number): Throttled<A> {
  let last = -Infinity;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let queued: A | null = null;

  const run = (args: A): void => {
    last = Date.now();
    fn(...args);
  };

  const arm = (): void => {
    if (timer !== null) return;
    timer = setTimeout(
      () => {
        timer = null;
        if (queued === null) return;
        const args = queued;
        queued = null;
        run(args);
      },
      Math.max(0, last + intervalMs - Date.now()),
    );
  };

  const throttled = ((...args: A): void => {
    if (timer === null && Date.now() - last >= intervalMs) {
      run(args);
    } else {
      queued = args;
      arm();
    }
  }) as Throttled<A>;

  throttled.flush = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (queued === null) return;
    const args = queued;
    queued = null;
    run(args);
  };
  throttled.cancel = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    queued = null;
  };
  Object.defineProperty(throttled, "pending", { get: () => queued !== null });
  return throttled;
}
