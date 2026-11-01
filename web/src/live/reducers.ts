// Pure reducers for the live store (06 A.4). The WS snapshot fills the store and change events keep it
// current. Optimistic edits are kept as a list of pending patches tagged with their `cid` and drawn on top
// of the server's state, so:
//   - a control change shows at once (the patch is overlaid immediately);
//   - the server's device.state / group.state replaces the confirmed state, and patches it has confirmed
//     (acked) are dropped, so ordering stays the server's and later edits from others still win;
//   - patches still in flight stay on top, so a slider being dragged doesn't jump back to older values;
//   - an `error` for a cid drops just that patch, which rolls the change back.
// No I/O here, so this file is unit-tested directly.
import { applyPatch, statesEqual } from "@doublelamp/protocol";
import type {
  Decoded,
  DeviceView,
  GroupView,
  LampState,
  OtaJob,
  Scene,
  StatePatch,
  Target,
  Telemetry,
  serverToClient,
} from "@doublelamp/protocol";

export type ServerMsg = Decoded<typeof serverToClient>;
export type MsgData<T extends ServerMsg["type"]> = Extract<ServerMsg, { type: T }>["data"];

export const deviceKey = (id: string): string => `d:${id}`;
export const groupKey = (id: number): string => `g:${id}`;
export const keyOf = (t: Target): string => ("device" in t ? deviceKey(t.device) : groupKey(t.group));

export interface Pending {
  cid: string;
  /** deviceKey / groupKey of the command's target. */
  key: string;
  target: Target;
  /** The patch as drawn locally (an effect switch also carries a local epoch and seed). */
  patch: StatePatch;
  transitionMs: number;
  /** Local Date.now() when sent. */
  sentAt: number;
  /** Number of state events for `key` seen before this command was sent. */
  seqAtSend: number;
  acked: boolean;
  ackedAt: number | null;
}

/** The last state event for a device or group. */
export interface StateMeta {
  applyAt: number | null;
  origin: string;
  by: string | null;
  /** Local Date.now() when received. */
  at: number;
}

/** What the UI draws: the confirmed state with pending patches on top. Entries keep their identity while equal. */
export interface LiveView {
  devices: Record<string, LampState | null>;
  groups: Record<number, LampState | null>;
}

export interface LiveState {
  devices: Record<string, DeviceView>;
  groups: Record<number, GroupView>;
  scenes: Scene[];
  otaJobs: Record<number, OtaJob>;
  pending: Pending[];
  seq: Record<string, number>;
  meta: Record<string, StateMeta>;
  view: LiveView;
  /** server_time of the last snapshot. */
  serverTime: number | null;
}

export function emptyLive(): LiveState {
  return {
    devices: {},
    groups: {},
    scenes: [],
    otaJobs: {},
    pending: [],
    seq: {},
    meta: {},
    view: { devices: {}, groups: {} },
    serverTime: null,
  };
}

// ------------------------------------------------------------------ derived view

type GroupsOnly = Pick<LiveState, "groups">;

/** The linked group a device follows, if any. While linked, the group's state is what the lamp shows. */
export function linkedGroupOf(s: GroupsOnly, deviceId: string): GroupView | null {
  for (const g of Object.values(s.groups)) if (g.linked && g.members.includes(deviceId)) return g;
  return null;
}

export function groupOf(s: Pick<LiveState, "groups" | "devices">, deviceId: string): GroupView | null {
  for (const g of Object.values(s.groups)) if (g.members.includes(deviceId)) return g;
  const gid = s.devices[deviceId]?.group_id;
  return gid != null ? (s.groups[gid] ?? null) : null;
}

function overlay(base: LampState, pending: readonly Pending[], keys: readonly string[]): LampState {
  let st = base;
  for (const p of pending) if (keys.includes(p.key)) st = applyPatch(st, p.patch).state;
  return st;
}

function computeDevice(s: LiveState, id: string): LampState | null {
  const d = s.devices[id];
  if (!d) return null;
  const g = linkedGroupOf(s, id);
  const base = g?.state ?? d.state;
  if (!base) return null;
  return overlay(base, s.pending, g ? [deviceKey(id), groupKey(g.id)] : [deviceKey(id)]);
}

function computeGroup(s: LiveState, g: GroupView): LampState | null {
  let base = g.state;
  if (!base) {
    for (const m of g.members) {
      const st = s.devices[m]?.state;
      if (st) {
        base = st;
        break;
      }
    }
  }
  if (!base) return null;
  return overlay(base, s.pending, [groupKey(g.id)]);
}

function keep(old: LampState | null | undefined, next: LampState | null): LampState | null {
  if (old === undefined) return next;
  if (old === next) return old;
  if (old && next && statesEqual(old, next)) return old;
  return next;
}

