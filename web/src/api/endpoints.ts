// Typed REST calls (04 §7.1). The WebSocket stays the source of live state; REST is for the
// create/update/delete screens.
import type {
  Command,
  DeviceView,
  EventRecord,
  FirmwareInfo,
  GroupView,
  LampState,
  LedConfig,
  OtaJob,
  Scene,
  Schedule,
  SessionInfo,
  Target,
} from "@doublelamp/protocol";
import { request, upload } from "./http";

const enc = encodeURIComponent;

export type ScheduleBody = Pick<Schedule, "name" | "target" | "when" | "action" | "enabled">;
export type SceneCreate = { name: string; state: LampState } | { name: string; from: Target };
export interface Me {
  session: SessionInfo;
  server_time: number;
}

export const api = {
  // session (05 §6)
  me: () => request<Me>("GET", "/me", undefined, { quiet401: true }),
  login: (password: string, label?: string) =>
    request<{ session: SessionInfo }>("POST", "/auth/login", label ? { password, label } : { password }, { quiet401: true }),
  logout: () => request<void>("POST", "/auth/logout", {}, { quiet401: true }),
  changePassword: (current: string, next: string) => request<void>("PUT", "/auth/password", { current, next }),
  sessions: () => request<{ sessions: SessionInfo[] }>("GET", "/sessions"),
  revokeSession: (id: string) => request<void>("DELETE", `/sessions/${enc(id)}`),

  // devices
  devices: () => request<{ devices: DeviceView[] }>("GET", "/devices"),
  device: (id: string) => request<DeviceView>("GET", `/devices/${enc(id)}`),
  patchDevice: (id: string, body: { name?: string; config?: Partial<LedConfig> }) =>
    request<DeviceView>("PATCH", `/devices/${enc(id)}`, body),
  unpair: (id: string) => request<void>("DELETE", `/devices/${enc(id)}`),
  deviceCommand: (id: string, cmd: Command) => request<{ state: LampState }>("POST", `/devices/${enc(id)}/state`, cmd),
  identify: (id: string, duration_ms?: number) =>
    request<void>("POST", `/devices/${enc(id)}/identify`, duration_ms === undefined ? {} : { duration_ms }),
  nudge: (id: string, body: { color?: string; count?: number } = {}) =>
    request<void>("POST", `/devices/${enc(id)}/nudge`, body),
  startOta: (id: string, body: { sha256?: string; version?: string; allow_downgrade?: boolean }) =>
    request<OtaJob>("POST", `/devices/${enc(id)}/ota`, body),

  // groups
  groups: () => request<{ groups: GroupView[] }>("GET", "/groups"),
  patchGroup: (id: number, body: { name?: string; linked?: boolean; match_from?: string }) =>
    request<GroupView>("PATCH", `/groups/${id}`, body),
  groupCommand: (id: number, cmd: Command) => request<{ state: LampState }>("POST", `/groups/${id}/state`, cmd),

  // scenes
  scenes: () => request<{ scenes: Scene[] }>("GET", "/scenes"),
  createScene: (body: SceneCreate) => request<Scene>("POST", "/scenes", body),
  updateScene: (id: number, body: { name?: string; state?: LampState; sort?: number }) =>
    request<Scene>("PUT", `/scenes/${id}`, body),
  deleteScene: (id: number) => request<void>("DELETE", `/scenes/${id}`),
  reorderScenes: (ids: number[]) => request<{ scenes: Scene[] }>("POST", "/scenes/reorder", { ids }),
  applyScene: (id: number, target: Target, transition_ms?: number) =>
    request<{ state: LampState }>(
      "POST",
      `/scenes/${id}/apply`,
      transition_ms === undefined ? { target } : { target, transition_ms },
    ),

  // schedules
  schedules: () => request<{ schedules: Schedule[] }>("GET", "/schedules"),
  createSchedule: (body: ScheduleBody) => request<Schedule>("POST", "/schedules", body),
  updateSchedule: (id: number, body: Partial<ScheduleBody>) => request<Schedule>("PUT", `/schedules/${id}`, body),
  deleteSchedule: (id: number) => request<void>("DELETE", `/schedules/${id}`),

  // pairing
  pairingCode: () => request<{ code: string; expires_in: number }>("POST", "/pairing-codes", {}),

  // firmware and OTA
  firmware: () => request<{ firmware: FirmwareInfo[] }>("GET", "/firmware"),
  uploadFirmware: (file: Blob, notes: string | undefined, onProgress: (fraction: number) => void) =>
    upload<FirmwareInfo>(`/firmware${notes ? `?notes=${enc(notes)}` : ""}`, file, onProgress),
  deleteFirmware: (sha256: string) => request<void>("DELETE", `/firmware/${enc(sha256)}`),
  otaJobs: () => request<{ jobs: OtaJob[] }>("GET", "/ota-jobs"),
  rollout: (sha256: string) => request<{ jobs: OtaJob[] }>("POST", "/ota/rollout", { sha256 }),

  // activity
  events: (q: { device_id?: string; before?: number; limit?: number } = {}) => {
    const p = new URLSearchParams();
    if (q.device_id) p.set("device_id", q.device_id);
    if (q.before !== undefined) p.set("before", String(q.before));
    if (q.limit !== undefined) p.set("limit", String(q.limit));
    const qs = p.toString();
    return request<{ events: EventRecord[] }>("GET", `/events${qs ? `?${qs}` : ""}`);
  },
};
