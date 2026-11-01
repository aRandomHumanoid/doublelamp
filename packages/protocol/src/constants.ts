// Protocol constants (docs/04-protocol.md).

/** Integer protocol version. The server accepts `proto` N and N−1. */
export const PROTO_VERSION = 1;

/** Top-level state fields. `effect` counts as one field for merging (04 §6). */
export const FIELD_NAMES = ["on", "brightness", "colors", "effect"] as const;
export type FieldName = (typeof FIELD_NAMES)[number];

/** Application close codes on /ws/device (04 §4.1). */
export const CloseCode = {
  BadToken: 4001,
  Replaced: 4002,
  Unclaimed: 4003,
  ProtoUnsupported: 4004,
  ProtocolViolation: 4008,
} as const;

export const LIMITS = {
  /** Lamp ↔ server messages, bytes. */
  lampMessageBytes: 4096,
  /** Browser → server messages, bytes. */
  browserMessageBytes: 16384,
  maxColors: 3,
  maxPixels: 1024,
  maxTransitionMs: 10000,
  presetSlots: 8,
  nameMaxLength: 32,
} as const;

/** Liveness (04 §4.1): the lamp sends time.ping at least this often; silence closes the socket. */
export const HEARTBEAT = {
  lampPingIntervalMs: 20_000,
  browserPingIntervalMs: 30_000,
  silenceTimeoutMs: 45_000,
} as const;

/** Default transition lengths used by the UIs (04 §2). */
export const TRANSITION = {
  tapMs: 400,
  dragMs: 120,
} as const;

export const ERROR_CODES = [
  "invalid",
  "invalid_code",
  "code_expired",
  "unknown_effect",
  "auth_required",
  "forbidden",
  "not_found",
  "conflict",
  "managed_by_server",
  "offline",
  "rate_limited",
  "too_large",
  "busy",
  "unsupported",
  "internal",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** Pixels per meter of the chosen strip (docs/02-hardware.md §3). */
export const STRIP_PIXELS_PER_M = 16;
