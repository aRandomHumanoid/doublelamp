import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_STATE, cloneState } from "@doublelamp/protocol";

import { ActivityLog } from "../../src/activity";
import { openDatabase } from "../../src/db/db";
import { SyncEngine } from "../../src/engine/engine";
import { SceneStore } from "../../src/scenes";
import {
  MISSED_GRACE_MS,
  Scheduler,
  missedRunDecision,
  nextRunAt,
  planFadeOff,
  sunrisePatch,
  validateWhen,
  whenToCron,
} from "../../src/scheduler";
import { Recorder, silentLogger } from "./engine-helpers";

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

describe("next run", () => {
  it("daily HH:MM on chosen weekdays becomes a cron expression", () => {
    expect(whenToCron({ type: "daily", time: "07:05", days: ["fri", "mon", "mon"], tz: "UTC" })).toEqual({ expr: "5 7 * * 1,5", tz: "UTC" });
  });

  it("daily, in the schedule's time zone, skipping days not chosen", () => {
    // Wed 2026-10-28 12:00 UTC; Berlin is UTC+1 after Oct 25, so 07:00 Berlin = 06:00 UTC.
    const from = Date.parse("2026-10-28T12:00:00Z");
    const when = { type: "daily" as const, time: "07:00", days: ["mon" as const, "thu" as const], tz: "Europe/Berlin" };
    expect(iso(nextRunAt(when, from))).toBe("2026-10-29T06:00:00.000Z");
    expect(iso(nextRunAt(when, Date.parse("2026-10-29T06:00:00Z")))).toBe("2026-11-02T06:00:00.000Z");
  });

  it("follows the spring-forward DST change (America/New_York, 2026-03-08)", () => {
    const when = { type: "daily" as const, time: "07:00", days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const, tz: "America/New_York" };
    const w = { ...when, days: [...when.days] };
    const sat = nextRunAt(w, Date.parse("2026-03-07T00:00:00Z"))!; // Sat 07:00 EST = 12:00 UTC
    const sun = nextRunAt(w, sat)!; // Sun 07:00 EDT = 11:00 UTC
    expect(iso(sat)).toBe("2026-03-07T12:00:00.000Z");
    expect(iso(sun)).toBe("2026-03-08T11:00:00.000Z");
    expect(sun - sat).toBe(23 * 3600_000); // the 23-hour day
  });

  it("follows the fall-back DST change (America/New_York, 2026-11-01)", () => {
    const w = { type: "daily" as const, time: "07:00", days: ["sat" as const, "sun" as const], tz: "America/New_York" };
    const sat = nextRunAt(w, Date.parse("2026-10-31T00:00:00Z"))!;
    const sun = nextRunAt(w, sat)!;
    expect(iso(sat)).toBe("2026-10-31T11:00:00.000Z"); // EDT
    expect(iso(sun)).toBe("2026-11-01T12:00:00.000Z"); // EST
    expect(sun - sat).toBe(25 * 3600_000);
  });

  it("a time that doesn't exist on the DST day (02:30) still runs once that day", () => {
    const w = { type: "daily" as const, time: "02:30", days: ["sun" as const], tz: "America/New_York" };
    const run = nextRunAt(w, Date.parse("2026-03-07T12:00:00Z"))!;
    expect(iso(run)?.slice(0, 10)).toBe("2026-03-08");
  });

  it("cron expressions with a time zone", () => {
    const w = { type: "cron" as const, expr: "30 22 * * 1-5", tz: "Asia/Tokyo" };
    // Wed 2026-10-28 12:00 UTC = 21:00 JST → next is today 22:30 JST = 13:30 UTC
    expect(iso(nextRunAt(w, Date.parse("2026-10-28T12:00:00Z")))).toBe("2026-10-28T13:30:00.000Z");
  });

  it("validates time zones and cron expressions", () => {
    expect(validateWhen({ type: "daily", time: "07:00", days: ["mon"], tz: "Mars/Olympus" })).toMatch(/time zone/);
    expect(validateWhen({ type: "cron", expr: "not a cron", tz: "UTC" })).toMatch(/5 fields|invalid/);
    expect(validateWhen({ type: "cron", expr: "* * * * * *", tz: "UTC" })).toMatch(/5 fields/);
    expect(validateWhen({ type: "cron", expr: "61 * * * *", tz: "UTC" })).toMatch(/invalid/);
    expect(validateWhen({ type: "cron", expr: "0 7 * * *", tz: "Europe/London" })).toBeNull();
  });
});

