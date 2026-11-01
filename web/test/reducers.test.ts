// Store reducers (06 A.4 / A.5): snapshot, change events, optimistic updates and rollback by cid.
import { describe, expect, it } from "vitest";
import type { StatePatch, Target } from "@doublelamp/protocol";
import {
  PENDING_TTL,
  addPending,
  applyServerMessage,
  deviceKey,
  dropAllPending,
  emptyLive,
  groupKey,
  keyOf,
  reduceAck,
  reduceDeviceRemoved,
  reduceDeviceState,
  reduceError,
  reduceGroupState,
  reduceGroupUpdated,
  reduceOtaJob,
  reducePresence,
  reduceScenes,
  reduceSnapshot,
  reduceTelemetry,
  sweepPending,
  type LiveState,
} from "../src/live/reducers";
import { A, B, device, group, scene, snapshotData, state } from "./fixtures";

const NOW = 10_000;

function live(over: Parameters<typeof snapshotData>[0] = {}): LiveState {
  return reduceSnapshot(emptyLive(), snapshotData(over));
}

function send(s: LiveState, cid: string, target: Target, patch: StatePatch, sentAt = NOW): LiveState {
  return addPending(s, { cid, key: keyOf(target), target, patch, transitionMs: 400, sentAt });
}

describe("snapshot", () => {
  it("fills devices, groups and scenes and computes the view", () => {
    const s = live({ scenes: [scene(2, 1), scene(1, 0), scene(3, 1)] });
    expect(Object.keys(s.devices)).toEqual([A, B]);
    expect(s.groups[1]?.members).toEqual([A, B]);
    expect(s.scenes.map((x) => x.id)).toEqual([1, 2, 3]);
    expect(s.view.devices[A]).toEqual(state());
    expect(s.serverTime).toBe(5000);
  });

  it("drops optimistic patches from before a reconnect", () => {
    let s = send(live(), "c1", { device: A }, { brightness: 10 });
    expect(s.view.devices[A]?.brightness).toBe(10);
    s = reduceSnapshot(s, snapshotData());
    expect(s.pending).toEqual([]);
    expect(s.view.devices[A]?.brightness).toBe(128);
  });

  it("shows the group state for linked lamps, since their own replica may be stale", () => {
    const s = live({ groups: [group({ linked: true, state: state({ brightness: 200 }) })] });
    expect(s.view.devices[A]?.brightness).toBe(200);
    expect(s.view.devices[B]?.brightness).toBe(200);
    expect(s.view.groups[1]?.brightness).toBe(200);
  });

  it("uses a member's state for a group that has none yet", () => {
    const s = live();
    expect(s.view.groups[1]).toEqual(state());
  });
});