/** Recomputes the view; returns `s` itself when nothing visible changed. */
export function recompute<S extends LiveState>(s: S): S {
  const prev = s.view;
  let changed = false;
  const devices: Record<string, LampState | null> = {};
  for (const id of Object.keys(s.devices)) {
    const v = keep(prev.devices[id], computeDevice(s, id));
    devices[id] = v;
    if (v !== prev.devices[id]) changed = true;
  }
  const groups: Record<number, LampState | null> = {};
  for (const g of Object.values(s.groups)) {
    const v = keep(prev.groups[g.id], computeGroup(s, g));
    groups[g.id] = v;
    if (v !== prev.groups[g.id]) changed = true;
  }
  if (Object.keys(prev.devices).length !== Object.keys(devices).length) changed = true;
  if (Object.keys(prev.groups).length !== Object.keys(groups).length) changed = true;
  return changed ? { ...s, view: { devices, groups } } : s;
}

/** The drawn state for a command target. */
export function displayOf(s: Pick<LiveState, "view">, t: Target): LampState | null {
  return ("device" in t ? s.view.devices[t.device] : s.view.groups[t.group]) ?? null;
}

// ------------------------------------------------------------------ server messages

function byId<T extends { id: string | number }>(items: readonly T[]): Record<string, T> {
  const out: Record<string, T> = {};
  for (const it of items) out[String(it.id)] = it;
  return out;
}

export function sortScenes(scenes: readonly Scene[]): Scene[] {
  return [...scenes].sort((a, b) => a.sort - b.sort || a.id - b.id);
}

/** A fresh snapshot replaces everything; optimistic patches from before it are dropped (06 A.4). */
export function reduceSnapshot<S extends LiveState>(s: S, data: MsgData<"snapshot">): S {
  return recompute({
    ...s,
    devices: byId(data.devices),
    groups: byId(data.groups),
    scenes: sortScenes(data.scenes),
    pending: [],
    meta: {},
    serverTime: data.server_time,
  });
}

function settle<S extends LiveState>(s: S, key: string, meta: StateMeta): Pick<S, "seq" | "pending" | "meta"> {
  return {
    seq: { ...s.seq, [key]: (s.seq[key] ?? 0) + 1 },
    // The server has applied every acked command for this target, so this state includes them.
    pending: s.pending.filter((p) => !(p.key === key && p.acked)),
    meta: { ...s.meta, [key]: meta },
  };
}

export function reduceDeviceState<S extends LiveState>(s: S, data: MsgData<"device.state">, now: number): S {
  const d = s.devices[data.id];
  if (!d) return s;
  const key = deviceKey(data.id);
  const meta: StateMeta = { applyAt: data.apply_at ?? null, origin: data.origin, by: data.by ?? null, at: now };
  return recompute({ ...s, ...settle(s, key, meta), devices: { ...s.devices, [data.id]: { ...d, state: data.state } } });
}

export function reduceGroupState<S extends LiveState>(s: S, data: MsgData<"group.state">, now: number): S {
  const g = s.groups[data.id];
  if (!g) return s;
  const key = groupKey(data.id);
  const meta: StateMeta = { applyAt: data.apply_at ?? null, origin: data.origin, by: data.by ?? null, at: now };
  return recompute({ ...s, ...settle(s, key, meta), groups: { ...s.groups, [data.id]: { ...g, state: data.state } } });
}

export function reducePresence<S extends LiveState>(s: S, data: MsgData<"device.presence">): S {
  const d = s.devices[data.id];
  if (!d) return s;
  return { ...s, devices: { ...s.devices, [data.id]: { ...d, online: data.online, last_seen_at: data.last_seen_at } } };
}

export function reduceTelemetry<S extends LiveState>(s: S, data: { id: string; telemetry: Telemetry }): S {
  const d = s.devices[data.id];
  if (!d) return s;
  return { ...s, devices: { ...s.devices, [data.id]: { ...d, telemetry: data.telemetry } } };
}

export function reduceDeviceUpdated<S extends LiveState>(s: S, view: DeviceView): S {
  return recompute({ ...s, devices: { ...s.devices, [view.id]: view } });
}

export function reduceDeviceRemoved<S extends LiveState>(s: S, data: { id: string }): S {
  if (!s.devices[data.id]) return s;
  const devices = { ...s.devices };
  delete devices[data.id];
  const groups: Record<number, GroupView> = {};
  for (const g of Object.values(s.groups)) {
    groups[g.id] = g.members.includes(data.id) ? { ...g, members: g.members.filter((m) => m !== data.id) } : g;
  }
  const key = deviceKey(data.id);
  return recompute({ ...s, devices, groups, pending: s.pending.filter((p) => p.key !== key) });
}

