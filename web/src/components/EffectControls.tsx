// EffectGallery and the effect's parameters (06 A.3). The gallery is built from the EffectDesc catalog,
// filtered by the caller to effects every targeted lamp supports.
import { memo, useMemo } from "react";
import type { PreviewState } from "@doublelamp/effects";
import type { EffectDesc, LampState } from "@doublelamp/protocol";
import { clamp } from "../lib/color";
import { cls, fromPercent, percent } from "../lib/format";
import { ParamSlider } from "./controls";
import { StripPreview, type DemoFn } from "./StripPreview";

/** What `intensity` means for each effect (03 §6). The catalog doesn't name it, so the UI does. */
const INTENSITY_LABEL: Record<string, string> = {
  breathe: "Depth",
  cycle: "Saturation",
  rainbow: "Hue span",
  candle: "Flicker",
  twinkle: "Density",
};

const DEMO_MS = 6000;
const DEMO_HOLD_MS = 1500;

/** Loops a one-shot effect (sunrise) over a few seconds in its thumbnail. */
const loopDemo: DemoFn = (s, now) => ({
  ...s,
  effect: { ...s.effect, epoch: now - (now % (DEMO_MS + DEMO_HOLD_MS)), duration_ms: DEMO_MS },
});

const EffectCard = memo(function EffectCard({
  effect,
  colorsKey,
  selected,
  pixels,
  onPick,
}: {
  effect: EffectDesc;
  colorsKey: string;
  selected: boolean;
  pixels: number;
  onPick: (e: EffectDesc) => void;
}) {
  const mini = useMemo<PreviewState>(
    () => ({
      on: true,
      brightness: 255,
      colors: colorsKey.split(","),
      effect: {
        id: effect.id,
        speed: effect.defaults.speed,
        intensity: effect.defaults.intensity,
        seed: 0x5eed,
        epoch: 0,
        duration_ms: effect.defaults.duration_ms ?? 0,
      },
    }),
    [effect, colorsKey],
  );
  return (
    <button
      type="button"
      className={cls("effect-card", selected && "selected")}
      aria-pressed={selected}
      onClick={() => onPick(effect)}
    >
      <span className="effect-thumb">
        <StripPreview state={mini} pixels={pixels} variant="mini" demo={effect.oneshot ? loopDemo : undefined} />
      </span>
      <span className="effect-name">{effect.name}</span>
    </button>
  );
});

export function EffectGallery({
  effects,
  state,
  pixels,
  onPick,
}: {
  effects: readonly EffectDesc[];
  state: LampState;
  pixels: number;
  onPick: (e: EffectDesc) => void;
}) {
  const colorsKey = state.colors.join(",");
  return (
    <section className="effects-section" aria-labelledby="effects-h">
      <h3 id="effects-h" className="section-label">
        Effects
      </h3>
      <div className="effects" role="group" aria-labelledby="effects-h">
        {effects.map((e) => (
          <EffectCard
            key={e.id}
            effect={e}
            colorsKey={colorsKey}
            selected={e.id === state.effect.id}
            pixels={pixels}
            onPick={onPick}
          />
        ))}
      </div>
    </section>
  );
}

/** Only the parameters the current effect uses: speed, intensity (named per effect) and duration in minutes. */
export function EffectParams({
  effect,
  state,
  disabled,
  onEffectPatch,
}: {
  effect: EffectDesc | undefined;
  state: LampState;
  disabled: boolean;
  onEffectPatch: (patch: { speed?: number; intensity?: number; duration_ms?: number }, transitionMs: number) => void;
}) {
  if (!effect) return null;
  const uses = new Set(effect.uses);
  if (!uses.has("speed") && !uses.has("intensity") && !uses.has("duration")) return null;
  const minutes = clamp(Math.round(state.effect.duration_ms / 60_000) || 30, 5, 60);
  return (
    <section className="params" aria-label={`${effect.name} settings`}>
      {uses.has("speed") && (
        <ParamSlider
          label="Speed"
          min={0}
          max={100}
          value={percent(state.effect.speed)}
          format={(v) => `${v} %`}
          disabled={disabled}
          onChange={(v, t) => onEffectPatch({ speed: fromPercent(v) }, t)}
        />
      )}
      {uses.has("intensity") && (
        <ParamSlider
          label={INTENSITY_LABEL[effect.id] ?? "Intensity"}
          min={0}
          max={100}
          value={percent(state.effect.intensity)}
          format={(v) => `${v} %`}
          disabled={disabled}
          onChange={(v, t) => onEffectPatch({ intensity: fromPercent(v) }, t)}
        />
      )}
      {uses.has("duration") && (
        <ParamSlider
          label="Duration"
          min={5}
          max={60}
          value={minutes}
          format={(m) => `${m} min`}
          disabled={disabled}
          onChange={(m, t) => onEffectPatch({ duration_ms: m * 60_000 }, t)}
        />
      )}
    </section>
  );
}
