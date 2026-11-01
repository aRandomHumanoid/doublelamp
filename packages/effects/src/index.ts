// Effects for live previews (web app, virtual lamp). Same math as the firmware.
import { type RGB, parseHex, formatHex } from "./math8";
import { renderEffect, type EffectParams } from "./effects";

export * from "./math8";
export { renderEffect, RENDERERS, type EffectParams } from "./effects";

/** Minimal LampState shape, so this package doesn't depend on zod. */
export interface PreviewState {
  on: boolean;
  brightness: number;
  colors: string[];
  effect: { id: string; speed: number; intensity: number; seed: number; epoch: number; duration_ms: number };
}

/** Effect output for a state at sync-clock time `now`, before brightness. */
export function renderStateRaw(state: PreviewState, now: number, n: number): RGB[] {
  const params: EffectParams = {
    speed: state.effect.speed,
    intensity: state.effect.intensity,
    seed: state.effect.seed >>> 0,
    duration_ms: state.effect.duration_ms,
    colors: state.colors.map(parseHex),
  };
  return renderEffect(state.effect.id, params, now - state.effect.epoch, n);
}

/**
 * What the strip looks like on screen: effect output scaled by the perceptual brightness.
 * The lamps add gamma, color correction and the current limiter on top; previews skip those.
 * Off renders black.
 */
export function renderPreview(state: PreviewState, now: number, n: number): RGB[] {
  const raw = renderStateRaw(state, now, n);
  if (!state.on) return raw.map(() => [0, 0, 0] as RGB);
  // Perceptual brightness to a display scale. A gentle floor keeps dim states visible on screen.
  const k = state.brightness === 0 ? 0 : 0.18 + 0.82 * (state.brightness / 255);
  return raw.map(([r, g, b]) => [Math.round(r * k), Math.round(g * k), Math.round(b * k)] as RGB);
}

export function toCss(c: RGB): string {
  return formatHex(c);
}
