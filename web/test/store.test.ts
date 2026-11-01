// The live store end to end without a socket: frames go through decodeMessage(serverToClient, …) and
// commands through the transport, as the WebSocket would do it.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { encodeMessage } from "@doublelamp/protocol";
import { sendCommand, setTransport } from "../src/live/commands";
import { handleServerText } from "../src/live/dispatch";
import { initialState, useApp } from "../src/live/store";
import { clock, localNow } from "../src/lib/clock";
import { A, B, snapshotData, state } from "./fixtures";

interface Sent {
  type: string;
  data: { target: unknown; patch: Record<string, unknown>; transition_ms: number; cid: string };
}

let sent: Sent[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  useApp.setState(initialState(), true);
  sent = [];
  setTransport({
    send: (type, data) => {
      sent.push({ type, data: data as Sent["data"] });
      return true;
    },
  });
});

const frame = (type: string, data: unknown, ref?: string) => handleServerText(encodeMessage(type, data, { ref }));

describe("live store", () => {
  it("sends nothing before a snapshot: controls are off and nothing is queued", () => {
    expect(sendCommand({ device: A }, { on: false })).toBeNull();
    expect(sent).toEqual([]);
  });

  it("a snapshot makes the store live", () => {
    frame("snapshot", snapshotData());
    const s = useApp.getState();
    expect(s.live).toBe(true);
    expect(s.view.devices[B]).toEqual(state());
  });

  it("sends cmd with a cid, shows the change at once, and settles on the server's echo and ack", () => {
    frame("snapshot", snapshotData());
    const cid = sendCommand({ device: A }, { brightness: 51 }, 120);
    expect(cid).toMatch(/^c[0-9a-z]+$/);
    expect(sent).toEqual([{ type: "cmd", data: { target: { device: A }, patch: { brightness: 51 }, transition_ms: 120, cid } }]);
    expect(useApp.getState().view.devices[A]?.brightness).toBe(51);

    frame("device.state", { id: A, state: state({ brightness: 51 }), origin: "web", by: "Kitchen iPad" });
    frame("ack", {}, cid!);
    const s = useApp.getState();
    expect(s.pending).toEqual([]);
    expect(s.view.devices[A]?.brightness).toBe(51);
    expect(s.meta[`d:${A}`]?.by).toBe("Kitchen iPad");
  });

  it("an error for the cid rolls the change back and explains it", () => {
    frame("snapshot", snapshotData());
    const cid = sendCommand({ device: B }, { on: false });
    expect(useApp.getState().view.devices[B]?.on).toBe(false);
    frame("error", { code: "offline", message: "device offline" }, cid!);
    const s = useApp.getState();
    expect(s.view.devices[B]?.on).toBe(true);
    expect(s.toasts.map((t) => t.text)).toEqual(["Lamp B is offline"]);
  });

  it("an effect switch draws locally at once with a local epoch; the server's epoch replaces it", () => {
    frame("snapshot", snapshotData());
    const cid = sendCommand({ device: A }, { effect: { id: "candle", speed: 128, intensity: 140, duration_ms: 0 } });
    expect(sent[0]?.data.patch).toEqual({ effect: { id: "candle", speed: 128, intensity: 140, duration_ms: 0 } });
    const local = useApp.getState().view.devices[A]!;
    expect(local.effect.id).toBe("candle");
    expect(local.effect.epoch).not.toBe(1000);
    frame("device.state", { id: A, state: state({ effect: { id: "candle", speed: 128, intensity: 140, seed: 42, epoch: 9999, duration_ms: 0 } }), origin: "web" });
    frame("ack", {}, cid!);
    expect(useApp.getState().view.devices[A]?.effect).toMatchObject({ id: "candle", seed: 42, epoch: 9999 });
  });

  it("drops invalid frames and ignores unknown message types", () => {
    frame("snapshot", snapshotData());
    const before = useApp.getState();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(frame("device.state", { id: A, state: { on: "yes" } })).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
    expect(frame("brand.new.thing", { x: 1 })).toBeNull();
    expect(handleServerText("not json")).toBeNull();
    expect(useApp.getState().view).toBe(before.view);
    warn.mockRestore();
  });

  it("time.pong feeds the sync clock", () => {
    const t0 = localNow() - 20;
    frame("time.pong", { t0, t1: t0 + 10 + 60_000, t2: t0 + 10 + 60_000 });
    expect(clock.isSynced).toBe(true);
    expect(Math.abs(clock.now() - (localNow() + 60_000))).toBeLessThan(50);
  });
});
