// Slider throttling (06 A.4): at most one cmd per 50 ms, and the final value is always sent.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { throttle } from "../src/lib/throttle";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("throttle", () => {
  it("sends the first call at once", () => {
    const fn = vi.fn();
    const t = throttle(fn, 50);
    t(1);
    expect(fn).toHaveBeenCalledExactlyOnceWith(1);
    expect(t.pending).toBe(false);
  });

  it("coalesces calls inside the interval and sends only the newest at its end", () => {
    const fn = vi.fn();
    const t = throttle(fn, 50);
    t(1);
    vi.advanceTimersByTime(10);
    t(2);
    t(3);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(t.pending).toBe(true);
    vi.advanceTimersByTime(39);
    expect(fn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenLastCalledWith(3);
    expect(t.pending).toBe(false);
  });

  it("never sends more than once per 50 ms during a drag, and ends on the final value", () => {
    const calls: { at: number; v: number }[] = [];
    const t = throttle((v: number) => calls.push({ at: Date.now(), v }), 50);
    for (let v = 0; v <= 200; v++) {
      t(v);
      vi.advanceTimersByTime(4); // a 250 Hz pointer
    }
    vi.advanceTimersByTime(100);
    expect(calls.at(-1)?.v).toBe(200);
    for (let i = 1; i < calls.length; i++) expect(calls[i]!.at - calls[i - 1]!.at).toBeGreaterThanOrEqual(50);
    expect(calls.length).toBeLessThanOrEqual(Math.ceil((201 * 4) / 50) + 1);
    expect(calls.length).toBeGreaterThan(10);
  });

  it("passes every argument of the newest call", () => {
    const fn = vi.fn();
    const t = throttle(fn, 50);
    t(10, 400);
    t(20, 120);
    vi.advanceTimersByTime(50);
    expect(fn).toHaveBeenLastCalledWith(20, 120);
  });

  it("sends at once again after a quiet interval", () => {
    const fn = vi.fn();
    const t = throttle(fn, 50);
    t(1);
    vi.advanceTimersByTime(80);
    t(2);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenLastCalledWith(2);
  });

  it("flush sends a waiting call now; cancel drops it", () => {
    const fn = vi.fn();
    const t = throttle(fn, 50);
    t(1);
    t(2);
    t.flush();
    expect(fn).toHaveBeenLastCalledWith(2);
    expect(fn).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(100);
    t(3);
    t(4);
    t.cancel();
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(3);
    expect(fn).toHaveBeenLastCalledWith(3);
    t.flush();
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
