// 08 §1.5 key scenarios, against the real server with two virtual lamps over real WebSockets.
import { afterEach, describe, expect, it } from "vitest";
import type { AppliedState, VirtualLamp } from "@doublelamp/virtual-lamp";
import { setupPair, sleep, waitUntil, type TestServer } from "./harness";

let server: TestServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

type StateSet = { state: { colors: string[]; brightness: number; on: boolean; effect: { id: string; epoch: number } }; apply_at?: number; origin: string };

async function link(srv: TestServer, cookie: string, groupId: number, matchFrom?: string): Promise<void> {
  const r = await srv.api("PATCH", `/api/v1/groups/${groupId}`, { cookie, body: { linked: true, ...(matchFrom ? { match_from: matchFrom } : {}) } });
  expect(r.status).toBe(200);
  expect(r.body.linked).toBe(true);
}

/** Both lamps agree with the server's group replica (logical and visible state). */
async function converged(srv: TestServer, groupId: number, lamps: VirtualLamp[]): Promise<void> {
  await waitUntil(() => {
    const g = srv.ctx.engine.getGroup(groupId)?.replica?.state;
    return !!g && lamps.every((l) => JSON.stringify(l.state) === JSON.stringify(g) && JSON.stringify(l.visible) === JSON.stringify(g));
  }, "lamps to converge on the group state");
}

