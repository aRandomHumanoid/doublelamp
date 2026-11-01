// Lamp local API shapes (04 §3). Implemented by the firmware, used by device-ui.
// These are plain types so the lamp UI can import them without bundling zod.
import type { Command, LampState } from "./state";
import type { DeviceInfo, LedConfig, Preset } from "./device";
import type { EffectDesc } from "./effects";

export type PowerPreset = "12v1a" | "12v2a" | "12v3a" | "12v5a";

/** max_current_ma for each supply choice (02 §5). */
export const POWER_PRESETS: Record<PowerPreset, { label: string; max_current_ma: number }> = {
  "12v1a": { label: "12 V 1 A", max_current_ma: 600 },
  "12v2a": { label: "12 V 2 A", max_current_ma: 1400 },
  "12v3a": { label: "12 V 3 A", max_current_ma: 2200 },
  "12v5a": { label: "12 V 5 A", max_current_ma: 3800 },
};

export interface SetupRequest {
  ssid: string;
  password: string;
  name: string;
  /** Min 8 characters. Also becomes the default direct-mode WiFi password. */
  admin_password: string;
  /** Strip length in meters; pixel_count = round(16 × strip_m). */
  strip_m: number;
  power: { preset: PowerPreset } | { max_current_ma: number };
  server_url?: string;
  pairing_code?: string;
}

export interface SetupStatus {
  state: "idle" | "connecting" | "online" | "failed";
  reason?: "wrong_password" | "no_network" | "no_ip" | "timeout" | string;
  ip?: string;
  host?: string;
  /** Result of the optional server claim during setup. */
  cloud?: "skipped" | "claiming" | "online" | "failed";
  cloud_error?: string;
}

export interface WifiNetwork {
  ssid: string;
  rssi: number;
  auth: "open" | "wep" | "wpa" | "wpa2" | "wpa3" | "wpa2-enterprise" | string;
}

export interface LoginResponse {
  token: string;
  expires_in: number;
}

export interface HomekitInfo {
  state: "off" | "unpaired" | "paired";
  controllers: number;
  setup_code: string;
  setup_id: string;
}

export interface NetworkSettings {
  /** Keep the WPA2 direct-mode AP up even while online. */
  ap_always_on: boolean;
}

export interface SecurityUpdate {
  current_password: string;
  admin_password?: string;
  ap_password?: string;
}

export interface CloudClaimRequest {
  server_url: string;
  code: string;
}

export type TestPattern = "color_order" | "last_pixel" | "white_25";
export interface TestPatternRequest {
  pattern: TestPattern;
  duration_ms?: number;
}

/** Local WebSocket `/api/v1/ws` messages (04 §3.1), each wrapped in the usual envelope. */
export type LocalServerMessage =
  | { type: "state"; data: { rev: number; state: LampState; origin: string } }
  | { type: "info"; data: DeviceInfo }
  | { type: "error"; ref?: string; data: { code: string; message: string } };
export type LocalClientMessage = { type: "cmd"; id?: string; data: Command };

export type { Command, LampState, DeviceInfo, LedConfig, Preset, EffectDesc };
