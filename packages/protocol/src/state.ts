// LampState, patches and commands (04 §2).
import { z } from "zod";
import { FIELD_NAMES, type FieldName, LIMITS } from "./constants";

export function normalizeHex(s: string): string {
  return "#" + s.replace(/^#/, "").toUpperCase();
}

/** "#RRGGBB" in either case on input, uppercase on output. */
export const hexColorSchema = z
  .string()
  .regex(/^#?[0-9a-fA-F]{6}$/, "expected #RRGGBB")
  .transform(normalizeHex);

export const u8Schema = z.number().int().min(0).max(255);
export const u32Schema = z.number().int().min(0).max(0xffffffff);

export const effectSchema = z.object({
  id: z.string().min(1).max(24),
  speed: u8Schema,
  intensity: u8Schema,
  seed: u32Schema,
  /** Sync-clock ms when the effect started. */
  epoch: z.number().int(),
  /** 0 = none. Used by one-shot effects such as `sunrise`. */
  duration_ms: u32Schema,
});
export type Effect = z.output<typeof effectSchema>;

export const colorsSchema = z.array(hexColorSchema).min(1).max(LIMITS.maxColors);

export const lampStateSchema = z.object({
  on: z.boolean(),
  /** 0–255, perceptual. */
  brightness: u8Schema,
  colors: colorsSchema,
  effect: effectSchema,
});
export type LampState = z.output<typeof lampStateSchema>;

/** Any subset of the state fields. Nested `effect` fields merge one by one. */
export const statePatchSchema = z.object({
  on: z.boolean().optional(),
  brightness: u8Schema.optional(),
  colors: colorsSchema.optional(),
  effect: effectSchema.partial().optional(),
});
export type StatePatch = z.output<typeof statePatchSchema>;

export const transitionMsSchema = z.number().int().min(0).max(LIMITS.maxTransitionMs);

/** A patch plus delivery options. `apply_at` is only used server → lamp. */
export const commandSchema = z.object({
  patch: statePatchSchema,
  transition_ms: transitionMsSchema.optional(),
});
export type Command = z.output<typeof commandSchema>;

export const DEFAULT_STATE: LampState = Object.freeze({
  on: false,
  brightness: 128,
  colors: ["#FFB46B"],
  effect: { id: "solid", speed: 128, intensity: 128, seed: 0, epoch: 0, duration_ms: 0 },
}) as LampState;

export function cloneState(s: LampState): LampState {
  return { on: s.on, brightness: s.brightness, colors: [...s.colors], effect: { ...s.effect } };
}

function sameColors(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((c, i) => c === b[i]);
}

function sameEffect(a: Effect, b: Effect): boolean {
  return (
    a.id === b.id &&
    a.speed === b.speed &&
    a.intensity === b.intensity &&
    a.seed === b.seed &&
    a.epoch === b.epoch &&
    a.duration_ms === b.duration_ms
  );
}

export function fieldEquals(a: LampState, b: LampState, f: FieldName): boolean {
  switch (f) {
    case "on":
      return a.on === b.on;
    case "brightness":
      return a.brightness === b.brightness;
    case "colors":
      return sameColors(a.colors, b.colors);
    case "effect":
      return sameEffect(a.effect, b.effect);
  }
}

export function statesEqual(a: LampState, b: LampState): boolean {
  return FIELD_NAMES.every((f) => fieldEquals(a, b, f));
}

export interface ApplyOptions {
  /** Used as `effect.epoch` when the effect id changes and the patch has no epoch. */
  now?: number;
  /** Used as `effect.seed` when the effect id changes and the patch has no seed. */
  newSeed?: () => number;
}

/**
 * Applies a patch and reports which top-level fields actually changed.
 * Applying a patch that changes nothing returns an empty list (05 §4: patches are idempotent).
 */
export function applyPatch(
  state: LampState,
  patch: StatePatch,
  opts: ApplyOptions = {},
): { state: LampState; changed: FieldName[] } {
  const next = cloneState(state);
  if (patch.on !== undefined) next.on = patch.on;
  if (patch.brightness !== undefined) next.brightness = patch.brightness;
  if (patch.colors !== undefined) next.colors = patch.colors.map(normalizeHex);
  if (patch.effect !== undefined) {
    const pe = patch.effect;
    const idChanged = pe.id !== undefined && pe.id !== state.effect.id;
    next.effect = { ...state.effect, ...stripUndefined(pe) };
    if (idChanged && pe.epoch === undefined && opts.now !== undefined) next.effect.epoch = opts.now;
    if (idChanged && pe.seed === undefined && opts.newSeed) next.effect.seed = opts.newSeed() >>> 0;
  }
  const changed = FIELD_NAMES.filter((f) => !fieldEquals(state, next, f));
  return { state: next, changed };
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
}

/** The fields of `state` named in `fields`, as a patch. */
export function pickFields(state: LampState, fields: readonly FieldName[]): StatePatch {
  const p: StatePatch = {};
  for (const f of fields) {
    if (f === "on") p.on = state.on;
    else if (f === "brightness") p.brightness = state.brightness;
    else if (f === "colors") p.colors = [...state.colors];
    else p.effect = { ...state.effect };
  }
  return p;
}

/** Random uint32 seed for effects. */
export function randomSeed(): number {
  return (Math.random() * 0x100000000) >>> 0;
}