describe("08 §1.5 sync scenarios", () => {
  it("1. linked change: both lamps get the same apply_at and the same effect epoch, and apply together", async () => {
    const s = await setupPair({ a: { latencyMs: 40, jitterMs: 10 }, b: { latencyMs: 90, jitterMs: 10 } });
    server = s.server;
    await link(s.server, s.cookie, s.groupId);
    await converged(s.server, s.groupId, [s.A, s.B]);
    await sleep(700); // a few time.ping exchanges for the delay estimate
    const gotA = s.A.waitFor<StateSet>("state.set", (d) => d.state.effect.id === "rainbow");
    const gotB = s.B.waitFor<StateSet>("state.set", (d) => d.state.effect.id === "rainbow");
    const appliedA = s.A.waitFor<AppliedState>("applied", (a) => a.state.effect.id === "rainbow");
    const appliedB = s.B.waitFor<AppliedState>("applied", (a) => a.state.effect.id === "rainbow");
    const sentAt = Date.now();
    const r = await s.server.api("POST", `/api/v1/groups/${s.groupId}/state`, {
      cookie: s.cookie,
      body: { patch: { effect: { id: "rainbow" } }, transition_ms: 400 },
    });
    expect(r.status).toBe(200);
    expect(r.body.state.effect.id).toBe("rainbow");
    const [a, b] = await Promise.all([gotA, gotB]);
    expect(a.apply_at).toBeDefined();
    expect(a.apply_at).toBe(b.apply_at);
    expect(a.state.effect.epoch).toBe(a.apply_at);
    expect(b.state.effect.epoch).toBe(a.apply_at);
    expect(a.state).toEqual(b.state);
    // Lead time covers the slower lamp's delay (≈90 ms one way) plus the 40 ms margin, within [80, 500].
    const lead = a.apply_at! - sentAt;
    expect(lead).toBeGreaterThanOrEqual(80);
    expect(lead).toBeLessThanOrEqual(520);
    expect(lead).toBeGreaterThan(100);
    const [pa, pb] = await Promise.all([appliedA, appliedB]);
    expect(Math.abs(pa.appliedAt - pb.appliedAt)).toBeLessThan(60);
    expect(pa.appliedAt).toBeGreaterThanOrEqual(a.apply_at! - 25);
    expect(pb.appliedAt).toBeGreaterThanOrEqual(a.apply_at! - 25);
    // Browsers see the same apply_at on group.state and on device.state for both members.
    const gs = await s.browser.waitFor("group.state", (m) => m.data.state.effect.id === "rainbow");
    expect(gs.data.apply_at).toBe(a.apply_at);
    for (const id of [s.A.id, s.B.id]) {
      const ds = await s.browser.waitFor("device.state", (m) => m.data.id === id && m.data.state.effect.id === "rainbow");
      expect(ds.data.apply_at).toBe(a.apply_at);
    }
  });

  it("2. concurrent edits: a local brightness change and a web color change both survive on both lamps", async () => {
    const s = await setupPair({ a: { latencyMs: 20 }, b: { latencyMs: 30 } });
    server = s.server;
    await link(s.server, s.cookie, s.groupId);
    await converged(s.server, s.groupId, [s.A, s.B]);
    s.A.localChange({ brightness: 42 });
    const ack = await s.browser.cmd({ group: s.groupId }, { colors: ["#00FF00"] }, 400);
    expect(ack.type).toBe("ack");
    await converged(s.server, s.groupId, [s.A, s.B]);
    for (const l of [s.A, s.B]) {
      expect(l.state.brightness).toBe(42);
      expect(l.state.colors).toEqual(["#00FF00"]);
    }
    await waitUntil(() => {
      const d = s.browser.last("device.state", (m) => m.data.id === s.B.id)?.data.state;
      return d?.brightness === 42 && d?.colors[0] === "#00FF00";
    }, "the browser to see both changes");
  });

  it("3. race on one field: everyone ends on whichever change the server received last", async () => {
    const s = await setupPair({ a: { latencyMs: 15 }, b: { latencyMs: 15 } });
    server = s.server;
    await link(s.server, s.cookie, s.groupId);
    await converged(s.server, s.groupId, [s.A, s.B]);
    s.A.localChange({ colors: ["#FF0000"] });
    s.browser.send("cmd", { target: { group: s.groupId }, patch: { colors: ["#0000FF"] }, cid: "race" });
    await s.browser.waitFor("ack", (m) => m.ref === "race");
    await sleep(300);
    await converged(s.server, s.groupId, [s.A, s.B]);
    const final = s.server.ctx.engine.getGroup(s.groupId)!.replica!.state.colors;
    const states = s.server.ctx.activity.query({ limit: 10 }).filter((e) => e.kind === "state");
    const lastReceived = (states[0]!.data!.patch as { colors: string[] }).colors;
    expect(final).toEqual(lastReceived);
    expect([["#FF0000"], ["#0000FF"]]).toContainEqual(final);
    expect(s.A.state.colors).toEqual(final);
    expect(s.B.state.colors).toEqual(final);
    await waitUntil(() => JSON.stringify(s.browser.last("group.state")?.data.state.colors) === JSON.stringify(final), "browser on the final color");
  });

  it("4. offline edit wins: the edit spreads to lamp B when no newer server change exists", async () => {
    const s = await setupPair();
    server = s.server;
    await link(s.server, s.cookie, s.groupId);
    await converged(s.server, s.groupId, [s.A, s.B]);
    s.A.setOffline(true);
    await waitUntil(() => !s.server!.ctx.engine.isOnline(s.A.id), "the server to see A offline");
    await s.browser.waitFor("device.presence", (m) => m.data.id === s.A.id && m.data.online === false);
    s.A.localChange({ colors: ["#AA00FF"] });
    await sleep(250);
    const toB = s.B.waitFor<StateSet>("state.set", (d) => d.state.colors[0] === "#AA00FF");
    s.A.setOffline(false);
    const setB = await toB;
    expect(setB.apply_at).toBeDefined();
    await converged(s.server, s.groupId, [s.A, s.B]);
    expect(s.A.state.colors).toEqual(["#AA00FF"]);
    expect(s.B.state.colors).toEqual(["#AA00FF"]);
    const ev = s.server.ctx.activity.query({ deviceId: s.A.id }).find((e) => e.kind === "state" && e.data?.offline_edit);
    expect(ev?.data?.patch).toEqual({ colors: ["#AA00FF"] });
  });

  it("5. offline edit loses: the web changed the group after A's edit, so A gets the server's value", async () => {
    const s = await setupPair();
    server = s.server;
    await link(s.server, s.cookie, s.groupId);
    await converged(s.server, s.groupId, [s.A, s.B]);
    s.A.setOffline(true);
    await waitUntil(() => !s.server!.ctx.engine.isOnline(s.A.id), "A offline");
    s.A.localChange({ colors: ["#AA00FF"] });
    await sleep(100);
    // The group replica still updates with A offline (B online).
    const toB = s.B.waitFor<StateSet>("state.set", (d) => d.state.colors[0] === "#00AAFF");
    const ack = await s.browser.cmd({ group: s.groupId }, { colors: ["#00AAFF"] });
    expect(ack.type).toBe("ack");
    await toB;
    let bGotLampValue = false;
    s.B.on("state.set", (d: StateSet) => {
      if (d.state.colors[0] === "#AA00FF") bGotLampValue = true;
    });
    s.A.setOffline(false);
    await s.A.waitFor("welcome");
    expect(s.A.state.colors).toEqual(["#00AAFF"]);
    await sleep(200);
    expect(bGotLampValue).toBe(false);
    await converged(s.server, s.groupId, [s.A, s.B]);
  });

  it("6. unknown age: after a reboot while offline the restored state has no age, so the server wins", async () => {
    const s = await setupPair();
    server = s.server;
    await link(s.server, s.cookie, s.groupId);
    await converged(s.server, s.groupId, [s.A, s.B]);
    const group = s.server.ctx.engine.getGroup(s.groupId)!.replica!.state;
    const before = { colors: [...group.colors], on: group.on };
    s.A.setOffline(true);
    await waitUntil(() => !s.server!.ctx.engine.isOnline(s.A.id), "A offline");
    s.A.localChange({ colors: ["#AA00FF"], on: !before.on });
    s.A.reboot("power_on");
    await sleep(300);
    const welcome = s.A.waitFor<{ desired: { colors: string[]; on: boolean } | null }>("welcome");
    s.A.setOffline(false);
    const w = await welcome;
    expect(w.desired!.colors).toEqual(before.colors);
    expect(s.A.state.colors).toEqual(before.colors);
    expect(s.A.state.on).toBe(before.on);
    expect(s.B.state.colors).toEqual(before.colors);
    expect(s.B.state.on).toBe(before.on);
  });

  it("7. link direction: matching B to A makes B blend to A's look at the shared apply_at", async () => {
    const s = await setupPair();
    server = s.server;
    s.A.localChange({ colors: ["#FF2200"], brightness: 200 });
    await sleep(30);
    s.B.localChange({ colors: ["#0022FF"], brightness: 60 }); // B changed most recently
    await waitUntil(() => s.server!.ctx.engine.getDevice(s.B.id)!.replica!.state.brightness === 60, "B's report");
    await sleep(500);
    const toA = s.A.waitFor<StateSet>("state.set", (d) => d.origin === "link");
    const toB = s.B.waitFor<StateSet>("state.set", (d) => d.origin === "link");
    const appliedB = s.B.waitFor<AppliedState>("applied", (a) => a.origin === "link");
    await link(s.server, s.cookie, s.groupId, s.A.id);
    const [a, b] = await Promise.all([toA, toB]);
    expect(b.state.colors).toEqual(["#FF2200"]);
    expect(b.state.brightness).toBe(200);
    expect(a.state).toEqual(b.state);
    expect(a.apply_at).toBeDefined();
    expect(a.apply_at).toBe(b.apply_at);
    const ab = await appliedB;
    expect(ab.appliedAt).toBeGreaterThanOrEqual(b.apply_at! - 25);
    await converged(s.server, s.groupId, [s.A, s.B]);
    // Without match_from, the most recently changed lamp would have won: check the rule once more by relinking.
    await s.server.api("PATCH", `/api/v1/groups/${s.groupId}`, { cookie: s.cookie, body: { linked: false } });
    s.B.localChange({ colors: ["#0022FF"] });
    await waitUntil(() => s.server!.ctx.engine.getDevice(s.B.id)!.replica!.state.colors[0] === "#0022FF", "B's report");
    await link(s.server, s.cookie, s.groupId);
    await converged(s.server, s.groupId, [s.A, s.B]);
    expect(s.A.state.colors).toEqual(["#0022FF"]);
  });

  it("8. a command to an offline lamp fails with offline and nothing is queued", async () => {
    const s = await setupPair();
    server = s.server;
    const before = s.B.state.colors;
    s.B.setOffline(true);
    await waitUntil(() => !s.server!.ctx.engine.isOnline(s.B.id), "B offline");
    const rest = await s.server.api("POST", `/api/v1/devices/${s.B.id}/state`, { cookie: s.cookie, body: { patch: { colors: ["#123456"] } } });
    expect(rest.status).toBe(409);
    expect(rest.body.error.code).toBe("offline");
    const ws = await s.browser.cmd({ device: s.B.id }, { colors: ["#654321"] });
    expect(ws.type).toBe("error");
    expect(ws.data.code).toBe("offline");
    s.B.setOffline(false);
    await s.B.waitFor("welcome");
    await sleep(150);
    expect(s.B.state.colors).toEqual(before);
    expect(s.server.ctx.engine.getDevice(s.B.id)!.replica!.state.colors).toEqual(before);
  });

  it("11. Apple Home change while linked: the partner follows at a shared apply_at, logged as homekit", async () => {
    const s = await setupPair({ a: { reportOrigin: "homekit" } });
    server = s.server;
    await link(s.server, s.cookie, s.groupId);
    await converged(s.server, s.groupId, [s.A, s.B]);
    const toB = s.B.waitFor<StateSet>("state.set", (d) => d.state.colors[0] === "#FF00FF");
    const echoA = s.A.waitFor<StateSet>("state.set", (d) => d.state.colors[0] === "#FF00FF");
    s.A.localChange({ colors: ["#FF00FF"] });
    const [b, a] = await Promise.all([toB, echoA]);
    expect(b.origin).toBe("homekit");
    expect(b.apply_at).toBeDefined();
    expect(a.apply_at).toBe(b.apply_at); // the echo to the reporting lamp
    const events = await s.server.api("GET", `/api/v1/events?device_id=${s.A.id}&limit=20`, { cookie: s.cookie });
    expect(events.status).toBe(200);
    const ev = (events.body.events as { kind: string; data: { origin?: string; patch?: unknown } }[]).find((e) => e.kind === "state");
    expect(ev?.data.origin).toBe("homekit");
    expect(ev?.data.patch).toEqual({ colors: ["#FF00FF"] });
  });

  it("unlinked lamps take commands separately; linked ones share the group state", async () => {
    const s = await setupPair();
    server = s.server;
    const r = await s.server.api("POST", `/api/v1/devices/${s.A.id}/state`, { cookie: s.cookie, body: { patch: { on: true, brightness: 10 } } });
    expect(r.status).toBe(200);
    await waitUntil(() => s.A.state.brightness === 10, "A updated");
    expect(s.B.state.brightness).not.toBe(10);
    await link(s.server, s.cookie, s.groupId);
    await converged(s.server, s.groupId, [s.A, s.B]);
    const viaDevice = await s.server.api("POST", `/api/v1/devices/${s.B.id}/state`, { cookie: s.cookie, body: { patch: { brightness: 77 } } });
    expect(viaDevice.status).toBe(200);
    await converged(s.server, s.groupId, [s.A, s.B]);
    expect(s.A.state.brightness).toBe(77);
    const unlink = await s.server.api("PATCH", `/api/v1/groups/${s.groupId}`, { cookie: s.cookie, body: { linked: false } });
    expect(unlink.body.linked).toBe(false);
    await waitUntil(() => s.A.link?.linked === false && s.B.link?.linked === false, "lamps told about the unlink");
  });
});
