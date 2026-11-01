import { describe, expect, it } from "vitest";
import { DEFAULT_STATE, cloneState, type LampState } from "@doublelamp/protocol";
import { LINK_TRANSITION_MS } from "../../src/engine/engine";
import { APPLY_AT } from "../../src/engine/timing";
import { A, B, makeRig, type Rig } from "./engine-helpers";

const RED: LampState = { ...cloneState(DEFAULT_STATE), on: true, brightness: 200, colors: ["#FF0000"] };
const BLUE: LampState = { ...cloneState(DEFAULT_STATE), on: true, brightness: 50, colors: ["#0000FF"] };

/** Both lamps connected with known states; optionally linked. Clears the recorder. */
function connected(opts: { linked?: boolean; stateA?: LampState; stateB?: LampState } = {}): Rig {
  const rig = makeRig();
  rig.engine.connect(A, { state: opts.stateA ?? RED, dirty: {} });
  rig.advance(1000);
  rig.engine.connect(B, { state: opts.stateB ?? BLUE, dirty: {} });
  if (opts.linked) rig.engine.setLinked(1, true, A);
  rig.advance(1000);
  rig.rec.clear();
  return rig;
}

describe("device commands", () => {
  it("applies to an online unlinked lamp with no apply_at and stamps field timestamps", () => {
    const rig = connected();
    const r = rig.engine.command({ device: A }, { brightness: 90 }, { origin: "web", by: "Kitchen iPad", transitionMs: 150 });
    expect(r.ok).toBe(true);
    const sent = rig.rec.sentTo(A);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ transition_ms: 150, origin: "web" });
    expect(sent[0]!.apply_at).toBeUndefined();
    expect(sent[0]!.state.brightness).toBe(90);
    expect(rig.rec.sentTo(B)).toHaveLength(0);
    expect(rig.engine.getDevice(A)!.replica!.fieldTs.brightness).toBe(rig.clock.now);
    expect(rig.rec.changes).toEqual([expect.objectContaining({ kind: "device", id: A, origin: "web", by: "Kitchen iPad" })]);
    expect(rig.rec.activities[0]).toMatchObject({ target: { device: A }, patch: { brightness: 90 }, origin: "web", by: "Kitchen iPad" });
  });

  it("is idempotent: a patch that changes nothing sends nothing and keeps timestamps", () => {
    const rig = connected();
    rig.engine.command({ device: A }, { brightness: 90 }, { origin: "web" });
    const ts = rig.engine.getDevice(A)!.replica!.fieldTs.brightness;
    rig.rec.clear();
    rig.advance(5000);
    const r = rig.engine.command({ device: A }, { brightness: 90, colors: ["#ff0000"] }, { origin: "web" });
    expect(r.ok && r.changed).toEqual([]);
    expect(rig.rec.sent).toHaveLength(0);
    expect(rig.rec.changes).toHaveLength(0);
    expect(rig.engine.getDevice(A)!.replica!.fieldTs.brightness).toBe(ts);
  });

  it("fails with offline for a lamp that isn't connected, and queues nothing", () => {
    const rig = connected();
    rig.engine.disconnect(B);
    const r = rig.engine.command({ device: B }, { on: false }, { origin: "web" });
    expect(r).toMatchObject({ ok: false, code: "offline" });
    expect(rig.rec.sent).toHaveLength(0);
    expect(rig.engine.getDevice(B)!.replica!.state.on).toBe(true);
  });

  it("fails with not_found for an unknown lamp or group", () => {
    const rig = connected();
    expect(rig.engine.command({ device: "dl-ffffff" }, { on: true }, { origin: "web" })).toMatchObject({ ok: false, code: "not_found" });
    expect(rig.engine.command({ group: 99 }, { on: true }, { origin: "web" })).toMatchObject({ ok: false, code: "not_found" });
  });

  it("rejects an effect the lamp doesn't support", () => {
    const rig = makeRig();
    rig.engine.connect(A, { state: RED, dirty: {}, effects: ["solid", "breathe"] });
    const r = rig.engine.command({ device: A }, { effect: { id: "rainbow" } }, { origin: "web" });
    expect(r).toMatchObject({ ok: false, code: "unknown_effect" });
    expect(rig.engine.command({ device: A }, { effect: { id: "breathe" } }, { origin: "web" }).ok).toBe(true);
  });
});

