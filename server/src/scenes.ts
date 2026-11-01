// Scenes; the first 8 by `sort` are pushed to every lamp as presets 0–7 (05 §11).
import { LIMITS, cloneState, lampStateSchema, type LampState, type Preset, type Scene, type StatePatch } from "@doublelamp/protocol";
import { jsonOrNull, type DB } from "./db/db";

interface Row {
  id: number;
  name: string;
  state_json: string;
  sort: number;
  created_at: number | null;
}

/** Scenes store a look, not a moment: the effect epoch is meaningless and is stored as 0. */
function normalizeSceneState(s: LampState): LampState {
  const out = cloneState(s);
  out.effect.epoch = 0;
  return out;
}

function fromRow(r: Row): Scene {
  const parsed = lampStateSchema.safeParse(jsonOrNull<unknown>(r.state_json));
  return { id: r.id, name: r.name, sort: r.sort, state: parsed.success ? (parsed.data as LampState) : (JSON.parse(r.state_json) as LampState) };
}

/** The patch that applies a scene: its whole look, with no epoch so the effect restarts at apply_at. */
export function scenePatch(state: LampState): StatePatch {
  const { epoch: _epoch, ...effect } = state.effect;
  return { on: state.on, brightness: state.brightness, colors: [...state.colors], effect };
}

export class SceneStore {
  constructor(
    private readonly db: DB,
    private readonly clock: () => number,
  ) {}

  list(): Scene[] {
    return (this.db.prepare("SELECT * FROM scenes ORDER BY sort, id").all() as Row[]).map(fromRow);
  }

  get(id: number): Scene | null {
    const row = this.db.prepare("SELECT * FROM scenes WHERE id = ?").get(id) as Row | undefined;
    return row ? fromRow(row) : null;
  }

  create(name: string, state: LampState): Scene {
    const sort = (this.db.prepare("SELECT COALESCE(MAX(sort), -1) + 1 AS s FROM scenes").get() as { s: number }).s;
    const id = Number(
      this.db
        .prepare("INSERT INTO scenes (name, state_json, sort, created_at) VALUES (?, ?, ?, ?)")
        .run(name, JSON.stringify(normalizeSceneState(state)), sort, this.clock()).lastInsertRowid,
    );
    return this.get(id)!;
  }

  update(id: number, patch: { name?: string; state?: LampState; sort?: number }): Scene | null {
    if (!this.get(id)) return null;
    if (patch.name !== undefined) this.db.prepare("UPDATE scenes SET name = ? WHERE id = ?").run(patch.name, id);
    if (patch.state !== undefined) this.db.prepare("UPDATE scenes SET state_json = ? WHERE id = ?").run(JSON.stringify(normalizeSceneState(patch.state)), id);
    if (patch.sort !== undefined) this.db.prepare("UPDATE scenes SET sort = ? WHERE id = ?").run(patch.sort, id);
    return this.get(id);
  }

  remove(id: number): boolean {
    return this.db.prepare("DELETE FROM scenes WHERE id = ?").run(id).changes > 0;
  }

  /** Puts `ids` first, in that order; scenes not listed keep their relative order after them. */
  reorder(ids: number[]): Scene[] | { unknown: number } {
    const all = this.list();
    const known = new Set(all.map((s) => s.id));
    for (const id of ids) if (!known.has(id)) return { unknown: id };
    const seen = new Set<number>();
    const order = [...ids.filter((id) => (seen.has(id) ? false : (seen.add(id), true))), ...all.map((s) => s.id).filter((id) => !seen.has(id))];
    const stmt = this.db.prepare("UPDATE scenes SET sort = ? WHERE id = ?");
    this.db.transaction(() => order.forEach((id, i) => stmt.run(i, id)))();
    return this.list();
  }

  /** presets.sync data: the first 8 scenes by sort, slot = index. */
  presets(): Preset[] {
    return this.list()
      .slice(0, LIMITS.presetSlots)
      .map((s, slot) => ({ slot, name: s.name.slice(0, LIMITS.nameMaxLength), state: normalizeSceneState(s.state) }));
  }
}
