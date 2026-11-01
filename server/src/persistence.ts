// Groups and replicas in SQLite. The engine's in-memory state is the source of truth; replica writes are
// batched to at most one per second per replica (05 §3).
import { lampStateSchema, type LampState } from "@doublelamp/protocol";
import type { DB } from "./db/db";
import { jsonOrNull } from "./db/db";
import type { OwnerRef, SyncEngine } from "./engine/engine";
import { makeReplica, zeroFieldTs, type FieldTs, type Replica } from "./engine/state";
import type { Logger } from "./log";

export interface GroupRow {
  id: number;
  name: string;
  linked: boolean;
  isDefault: boolean;
  members: string[];
}

export const DEFAULT_GROUP_NAME = "Both lamps";

export class GroupStore {
  constructor(private readonly db: DB) {}

  all(): GroupRow[] {
    const groups = this.db.prepare("SELECT id, name, linked, is_default FROM groups ORDER BY id").all() as {
      id: number;
      name: string;
      linked: number;
      is_default: number;
    }[];
    const members = this.db.prepare("SELECT group_id, device_id FROM group_members ORDER BY position, rowid").all() as {
      group_id: number;
      device_id: string;
    }[];
    return groups.map((g) => ({
      id: g.id,
      name: g.name,
      linked: g.linked === 1,
      isDefault: g.is_default === 1,
      members: members.filter((m) => m.group_id === g.id).map((m) => m.device_id),
    }));
  }

  defaultGroupId(): number | null {
    const row = this.db.prepare("SELECT id FROM groups WHERE is_default = 1 ORDER BY id LIMIT 1").get() as { id: number } | undefined;
    return row?.id ?? null;
  }

  create(name: string, isDefault: boolean): number {
    return Number(this.db.prepare("INSERT INTO groups (name, linked, is_default) VALUES (?, 0, ?)").run(name, isDefault ? 1 : 0).lastInsertRowid);
  }

  addMember(groupId: number, deviceId: string): void {
    const pos = (this.db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS p FROM group_members WHERE group_id = ?").get(groupId) as { p: number }).p;
    this.db.prepare("INSERT OR IGNORE INTO group_members (group_id, device_id, position) VALUES (?, ?, ?)").run(groupId, deviceId, pos);
  }

  update(id: number, patch: { name?: string; linked?: boolean }): void {
    if (patch.name !== undefined) this.db.prepare("UPDATE groups SET name = ? WHERE id = ?").run(patch.name, id);
    if (patch.linked !== undefined) this.db.prepare("UPDATE groups SET linked = ? WHERE id = ?").run(patch.linked ? 1 : 0, id);
  }
}

interface ReplicaRow {
  owner_type: "device" | "group";
  owner_id: string;
  state_json: string;
  field_ts_json: string;
  rev: number;
}

function ownerKey(o: OwnerRef): string {
  return `${o.type}:${o.id}`;
}

function parseReplica(row: ReplicaRow, log?: Logger): Replica | null {
  const parsed = lampStateSchema.safeParse(jsonOrNull<unknown>(row.state_json));
  if (!parsed.success) {
    log?.warn({ owner: `${row.owner_type}:${row.owner_id}` }, "ignoring a stored replica that no longer validates");
    return null;
  }
  const ts = { ...zeroFieldTs(), ...(jsonOrNull<Partial<FieldTs>>(row.field_ts_json) ?? {}) };
  return makeReplica(parsed.data as LampState, ts, row.rev);
}

export function loadReplicas(db: DB, log?: Logger): { devices: Map<string, Replica>; groups: Map<number, Replica> } {
  const devices = new Map<string, Replica>();
  const groups = new Map<number, Replica>();
  for (const row of db.prepare("SELECT * FROM replicas").all() as ReplicaRow[]) {
    const r = parseReplica(row, log);
    if (!r) continue;
    if (row.owner_type === "device") devices.set(row.owner_id, r);
    else groups.set(Number(row.owner_id), r);
  }
  return { devices, groups };
}

/** Coalesces replica writes: every dirty replica is written once per flush interval. */
export class ReplicaPersister {
  private readonly dirty = new Map<string, OwnerRef>();
  private timer: NodeJS.Timeout | null = null;
  private readonly upsert;
  private readonly del;

  constructor(
    private readonly db: DB,
    private readonly engine: () => SyncEngine,
    private readonly clock: () => number,
    private readonly log: Logger,
    private readonly intervalMs = 1000,
  ) {
    this.upsert = db.prepare(
      `INSERT INTO replicas (owner_type, owner_id, state_json, field_ts_json, rev, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(owner_type, owner_id) DO UPDATE SET state_json = excluded.state_json, field_ts_json = excluded.field_ts_json,
       rev = excluded.rev, updated_at = excluded.updated_at`,
    );
    this.del = db.prepare("DELETE FROM replicas WHERE owner_type = ? AND owner_id = ?");
  }

  mark(owner: OwnerRef): void {
    this.dirty.set(ownerKey(owner), owner);
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.flush();
      }, this.intervalMs);
      this.timer.unref?.();
    }
  }

  flush(): void {
    if (!this.dirty.size) return;
    const owners = [...this.dirty.values()];
    this.dirty.clear();
    const engine = this.engine();
    const now = this.clock();
    try {
      this.db.transaction(() => {
        for (const o of owners) {
          const replica = o.type === "device" ? engine.getDevice(o.id)?.replica : engine.getGroup(o.id)?.replica;
          if (!replica) {
            this.del.run(o.type, String(o.id));
            continue;
          }
          this.upsert.run(o.type, String(o.id), JSON.stringify(replica.state), JSON.stringify(replica.fieldTs), replica.rev, now);
        }
      })();
    } catch (err) {
      this.log.error({ err }, "failed to persist replicas");
    }
  }

  close(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.flush();
  }
}