describe("effect epoch and seed", () => {
  it("single lamp: a new effect starts now with a fresh seed", () => {
    const rig = connected();
    const r = rig.engine.command({ device: A }, { effect: { id: "candle" } }, { origin: "web" });
    expect(r.ok).toBe(true);
    const e = rig.engine.getDevice(A)!.replica!.state.effect;
    expect(e.id).toBe("candle");
    expect(e.epoch).toBe(rig.clock.now);
    expect(e.seed).not.toBe(RED.effect.seed);
  });

  it("keeps an explicit epoch and seed", () => {
    const rig = connected();
    rig.engine.command({ device: A }, { effect: { id: "candle", seed: 42, epoch: 1234 } }, { origin: "web" });
    expect(rig.engine.getDevice(A)!.replica!.state.effect).toMatchObject({ id: "candle", seed: 42, epoch: 1234 });
  });

  it("commands: a parameter change keeps the epoch and seed; a new effect id restarts it with a new seed", () => {
    const rig = connected();
    rig.engine.command({ device: A }, { effect: { id: "rainbow" } }, { origin: "web" });
    const first = { ...rig.engine.getDevice(A)!.replica!.state.effect };
    rig.advance(10_000);
    rig.engine.command({ device: A }, { effect: { speed: 200 } }, { origin: "web" });
    const second = { ...rig.engine.getDevice(A)!.replica!.state.effect };
    expect(second.speed).toBe(200);
    expect(second.epoch).toBe(first.epoch); // dragging a slider doesn't restart the animation
    expect(second.seed).toBe(first.seed);
    rig.advance(1000);
    rig.engine.command({ device: A }, { effect: { id: "candle" } }, { origin: "web" });
    const third = rig.engine.getDevice(A)!.replica!.state.effect;
    expect(third.epoch).toBe(rig.clock.now);
  });

  it("lamp reports: the epoch only moves when the effect id changes (mirrors the firmware)", () => {
    const rig = connected();
    rig.engine.command({ device: A }, { effect: { id: "rainbow" } }, { origin: "web" });
    const epoch = rig.engine.getDevice(A)!.replica!.state.effect.epoch;
    rig.advance(10_000);
    rig.engine.report(A, { effect: { speed: 10 } }, "local");
    expect(rig.engine.getDevice(A)!.replica!.state.effect.epoch).toBe(epoch);
    rig.advance(1000);
    rig.engine.report(A, { effect: { id: "breathe" } }, "local");
    expect(rig.engine.getDevice(A)!.replica!.state.effect.epoch).toBe(rig.clock.now);
  });

  it("restartEffect re-stamps the epoch even when nothing else changed (scheduled sunrise)", () => {
    const rig = connected();
    const patch = { on: true, effect: { id: "sunrise", duration_ms: 600_000 } };
    rig.engine.command({ device: A }, patch, { origin: "schedule" });
    rig.advance(86_400_000);
    rig.rec.clear();
    const r = rig.engine.command({ device: A }, patch, { origin: "schedule", restartEffect: true });
    expect(r.ok && r.changed).toEqual(["effect"]);
    expect(rig.engine.getDevice(A)!.replica!.state.effect.epoch).toBe(rig.clock.now);
    expect(rig.rec.sentTo(A)).toHaveLength(1);
  });
});

