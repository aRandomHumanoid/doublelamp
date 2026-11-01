// Schedules (06 A.1, 05 §9): list with next-run times; the editor sets target, a daily time and days or
// a cron expression in an IANA time zone, and an action: power, scene, sunrise or fade off.
import { useMemo, useState, type CSSProperties, type FormEvent } from "react";
import { LIMITS, WEEKDAYS, scheduleCreateSchema, type Schedule, type ScheduleAction, type Target } from "@doublelamp/protocol";
import { api, type ScheduleBody } from "../api/endpoints";
import { ConfirmDialog, Dialog } from "../components/Dialog";
import { IconPlus } from "../components/Icons";
import { cls, timeAgo } from "../lib/format";
import { useAsync } from "../lib/hooks";
import {
  DAY_LONG,
  DAY_SHORT,
  WEEKEND,
  WORKDAYS,
  browserTimeZone,
  describeAction,
  describeWhen,
  formatNextRun,
  timeZones,
  type Weekday,
} from "../lib/schedule";
import { describeError, targetName } from "../live/names";
import { resolveControlTarget, useLayout } from "../live/selectors";
import { toast, useApp } from "../live/store";

export default function SchedulesScreen() {
  const res = useAsync(() => api.schedules(), []);
  const scenes = useApp((s) => s.scenes);
  const devices = useApp((s) => s.devices);
  const groups = useApp((s) => s.groups);
  const [editing, setEditing] = useState<Schedule | "new" | null>(null);
  const [deleting, setDeleting] = useState<Schedule | null>(null);
  const [busy, setBusy] = useState(false);
  const list = useMemo(
    () =>
      [...(res.data?.schedules ?? [])].sort(
        (a, b) => Number(b.enabled) - Number(a.enabled) || (a.next_run_at ?? Infinity) - (b.next_run_at ?? Infinity),
      ),
    [res.data],
  );

  const toggle = async (s: Schedule) => {
    try {
      const updated = await api.updateSchedule(s.id, { enabled: !s.enabled });
      res.setData((d) => (d ? { schedules: d.schedules.map((x) => (x.id === s.id ? updated : x)) } : d));
    } catch (e) {
      toast("error", describeError(e));
    }
  };

  const remove = async () => {
    if (!deleting) return;
    setBusy(true);
    try {
      await api.deleteSchedule(deleting.id);
      res.setData((d) => (d ? { schedules: d.schedules.filter((x) => x.id !== deleting.id) } : d));
      toast("ok", "Schedule deleted");
    } catch (e) {
      toast("error", describeError(e));
    } finally {
      setBusy(false);
      setDeleting(null);
    }
  };

  return (
    <div className="screen narrow">
      <div className="screen-head">
        <h1>Schedules</h1>
        <button type="button" className="btn btn-primary" onClick={() => setEditing("new")}>
          <IconPlus size={18} /> New schedule
        </button>
      </div>
      <p className="muted">Schedules run on the server, so they need it to be up (05 §9).</p>
      {res.loading && !res.data && <p className="muted">Loading…</p>}
      {res.error != null && (
        <p className="error">
          {describeError(res.error)}{" "}
          <button type="button" className="btn small" onClick={res.reload}>
            Retry
          </button>
        </p>
      )}
      {res.data && list.length === 0 && (
        <div className="empty card">
          <h2>No schedules</h2>
          <p className="muted">Wake up to a sunrise, or fade off at bedtime.</p>
        </div>
      )}
      <ul className="list">
        {list.map((s) => {
          const tz = s.when.tz;
          const next = s.enabled ? formatNextRun(s.next_run_at, tz) : null;
          return (
            <li key={s.id} className={cls("card", "schedule", !s.enabled && "disabled")}>
              <div className="schedule-main">
                <h2>{s.name || describeAction(s.action, scenes)}</h2>
                <p>
                  {describeWhen(s.when)} · {describeAction(s.action, scenes)} · {targetName({ devices, groups }, s.target)}
                </p>
                <p className="muted small">
                  {s.enabled ? (next ? `Next: ${next}` : "No upcoming run") : "Off"}
                  {s.last_run_at ? ` · Last ran ${timeAgo(s.last_run_at)}${s.last_result ? ` (${s.last_result})` : ""}` : ""}
                </p>
              </div>
              <div className="schedule-actions">
                <label className="switch">
                  <input type="checkbox" checked={s.enabled} onChange={() => void toggle(s)} />
                  <span className="sr-only">Enabled: {s.name || describeWhen(s.when)}</span>
                  <span className="switch-ui" aria-hidden="true" />
                </label>
                <button type="button" className="btn small" onClick={() => setEditing(s)}>
                  Edit
                </button>
                <button type="button" className="btn small btn-danger" onClick={() => setDeleting(s)}>
                  Delete
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      {editing && (
        <ScheduleEditor
          schedule={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(s) => {
            res.setData((d) => {
              const rest = (d?.schedules ?? []).filter((x) => x.id !== s.id);
              return { schedules: [...rest, s] };
            });
            setEditing(null);
          }}
        />
      )}
      {deleting && (
        <ConfirmDialog title="Delete this schedule?" confirmLabel="Delete" danger busy={busy} onConfirm={() => void remove()} onClose={() => setDeleting(null)}>
          <p>{deleting.name || describeWhen(deleting.when)}</p>
        </ConfirmDialog>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ editor

type ActionType = ScheduleAction["type"];

interface Draft {
  name: string;
  target: string;
  whenType: "daily" | "cron";
  time: string;
  days: Weekday[];
  expr: string;
  tz: string;
  action: ActionType;
  on: boolean;
  sceneId: number | null;
  transitionS: number;
  sunriseMin: number;
  fadeMin: number;
  enabled: boolean;
}

const encodeTarget = (t: Target): string => ("device" in t ? `d:${t.device}` : `g:${t.group}`);
const decodeTarget = (v: string): Target => (v.startsWith("g:") ? { group: Number(v.slice(2)) } : { device: v.slice(2) });

function draftFrom(s: Schedule | null, fallbackTarget: string, firstScene: number | null): Draft {
  const tz = s?.when.tz ?? browserTimeZone();
  const a = s?.action;
  return {
    name: s?.name ?? "",
    target: s ? encodeTarget(s.target) : fallbackTarget,
    whenType: s?.when.type ?? "daily",
    time: s?.when.type === "daily" ? s.when.time : "07:00",
    days: s?.when.type === "daily" ? [...s.when.days] : [...WORKDAYS],
    expr: s?.when.type === "cron" ? s.when.expr : "0 7 * * 1-5",
    tz,
    action: a?.type ?? "sunrise",
    on: a?.type === "power" ? a.on : true,
    sceneId: a?.type === "scene" ? a.scene_id : firstScene,
    transitionS: a?.type === "scene" && a.transition_ms !== undefined ? a.transition_ms / 1000 : 1,
    sunriseMin: a?.type === "sunrise" ? a.duration_min : 30,
    fadeMin: a?.type === "fade_off" ? a.duration_min : 20,
    enabled: s?.enabled ?? true,
  };
}

function bodyFrom(d: Draft): unknown {
  const action =
    d.action === "power"
      ? { type: "power", on: d.on }
      : d.action === "scene"
        ? { type: "scene", scene_id: d.sceneId ?? -1, transition_ms: Math.round(d.transitionS * 1000) }
        : d.action === "sunrise"
          ? { type: "sunrise", duration_min: d.sunriseMin }
          : { type: "fade_off", duration_min: d.fadeMin };
  return {
    name: d.name.trim(),
    target: decodeTarget(d.target),
    when: d.whenType === "daily" ? { type: "daily", time: d.time, days: WEEKDAYS.filter((x) => d.days.includes(x)), tz: d.tz } : { type: "cron", expr: d.expr.trim(), tz: d.tz },
    action,
    enabled: d.enabled,
  };
}

function ScheduleEditor({ schedule, onClose, onSaved }: { schedule: Schedule | null; onClose: () => void; onSaved: (s: Schedule) => void }) {
  const scenes = useApp((s) => s.scenes);
  const devices = useApp((s) => s.devices);
  const layout = useLayout();
  const groups = useApp((s) => s.groups);
  const fallback = useMemo(() => {
    const ct = resolveControlTarget(useApp.getState());
    return ct ? encodeTarget(ct.target) : "";
  }, []);
  const [d, setD] = useState<Draft>(() => draftFrom(schedule, fallback, scenes[0]?.id ?? null));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const zones = useMemo(() => timeZones(d.tz), [d.tz]);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));

  const targets = useMemo(() => {
    const out: { value: string; label: string }[] = [];
    for (const item of layout) {
      if (item.kind === "group") {
        out.push({ value: `g:${item.group.id}`, label: `Both lamps${item.group.linked ? " (linked)" : ""}` });
        for (const m of item.members) out.push({ value: `d:${m}`, label: devices[m]?.name ?? m });
      } else out.push({ value: `d:${item.id}`, label: devices[item.id]?.name ?? item.id });
    }
    if (d.target && !out.some((o) => o.value === d.target)) out.push({ value: d.target, label: targetName({ devices, groups }, decodeTarget(d.target)) });
    return out;
  }, [layout, devices, groups, d.target]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (d.whenType === "daily" && d.days.length === 0) {
      setError("Pick at least one day");
      return;
    }
    if (d.action === "scene" && d.sceneId === null) {
      setError("Pick a scene");
      return;
    }
    const parsed = scheduleCreateSchema.safeParse(bodyFrom(d));
    if (!parsed.success) {
      const i = parsed.error.issues[0];
      setError(i ? `${i.path.join(".")}: ${i.message}` : "Check the form");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const body = parsed.data as ScheduleBody;
      const saved = schedule ? await api.updateSchedule(schedule.id, body) : await api.createSchedule(body);
      toast("ok", schedule ? "Schedule saved" : "Schedule created");
      onSaved(saved);
    } catch (err) {
      setError(describeError(err));
      setBusy(false);
    }
  };

  const toggleDay = (day: Weekday) => set("days", d.days.includes(day) ? d.days.filter((x) => x !== day) : [...d.days, day]);

  return (
    <Dialog
      title={schedule ? "Edit schedule" : "New schedule"}
      onClose={onClose}
      className="wide-dialog"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="schedule-form" className="btn btn-primary" disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      <form id="schedule-form" className="form" onSubmit={submit} noValidate>
        <label className="field">
          <span>
            Name <span className="muted">(optional)</span>
          </span>
          <input value={d.name} maxLength={LIMITS.nameMaxLength} placeholder="Wake up" onChange={(e) => set("name", e.target.value)} />
        </label>
        <label className="field">
          <span>Lamps</span>
          <select value={d.target} onChange={(e) => set("target", e.target.value)}>
            {targets.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </label>

        <fieldset className="field">
          <legend>When</legend>
          <div className="segmented" role="radiogroup" aria-label="Repeat">
            {(["daily", "cron"] as const).map((w) => (
              <label key={w} className={cls("seg", d.whenType === w && "on")}>
                <input type="radio" name="when" value={w} checked={d.whenType === w} onChange={() => set("whenType", w)} />
                <span>{w === "daily" ? "Time and days" : "Cron"}</span>
              </label>
            ))}
          </div>
          {d.whenType === "daily" ? (
            <>
              <label className="field">
                <span>Time</span>
                <input type="time" value={d.time} required onChange={(e) => set("time", e.target.value.slice(0, 5))} />
              </label>
              <div className="days" role="group" aria-label="Days">
                {WEEKDAYS.map((day) => (
                  <button
                    key={day}
                    type="button"
                    className={cls("day", d.days.includes(day) && "on")}
                    aria-pressed={d.days.includes(day)}
                    aria-label={DAY_LONG[day]}
                    onClick={() => toggleDay(day)}
                  >
                    {DAY_SHORT[day]}
                  </button>
                ))}
              </div>
              <div className="preset-row">
                <button type="button" className="btn small" onClick={() => set("days", [...WEEKDAYS])}>
                  Every day
                </button>
                <button type="button" className="btn small" onClick={() => set("days", [...WORKDAYS])}>
                  Weekdays
                </button>
                <button type="button" className="btn small" onClick={() => set("days", [...WEEKEND])}>
                  Weekends
                </button>
              </div>
            </>
          ) : (
            <label className="field">
              <span>Cron expression</span>
              <input className="mono" value={d.expr} onChange={(e) => set("expr", e.target.value)} aria-describedby="cron-hint" />
              <small id="cron-hint" className="muted">
                minute hour day-of-month month day-of-week, e.g. “30 22 * * 0-4”
              </small>
            </label>
          )}
          <label className="field">
            <span>Time zone</span>
            <select value={d.tz} onChange={(e) => set("tz", e.target.value)}>
              {zones.map((z) => (
                <option key={z} value={z}>
                  {z}
                </option>
              ))}
            </select>
          </label>
        </fieldset>

        <fieldset className="field">
          <legend>Action</legend>
          <label className="field">
            <span>Do</span>
            <select value={d.action} onChange={(e) => set("action", e.target.value as ActionType)}>
              <option value="sunrise">Sunrise</option>
              <option value="fade_off">Fade off</option>
              <option value="power">Turn on or off</option>
              <option value="scene" disabled={scenes.length === 0}>
                Apply a scene
              </option>
            </select>
          </label>
          {d.action === "power" && (
            <div className="segmented" role="radiogroup" aria-label="Power">
              {[true, false].map((v) => (
                <label key={String(v)} className={cls("seg", d.on === v && "on")}>
                  <input type="radio" name="power" checked={d.on === v} onChange={() => set("on", v)} />
                  <span>{v ? "On" : "Off"}</span>
                </label>
              ))}
            </div>
          )}
          {d.action === "scene" && (
            <>
              <label className="field">
                <span>Scene</span>
                <select value={d.sceneId ?? ""} onChange={(e) => set("sceneId", Number(e.target.value))}>
                  {scenes.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Fade over (seconds)</span>
                <input type="number" min={0} max={10} step={0.1} value={d.transitionS} onChange={(e) => set("transitionS", e.target.valueAsNumber || 0)} />
              </label>
            </>
          )}
          {d.action === "sunrise" && (
            <label className="field">
              <span>Sunrise length: {d.sunriseMin} min</span>
              <input
                className="range"
                type="range"
                min={5}
                max={60}
                value={d.sunriseMin}
                aria-valuetext={`${d.sunriseMin} minutes`}
                onChange={(e) => set("sunriseMin", Number(e.target.value))}
                style={{ "--fill": `${((d.sunriseMin - 5) / 55) * 100}%` } as CSSProperties}
              />
            </label>
          )}
          {d.action === "fade_off" && (
            <label className="field">
              <span>Fade length: {d.fadeMin} min</span>
              <input
                className="range"
                type="range"
                min={1}
                max={120}
                value={d.fadeMin}
                aria-valuetext={`${d.fadeMin} minutes`}
                onChange={(e) => set("fadeMin", Number(e.target.value))}
                style={{ "--fill": `${((d.fadeMin - 1) / 119) * 100}%` } as CSSProperties}
              />
            </label>
          )}
        </fieldset>

        <label className="field check">
          <input type="checkbox" checked={d.enabled} onChange={(e) => set("enabled", e.target.checked)} />
          <span>Enabled</span>
        </label>
        <p className="error" role="alert">
          {error}
        </p>
      </form>
    </Dialog>
  );
}
