// Human-readable schedules (05 §9).
import { WEEKDAYS, type Scene, type ScheduleAction, type ScheduleWhen } from "@doublelamp/protocol";

export type Weekday = (typeof WEEKDAYS)[number];

export const DAY_SHORT: Record<Weekday, string> = {
  mon: "Mon",
  tue: "Tue",
  wed: "Wed",
  thu: "Thu",
  fri: "Fri",
  sat: "Sat",
  sun: "Sun",
};
export const DAY_LONG: Record<Weekday, string> = {
  mon: "Monday",
  tue: "Tuesday",
  wed: "Wednesday",
  thu: "Thursday",
  fri: "Friday",
  sat: "Saturday",
  sun: "Sunday",
};
export const WORKDAYS: Weekday[] = ["mon", "tue", "wed", "thu", "fri"];
export const WEEKEND: Weekday[] = ["sat", "sun"];

export function describeDays(days: readonly Weekday[]): string {
  const set = new Set(days);
  if (set.size === 7) return "Every day";
  if (set.size === 5 && WORKDAYS.every((d) => set.has(d))) return "Weekdays";
  if (set.size === 2 && WEEKEND.every((d) => set.has(d))) return "Weekends";
  return WEEKDAYS.filter((d) => set.has(d))
    .map((d) => DAY_SHORT[d])
    .join(", ");
}

export function describeWhen(w: ScheduleWhen): string {
  return w.type === "daily" ? `${describeDays(w.days)} at ${w.time}` : `Cron ${w.expr}`;
}

export function describeAction(a: ScheduleAction, scenes: readonly Scene[]): string {
  switch (a.type) {
    case "power":
      return a.on ? "Turn on" : "Turn off";
    case "scene": {
      const s = scenes.find((x) => x.id === a.scene_id);
      return `Scene ${s ? `“${s.name}”` : `#${a.scene_id}`}`;
    }
    case "sunrise":
      return `Sunrise over ${a.duration_min} min`;
    case "fade_off":
      return `Fade off over ${a.duration_min} min`;
  }
}

export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function timeZones(current: string): string[] {
  let list: string[] = [];
  try {
    list = Intl.supportedValuesOf("timeZone");
  } catch {
    list = [];
  }
  const out = new Set(list);
  out.add("UTC");
  if (current) out.add(current);
  return [...out].sort();
}

function relative(ms: number): string {
  if (ms < 30_000) return "now";
  const m = Math.round(ms / 60_000);
  if (m < 60) return `in ${m} min`;
  const h = Math.round(m / 60);
  if (h < 48) return `in ${h} h`;
  return `in ${Math.round(h / 24)} d`;
}

/** "Tue 07:00 · in 9 h", shown in the schedule's own time zone. */
export function formatNextRun(ts: number | null, tz: string, now = Date.now()): string | null {
  if (ts == null) return null;
  const zone = isValidTimeZone(tz) ? tz : undefined;
  const text = new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: zone,
  }).format(ts);
  const tzNote = zone && zone !== browserTimeZone() ? ` (${zone})` : "";
  return `${text}${tzNote} · ${relative(ts - now)}`;
}