describe("linked groups", () => {
  it("a group change reaches every online member with the same apply_at, and epoch = apply_at", () => {
    const rig = connected({ linked: true });
    rig.engine.recordDelay(A, 30);
    rig.engine.recordDelay(B, 120);
    const now = rig.clock.now;
    const r = rig.engine.command({ group: 1 }, { effect: { id: "rainbow" } }, { origin: "web", transitionMs: 400 });
    expect(r.ok).toBe(true);
    const a = rig.rec.sentTo(A);
    const b = rig.rec.sentTo(B);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0]!.apply_at).toBe(now + 120 + APPLY_AT.marginMs);
    expect(b[0]!.apply_at).toBe(a[0]!.apply_at);
    expect(a[0]!.state.effect.epoch).toBe(a[0]!.apply_at);
    expect(b[0]!.state).toEqual(a[0]!.state);
    // group.state plus device.state for each member
    const kinds = rig.rec.changes.map((c) => `${c.kind}:${c.id}`);
    expect(kinds).toEqual(["group:1", `device:${A}`, `device:${B}`]);
    // member replicas follow the group replica
    expect(rig.engine.getDevice(A)!.replica!.state).toEqual(rig.engine.getGroup(1)!.replica!.state);
    expect(rig.engine.getDevice(B)!.replica!.state).toEqual(rig.engine.getGroup(1)!.replica!.state);
  });

  it("a device-targeted command on a linked lamp goes to the group", () => {
    const rig = connected({ linked: true });
    rig.engine.command({ device: B }, { brightness: 7 }, { origin: "web" });
    expect(rig.rec.sentTo(A)[0]!.state.brightness).toBe(7);
    expect(rig.rec.sentTo(B)[0]!.state.brightness).toBe(7);
    expect(rig.engine.getGroup(1)!.replica!.state.brightness).toBe(7);
  });

  it("with one member offline the group replica still updates; the online one gets no apply_at", () => {
    const rig = connected({ linked: true });
    rig.engine.disconnect(B);
    const r = rig.engine.command({ group: 1 }, { colors: ["#00FF00"] }, { origin: "web" });
    expect(r.ok).toBe(true);
    expect(rig.rec.sentTo(A)).toHaveLength(1);
    expect(rig.rec.sentTo(A)[0]!.apply_at).toBeUndefined();
    expect(rig.rec.sentTo(B)).toHaveLength(0);
    expect(rig.engine.getGroup(1)!.replica!.state.colors).toEqual(["#00FF00"]);
    expect(rig.engine.getDevice(B)!.replica!.state.colors).toEqual(["#00FF00"]);
  });

  it("but a device-targeted command to the offline member fails with offline", () => {
    const rig = connected({ linked: true });
    rig.engine.disconnect(B);
    expect(rig.engine.command({ device: B }, { on: false }, { origin: "web" })).toMatchObject({ ok: false, code: "offline" });
  });

  it("a group with no online member fails with offline", () => {
    const rig = connected({ linked: true });
    rig.engine.disconnect(A);
    rig.engine.disconnect(B);
    expect(rig.engine.command({ group: 1 }, { on: false }, { origin: "schedule" })).toMatchObject({ ok: false, code: "offline" });
  });

  it("state.report is echoed to every member, including the lamp that reported", () => {
    const rig = connected({ linked: true });
    rig.engine.report(A, { brightness: 33 }, "homekit");
    expect(rig.rec.sentTo(A)).toHaveLength(1);
    expect(rig.rec.sentTo(B)).toHaveLength(1);
    expect(rig.rec.sentTo(B)[0]).toMatchObject({ origin: "homekit" });
    expect(rig.rec.sentTo(B)[0]!.apply_at).toBe(rig.rec.sentTo(A)[0]!.apply_at);
    expect(rig.rec.activities[0]).toMatchObject({ deviceId: A, origin: "homekit", patch: { brightness: 33 } });
  });

  it("concurrent edits to different fields both survive", () => {
    const rig = connected({ linked: true });
    rig.engine.report(A, { brightness: 10 }, "local");
    rig.advance(5);
    rig.engine.command({ group: 1 }, { colors: ["#123456"] }, { origin: "web" });
    for (const id of [A, B]) {
      const last = rig.rec.sentTo(id).at(-1)!;
      expect(last.state.brightness).toBe(10);
      expect(last.state.colors).toEqual(["#123456"]);
    }
  });

  it("a race on one field ends on whichever change the server received last", () => {
    for (const order of [["lamp", "web"], ["web", "lamp"]] as const) {
      const rig = connected({ linked: true });
      for (const who of order) {
        if (who === "lamp") rig.engine.report(A, { colors: ["#FF0000"] }, "local");
        else rig.engine.command({ group: 1 }, { colors: ["#0000FF"] }, { origin: "web" });
        rig.advance(3);
      }
      const expected = order[1] === "web" ? ["#0000FF"] : ["#FF0000"];
      expect(rig.rec.sentTo(A).at(-1)!.state.colors).toEqual(expected);
      expect(rig.rec.sentTo(B).at(-1)!.state.colors).toEqual(expected);
      expect(rig.engine.getGroup(1)!.replica!.state.colors).toEqual(expected);
    }
  });
});

