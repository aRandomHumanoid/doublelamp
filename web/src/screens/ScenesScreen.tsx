// Scenes (06 A.1): grid, save current, reorder (the first 8 become lamp presets, 05 §11), rename,
// update, delete, apply.
import { useMemo, useState, type FormEvent } from "react";
import { LIMITS, type Scene, type Target } from "@doublelamp/protocol";
import { api } from "../api/endpoints";
import { ConfirmDialog } from "../components/Dialog";
import { IconDown, IconPencil, IconPlus, IconTrash, IconUp } from "../components/Icons";
import { SaveSceneDialog, applyScene, upsertScene } from "../components/SceneControls";
import { StripPreview } from "../components/StripPreview";
import { describeState } from "../components/Tiles";
import { cls } from "../lib/format";
import { describeError, groupLabel } from "../live/names";
import { linkedGroupOf, reduceScenes } from "../live/reducers";
import { useControlTarget, useLayout } from "../live/selectors";
import { toast, useApp } from "../live/store";

const PRESET_SLOTS = LIMITS.presetSlots;

interface TargetOption {
  value: string;
  label: string;
  targets: Target[];
}

function useTargetOptions(): TargetOption[] {
  const layout = useLayout();
  const devices = useApp((s) => s.devices);
  const groups = useApp((s) => s.groups);
  return useMemo(() => {
    const out: TargetOption[] = [];
    for (const item of layout) {
      if (item.kind === "group") {
        if (item.group.linked) {
          out.push({ value: `g:${item.group.id}`, label: `${groupLabel(item.group)} (linked)`, targets: [{ group: item.group.id }] });
        } else {
          for (const m of item.members) out.push({ value: `d:${m}`, label: devices[m]?.name ?? m, targets: [{ device: m }] });
          out.push({ value: `both:${item.group.id}`, label: groupLabel(item.group), targets: item.members.map((m) => ({ device: m })) });
        }
      } else if (!linkedGroupOf({ groups }, item.id)) {
        out.push({ value: `d:${item.id}`, label: devices[item.id]?.name ?? item.id, targets: [{ device: item.id }] });
      }
    }
    return out;
  }, [layout, devices, groups]);
}

export default function ScenesScreen() {
  const scenes = useApp((s) => s.scenes);
  const live = useApp((s) => s.live);
  const ct = useControlTarget();
  const options = useTargetOptions();
  const defaultValue = ct ? ("group" in ct.target ? `g:${ct.target.group}` : `d:${ct.target.device}`) : "";
  const [choice, setChoice] = useState<string | null>(null);
  const value = choice && options.some((o) => o.value === choice) ? choice : defaultValue;
  const option = options.find((o) => o.value === value) ?? options[0];
  const [saving, setSaving] = useState(false);

  const move = async (index: number, delta: number) => {
    const next = [...scenes];
    const [it] = next.splice(index, 1);
    if (!it) return;
    next.splice(index + delta, 0, it);
    const ids = next.map((s) => s.id);
    useApp.setState((s) => reduceScenes(s, next.map((sc, i) => ({ ...sc, sort: i }))));
    try {
      const r = await api.reorderScenes(ids);
      useApp.setState((s) => reduceScenes(s, r.scenes));
    } catch (e) {
      toast("error", describeError(e));
      useApp.setState((s) => reduceScenes(s, scenes));
    }
  };

  return (
    <div className="screen">
      <div className="screen-head">
        <h1>Scenes</h1>
        <button type="button" className="btn btn-primary" disabled={!live || !ct} onClick={() => setSaving(true)}>
          <IconPlus size={18} /> Save current as scene
        </button>
      </div>
      <p className="muted">
        The first {PRESET_SLOTS} scenes also become presets 1–{PRESET_SLOTS} on each lamp, for its own page and its button.
      </p>
      {options.length > 0 && (
        <label className="field inline">
          <span>Apply to</span>
          <select value={value} onChange={(e) => setChoice(e.target.value)}>
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      )}
      {scenes.length === 0 ? (
        <div className="empty card">
          <h2>No scenes yet</h2>
          <p className="muted">Set up a look you like, then save it here.</p>
        </div>
      ) : (
        <ol className="scene-grid">
          {scenes.map((sc, i) => (
            <SceneCard
              key={sc.id}
              scene={sc}
              index={i}
              count={scenes.length}
              live={live}
              targets={option?.targets ?? []}
              targetLabel={option?.label ?? ""}
              onMove={(d) => void move(i, d)}
            />
          ))}
        </ol>
      )}
      {saving && <SaveSceneDialog onClose={() => setSaving(false)} />}
    </div>
  );
}

