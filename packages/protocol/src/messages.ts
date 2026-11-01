// WebSocket messages: lamp ↔ server (04 §4) and browser ↔ server (04 §7.2).
import { z } from "zod";
import { lampStateSchema, statePatchSchema, transitionMsSchema, hexColorSchema } from "./state";
import {
  deviceInfoSchema,
  deviceIdSchema,
  hwSchema,
  ledConfigSchema,
  presetSchema,
  telemetrySchema,
} from "./device";
import { deviceViewSchema, groupViewSchema, otaJobSchema, sceneSchema, targetSchema } from "./rest";

/** Every WebSocket text frame holds exactly one envelope (04 §4.2). */
export const envelopeSchema = z.object({
  type: z.string().min(1).max(40),
  id: z.string().max(40).nullish(),
  ref: z.string().max(40).nullish(),
  data: z.unknown().optional(),
});
export type Envelope = z.output<typeof envelopeSchema>;

export const errorDataSchema = z.object({ code: z.string(), message: z.string().default("") });
const emptySchema = z.object({}).passthrough();

const dirtyEntry = z.object({ age_ms: z.number().int().min(0).nullable() });
export const dirtySchema = z.object({
  on: dirtyEntry.optional(),
  brightness: dirtyEntry.optional(),
  colors: dirtyEntry.optional(),
  effect: dirtyEntry.optional(),
});
export type Dirty = z.output<typeof dirtySchema>;

export const linkSchema = z.object({
  group_id: z.number().int(),
  name: z.string(),
  linked: z.boolean(),
  peers: z.array(z.object({ id: z.string(), name: z.string() })),
});
export type Link = z.output<typeof linkSchema>;

// ---------------------------------------------------------------- lamp → server

export const helloSchema = z.object({
  device_id: deviceIdSchema,
  proto: z.number().int(),
  fw: z.string(),
  build: z.string().optional(),
  hw: hwSchema,
  state: lampStateSchema,
  dirty: dirtySchema.default({}),
  boot_reason: z.string().optional(),
  rollback: z.boolean().default(false),
  pending_verify: z.boolean().default(false),
  uptime_s: z.number().int().optional(),
  ip: z.string().optional(),
  rssi: z.number().int().optional(),
  effects: z.array(z.string()).default([]),
  /** Added to 04 §4.3: lets the server show name, network, Apple Home status and LED config. */
  info: deviceInfoSchema.optional(),
  config: ledConfigSchema.optional(),
});
export type Hello = z.output<typeof helloSchema>;

export const reportOriginSchema = z.enum(["local", "homekit", "button", "timer"]);

export const lampToServer = {
  hello: helloSchema,
  "state.report": z.object({ rev: z.number().int(), patch: statePatchSchema, origin: reportOriginSchema }),
  "time.ping": z.object({ t0: z.number() }),
  ack: emptySchema,
  error: errorDataSchema,
  "ota.progress": z.object({
    job_id: z.number().int(),
    phase: z.enum(["download", "verify", "reboot", "done", "failed"]),
    pct: z.number().int().min(0).max(100),
    error: z.string().optional(),
  }),
  event: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("button"), gesture: z.string() }),
    z.object({ kind: z.literal("crash"), summary: z.string() }),
    z.object({ kind: z.literal("log"), level: z.string(), msg: z.string() }),
  ]),
  telemetry: telemetrySchema,
  /** Sent when name, network, Apple Home status or LED config change. */
  info: z.object({ info: deviceInfoSchema, config: ledConfigSchema.optional() }),
} as const;

// ---------------------------------------------------------------- server → lamp

export const stateSetSchema = z.object({
  /** Always the full state, so delivery is idempotent. */
  state: lampStateSchema,
  apply_at: z.number().int().optional(),
  transition_ms: transitionMsSchema,
  origin: z.string(),
});