describe("unlinked group commands", () => {
  it("apply to each online member separately, without apply_at", () => {
    const rig = connected();
    const r = rig.engine.command({ group: 1 }, { on: false }, { origin: "schedule" });
    expect(r.ok).toBe(true);
    expect(rig.rec.sentTo(A)[0]!.apply_at).toBeUndefined();
    expect(rig.rec.sentTo(B)[0]!.apply_at).toBeUndefined();
    expect(rig.engine.getDevice(A)!.replica!.state.on).toBe(false);
    expect(rig.engine.getDevice(B)!.replica!.state.on).toBe(false);
    expect(rig.engine.getDevice(A)!.replica!.state.colors).toEqual(RED.colors);
    expect(rig.engine.getDevice(B)!.replica!.state.colors).toEqual(BLUE.colors);
  });
});

describe("link and unlink", () => {
  it("linking starts from the most recently changed member and pushes it to all at a shared apply_at", () => {
    const rig = connected();
    rig.engine.command({ device: B }, { brightness: 222 }, { origin: "web" });
    rig.advance(1000);
    rig.rec.clear();
    const now = rig.clock.now;
    const r = rig.engine.setLinked(1, true);
    expect(r).toMatchObject({ ok: true, changed: true, sourceId: B });
    const a = rig.rec.sentTo(A)[0]!;
    const b = rig.rec.sentTo(B)[0]!;
    expect(a.state).toEqual(b.state);
    expect(a.state.colors).toEqual(BLUE.colors);
    expect(a.state.brightness).toBe(222);
    expect(a.apply_at).toBeDefined();
    expect(a.apply_at).toBe(b.apply_at);
    expect(a.transition_ms).toBe(LINK_TRANSITION_MS);
    expect(a.origin).toBe("link");
    // The link is the newest change to every field.
    expect(rig.engine.getGroup(1)!.replica!.fieldTs).toEqual({ on: now, brightness: now, colors: now, effect: now });
    // Both lamps are told about the link.
    expect(rig.rec.links.map((l) => [l.deviceId, l.link?.linked])).toEqual([
      [A, true],
      [B, true],
    ]);
  });

  it("match_from overrides the most-recent rule (match B to A)", () => {
    const rig = connected();
    rig.engine.command({ device: B }, { brightness: 222 }, { origin: "web" });
    rig.rec.clear();
    const r = rig.engine.setLinked(1, true, A);
    expect(r).toMatchObject({ ok: true, sourceId: A });
    expect(rig.rec.sentTo(B)[0]!.state.colors).toEqual(RED.colors);
    expect(rig.rec.sentTo(B)[0]!.state.brightness).toBe(RED.brightness);
  });

  it("rejects a match_from that isn't a member", () => {
    const rig = connected();
    expect(rig.engine.setLinked(1, true, "dl-ffffff")).toMatchObject({ ok: false, code: "invalid", field: "match_from" });
    expect(rig.engine.getGroup(1)!.linked).toBe(false);
  });

  it("unlinking copies the group state into each lamp's own replica without sending anything", () => {
    const rig = connected({ linked: true });
    rig.engine.command({ group: 1 }, { colors: ["#ABCDEF"] }, { origin: "web" });
    rig.rec.clear();
    expect(rig.engine.setLinked(1, false)).toMatchObject({ ok: true, changed: true });
    expect(rig.rec.sent).toHaveLength(0);
    expect(rig.engine.getDevice(A)!.replica!.state.colors).toEqual(["#ABCDEF"]);
    expect(rig.engine.getDevice(B)!.replica!.state.colors).toEqual(["#ABCDEF"]);
    // From now on the lamps take commands separately.
    rig.engine.command({ device: A }, { colors: ["#111111"] }, { origin: "web" });
    expect(rig.rec.sentTo(B)).toHaveLength(0);
  });

  it("linking again with the same value is a no-op", () => {
    const rig = connected({ linked: true });
    expect(rig.engine.setLinked(1, true)).toMatchObject({ ok: true, changed: false });
    expect(rig.rec.sent).toHaveLength(0);
  });
});