function SceneCard({
  scene,
  index,
  count,
  live,
  targets,
  targetLabel,
  onMove,
}: {
  scene: Scene;
  index: number;
  count: number;
  live: boolean;
  targets: Target[];
  targetLabel: string;
  onMove: (delta: number) => void;
}) {
  const ct = useControlTarget();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(scene.name);
  const [asking, setAsking] = useState<"delete" | "replace" | null>(null);
  const [busy, setBusy] = useState(false);

  const rename = async (e: FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (!n) return;
    setBusy(true);
    try {
      upsertScene(await api.updateScene(scene.id, { name: n }));
      setEditing(false);
    } catch (err) {
      toast("error", describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await api.deleteScene(scene.id);
      useApp.setState((s) => reduceScenes(s, s.scenes.filter((x) => x.id !== scene.id)));
      toast("ok", `Deleted “${scene.name}”`);
    } catch (err) {
      toast("error", describeError(err));
      setBusy(false);
    }
    setAsking(null);
  };

  const replace = async () => {
    if (!ct?.state) return;
    setBusy(true);
    try {
      upsertScene(await api.updateScene(scene.id, { state: ct.state }));
      toast("ok", `Updated “${scene.name}” from ${ct.label}`);
    } catch (err) {
      toast("error", describeError(err));
    } finally {
      setBusy(false);
      setAsking(null);
    }
  };

  const apply = async () => {
    setBusy(true);
    await Promise.all(targets.map((t) => applyScene(scene, t)));
    setBusy(false);
  };

  return (
    <li className={cls("scene-card", "card", index < PRESET_SLOTS && "preset")}>
      <div className="strip">
        <StripPreview state={scene.state} pixels={10} />
      </div>
      {editing ? (
        <form className="rename" onSubmit={rename}>
          <label className="sr-only" htmlFor={`scene-${scene.id}`}>
            Scene name
          </label>
          <input id={`scene-${scene.id}`} value={name} maxLength={LIMITS.nameMaxLength} onChange={(e) => setName(e.target.value)} autoFocus />
          <button type="submit" className="btn btn-primary small" disabled={busy}>
            Save
          </button>
          <button
            type="button"
            className="btn small"
            onClick={() => {
              setEditing(false);
              setName(scene.name);
            }}
          >
            Cancel
          </button>
        </form>
      ) : (
        <div className="scene-title">
          <h2>{scene.name}</h2>
          {index < PRESET_SLOTS && <span className="badge">Preset {index + 1}</span>}
        </div>
      )}
      <p className="muted small">{describeState(scene.state)}</p>
      <div className="scene-actions">
        <button type="button" className="btn btn-primary" disabled={!live || busy || targets.length === 0} onClick={() => void apply()}>
          Apply{targetLabel ? ` to ${targetLabel}` : ""}
        </button>
        <div className="icon-row">
          <button type="button" className="icon-btn" aria-label={`Move ${scene.name} up`} disabled={index === 0} onClick={() => onMove(-1)}>
            <IconUp />
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label={`Move ${scene.name} down`}
            disabled={index === count - 1}
            onClick={() => onMove(1)}
          >
            <IconDown />
          </button>
          <button type="button" className="icon-btn" aria-label={`Rename ${scene.name}`} onClick={() => setEditing(true)}>
            <IconPencil />
          </button>
          <button type="button" className="icon-btn danger" aria-label={`Delete ${scene.name}`} onClick={() => setAsking("delete")}>
            <IconTrash />
          </button>
        </div>
        <button type="button" className="text-link" disabled={!ct?.state || busy} onClick={() => setAsking("replace")}>
          Replace with the current look
        </button>
      </div>
      {asking === "delete" && (
        <ConfirmDialog title={`Delete “${scene.name}”?`} confirmLabel="Delete" danger busy={busy} onConfirm={() => void remove()} onClose={() => setAsking(null)}>
          <p>Schedules that use this scene will stop working.</p>
        </ConfirmDialog>
      )}
      {asking === "replace" && (
        <ConfirmDialog
          title={`Replace “${scene.name}”?`}
          confirmLabel="Replace"
          busy={busy}
          onConfirm={() => void replace()}
          onClose={() => setAsking(null)}
        >
          <p>The scene takes the current look of {ct?.label ?? "the selected lamp"}.</p>
        </ConfirmDialog>
      )}
    </li>
  );
}