describe("change events", () => {
  it("device.state replaces the lamp's state and records apply_at", () => {
    const s = reduceDeviceState(live(), { id: B, state: state({ on: false }), origin: "homekit", apply_at: 777 }, NOW);
    expect(s.view.devices[B]?.on).toBe(false);
    expect(s.view.devices[A]?.on).toBe(true);
    expect(s.meta[deviceKey(B)]).toEqual({ applyAt: 777, origin: "homekit", by: null, at: NOW });
  });

  it("ignores state for lamps it doesn't know", () => {
    const s0 = live();
    expect(reduceDeviceState(s0, { id: "dl-cccccc", state: state(), origin: "web" }, NOW)).toBe(s0);
  });

  it("keeps view entries identical while nothing visible changes", () => {
    const s0 = live();
    const s1 = reduceDeviceState(s0, { id: A, state: state(), origin: "web" }, NOW);
    expect(s1.view).toBe(s0.view);
    expect(s1.view.devices[A]).toBe(s0.view.devices[A]);
  });

  it("presence and telemetry update the lamp without touching the view", () => {
    const s0 = live();
    let s = reducePresence(s0, { id: A, online: false, last_seen_at: 1234 });
    s = reduceTelemetry(s, {
      id: A,
      telemetry: { rssi: -60, heap_free: 1, heap_min: 1, uptime_s: 5, fps: 100, reconnects: 0, temp_c: 40 },
    });
    expect(s.devices[A]?.online).toBe(false);
    expect(s.devices[A]?.last_seen_at).toBe(1234);
    expect(s.devices[A]?.telemetry?.rssi).toBe(-60);
    expect(s.view).toBe(s0.view);
  });

  it("device.removed drops the lamp, its pending patches and its group membership", () => {
    let s = send(live(), "c1", { device: B }, { on: false });
    s = reduceDeviceRemoved(s, { id: B });
    expect(s.devices[B]).toBeUndefined();
    expect(s.view.devices[B]).toBeUndefined();
    expect(s.pending).toEqual([]);
    expect(s.groups[1]?.members).toEqual([A]);
  });

  it("device.updated replaces the whole view of the lamp", () => {
    const s = applyServerMessage(live(), { type: "device.updated", data: device(A, "Desk", { state: state({ brightness: 3 }) }) }, NOW);
    expect(s.devices[A]?.name).toBe("Desk");
    expect(s.view.devices[A]?.brightness).toBe(3);
  });

  it("scene.updated replaces the list, sorted by sort then id", () => {
    const s = reduceScenes(live(), [scene(9, 2), scene(4, 0), scene(7, 0)]);
    expect(s.scenes.map((x) => x.id)).toEqual([4, 7, 9]);
  });

  it("ota.job upserts by id", () => {
    const job = { id: 5, device_id: A, sha256: "a".repeat(64), version: "1.1.0", status: "download" as const, pct: 10, error: null, created_at: 1, updated_at: 2 };
    let s = reduceOtaJob(live(), job);
    s = reduceOtaJob(s, { ...job, pct: 60 });
    expect(Object.keys(s.otaJobs)).toEqual(["5"]);
    expect(s.otaJobs[5]?.pct).toBe(60);
  });

  it("linking switches both tiles to the group state; unlinking copies it into each lamp", () => {
    let s = live();
    s = reduceDeviceState(s, { id: B, state: state({ colors: ["#0000FF"] }), origin: "local" }, NOW);
    s = reduceGroupUpdated(s, group({ linked: true, state: state({ colors: ["#FF0000"] }) }));
    expect(s.view.devices[A]?.colors).toEqual(["#FF0000"]);
    expect(s.view.devices[B]?.colors).toEqual(["#FF0000"]);
    s = reduceGroupUpdated(s, group({ linked: false, state: state({ colors: ["#FF0000"] }) }));
    expect(s.devices[B]?.state?.colors).toEqual(["#FF0000"]);
    expect(s.view.devices[B]?.colors).toEqual(["#FF0000"]);
  });
});

