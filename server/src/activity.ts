// Activity log (`events`, 05 §14): state changes with origin and session label, connects and disconnects,
// OTA results, failed logins. Rapid state changes to one target from one source (slider drags) are merged into
// one row. Rows older than 30 days are deleted by the daily retention job.
import type { EventRecord, StatePatch, Target } from "@doublelamp/protocol";
import { jsonOrNull, type DB } from "./db/db";

export const RETENTION_MS = 30 * 24 * 3600_000;
const COALESCE_MS = 3000;

export interface RecordInput {
  deviceId?: string | null;
  by?: string | null;
  data?: Record<string, unknown> | null;
}

interface Row {
  id: number;
  ts: number;
  kind: string;
  device_id: string | null;
  by_label: string | null;
  data_json: string | null;
}

function mergePatch(a: StatePatch, b: StatePatch): StatePatch {
  const out: StatePatch = { ...a, ...b };
  if (a.effect && b.effect) out.effect = { ...a.effect, ...b.effect };
  return out;
}

export class ActivityLog {
  private lastId = 0;
  private lastState: { id: number; key: string; ts: number; data: Record<string, unknown> } | null = null;

  constructor(
    private readonly db: DB,
    private readonly clock: () => number,
    private readonly coalesceMs = COALESCE_MS,
  ) {}

  record(kind: string, input: RecordInput = {}): number {
    const ts = this.clock();
    const id = Number(
      this.db
        .prepare("INSERT INTO events (ts, kind, device_id, by_label, data_json) VALUES (?, ?, ?, ?, ?)")
        .run(ts, kind, input.deviceId ?? null, input.by ?? null, input.data ? JSON.stringify(input.data) : null).lastInsertRowid,
    );
    this.lastId = id;
    return id;
  }

  recordState(rec: { target: Target; deviceId: string | null; patch: StatePatch; origin: string; by?: string; extra?: Record<string, unknown> }): void {
    const now = this.clock();
    const key = `${JSON.stringify(rec.target)}|${rec.deviceId ?? ""}|${rec.origin}|${rec.by ?? ""}|${JSON.stringify(rec.extra ?? {})}`;
    const last = this.lastState;
    if (last && last.id === this.lastId && last.key === key && now - last.ts < this.coalesceMs) {
      const data = { ...last.data, patch: mergePatch(last.data.patch as StatePatch, rec.patch) };
      this.db.prepare("UPDATE events SET ts = ?, data_json = ? WHERE id = ?").run(now, JSON.stringify(data), last.id);
      this.lastState = { ...last, ts: now, data };
      return;
    }
    const data: Record<string, unknown> = { target: rec.target, patch: rec.patch, origin: rec.origin, ...(rec.extra ?? {}) };
    const id = this.record("state", { deviceId: rec.deviceId, by: rec.by ?? null, data });
    this.lastState = { id, key, ts: now, data };
  }

  /**
   * Newest first. `before` is an event id when it's a small number (< 1e11): events with id < before, exact.
   * Otherwise it's a timestamp in ms and is inclusive (ts <= before), so events sharing the last row's
   * millisecond aren't skipped; clients paging by `ts` drop the repeated rows by id.
   */
  query(opts: { deviceId?: string; before?: number; limit?: number }): EventRecord[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts.deviceId) {
      where.push("device_id = ?");
      args.push(opts.deviceId);
    }
    if (opts.before !== undefined) {
      if (opts.before < 1e11) where.push("id < ?");
      else where.push("ts <= ?");
      args.push(opts.before);
    }
    const limit = Math.max(1, Math.min(500, opts.limit ?? 50));
    const rows = this.db
      .prepare(`SELECT * FROM events ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY ts DESC, id DESC LIMIT ?`)
      .all(...args, limit) as Row[];
    return rows.map((r) => ({
      id: r.id,
      ts: r.ts,
      kind: r.kind,
      device_id: r.device_id,
      by_label: r.by_label,
      data: jsonOrNull<Record<string, unknown>>(r.data_json),
    }));
  }

  purgeOlderThan(ageMs = RETENTION_MS): number {
    return this.db.prepare("DELETE FROM events WHERE ts < ?").run(this.clock() - ageMs).changes;
  }
}
