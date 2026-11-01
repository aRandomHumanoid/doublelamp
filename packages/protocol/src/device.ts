// Device-level objects (04 §2 "Other objects").
import { z } from "zod";
import { lampStateSchema, u8Schema } from "./state";
import { LIMITS } from "./constants";

export const COLOR_ORDERS = ["RGB", "RBG", "GRB", "GBR", "BRG", "BGR", "GRBW", "RGBW"] as const;
export const colorOrderSchema = z.enum(COLOR_ORDERS);
export type ColorOrder = z.output<typeof colorOrderSchema>;

export const powerOnSchema = z.enum(["restore", "on", "off"]);

export const ledConfigSchema = z.object({
  pixel_count: z.number().int().min(1).max(LIMITS.maxPixels),
  channels: z.union([z.literal(3), z.literal(4)]),
  color_order: colorOrderSchema,
  max_current_ma: z.number().int().min(100).max(20000),
  ma_per_pixel_white: z.number().int().min(1).max(200),
  color_correction: z.tuple([u8Schema, u8Schema, u8Schema]),
  fps: z.number().int().min(10).max(100),
  dither: z.boolean(),
  power_on: powerOnSchema,
});
export type LedConfig = z.output<typeof ledConfigSchema>;

/** Defaults for the chosen strip: 625 mm of BTF FCOB WS2811 12 V on a 12 V 1 A supply (02 §3, 03 §13). */
export const DEFAULT_LED_CONFIG: LedConfig = Object.freeze({
  pixel_count: 10,
  channels: 3,
  color_order: "RGB",
  max_current_ma: 600,
  ma_per_pixel_white: 42,
  color_correction: [255, 255, 255],
  fps: 100,
  dither: true,
  power_on: "restore",
}) as LedConfig;

export const hwSchema = z.object({
  chip: z.string().default("esp32c3"),
  pixels: z.number().int().min(1).max(LIMITS.maxPixels),
  channels: z.number().int().min(3).max(4),
  color_order: z.string().optional(),
});
export type Hw = z.output<typeof hwSchema>;

export const homekitStatusSchema = z.object({
  state: z.enum(["off", "unpaired", "paired"]),
  controllers: z.number().int().min(0),
});

export const deviceInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  fw: z.string(),
  proto: z.number().int(),
  build: z.string().optional(),
  /** mDNS host, e.g. "doublelamp-3fa2c1.local". */
  host: z.string().optional(),
  hw: hwSchema,
  net: z.object({
    mode: z.enum(["sta", "ap", "apsta"]),
    ssid: z.string(),
    ip: z.string(),
    rssi: z.number().int(),
  }),
  cloud: z.object({
    state: z.enum(["off", "connecting", "online"]),
    url: z.string(),
    linked: z.boolean(),
    group_name: z.string(),
  }),
  homekit: homekitStatusSchema,
  insecure_server_allowed: z.boolean(),
  setup_mode: z.boolean().optional(),
  uptime_s: z.number().int(),
});
export type DeviceInfo = z.output<typeof deviceInfoSchema>;

export const telemetrySchema = z.object({
  rssi: z.number().int(),
  heap_free: z.number().int(),
  heap_min: z.number().int(),
  uptime_s: z.number().int(),
  fps: z.number(),
  reconnects: z.number().int(),
  temp_c: z.number(),
});
export type Telemetry = z.output<typeof telemetrySchema>;

export const presetSchema = z.object({
  slot: z.number().int().min(0).max(LIMITS.presetSlots - 1),
  name: z.string().min(1).max(LIMITS.nameMaxLength),
  /** A full LampState; `effect.epoch` is ignored when applied. */
  state: lampStateSchema,
});
export type Preset = z.output<typeof presetSchema>;

export const deviceIdSchema = z.string().regex(/^dl-[0-9a-f]{6}$/, "expected dl-xxxxxx");
