// Lamp metadata: name, token hash, firmware, info, LED config, telemetry. In memory, written through to `devices`.
// Sync state (online, group, replica) lives in the engine.
import type { DeviceInfo, Hw, LedConfig, Telemetry } from "@doublelamp/protocol";
import { jsonOrNull, type DB } from "./db/db";
import { safeEqualHex, sha256Hex } from "./util/crypto";

export interface DeviceRecord {
  id: string;
  name: string;
  tokenHash: string | null;
  fw: string | null;
  hw: Hw | null;
  config: LedConfig | null;
  info: DeviceInfo | null;
  telemetry: Telemetry | null;
  effects: string[];
  pendingVerify: boolean;
  /** Renamed in the web app while offline: send name.set after the next welcome. */
  namePending: boolean;
  claimedAt: number | null;
  lastSeenAt: number | null;
}

interface Row {
  id: string;
  name: string;
  token_hash: string | null;
  fw: string | null;
  hw_json: string | null;
  config_json: string | null;
  info_json: string | null;
  telemetry_json: string | null;
  effects_json: string | null;
  pending_verify: number;
  name_pending: number;
  claimed_at: number | null;
  last_seen_at: number | null;
}

function fromRow(r: Row): DeviceRecord {
  return {
    id: r.id,
    name: r.name,
    tokenHash: r.token_hash,
    fw: r.fw,
    hw: jsonOrNull<Hw>(r.hw_json),
    config: jsonOrNull<LedConfig>(r.config_json),
    info: jsonOrNull<DeviceInfo>(r.info_json),
    telemetry: jsonOrNull<Telemetry>(r.telemetry_json),
    effects: jsonOrNull<string[]>(r.effects_json) ?? [],
    pendingVerify: r.pending_verify === 1,
    namePending: r.name_pending === 1,
    claimedAt: r.claimed_at,
    lastSeenAt: r.last_seen_at,
  };
}

type Patch = Partial<Omit<DeviceRecord, "id">>;

const COLUMNS: Record<keyof Patch, [string, (v: never) => unknown]> = {
  name: ["name", (v: string) => v],
  tokenHash: ["token_hash", (v: string | null) => v],
  fw: ["fw", (v: string | null) => v],
  hw: ["hw_json", (v: Hw | null) => (v ? JSON.stringify(v) : null)],
  config: ["config_json", (v: LedConfig | null) => (v ? JSON.stringify(v) : null)],
  info: ["info_json", (v: DeviceInfo | null) => (v ? JSON.stringify(v) : null)],
  telemetry: ["telemetry_json", (v: Telemetry | null) => (v ? JSON.stringify(v) : null)],
  effects: ["effects_json", (v: string[]) => JSON.stringify(v)],
  pendingVerify: ["pending_verify", (v: boolean) => (v ? 1 : 0)],
  namePending: ["name_pending", (v: boolean) => (v ? 1 : 0)],
  claimedAt: ["claimed_at", (v: number | null) => v],
  lastSeenAt: ["last_seen_at", (v: number | null) => v],
};

export class DeviceRegistry {
  private readonly records = new Map<string, DeviceRecord>();
  private readonly seenDirty = new Set<string>();

  constructor(private readonly db: DB) {
    for (const row of db.prepare("SELECT * FROM devices").all() as Row[]) this.records.set(row.id, fromRow(row));
  }

  all(): DeviceRecord[] {
    return [...this.records.values()].sort((a, b) => (a.claimedAt ?? 0) - (b.claimedAt ?? 0) || a.id.localeCompare(b.id));
  }

  get(id: string): DeviceRecord | undefined {
    return this.records.get(id);
  }

  /** Finds the lamp a bearer token belongs to: sha256 lookup with a constant-time comparison. */
  byToken(token: string): DeviceRecord | undefined {
    if (!token || token.length > 128) return undefined;
    const h = sha256Hex(token);
    let found: DeviceRecord | undefined;
    for (const r of this.records.values()) {
      if (r.tokenHash && safeEqualHex(r.tokenHash, h)) found = r;
    }
    return found;
  }

  /** Creates or updates the row for a claim; re-claiming replaces the token hash (the old token stops working). */
  claim(input: { id: string; name: string; fw: string; hw: Hw; tokenHash: string; now: number }): { record: DeviceRecord; created: boolean } {
    const existing = this.records.get(input.id);
    if (existing) {
      const record = this.update(input.id, { name: input.name, fw: input.fw, hw: input.hw, tokenHash: input.tokenHash, claimedAt: input.now });
      return { record, created: false };
    }
    this.db
      .prepare("INSERT INTO devices (id, name, token_hash, fw, hw_json, claimed_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(input.id, input.name, input.tokenHash, input.fw, JSON.stringify(input.hw), input.now);
    const record: DeviceRecord = {
      id: input.id,
      name: input.name,
      tokenHash: input.tokenHash,
      fw: input.fw,
      hw: input.hw,
      config: null,
      info: null,
      telemetry: null,
      effects: [],
      pendingVerify: false,
      namePending: false,
      claimedAt: input.now,
      lastSeenAt: null,
    };
    this.records.set(record.id, record);
    return { record, created: true };
  }

  update(id: string, patch: Patch): DeviceRecord {
    const rec = this.records.get(id);
    if (!rec) throw new Error(`unknown device ${id}`);
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [key, value] of Object.entries(patch) as [keyof Patch, unknown][]) {
      if (value === undefined) continue;
      const col = COLUMNS[key];
      sets.push(`${col[0]} = ?`);
      values.push((col[1] as (v: unknown) => unknown)(value));
      (rec as unknown as Record<string, unknown>)[key] = value;
    }
    if (sets.length) this.db.prepare(`UPDATE devices SET ${sets.join(", ")} WHERE id = ?`).run(...values, id);
    if (patch.lastSeenAt !== undefined) this.seenDirty.delete(id);
    return rec;
  }

  /** Updates last_seen_at in memory; `flushLastSeen` persists it. */
  touch(id: string, now: number): void {
    const rec = this.records.get(id);
    if (!rec) return;
    rec.lastSeenAt = now;
    this.seenDirty.add(id);
  }

  flushLastSeen(): void {
    if (!this.seenDirty.size) return;
    const stmt = this.db.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?");
    this.db.transaction(() => {
      for (const id of this.seenDirty) {
        const rec = this.records.get(id);
        if (rec) stmt.run(rec.lastSeenAt, id);
      }
    })();
    this.seenDirty.clear();
  }

  /** Deletes the lamp, its group membership (cascade), replica and OTA jobs (cascade). */
  remove(id: string): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM replicas WHERE owner_type = 'device' AND owner_id = ?").run(id);
      this.db.prepare("DELETE FROM devices WHERE id = ?").run(id);
    })();
    this.records.delete(id);
    this.seenDirty.delete(id);
  }
}
