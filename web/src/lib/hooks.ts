import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { throttle, type Throttled } from "./throttle";

/** Throttled version of a callback that always calls the newest `fn`. Flushes on unmount. */
export function useThrottledCallback<A extends unknown[]>(fn: (...args: A) => void, ms: number): Throttled<A> {
  const ref = useRef(fn);
  useLayoutEffect(() => {
    ref.current = fn;
  });
  const t = useMemo(() => throttle((...args: A) => ref.current(...args), ms), [ms]);
  useEffect(() => () => t.flush(), [t]);
  return t;
}

export interface AsyncState<T> {
  data: T | null;
  error: unknown;
  loading: boolean;
  reload: () => void;
  setData: (fn: (d: T | null) => T | null) => void;
}

/** Runs a request on mount (and when `deps` change); keeps the last data while reloading. */
export function useAsync<T>(fn: () => Promise<T>, deps: readonly unknown[]): AsyncState<T> {
  const [data, setDataRaw] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [n, setN] = useState(0);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    fn().then(
      (d) => {
        if (!alive) return;
        setDataRaw(d);
        setError(null);
        setLoading(false);
      },
      (e: unknown) => {
        if (!alive) return;
        setError(e);
        setLoading(false);
      },
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, n]);
  return { data, error, loading, reload: () => setN((x) => x + 1), setData: setDataRaw };
}

/** Re-renders every `ms` (for countdowns and "5 min ago" labels). */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}
