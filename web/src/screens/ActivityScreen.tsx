// Activity (06 A.1): timeline from GET /events — state changes with their source and browser label,
// connects and disconnects, OTA results, sign-ins.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { EventRecord } from "@doublelamp/protocol";
import { api } from "../api/endpoints";
import { IconRefresh } from "../components/Icons";
import { formatEvent, type ActivityContext } from "../lib/activity";
import { cls, formatTime } from "../lib/format";
import { describeError, groupLabel } from "../live/names";
import { useApp } from "../live/store";

const PAGE = 50;

function dayLabel(ts: number, now: Date): string {
  const d = new Date(ts);
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(now) - start(d)) / 86_400_000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
}

export default function ActivityScreen() {
  const devices = useApp((s) => s.devices);
  const groups = useApp((s) => s.groups);
  const scenes = useApp((s) => s.scenes);
  const [filter, setFilter] = useState("");
  const [events, setEvents] = useState<EventRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [more, setMore] = useState(false);

  const load = useCallback(
    async (before?: number) => {
      setLoading(true);
      setError(null);
      try {
        const r = await api.events({ device_id: filter || undefined, before, limit: PAGE });
        setEvents((prev) => {
          const base = before === undefined ? [] : prev;
          const seen = new Set(base.map((e) => e.id));
          return [...base, ...r.events.filter((e) => !seen.has(e.id))].sort((a, b) => b.ts - a.ts || b.id - a.id);
        });
        setMore(r.events.length >= PAGE);
      } catch (e) {
        setError(describeError(e));
      } finally {
        setLoading(false);
      }
    },
    [filter],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const ctx = useMemo<ActivityContext>(
    () => ({
      deviceName: (id) => devices[id]?.name ?? id,
      groupName: (id) => groupLabel(groups[id]),
      sceneName: (id) => scenes.find((s) => s.id === id)?.name,
    }),
    [devices, groups, scenes],
  );

  const days = useMemo(() => {
    const now = new Date();
    const out: { label: string; items: EventRecord[] }[] = [];
    for (const e of events) {
      const label = dayLabel(e.ts, now);
      const last = out[out.length - 1];
      if (last && last.label === label) last.items.push(e);
      else out.push({ label, items: [e] });
    }
    return out;
  }, [events]);

  return (
    <div className="screen narrow">
      <div className="screen-head">
        <h1>Activity</h1>
        <button type="button" className="icon-btn" onClick={() => void load()} aria-label="Refresh" disabled={loading}>
          <IconRefresh />
        </button>
      </div>
      <label className="field inline">
        <span>Show</span>
        <select value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="">All lamps</option>
          {Object.values(devices).map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      </label>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {!loading && !error && events.length === 0 && <p className="muted">Nothing yet.</p>}
      {days.map((day) => (
        <section key={day.label} className="timeline" aria-label={day.label}>
          <h2 className="section-label">{day.label}</h2>
          <ol>
            {day.items.map((e) => {
              const line = formatEvent(e, ctx);
              return (
                <li key={e.id} className={cls("event", `tone-${line.tone}`)}>
                  <time dateTime={new Date(e.ts).toISOString()}>{formatTime(e.ts)}</time>
                  <span className="event-text">
                    {line.text}
                    {line.source && <span className="muted"> · {line.source}</span>}
                  </span>
                </li>
              );
            })}
          </ol>
        </section>
      ))}
      {more && (
        <button type="button" className="btn wide" disabled={loading} onClick={() => void load(events[events.length - 1]?.ts)}>
          {loading ? "Loading…" : "Show older"}
        </button>
      )}
      {loading && events.length === 0 && <p className="muted">Loading…</p>}
    </div>
  );
}
