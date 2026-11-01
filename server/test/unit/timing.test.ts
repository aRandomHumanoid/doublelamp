import { describe, expect, it } from "vitest";
import { APPLY_AT, DELAY_WINDOW, DelayTracker, applyLeadMs, computeApplyAt, percentile } from "../../src/engine/timing";

describe("percentile", () => {
  it("uses the nearest-rank method", () => {
    expect(percentile([], 90)).toBeNull();
    expect(percentile([7], 90)).toBe(7);
    const v = Array.from({ length: 20 }, (_, i) => i + 1); // 1..20
    expect(percentile(v, 90)).toBe(18);
    expect(percentile(v, 50)).toBe(10);
    expect(percentile([5, 1, 3], 100)).toBe(5);
  });
});

describe("DelayTracker", () => {
  it("keeps the last 20 samples and reports their p90", () => {
    const d = new DelayTracker();
    for (let i = 1; i <= 25; i++) d.add(i * 10); // keeps 60..250
    expect(d.size).toBe(DELAY_WINDOW);
    expect(d.p90()).toBe(230);
  });

  it("rejects implausible samples (an unsynced lamp clock) and clamps small negatives to 0", () => {
    const d = new DelayTracker();
    expect(d.add(1.7e12)).toBe(false);
    expect(d.add(Number.NaN)).toBe(false);
    expect(d.add(-5000)).toBe(false);
    expect(d.add(-3)).toBe(true);
    expect(d.p90()).toBe(0);
  });

  it("p90 ignores a single slow outlier among 20", () => {
    const d = new DelayTracker();
    for (let i = 0; i < 19; i++) d.add(40);
    d.add(900);
    expect(d.p90()).toBe(40);
  });
});

describe("apply_at", () => {
  it("is now + clamp(max p90 + 40, 80, 500)", () => {
    expect(applyLeadMs([10, 20])).toBe(80); // 20 + 40 = 60 → floor 80
    expect(applyLeadMs([100, 150])).toBe(190);
    expect(applyLeadMs([30, 700])).toBe(500); // capped
    expect(computeApplyAt(1000, [100, 150])).toBe(1190);
  });

  it("assumes a default delay for a lamp with no samples yet", () => {
    expect(applyLeadMs([null, 20])).toBe(APPLY_AT.defaultOneWayMs + APPLY_AT.marginMs);
  });

  it("is undefined for a single lamp, so it reacts as quickly as possible", () => {
    expect(computeApplyAt(1000, [50])).toBeUndefined();
    expect(computeApplyAt(1000, [])).toBeUndefined();
  });
});