describe("missed runs", () => {
  it("fire if less than 5 minutes late, otherwise skip", () => {
    const now = 1_000_000_000;
    expect(missedRunDecision(null, now)).toBe("none");
    expect(missedRunDecision(now + 1, now)).toBe("none");
    expect(missedRunDecision(now - 1000, now)).toBe("fire");
    expect(missedRunDecision(now - MISSED_GRACE_MS + 1, now)).toBe("fire");
    expect(missedRunDecision(now - MISSED_GRACE_MS, now)).toBe("skip");
    expect(missedRunDecision(now - 3600_000, now)).toBe("skip");
  });
});

describe("fade_off planning", () => {
  it("steps every ≈10 s from the start brightness to 0, then off, then restores the brightness", () => {
    const plan = planFadeOff(200, 60_000);
    const dims = plan.filter((s) => s.kind === "dim");
    expect(dims).toHaveLength(6);
    expect(dims.map((s) => s.atMs)).toEqual([0, 10_000, 20_000, 30_000, 40_000, 50_000]);
    expect(dims.map((s) => s.patch.brightness)).toEqual([167, 133, 100, 67, 33, 0]);
    expect(dims.every((s) => s.transitionMs === 10_000)).toBe(true);
    expect(plan.at(-2)).toEqual({ atMs: 60_000, patch: { on: false }, transitionMs: 0, kind: "off" });
    expect(plan.at(-1)).toMatchObject({ kind: "restore", patch: { brightness: 200 } });
    expect(plan.at(-1)!.atMs).toBeGreaterThan(60_000);
  });

  it("brightness never increases and transitions stay within the 10 s limit", () => {
    for (const [b, min] of [
      [255, 1],
      [10, 30],
      [128, 120],
      [1, 5],
    ] as const) {
      const dims = planFadeOff(b, min * 60_000).filter((s) => s.kind === "dim");
      expect(dims).toHaveLength(Math.round((min * 60_000) / 10_000));
      for (let i = 1; i < dims.length; i++) expect(dims[i]!.patch.brightness!).toBeLessThanOrEqual(dims[i - 1]!.patch.brightness!);
      expect(dims.at(-1)!.patch.brightness).toBe(0);
      expect(dims.every((s) => s.transitionMs <= 10_000)).toBe(true);
    }
  });

  it("a very short fade is a single step", () => {
    const plan = planFadeOff(100, 3000);
    expect(plan.filter((s) => s.kind === "dim")).toEqual([{ atMs: 0, patch: { brightness: 0 }, transitionMs: 3000, kind: "dim" }]);
  });
});

describe("sunrise", () => {
  it("turns on at full brightness with the sunrise effect for the duration", () => {
    expect(sunrisePatch(30)).toEqual({ on: true, brightness: 255, effect: { id: "sunrise", duration_ms: 1_800_000 } });
  });
});

