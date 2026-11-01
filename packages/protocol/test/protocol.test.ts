import { describe, expect, it } from "vitest";
import {
  DEFAULT_STATE,
  applyPatch,
  decodeMessage,
  encodeMessage,
  lampToServer,
  serverToLamp,
  clientToServer,
  SyncClock,
} from "../src";

describe("applyPatch", () => {
  it("reports only fields that changed", () => {
    const r = applyPatch(DEFAULT_STATE, { brightness: 128, on: true });
    expect(r.changed).toEqual(["on"]);
    expect(r.state.on).toBe(true);
  });

  it("is idempotent", () => {
    const a = applyPatch(DEFAULT_STATE, { colors: ["#ff0000"] });
    const b = applyPatch(a.state, { colors: ["#FF0000"] });
    expect(b.changed).toEqual([]);
  });

  it("merges effect subfields and stamps epoch/seed on id change", () => {
    const r = applyPatch(DEFAULT_STATE, { effect: { id: "candle" } }, { now: 1234, newSeed: () => 99 });
    expect(r.state.effect).toMatchObject({ id: "candle", epoch: 1234, seed: 99, speed: 128 });
    const s = applyPatch(r.state, { effect: { speed: 10 } }, { now: 9999, newSeed: () => 1 });
    expect(s.state.effect).toMatchObject({ id: "candle", epoch: 1234, seed: 99, speed: 10 });
    expect(s.changed).toEqual(["effect"]);
  });
});

describe("messages", () => {
  it("round-trips a hello", () => {
    const text = encodeMessage("hello", {
      device_id: "dl-3fa2c1",
      proto: 1,
      fw: "1.0.0",
      hw: { chip: "esp32c3", pixels: 10, channels: 3 },
      state: DEFAULT_STATE,
      dirty: { colors: { age_ms: 300000 } },
      extra_field_from_future: true,
    });
    const r = decodeMessage(lampToServer, text);
    expect(r.ok).toBe(true);
    if (r.ok && r.msg.type === "hello") {
      expect(r.msg.data.dirty.colors?.age_ms).toBe(300000);
      expect(r.msg.data.rollback).toBe(false);
    }
  });

  it("rejects unknown types and bad data", () => {
    expect(decodeMessage(serverToLamp, '{"type":"nope","data":{}}')).toMatchObject({ ok: false, code: "unsupported" });
    expect(decodeMessage(clientToServer, '{"type":"cmd","data":{"target":{"device":"x"},"patch":{},"cid":"1"}}')).toMatchObject({
      ok: false,
      code: "invalid",
    });
    expect(decodeMessage(clientToServer, "not json")).toMatchObject({ ok: false, code: "invalid" });
  });

  it("normalizes colors to uppercase", () => {
    const r = decodeMessage(
      clientToServer,
      encodeMessage("cmd", { target: { group: 1 }, patch: { colors: ["#ff8a3d"] }, cid: "c1" }),
    );
    expect(r.ok && r.msg.type === "cmd" && r.msg.data.patch.colors).toEqual(["#FF8A3D"]);
  });
});

describe("SyncClock", () => {
  it("estimates the server offset from the lowest-delay sample", () => {
    let local = 1000;
    const clock = new SyncClock(() => local);
    // server is 5000 ms ahead; one-way 20 ms each way
    local = 1041;
    clock.addSample(1000, 6020, 6021, 1041); // offset = ((6020−1000) + (6021−1041)) / 2 = 5000
    expect(clock.now()).toBe(6041);
    local = 2000;
    expect(Math.abs(clock.now() - 7000)).toBeLessThan(2);
  });
});
