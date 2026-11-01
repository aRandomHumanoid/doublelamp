// Effect catalog (03 §6). The firmware's `GET /effects` returns the same list.

export const EFFECT_USES = ["colors1", "colors2", "colors3", "speed", "intensity", "duration"] as const;
export type EffectUse = (typeof EFFECT_USES)[number];

export interface EffectDesc {
  id: string;
  name: string;
  uses: EffectUse[];
  oneshot: boolean;
  /** Parameter defaults applied by the UIs when switching to this effect. Tuned for 10-pixel lamps. */
  defaults: { speed: number; intensity: number; duration_ms?: number };
}

export const EFFECTS: readonly EffectDesc[] = [
  { id: "solid", name: "Solid", uses: ["colors1"], oneshot: false, defaults: { speed: 128, intensity: 128 } },
  {
    id: "breathe",
    name: "Breathe",
    uses: ["colors1", "speed", "intensity"],
    oneshot: false,
    defaults: { speed: 96, intensity: 160 },
  },
  {
    id: "gradient",
    name: "Gradient",
    uses: ["colors1", "colors2", "colors3", "speed"],
    oneshot: false,
    defaults: { speed: 0, intensity: 128 },
  },
  { id: "cycle", name: "Color cycle", uses: ["speed", "intensity"], oneshot: false, defaults: { speed: 64, intensity: 255 } },
  { id: "rainbow", name: "Rainbow", uses: ["speed", "intensity"], oneshot: false, defaults: { speed: 64, intensity: 96 } },
  {
    id: "candle",
    name: "Candle",
    uses: ["colors1", "speed", "intensity"],
    oneshot: false,
    defaults: { speed: 128, intensity: 140 },
  },
  {
    id: "twinkle",
    name: "Twinkle",
    uses: ["colors1", "colors2", "colors3", "speed", "intensity"],
    oneshot: false,
    defaults: { speed: 96, intensity: 64 },
  },
  {
    id: "sunrise",
    name: "Sunrise",
    uses: ["duration"],
    oneshot: true,
    defaults: { speed: 128, intensity: 128, duration_ms: 30 * 60_000 },
  },
  { id: "sync_test", name: "Sync test", uses: [], oneshot: false, defaults: { speed: 128, intensity: 128 } },
];

export const EFFECT_IDS = EFFECTS.map((e) => e.id);

export function findEffect(id: string): EffectDesc | undefined {
  return EFFECTS.find((e) => e.id === id);
}

/** Effects whose look doesn't depend on `colors` (a new color switches these to `solid`, 03 §11). */
export function effectUsesColors(id: string): boolean {
  return findEffect(id)?.uses.includes("colors1") ?? true;
}