describe("connect (reconnect merge)", () => {
  it("adopts the state of a lamp the server has never seen (desired = null)", () => {
    const rig = makeRig();
    const res = rig.engine.connect(A, { state: RED, dirty: {} });
    expect(res.adopted).toBe(true);
    expect(res.desired).toBeNull();
    expect(rig.engine.getDevice(A)!.replica!.state).toEqual(RED);
    expect(res.link).toMatchObject({ group_id: 1, linked: false, peers: [{ id: B, name: "Lamp B" }] });
  });

  it("a linked lamp's offline edit that wins spreads to the online partner at apply_at", () => {
    const rig = connected({ linked: true });
    rig.engine.disconnect(A);
    rig.advance(60_000);
    rig.rec.clear();
    const res = rig.engine.connect(A, { state: { ...RED, colors: ["#00FFFF"] }, dirty: { colors: { age_ms: 30_000 } } });
    expect(res.lampWon).toEqual(["colors"]);
    expect(res.desired!.colors).toEqual(["#00FFFF"]);
    expect(rig.rec.sentTo(A)).toHaveLength(0); // A gets welcome.desired instead
    const b = rig.rec.sentTo(B);
    expect(b).toHaveLength(1);
    expect(b[0]!.state.colors).toEqual(["#00FFFF"]);
    expect(b[0]!.apply_at).toBeDefined();
    expect(rig.rec.activities[0]).toMatchObject({ deviceId: A, extra: expect.objectContaining({ offline_edit: true }) });
  });

  it("an offline edit older than the group's last change loses", () => {
    // T: A goes offline. T+10 s: A edits locally. T+15 s: the web changes the group. T+20 s: A reconnects.
    const rig = connected({ linked: true });
    rig.engine.disconnect(A);
    rig.advance(15_000);
    rig.engine.command({ group: 1 }, { colors: ["#BADA55"] }, { origin: "web" });
    rig.advance(5_000);
    rig.rec.clear();
    // A's edit is 10 s old: lamp_ts = T+10 s, older than the web change at T+15 s.
    const res = rig.engine.connect(A, { state: { ...RED, colors: ["#00FFFF"] }, dirty: { colors: { age_ms: 10_000 } } });
    expect(res.lampWon).toEqual([]);
    expect(res.desired!.colors).toEqual(["#BADA55"]);
    expect(rig.rec.sentTo(B)).toHaveLength(0);
  });

  it("unknown age loses to the server", () => {
    const rig = connected({ linked: true });
    rig.engine.disconnect(A);
    rig.advance(60_000);
    const res = rig.engine.connect(A, { state: { ...RED, on: false }, dirty: { on: { age_ms: null } } });
    expect(res.lampWon).toEqual([]);
    expect(res.desired!.on).toBe(true);
  });

  it("a lamp joining a linked group whose state is unknown seeds it", () => {
    const rig = makeRig();
    rig.engine.setLinked(1, true); // nobody has state yet
    expect(rig.engine.getGroup(1)!.replica).toBeNull();
    const res = rig.engine.connect(B, { state: BLUE, dirty: {} });
    expect(res.adopted).toBe(true);
    expect(rig.engine.getGroup(1)!.replica!.state).toEqual(BLUE);
    expect(rig.engine.getDevice(A)!.replica!.state).toEqual(BLUE);
    // A then connects and gets the group's state.
    const resA = rig.engine.connect(A, { state: RED, dirty: {} });
    expect(resA.desired).toEqual(BLUE);
  });
});

describe("topology", () => {
  it("renaming a lamp tells its online peers", () => {
    const rig = connected();
    rig.engine.renameDevice(B, "Bedroom");
    expect(rig.rec.links.find((l) => l.deviceId === A)!.link!.peers).toEqual([{ id: B, name: "Bedroom" }]);
  });

  it("removing a lamp drops it from its group", () => {
    const rig = connected({ linked: true });
    rig.engine.removeDevice(B);
    expect(rig.engine.getGroup(1)!.members).toEqual([A]);
    const r = rig.engine.command({ group: 1 }, { on: false }, { origin: "web" });
    expect(r.ok).toBe(true);
    expect(rig.rec.sentTo(A).at(-1)!.apply_at).toBeUndefined();
  });
});
