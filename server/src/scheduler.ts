// Schedules (05 §9): daily HH:MM + weekdays, or cron, in an IANA time zone (croner handles DST). Each run calls
// the engine with origin "schedule". Missed runs less than 5 minutes late fire at startup; later ones are skipped
// and logged.
import { Cron } from "croner";
import {
  type Schedule,
  type ScheduleAction,
  type ScheduleWhen,
  type StatePatch,
  type Target,
} from "@doublelamp/protocol";
import type { ActivityLog } from "./activity";
import { jsonOrNull, type DB } from "./db/db";
import type { CommandResult, SyncEngine } from "./engine/engine";
import type { Logger } from "./log";
import { scenePatch, type SceneStore } from "./scenes";
import { ApiError } from "./util/errors";

export const MISSED_GRACE_MS = 5 * 60_000;
export const FADE_STEP_MS = 10_000;
const SCHEDULE_TRANSITION_MS = 1000;
const MAX_TIMER_MS = 60_000;

const DOW: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

// ------------------------------------------------------------------ pure helpers

export function whenToCron(when: ScheduleWhen): { expr: string; tz: string } {
  if (when.type === "cron") return { expr: when.expr.trim(), tz: when.tz };
  const [hh, mm] = when.time.split(":").map(Number);
  const days = [...new Set(when.days.map((d) => DOW[d]!))].sort((a, b) => a - b).join(",");
  return { expr: `${mm} ${hh} * * ${days}`, tz: when.tz };
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Null when valid, otherwise a message. Cron must have 5 fields (minute resolution) or be an @nickname. */
export function validateWhen(when: ScheduleWhen): string | null {
  if (!isValidTimeZone(when.tz)) return `unknown time zone "${when.tz}"`;
  if (when.type === "cron") {
    const expr = when.expr.trim();
    if (!expr.startsWith("@") && expr.split(/\s+/).length !== 5) return "cron expressions need 5 fields (minute hour day month weekday)";
  }
  try {
    const { expr, tz } = whenToCron(when);
    if (nextRunFrom(expr, tz, Date.now()) === null) return "this schedule never runs";
  } catch (err) {
    return `invalid cron expression: ${(err as Error).message}`;
  }
  return null;
}

function nextRunFrom(expr: string, tz: string, fromMs: number): number | null {
  const job = new Cron(expr, { timezone: tz, paused: true });
  try {
    const next = job.nextRun(new Date(fromMs));
    return next ? next.getTime() : null;
  } finally {
    job.stop();
  }
}

/** The first run strictly after `fromMs`, in the schedule's time zone. */
export function nextRunAt(when: ScheduleWhen, fromMs: number): number | null {
  const { expr, tz } = whenToCron(when);
  return nextRunFrom(expr, tz, fromMs);
}

export type MissedDecision = "none" | "fire" | "skip";

/** At startup: a run that was due less than 5 minutes ago fires; anything later is skipped. */
export function missedRunDecision(nextRunAtMs: number | null, now: number, graceMs = MISSED_GRACE_MS): MissedDecision {
  if (nextRunAtMs === null || nextRunAtMs > now) return "none";
  return now - nextRunAtMs < graceMs ? "fire" : "skip";
}

export interface FadeStep {
  /** Offset from the start of the fade. */
  atMs: number;
  patch: StatePatch;
  transitionMs: number;
  kind: "dim" | "off" | "restore";
}

/**
 * fade_off: server-driven steps every ≈10 s from the current brightness down to 0 over `durationMs` (each step
 * fades over the step length, so the light moves smoothly), then `on: false`, then the original brightness is
 * restored while the lamp is off so the next "on" isn't at zero.
 */
export function planFadeOff(startBrightness: number, durationMs: number, stepMs = FADE_STEP_MS): FadeStep[] {
  const b0 = Math.max(0, Math.min(255, Math.round(startBrightness)));
  const steps = Math.max(1, Math.round(durationMs / stepMs));
  const step = durationMs / steps;
  const out: FadeStep[] = [];
  for (let k = 1; k <= steps; k++) {
    out.push({
      atMs: Math.round((k - 1) * step),
      patch: { brightness: Math.round((b0 * (steps - k)) / steps) },
      transitionMs: Math.min(10_000, Math.round(step)),
      kind: "dim",
    });
  }
  out.push({ atMs: Math.round(durationMs), patch: { on: false }, transitionMs: 0, kind: "off" });
  out.push({ atMs: Math.round(durationMs) + 2000, patch: { brightness: b0 }, transitionMs: 0, kind: "restore" });
  return out;
}

/** The patch a scheduled sunrise sends (05 §9). */
export function sunrisePatch(durationMin: number): StatePatch {
  return { on: true, brightness: 255, effect: { id: "sunrise", duration_ms: durationMin * 60_000 } };
}

// ------------------------------------------------------------------ runtime

interface Row {
  id: number;
  name: string;
  target_type: string;
  target_id: string;
  when_json: string;
  action_json: string;
  enabled: number;
  next_run_at: number | null;
  last_run_at: number | null;
  last_result: string | null;
}

function rowToSchedule(r: Row): Schedule {
  const target: Target = r.target_type === "group" ? { group: Number(r.target_id) } : { device: r.target_id };
  return {
    id: r.id,
    name: r.name,
    target,
    when: jsonOrNull<ScheduleWhen>(r.when_json)!,
    action: jsonOrNull<ScheduleAction>(r.action_json)!,
    enabled: r.enabled === 1,
    next_run_at: r.next_run_at,
    last_run_at: r.last_run_at,
    last_result: r.last_result,
  };
}

function targetKey(t: Target): string {
  return "device" in t ? `d:${t.device}` : `g:${t.group}`;
}

export interface ScheduleInput {
  name: string;
  target: Target;
  when: ScheduleWhen;
  action: ScheduleAction;
  enabled: boolean;
}

export interface SchedulerDeps {
  db: DB;
  clock: () => number;
  engine: SyncEngine;
  scenes: SceneStore;
  activity: ActivityLog;
  log: Logger;
  /** Missed runs (< 5 min late) fire this long after startup, so lamps have time to reconnect. */
  startupDelayMs?: number;
}

class FadeRun {
  private i = 0;
  private lastBrightness: number | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly t0: number;
  cancelled = false;

  constructor(
    private readonly target: Target,
    private readonly plan: FadeStep[],
    private readonly by: string,
    private readonly deps: SchedulerDeps,
    private readonly onDone: (result: string) => void,
  ) {
    this.t0 = deps.clock();
  }

  start(): void {
    this.next();
  }

  cancel(): void {
    this.cancelled = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private next(): void {
    if (this.cancelled) return;
    const step = this.plan[this.i];
    if (!step) return this.onDone("done");
    const delay = Math.max(0, this.t0 + step.atMs - this.deps.clock());
    this.timer = setTimeout(() => this.run(step), delay);
    this.timer.unref?.();
  }

  private run(step: FadeStep): void {
    if (this.cancelled) return;
    const cur = this.deps.engine.stateOf(this.target);
    if (!cur) return this.onDone("target removed");
    if (step.kind === "restore") {
      if (cur.on || cur.brightness !== 0) return this.onDone("done");
    } else if (this.i > 0 && (!cur.on || cur.brightness !== this.lastBrightness)) {
      // Someone else changed the light during the fade: stop.
      return this.onDone("interrupted");
    }
    const r = this.deps.engine.command(this.target, step.patch, {
      origin: "schedule",
      by: this.by,
      transitionMs: step.transitionMs,
      quiet: step.kind !== "off",
    });
    if (!r.ok) return this.onDone(r.code);
    if (step.patch.brightness !== undefined) this.lastBrightness = step.patch.brightness;
    this.i += 1;
    this.next();
  }
}

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  private readonly fades = new Map<string, FadeRun>();
  private readonly startupTimers = new Set<NodeJS.Timeout>();

  constructor(private readonly deps: SchedulerDeps) {}

  // ---------------------------------------------------------------- CRUD

  list(): Schedule[] {
    return (this.deps.db.prepare("SELECT * FROM schedules ORDER BY id").all() as Row[]).map(rowToSchedule);
  }

  get(id: number): Schedule | null {
    const row = this.deps.db.prepare("SELECT * FROM schedules WHERE id = ?").get(id) as Row | undefined;
    return row ? rowToSchedule(row) : null;
  }

  private validate(input: ScheduleInput): void {
    const t = input.target;
    if ("device" in t ? !this.deps.engine.getDevice(t.device) : !this.deps.engine.getGroup(t.group)) {
      throw new ApiError("invalid", "target: no such lamp or group", "target");
    }
    const whenErr = validateWhen(input.when);
    if (whenErr) throw new ApiError("invalid", `when: ${whenErr}`, "when");
    if (input.action.type === "scene" && !this.deps.scenes.get(input.action.scene_id)) {
      throw new ApiError("invalid", "action.scene_id: no such scene", "action.scene_id");
    }
  }

  create(input: ScheduleInput): Schedule {
    this.validate(input);
    const next = input.enabled ? nextRunAt(input.when, this.deps.clock()) : null;
    const id = Number(
      this.deps.db
        .prepare(
          "INSERT INTO schedules (name, target_type, target_id, when_json, action_json, enabled, next_run_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          input.name,
          "device" in input.target ? "device" : "group",
          "device" in input.target ? input.target.device : String(input.target.group),
          JSON.stringify(input.when),
          JSON.stringify(input.action),
          input.enabled ? 1 : 0,
          next,
        ).lastInsertRowid,
    );
    this.arm();
    return this.get(id)!;
  }

  update(id: number, patch: Partial<ScheduleInput>): Schedule | null {
    const cur = this.get(id);
    if (!cur) return null;
    const merged: ScheduleInput = {
      name: patch.name ?? cur.name,
      target: patch.target ?? cur.target,
      when: patch.when ?? cur.when,
      action: patch.action ?? cur.action,
      enabled: patch.enabled ?? cur.enabled,
    };
    this.validate(merged);
    const next = merged.enabled ? nextRunAt(merged.when, this.deps.clock()) : null;
    this.deps.db
      .prepare(
        "UPDATE schedules SET name = ?, target_type = ?, target_id = ?, when_json = ?, action_json = ?, enabled = ?, next_run_at = ? WHERE id = ?",
      )
      .run(
        merged.name,
        "device" in merged.target ? "device" : "group",
        "device" in merged.target ? merged.target.device : String(merged.target.group),
        JSON.stringify(merged.when),
        JSON.stringify(merged.action),
        merged.enabled ? 1 : 0,
        next,
        id,
      );
    this.arm();
    return this.get(id);
  }

  remove(id: number): boolean {
    const ok = this.deps.db.prepare("DELETE FROM schedules WHERE id = ?").run(id).changes > 0;
    this.arm();
    return ok;
  }

  // ---------------------------------------------------------------- lifecycle

  /** Handles runs missed while the server was down, then arms the timer. */
  start(): void {
    this.stopped = false;
    const now = this.deps.clock();
    const toFire: number[] = [];
    for (const s of this.list()) {
      if (!s.enabled) continue;
      const decision = missedRunDecision(s.next_run_at, now);
      if (decision === "fire") {
        toFire.push(s.id);
      } else if (decision === "skip") {
        const late = Math.round((now - s.next_run_at!) / 60_000);
        const result = `missed: the server was down at the scheduled time (${late} min ago)`;
        this.deps.log.warn({ schedule: s.id, name: s.name, scheduled_at: s.next_run_at }, "skipping a missed schedule run");
        this.deps.activity.record("schedule", {
          by: s.name || null,
          data: { schedule_id: s.id, name: s.name, result: "missed", scheduled_at: s.next_run_at },
        });
        this.deps.db.prepare("UPDATE schedules SET last_result = ? WHERE id = ?").run(result, s.id);
      }
      this.deps.db.prepare("UPDATE schedules SET next_run_at = ? WHERE id = ?").run(nextRunAt(s.when, now), s.id);
    }
    if (toFire.length) {
      const t = setTimeout(() => {
        this.startupTimers.delete(t);
        for (const id of toFire) {
          const s = this.get(id);
          if (s && s.enabled && !this.stopped) this.runSchedule(s, true);
        }
      }, this.deps.startupDelayMs ?? 10_000);
      t.unref?.();
      this.startupTimers.add(t);
    }
    this.arm();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const t of this.startupTimers) clearTimeout(t);
    this.startupTimers.clear();
    for (const f of this.fades.values()) f.cancel();
    this.fades.clear();
  }

  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.stopped) return;
    const row = this.deps.db
      .prepare("SELECT MIN(next_run_at) AS t FROM schedules WHERE enabled = 1 AND next_run_at IS NOT NULL")
      .get() as { t: number | null };
    if (row.t === null) return;
    const delay = Math.max(0, Math.min(row.t - this.deps.clock(), MAX_TIMER_MS));
    this.timer = setTimeout(() => this.tick(), delay);
    this.timer.unref?.();
  }

  private tick(): void {
    this.timer = null;
    const now = this.deps.clock();
    const due = (
      this.deps.db
        .prepare("SELECT * FROM schedules WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at")
        .all(now) as Row[]
    ).map(rowToSchedule);
    for (const s of due) {
      this.deps.db.prepare("UPDATE schedules SET next_run_at = ? WHERE id = ?").run(nextRunAt(s.when, now), s.id);
      this.runSchedule(s, false);
    }
    this.arm();
  }

  /** Runs one schedule now and records the result. */
  runSchedule(s: Schedule, missed: boolean): string {
    let result: string;
    try {
      result = this.execute(s);
    } catch (err) {
      this.deps.log.error({ err, schedule: s.id }, "schedule run failed");
      result = `error: ${(err as Error).message}`;
    }
    const now = this.deps.clock();
    this.deps.db.prepare("UPDATE schedules SET last_run_at = ?, last_result = ? WHERE id = ?").run(now, result, s.id);
    this.deps.activity.record("schedule", {
      deviceId: "device" in s.target ? s.target.device : null,
      by: s.name || null,
      data: { schedule_id: s.id, name: s.name, action: s.action.type, result, ...(missed ? { missed: true } : {}) },
    });
    this.deps.log.info({ schedule: s.id, action: s.action.type, result }, "schedule ran");
    return result;
  }

  private execute(s: Schedule): string {
    const by = s.name || `Schedule ${s.id}`;
    const base = { origin: "schedule", by };
    const a = s.action;
    let r: CommandResult;
    switch (a.type) {
      case "power":
        r = this.deps.engine.command(s.target, { on: a.on }, { ...base, transitionMs: SCHEDULE_TRANSITION_MS });
        break;
      case "scene": {
        const scene = this.deps.scenes.get(a.scene_id);
        if (!scene) return "error: scene not found";
        r = this.deps.engine.command(s.target, scenePatch(scene.state), { ...base, transitionMs: a.transition_ms ?? SCHEDULE_TRANSITION_MS });
        break;
      }
      case "sunrise":
        r = this.deps.engine.command(s.target, sunrisePatch(a.duration_min), {
          ...base,
          transitionMs: SCHEDULE_TRANSITION_MS,
          restartEffect: true,
        });
        break;
      case "fade_off":
        return this.startFade(s.target, a.duration_min * 60_000, by);
    }
    return r.ok ? "ok" : r.code === "offline" ? "offline" : `error: ${r.message}`;
  }

  /** The replicas a fade drives: the group while linked; each online lamp of an unlinked group. */
  private fadeTargets(target: Target): Target[] {
    const engine = this.deps.engine;
    if ("device" in target) {
      if (!engine.isOnline(target.device)) return [];
      const g = engine.linkedGroupOf(target.device);
      return [g ? { group: g.id } : target];
    }
    const g = engine.getGroup(target.group);
    if (!g) return [];
    if (g.linked) return engine.onlineMembers(g).length ? [target] : [];
    return engine.onlineMembers(g).map((d) => ({ device: d.id }));
  }

  startFade(target: Target, durationMs: number, by: string, stepMs = FADE_STEP_MS): string {
    const targets = this.fadeTargets(target);
    if (!targets.length) return "offline";
    let started = 0;
    for (const t of targets) {
      const state = this.deps.engine.stateOf(t);
      if (!state || !state.on) continue;
      const key = targetKey(t);
      this.fades.get(key)?.cancel();
      const run = new FadeRun(t, planFadeOff(state.brightness, durationMs, stepMs), by, this.deps, (result) => {
        if (this.fades.get(key) === run) this.fades.delete(key);
        this.deps.log.debug({ target: t, result }, "fade_off finished");
      });
      this.fades.set(key, run);
      run.start();
      started += 1;
    }
    return started ? "ok" : "already off";
  }
}