export const otaStartSchema = z.object({
  job_id: z.number().int(),
  version: z.string(),
  url: z.string(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  size: z.number().int().positive(),
  allow_downgrade: z.boolean().default(false),
});

export const serverToLamp = {
  welcome: z.object({
    server_time: z.number(),
    heartbeat_s: z.number().int(),
    desired: lampStateSchema.nullable(),
    link: linkSchema.nullable(),
  }),
  "state.set": stateSetSchema,
  "time.pong": z.object({ t0: z.number(), t1: z.number(), t2: z.number() }),
  link: linkSchema.nullable(),
  "config.set": ledConfigSchema.partial(),
  "presets.sync": z.object({ presets: z.array(presetSchema).max(8) }),
  identify: z.object({ duration_ms: z.number().int().min(0).max(60000).default(3000) }),
  nudge: z.object({ from_name: z.string(), color: hexColorSchema, count: z.number().int().min(1).max(10).default(3) }),
  "ota.start": otaStartSchema,
  reboot: emptySchema,
  unclaim: emptySchema,
  /** Added to 04 §4.4: the web app renamed the lamp. */
  "name.set": z.object({ name: z.string().min(1).max(32) }),
  ack: emptySchema,
  error: errorDataSchema,
} as const;

// ---------------------------------------------------------------- browser → server

export const cmdSchema = z.object({
  target: targetSchema,
  patch: statePatchSchema,
  transition_ms: transitionMsSchema.optional(),
  cid: z.string().min(1).max(40),
});

export const clientToServer = {
  cmd: cmdSchema,
  "time.ping": z.object({ t0: z.number() }),
} as const;

// ---------------------------------------------------------------- server → browser

const stateEvent = z.object({
  state: lampStateSchema,
  origin: z.string(),
  by: z.string().optional(),
  apply_at: z.number().optional(),
});

export const serverToClient = {
  snapshot: z.object({
    devices: z.array(deviceViewSchema),
    groups: z.array(groupViewSchema),
    scenes: z.array(sceneSchema),
    server_time: z.number(),
  }),
  "device.state": stateEvent.extend({ id: z.string() }),
  "group.state": stateEvent.extend({ id: z.number().int() }),
  "device.presence": z.object({ id: z.string(), online: z.boolean(), last_seen_at: z.number().nullable() }),
  "device.updated": deviceViewSchema,
  "device.removed": z.object({ id: z.string() }),
  "device.telemetry": z.object({ id: z.string(), telemetry: telemetrySchema }),
  "group.updated": groupViewSchema,
  "scene.updated": z.object({ scenes: z.array(sceneSchema) }),
  "ota.job": otaJobSchema,
  "time.pong": z.object({ t0: z.number(), t1: z.number(), t2: z.number() }),
  ack: emptySchema,
  error: errorDataSchema,
} as const;

// ---------------------------------------------------------------- helpers

type SchemaMap = Record<string, z.ZodTypeAny>;
export type DataOf<M extends SchemaMap, K extends keyof M> = z.output<M[K]>;

export type Decoded<M extends SchemaMap> = {
  [K in keyof M & string]: { type: K; id?: string | null; ref?: string | null; data: z.output<M[K]> };
}[keyof M & string];

export type DecodeResult<M extends SchemaMap> =
  | { ok: true; msg: Decoded<M> }
  | { ok: false; code: "invalid" | "unsupported"; message: string; id?: string | null; type?: string };

/** Parses a raw JSON text frame against a message map. Unknown fields are dropped. */
export function decodeMessage<M extends SchemaMap>(map: M, text: string): DecodeResult<M> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, code: "invalid", message: "malformed JSON" };
  }
  const env = envelopeSchema.safeParse(raw);
  if (!env.success) return { ok: false, code: "invalid", message: "bad envelope" };
  const { type, id, ref } = env.data;
  const schema = map[type];
  if (!schema) return { ok: false, code: "unsupported", message: `unknown type ${type}`, id, type };
  const data = schema.safeParse(env.data.data ?? {});
  if (!data.success) {
    const issue = data.error.issues[0];
    const path = issue?.path.join(".") ?? "";
    return { ok: false, code: "invalid", message: `${path ? path + ": " : ""}${issue?.message ?? "invalid"}`, id, type };
  }
  return { ok: true, msg: { type, id, ref, data: data.data } as Decoded<M> };
}

/** Serializes one envelope. */
export function encodeMessage(type: string, data: unknown, opts: { id?: string; ref?: string | null } = {}): string {
  const env: Record<string, unknown> = { type };
  if (opts.id !== undefined) env.id = opts.id;
  if (opts.ref !== undefined && opts.ref !== null) env.ref = opts.ref;
  env.data = data ?? {};
  return JSON.stringify(env);
}