describe("optimistic updates", () => {
  it("shows a patch at once, only on its target", () => {
    const s = send(live(), "c1", { device: A }, { colors: ["#ff0000"] });
    expect(s.view.devices[A]?.colors).toEqual(["#FF0000"]);
    expect(s.view.devices[B]?.colors).toEqual(["#FFB46B"]);
    expect(s.pending[0]?.seqAtSend).toBe(0);
  });

  it("server state then ack: the ack drops the patch (the state already has it)", () => {
    let s = send(live(), "c1", { device: A }, { brightness: 50 });
    s = reduceDeviceState(s, { id: A, state: state({ brightness: 50 }), origin: "web" }, NOW);
    expect(s.pending).toHaveLength(1);
    s = reduceAck(s, "c1", NOW);
    expect(s.pending).toHaveLength(0);
    expect(s.view.devices[A]?.brightness).toBe(50);
  });

  it("ack then server state: the patch stays until the state arrives, so nothing flickers", () => {
    let s = send(live(), "c1", { device: A }, { brightness: 50 });
    s = reduceAck(s, "c1", NOW);
    expect(s.pending[0]?.acked).toBe(true);
    expect(s.view.devices[A]?.brightness).toBe(50);
    s = reduceDeviceState(s, { id: A, state: state({ brightness: 50 }), origin: "web" }, NOW);
    expect(s.pending).toHaveLength(0);
    expect(s.view.devices[A]?.brightness).toBe(50);
  });

  it("keeps in-flight drag values on top of older server echoes", () => {
    let s = live();
    s = send(s, "c1", { device: A }, { brightness: 100 });
    s = send(s, "c2", { device: A }, { brightness: 110 });
    s = send(s, "c3", { device: A }, { brightness: 120 });
    s = reduceDeviceState(s, { id: A, state: state({ brightness: 100 }), origin: "web" }, NOW);
    s = reduceAck(s, "c1", NOW);
    expect(s.view.devices[A]?.brightness).toBe(120);
    s = reduceDeviceState(s, { id: A, state: state({ brightness: 110 }), origin: "web" }, NOW);
    s = reduceAck(s, "c2", NOW);
    expect(s.view.devices[A]?.brightness).toBe(120);
    s = reduceDeviceState(s, { id: A, state: state({ brightness: 120 }), origin: "web" }, NOW);
    s = reduceAck(s, "c3", NOW);
    expect(s.pending).toEqual([]);
    expect(s.view.devices[A]?.brightness).toBe(120);
  });

  it("rolls back on error, for that cid only", () => {
    let s = live();
    s = send(s, "c1", { device: B }, { on: false });
    s = send(s, "c2", { device: B }, { brightness: 40 });
    expect(s.view.devices[B]).toMatchObject({ on: false, brightness: 40 });
    const r = reduceError(s, "c1");
    expect(r.pending?.cid).toBe("c1");
    expect(r.pending?.target).toEqual({ device: B });
    expect(r.state.view.devices[B]).toMatchObject({ on: true, brightness: 40 });
    const r2 = reduceError(r.state, "c2");
    expect(r2.state.view.devices[B]).toEqual(state());
  });

  it("an error for an unknown cid changes nothing", () => {
    const s = live();
    expect(reduceError(s, "nope")).toEqual({ state: s, pending: null });
    expect(reduceAck(s, "nope", NOW)).toBe(s);
  });

  it("later edits from someone else win once ours is confirmed (server order)", () => {
    let s = send(live(), "c1", { device: A }, { brightness: 50 });
    s = reduceDeviceState(s, { id: A, state: state({ brightness: 50 }), origin: "web" }, NOW);
    s = reduceAck(s, "c1", NOW);
    s = reduceDeviceState(s, { id: A, state: state({ brightness: 30 }), origin: "local" }, NOW);
    expect(s.view.devices[A]?.brightness).toBe(30);
  });

  it("linked: a group command shows on both tiles and the group, and group.state settles it", () => {
    let s = live({ groups: [group({ linked: true, state: state() })] });
    s = send(s, "g1", { group: 1 }, { colors: ["#00FF00"] });
    expect(s.pending[0]?.key).toBe(groupKey(1));
    expect(s.view.devices[A]?.colors).toEqual(["#00FF00"]);
    expect(s.view.devices[B]?.colors).toEqual(["#00FF00"]);
    expect(s.view.groups[1]?.colors).toEqual(["#00FF00"]);
    s = reduceAck(s, "g1", NOW);
    s = reduceGroupState(s, { id: 1, state: state({ colors: ["#00FF00"] }), origin: "web", apply_at: 999 }, NOW);
    expect(s.pending).toEqual([]);
    expect(s.view.devices[B]?.colors).toEqual(["#00FF00"]);
    expect(s.meta[groupKey(1)]?.applyAt).toBe(999);
  });

  it("a device command doesn't move the partner while unlinked", () => {
    const s = send(live(), "c1", { device: A }, { on: false });
    expect(s.view.devices[B]?.on).toBe(true);
    expect(s.view.groups[1]?.on).toBe(true);
  });

  it("sweep drops acked patches with no state event, and patches never answered", () => {
    let s = live();
    s = send(s, "c1", { device: A }, { brightness: 128 }, NOW);
    s = send(s, "c2", { device: B }, { brightness: 7 }, NOW);
    s = reduceAck(s, "c1", NOW);
    s = sweepPending(s, NOW + PENDING_TTL.ackedMs - 1);
    expect(s.pending.map((p) => p.cid)).toEqual(["c1", "c2"]);
    s = sweepPending(s, NOW + PENDING_TTL.ackedMs);
    expect(s.pending.map((p) => p.cid)).toEqual(["c2"]);
    s = sweepPending(s, NOW + PENDING_TTL.unackedMs);
    expect(s.pending).toEqual([]);
    expect(s.view.devices[B]?.brightness).toBe(128);
  });

  it("disconnect drops every pending patch (nothing is queued)", () => {
    let s = send(live(), "c1", { device: A }, { on: false });
    s = dropAllPending(s);
    expect(s.pending).toEqual([]);
    expect(s.view.devices[A]?.on).toBe(true);
  });

  it("applyServerMessage routes ack and error by ref", () => {
    let s = send(live(), "c1", { device: A }, { on: false });
    s = applyServerMessage(s, { type: "error", ref: "c1", data: { code: "offline", message: "offline" } }, NOW);
    expect(s.view.devices[A]?.on).toBe(true);
    s = send(s, "c2", { device: A }, { on: false });
    s = applyServerMessage(s, { type: "ack", ref: "c2", data: {} }, NOW);
    expect(s.pending[0]?.acked).toBe(true);
  });
});