/**
 * Unlinking copies the group state into each member's own replica on the server (05 §4); do the same
 * here so the tiles don't fall back to the pre-link device state.
 */
export function reduceGroupUpdated<S extends LiveState>(s: S, g: GroupView): S {
  const prev = s.groups[g.id];
  let devices = s.devices;
  if (prev?.linked && !g.linked) {
    const st = g.state ?? prev.state;
    if (st) {
      devices = { ...devices };
      for (const m of g.members) {
        const d = devices[m];
        if (d) devices[m] = { ...d, state: st };
      }
    }
  }
  return recompute({ ...s, devices, groups: { ...s.groups, [g.id]: g } });
}

export function reduceScenes<S extends LiveState>(s: S, scenes: readonly Scene[]): S {
  return { ...s, scenes: sortScenes(scenes) };
}

export function reduceOtaJob<S extends LiveState>(s: S, job: OtaJob): S {
  return { ...s, otaJobs: { ...s.otaJobs, [job.id]: job } };
}

// ------------------------------------------------------------------ optimistic commands

export function addPending<S extends LiveState>(
  s: S,
  p: Omit<Pending, "seqAtSend" | "acked" | "ackedAt">,
): S {
  const entry: Pending = { ...p, seqAtSend: s.seq[p.key] ?? 0, acked: false, ackedAt: null };
  return recompute({ ...s, pending: [...s.pending, entry] });
}

/**
 * `ack` for a cid. If a state event for the target arrived after the command was sent, that state already
 * includes it (the server broadcasts before it acks), so the patch goes now. Otherwise it is marked acked
 * and goes with the next state event for its target, or after a short timeout (a no-op patch sends no event).
 */
export function reduceAck<S extends LiveState>(s: S, cid: string, now: number): S {
  const p = s.pending.find((x) => x.cid === cid);
  if (!p) return s;
  if ((s.seq[p.key] ?? 0) > p.seqAtSend) return recompute({ ...s, pending: s.pending.filter((x) => x !== p) });
  return { ...s, pending: s.pending.map((x) => (x === p ? { ...x, acked: true, ackedAt: now } : x)) };
}

/** `error` for a cid: drop that patch, which rolls its change back. Returns the dropped patch for the toast. */
export function reduceError<S extends LiveState>(s: S, cid: string): { state: S; pending: Pending | null } {
  const p = s.pending.find((x) => x.cid === cid);
  if (!p) return { state: s, pending: null };
  return { state: recompute({ ...s, pending: s.pending.filter((x) => x !== p) }), pending: p };
}

export const PENDING_TTL = { ackedMs: 1500, unackedMs: 10_000 };

/** Drops acked patches that never saw a state event, and patches the server never answered. */
export function sweepPending<S extends LiveState>(s: S, now: number, ttl = PENDING_TTL): S {
  const kept = s.pending.filter((p) =>
    p.acked ? now - (p.ackedAt ?? now) < ttl.ackedMs : now - p.sentAt < ttl.unackedMs,
  );
  return kept.length === s.pending.length ? s : recompute({ ...s, pending: kept });
}

/** On disconnect nothing is queued (06 A.4): show the last confirmed state. */
export function dropAllPending<S extends LiveState>(s: S): S {
  return s.pending.length ? recompute({ ...s, pending: [] }) : s;
}

/** Applies one server → browser message. `time.pong` and `error` have side effects and are handled by the caller. */
export function applyServerMessage<S extends LiveState>(s: S, msg: ServerMsg, now: number): S {
  switch (msg.type) {
    case "snapshot":
      return reduceSnapshot(s, msg.data);
    case "device.state":
      return reduceDeviceState(s, msg.data, now);
    case "group.state":
      return reduceGroupState(s, msg.data, now);
    case "device.presence":
      return reducePresence(s, msg.data);
    case "device.updated":
      return reduceDeviceUpdated(s, msg.data);
    case "device.removed":
      return reduceDeviceRemoved(s, msg.data);
    case "device.telemetry":
      return reduceTelemetry(s, msg.data);
    case "group.updated":
      return reduceGroupUpdated(s, msg.data);
    case "scene.updated":
      return reduceScenes(s, msg.data.scenes);
    case "ota.job":
      return reduceOtaJob(s, msg.data);
    case "ack":
      return msg.ref ? reduceAck(s, msg.ref, now) : s;
    case "error":
      return msg.ref ? reduceError(s, msg.ref).state : s;
    case "time.pong":
      return s;
  }
}
