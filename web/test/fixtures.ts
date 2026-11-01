import type { DeviceView, GroupView, LampState, Scene } from "@doublelamp/protocol";

export const A = "dl-aaaaaa";
export const B = "dl-bbbbbb";

export const baseState: LampState = {
  on: true,
  brightness: 128,
  colors: ["#FFB46B"],
  effect: { id: "solid", speed: 128, intensity: 128, seed: 1, epoch: 1000, duration_ms: 0 },
};

export function state(over: Partial<LampState> = {}): LampState {
  return { ...baseState, ...over, effect: { ...baseState.effect, ...(over.effect ?? {}) } };
}

export function device(id: string, name: string, over: Partial<DeviceView> = {}): DeviceView {
  return {
    id,
    name,
    online: true,
    last_seen_at: 1,
    fw: "1.0.0",
    info: null,
    config: null,
    state: baseState,
    telemetry: null,
    effects: ["solid", "breathe", "candle"],
    group_id: 1,
    ...over,
  };
}

export function group(over: Partial<GroupView> = {}): GroupView {
  return { id: 1, name: "Home", linked: false, members: [A, B], state: null, ...over };
}

export function scene(id: number, sort: number, name = `Scene ${id}`): Scene {
  return { id, name, sort, state: baseState };
}

export function snapshotData(over: { devices?: DeviceView[]; groups?: GroupView[]; scenes?: Scene[] } = {}) {
  return {
    devices: over.devices ?? [device(A, "Lamp A"), device(B, "Lamp B")],
    groups: over.groups ?? [group()],
    scenes: over.scenes ?? [],
    server_time: 5000,
  };
}