describe("Scheduler runtime", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function setup(nowIso: string) {
    vi.useFakeTimers({ now: Date.parse(nowIso) });
    const db = openDatabase(":memory:");
    const rec = new Recorder();
    const clock = () => Date.now();
    const engine = new SyncEngine({ clock, hooks: rec });
    engine.addDevice({ id: "dl-00000a", name: "Lamp A" });
    engine.connect("dl-00000a", { state: { ...cloneState(DEFAULT_STATE), on: true, brightness: 100 }, dirty: {} });
    rec.clear();
    const scenes = new SceneStore(db, clock);
    const activity = new ActivityLog(db, clock);
    const scheduler = new Scheduler({ db, clock, engine, scenes, activity, log: silentLogger(), startupDelayMs: 1000 });
    return { db, rec, engine, scheduler, activity };
  }

  it("runs a schedule at its time with origin schedule and records the result", () => {
    const { rec, scheduler } = setup("2026-10-28T06:59:00Z");
    const s = scheduler.create({
      name: "Lights off",
      target: { device: "dl-00000a" },
      when: { type: "daily", time: "07:00", days: ["wed"], tz: "UTC" },
      action: { type: "power", on: false },
      enabled: true,
    });
    expect(iso(s.next_run_at)).toBe("2026-10-28T07:00:00.000Z");
    scheduler.start();
    vi.advanceTimersByTime(61_000);
    expect(rec.sentTo("dl-00000a").at(-1)).toMatchObject({ origin: "schedule", state: { on: false } });
    const after = scheduler.get(s.id)!;
    expect(after.last_result).toBe("ok");
    expect(iso(after.next_run_at)).toBe("2026-11-04T07:00:00.000Z");
    scheduler.stop();
  });

  it("at startup, fires a run missed by less than 5 minutes and skips (and logs) older ones", () => {
    const { db, rec, scheduler, activity } = setup("2026-10-28T07:03:00Z");
    const insert = db.prepare(
      "INSERT INTO schedules (name, target_type, target_id, when_json, action_json, enabled, next_run_at) VALUES (?, 'device', 'dl-00000a', ?, ?, 1, ?)",
    );
    const when = JSON.stringify({ type: "daily", time: "07:00", days: ["wed"], tz: "UTC" });
    insert.run("recent", when, JSON.stringify({ type: "power", on: false }), Date.parse("2026-10-28T07:00:00Z"));
    insert.run("old", JSON.stringify({ type: "daily", time: "06:00", days: ["wed"], tz: "UTC" }), JSON.stringify({ type: "power", on: true }), Date.parse("2026-10-28T06:00:00Z"));
    scheduler.start();
    const [recent, old] = scheduler.list();
    expect(old!.last_result).toMatch(/^missed/);
    expect(iso(old!.next_run_at)).toBe("2026-11-04T06:00:00.000Z");
    expect(activity.query({}).some((e) => e.kind === "schedule" && e.data?.result === "missed")).toBe(true);
    expect(rec.sent).toHaveLength(0); // the recent one waits for lamps to reconnect
    vi.advanceTimersByTime(1000);
    expect(rec.sentTo("dl-00000a")).toHaveLength(1);
    expect(rec.sentTo("dl-00000a")[0]!.state.on).toBe(false);
    expect(scheduler.get(recent!.id)!.last_result).toBe("ok");
    scheduler.stop();
  });

  it("reports offline when the target lamp isn't connected", () => {
    const { engine, scheduler } = setup("2026-10-28T06:59:00Z");
    engine.disconnect("dl-00000a");
    const s = scheduler.create({
      name: "",
      target: { device: "dl-00000a" },
      when: { type: "cron", expr: "0 7 * * *", tz: "UTC" },
      action: { type: "sunrise", duration_min: 20 },
      enabled: true,
    });
    expect(scheduler.runSchedule(s, false)).toBe("offline");
    scheduler.stop();
  });

  it("fade_off drives the brightness down in steps, then turns off and restores the brightness", () => {
    const { rec, scheduler, engine } = setup("2026-10-28T06:59:00Z");
    const result = scheduler.startFade({ device: "dl-00000a" }, 30_000, "Bedtime");
    expect(result).toBe("ok");
    vi.advanceTimersByTime(40_000);
    const sent = rec.sentTo("dl-00000a");
    expect(sent.map((m) => m.state.brightness)).toEqual([67, 33, 0, 0, 100]);
    expect(sent.map((m) => m.state.on)).toEqual([true, true, true, false, false]);
    expect(engine.getDevice("dl-00000a")!.replica!.state).toMatchObject({ on: false, brightness: 100 });
    scheduler.stop();
  });

  it("fade_off stops if someone changes the light meanwhile", () => {
    const { rec, scheduler, engine } = setup("2026-10-28T06:59:00Z");
    scheduler.startFade({ device: "dl-00000a" }, 60_000, "Bedtime");
    vi.advanceTimersByTime(5_000);
    engine.command({ device: "dl-00000a" }, { brightness: 180 }, { origin: "web" });
    rec.clear();
    vi.advanceTimersByTime(120_000);
    expect(rec.sent).toHaveLength(0);
    expect(engine.getDevice("dl-00000a")!.replica!.state).toMatchObject({ on: true, brightness: 180 });
    scheduler.stop();
  });

  it("rejects schedules for unknown targets, scenes or time zones", () => {
    const { scheduler } = setup("2026-10-28T06:59:00Z");
    const base = { name: "x", when: { type: "cron" as const, expr: "0 7 * * *", tz: "UTC" }, action: { type: "power" as const, on: true }, enabled: true };
    expect(() => scheduler.create({ ...base, target: { device: "dl-ffffff" } })).toThrow(/target/);
    expect(() => scheduler.create({ ...base, target: { device: "dl-00000a" }, action: { type: "scene", scene_id: 99 } })).toThrow(/scene/);
    expect(() => scheduler.create({ ...base, target: { device: "dl-00000a" }, when: { type: "cron", expr: "0 7 * * *", tz: "Nowhere/City" } })).toThrow(/time zone/);
    scheduler.stop();
  });
});
