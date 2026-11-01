// Scenes row on Home, the save-scene dialog, and applying a scene.
import { useState, type FormEvent } from "react";
import { LIMITS, TRANSITION, sceneCreateSchema, type Scene, type Target } from "@doublelamp/protocol";
import { api } from "../api/endpoints";
import { describeError, targetName } from "../live/names";
import { reduceScenes } from "../live/reducers";
import { resolveControlTarget, useControlTarget } from "../live/selectors";
import { toast, useApp } from "../live/store";
import { Dialog } from "./Dialog";
import { IconPlus } from "./Icons";

export async function applyScene(scene: Scene, target: Target): Promise<boolean> {
  const name = targetName(useApp.getState(), target);
  try {
    await api.applyScene(scene.id, target, TRANSITION.tapMs);
    return true;
  } catch (e) {
    toast("error", describeError(e, name));
    return false;
  }
}

/** Applies to whatever the control sheet controls: the group while linked, else the selected lamp. */
export function applySceneToCurrent(scene: Scene): void {
  const ct = resolveControlTarget(useApp.getState());
  if (ct) void applyScene(scene, ct.target);
}

export function upsertScene(scene: Scene): void {
  useApp.setState((s) => reduceScenes(s, [...s.scenes.filter((x) => x.id !== scene.id), scene]));
}

export function SaveSceneDialog({ onClose }: { onClose: () => void }) {
  const ct = useControlTarget();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ct) return;
    const body = { name: name.trim(), from: ct.target };
    const parsed = sceneCreateSchema.safeParse(body);
    if (!parsed.success) {
      setError(body.name ? (parsed.error.issues[0]?.message ?? "Check the name") : "Give the scene a name");
      return;
    }
    setBusy(true);
    try {
      const scene = await api.createScene(body);
      upsertScene(scene);
      toast("ok", `Saved “${scene.name}”`);
      onClose();
    } catch (err) {
      setError(describeError(err));
      setBusy(false);
    }
  };

  return (
    <Dialog
      title="Save current look as a scene"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="save-scene" className="btn btn-primary" disabled={busy || !ct}>
            Save
          </button>
        </>
      }
    >
      <form id="save-scene" className="form" onSubmit={submit}>
        <label className="field">
          <span>Name</span>
          <input
            value={name}
            maxLength={LIMITS.nameMaxLength}
            onChange={(e) => setName(e.target.value)}
            placeholder="Cozy"
            data-autofocus
            required
            aria-invalid={!!error}
            aria-describedby="save-scene-err"
          />
        </label>
        <p className="muted">From {ct?.label ?? "the selected lamp"}. The first 8 scenes also become presets on the lamps.</p>
        <p id="save-scene-err" className="error" role="alert">
          {error}
        </p>
      </form>
    </Dialog>
  );
}

export function ScenesRow() {
  const scenes = useApp((s) => s.scenes);
  const live = useApp((s) => s.live);
  const [saving, setSaving] = useState(false);
  return (
    <section className="scenes-row" aria-labelledby="scenes-row-h">
      <div className="row-head">
        <h2 id="scenes-row-h" className="section-label">
          Scenes
        </h2>
        <a className="text-link" href="#/scenes">
          All scenes
        </a>
      </div>
      <div className="chips">
        {scenes.map((sc) => (
          <button
            key={sc.id}
            type="button"
            className="chip"
            disabled={!live}
            onClick={() => applySceneToCurrent(sc)}
            aria-label={`Apply scene ${sc.name}`}
          >
            <span className="chip-dot" style={{ backgroundColor: sc.state.colors[0] }} aria-hidden="true" />
            <span>{sc.name}</span>
          </button>
        ))}
        <button
          type="button"
          className="chip add"
          disabled={!live}
          onClick={() => setSaving(true)}
          aria-label="Save current look as a scene"
          title="Save current look as a scene"
        >
          <IconPlus size={18} />
          {scenes.length === 0 && <span>Save current look</span>}
        </button>
      </div>
      {saving && <SaveSceneDialog onClose={() => setSaving(false)} />}
    </section>
  );
}
