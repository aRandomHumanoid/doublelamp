// Browser ↔ server REST shapes (04 §7.1) and lamp pairing (04 §4.5).
// These are the contract between server/ and web/.
import { z } from "zod";
import { commandSchema, lampStateSchema, transitionMsSchema } from "./state";
import { deviceIdSchema, deviceInfoSchema, hwSchema, ledConfigSchema, telemetrySchema } from "./device";
import { LIMITS } from "./constants";

export const targetSchema = z.union([
  z.object({ device: deviceIdSchema }).strict(),
  z.object({ group: z.number().int() }).strict(),
]);
export type Target = z.output<typeof targetSchema>;

// ---------------------------------------------------------------- views

export const deviceViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  online: z.boolean(),
  last_seen_at: z.number().nullable(),
  fw: z.string().nullable(),
  info: deviceInfoSchema.nullable(),
  config: ledConfigSchema.nullable(),
  /** The lamp's own replica. While linked, the group state is what the lamp shows. */
  state: lampStateSchema.nullable(),
  telemetry: telemetrySchema.nullable(),
  effects: z.array(z.string()),
  group_id: z.number().int().nullable(),
  pending_verify: z.boolean().optional(),
});
export type DeviceView = z.output<typeof deviceViewSchema>;

export const groupViewSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  linked: z.boolean(),
  members: z.array(z.string()),
  state: lampStateSchema.nullable(),
});
export type GroupView = z.output<typeof groupViewSchema>;

export const sceneSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  state: lampStateSchema,
  sort: z.number().int(),
});
export type Scene = z.output<typeof sceneSchema>;

export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

export const scheduleWhenSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("daily"),
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "expected HH:MM"),
    days: z.array(z.enum(WEEKDAYS)).min(1),
    tz: z.string().min(1),
  }),
  z.object({ type: z.literal("cron"), expr: z.string().min(1).max(100), tz: z.string().min(1) }),
]);
export type ScheduleWhen = z.output<typeof scheduleWhenSchema>;

export const scheduleActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("power"), on: z.boolean() }),
  z.object({ type: z.literal("scene"), scene_id: z.number().int(), transition_ms: transitionMsSchema.optional() }),
  z.object({ type: z.literal("sunrise"), duration_min: z.number().int().min(5).max(60) }),
  z.object({ type: z.literal("fade_off"), duration_min: z.number().int().min(1).max(120) }),
]);
export type ScheduleAction = z.output<typeof scheduleActionSchema>;

export const scheduleSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  target: targetSchema,
  when: scheduleWhenSchema,
  action: scheduleActionSchema,
  enabled: z.boolean(),
  next_run_at: z.number().nullable(),
  last_run_at: z.number().nullable(),
  last_result: z.string().nullable(),
});
export type Schedule = z.output<typeof scheduleSchema>;

export const OTA_STATUSES = ["pending", "sent", "download", "verify", "reboot", "done", "failed"] as const;
export const otaJobSchema = z.object({
  id: z.number().int(),
  device_id: z.string(),
  sha256: z.string(),
  version: z.string(),
  status: z.enum(OTA_STATUSES),
  pct: z.number().int(),
  error: z.string().nullable(),
  created_at: z.number(),
  updated_at: z.number(),
});
export type OtaJob = z.output<typeof otaJobSchema>;

export const firmwareInfoSchema = z.object({
  sha256: z.string(),
  version: z.string(),
  idf: z.string().nullable(),
  size: z.number().int(),
  notes: z.string().nullable(),
  uploaded_at: z.number(),
});
export type FirmwareInfo = z.output<typeof firmwareInfoSchema>;

export const eventRecordSchema = z.object({
  id: z.number().int(),
  ts: z.number(),
  kind: z.string(),
  device_id: z.string().nullable(),
  by_label: z.string().nullable(),
  data: z.record(z.unknown()).nullable(),
});
export type EventRecord = z.output<typeof eventRecordSchema>;

export const sessionInfoSchema = z.object({
  id: z.string(),
  label: z.string(),
  created_at: z.number(),
  last_seen_at: z.number().nullable(),
  user_agent: z.string().nullable(),
  current: z.boolean(),
});
export type SessionInfo = z.output<typeof sessionInfoSchema>;

// ---------------------------------------------------------------- requests

export const loginRequestSchema = z.object({
  password: z.string().min(1).max(200),
  label: z.string().max(LIMITS.nameMaxLength).optional(),
});
export const passwordChangeSchema = z.object({
  current: z.string().min(1).max(200),
  next: z.string().min(12, "at least 12 characters").max(200),
});
export const devicePatchSchema = z.object({
  name: z.string().min(1).max(LIMITS.nameMaxLength).optional(),
  config: ledConfigSchema.partial().optional(),
});
export const groupPatchSchema = z.object({
  name: z.string().min(1).max(LIMITS.nameMaxLength).optional(),
  linked: z.boolean().optional(),
  /** When linking, start the group from this member's state ("match B to A"). */
  match_from: deviceIdSchema.optional(),
});
export const stateCommandSchema = commandSchema;
export const identifyRequestSchema = z.object({ duration_ms: z.number().int().min(0).max(60000).optional() });
export const nudgeRequestSchema = z.object({
  color: z.string().regex(/^#?[0-9a-fA-F]{6}$/).optional(),
  count: z.number().int().min(1).max(10).optional(),
});
export const sceneCreateSchema = z.union([
  z.object({ name: z.string().min(1).max(LIMITS.nameMaxLength), state: lampStateSchema }),
  z.object({ name: z.string().min(1).max(LIMITS.nameMaxLength), from: targetSchema }),
]);
export const sceneUpdateSchema = z.object({
  name: z.string().min(1).max(LIMITS.nameMaxLength).optional(),
  state: lampStateSchema.optional(),
  sort: z.number().int().optional(),
});
export const sceneReorderSchema = z.object({ ids: z.array(z.number().int()) });
export const sceneApplySchema = z.object({ target: targetSchema, transition_ms: transitionMsSchema.optional() });
export const scheduleCreateSchema = z.object({
  name: z.string().max(LIMITS.nameMaxLength).default(""),
  target: targetSchema,
  when: scheduleWhenSchema,
  action: scheduleActionSchema,
  enabled: z.boolean().default(true),
});
export const scheduleUpdateSchema = scheduleCreateSchema.partial();
export const otaStartRequestSchema = z.object({
  sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  version: z.string().optional(),
  allow_downgrade: z.boolean().optional(),
});

// ---------------------------------------------------------------- pairing (04 §4.5)

export const claimRequestSchema = z.object({
  code: z.string().min(8).max(9),
  device_id: deviceIdSchema,
  name: z.string().min(1).max(LIMITS.nameMaxLength),
  fw: z.string(),
  hw: hwSchema,
});
export type ClaimRequest = z.output<typeof claimRequestSchema>;
export const claimResponseSchema = z.object({ device_token: z.string(), ws_url: z.string() });
export type ClaimResponse = z.output<typeof claimResponseSchema>;
export const pairingCodeResponseSchema = z.object({ code: z.string(), expires_in: z.number().int() });

/** REST error body: `{"error": {"code", "message", "field"?}}`. */
export interface ErrorBody {
  error: { code: string; message: string; field?: string };
}
