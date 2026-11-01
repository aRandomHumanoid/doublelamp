// Pairing, device hub behaviour, REST resources, static serving, persistence across restarts.
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { CloseCode, PROTO_VERSION, DEFAULT_STATE, encodeMessage } from "@doublelamp/protocol";
import { VirtualLamp } from "@doublelamp/virtual-lamp";
import { FAST_LAMP, TestServer, setupPair, sleep, upgradeStatus, waitUntil, type Json } from "./harness";

let server: TestServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

function claimBody(code: string, id = "dl-0000c1") {
  return { code, device_id: id, name: "Raw lamp", fw: "1.0.0", hw: { chip: "esp32c3", pixels: 10, channels: 3 } };
}

/** A raw device socket for protocol-level checks. */
function rawDevice(srv: TestServer, token: string): Promise<{ ws: WebSocket; messages: Json[]; closed: Promise<number> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${srv.url.replace("http", "ws")}/ws/device`, { headers: { authorization: `Bearer ${token}` } });
    const messages: Json[] = [];
    const closed = new Promise<number>((r) => ws.on("close", (code) => r(code)));
    ws.on("message", (d) => messages.push(JSON.parse(d.toString())));
    ws.once("open", () => resolve({ ws, messages, closed }));
    ws.once("error", reject);
  });
}

function hello(id: string, extra: Record<string, unknown> = {}) {
  return encodeMessage("hello", { device_id: id, proto: PROTO_VERSION, fw: "1.0.0", hw: { pixels: 10, channels: 3 }, state: DEFAULT_STATE, dirty: {}, ...extra });
}

describe("pairing", () => {
  it("claims with a code once, returns a 43-char token and the ws_url; re-claiming invalidates the old token", async () => {
    server = await TestServer.start();
    const cookie = await server.login();
    const code = await server.pairingCode(cookie);
    const r = await server.api("POST", "/api/v1/devices/claim", { body: claimBody(code.toLowerCase()), origin: null });
    expect(r.status).toBe(200);
    expect(r.body.device_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(r.body.ws_url).toBe(`${server.url.replace("http", "ws")}/ws/device`);
    const reuse = await server.api("POST", "/api/v1/devices/claim", { body: claimBody(code), origin: null });
    expect(reuse.status).toBe(400);
    expect(reuse.body.error.code).toBe("invalid_code");
    // The lamp appears in the default group, offline until it connects.
    const devices = await server.api("GET", "/api/v1/devices", { cookie });
    expect(devices.body.devices).toEqual([expect.objectContaining({ id: "dl-0000c1", name: "Raw lamp", online: false, state: null, group_id: expect.any(Number) })]);
    const groups = await server.api("GET", "/api/v1/groups", { cookie });
    expect(groups.body.groups).toEqual([expect.objectContaining({ linked: false, members: ["dl-0000c1"] })]);
    const ws = `${server.url.replace("http", "ws")}/ws/device`;
    expect(await upgradeStatus(ws, { authorization: `Bearer ${r.body.device_token}` })).toBe(101);
    const again = await server.api("POST", "/api/v1/devices/claim", { body: claimBody(await server.pairingCode(cookie)), origin: null });
    expect(again.status).toBe(200);
    expect(await upgradeStatus(ws, { authorization: `Bearer ${r.body.device_token}` })).toBe(401);
    expect(await upgradeStatus(ws, { authorization: `Bearer ${again.body.device_token}` })).toBe(101);
    expect(await upgradeStatus(ws, {})).toBe(401);
    // Still one lamp, still one group.
    expect((await server.api("GET", "/api/v1/devices", { cookie })).body.devices).toHaveLength(1);
  });

  it("rejects bad and expired codes and rate-limits claims per IP", async () => {
    server = await TestServer.start();
    const bad = await server.api("POST", "/api/v1/devices/claim", { body: claimBody("ZZZZ-ZZZZ"), origin: null });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("invalid_code");
    const invalid = await server.api("POST", "/api/v1/devices/claim", { body: { code: "x" }, origin: null });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe("invalid");
    for (let i = 0; i < 3; i++) await server.api("POST", "/api/v1/devices/claim", { body: claimBody("ZZZZ-ZZZZ"), origin: null });
    const limited = await server.api("POST", "/api/v1/devices/claim", { body: claimBody("ZZZZ-ZZZZ"), origin: null });
    expect(limited.status).toBe(429);
  });

  it("410 code_expired after 10 minutes", async () => {
    let now = Date.now();
    server = await TestServer.start({ overrides: { clock: () => now } });
    const cookie = await server.login();
    const code = await server.pairingCode(cookie);
    now += 10 * 60_000 + 1;
    const r = await server.api("POST", "/api/v1/devices/claim", { body: claimBody(code), origin: null });
    expect(r.status).toBe(410);
    expect(r.body.error.code).toBe("code_expired");
  });
});

describe("device hub", () => {
  async function claimed(): Promise<{ srv: TestServer; cookie: string; token: string }> {
    const srv = await TestServer.start({ overrides: { deviceTimings: { helloTimeoutMs: 300, silenceTimeoutMs: 600, sweepIntervalMs: 100 } } });
    const cookie = await srv.login();
    const r = await srv.api("POST", "/api/v1/devices/claim", { body: claimBody(await srv.pairingCode(cookie)), origin: null });
    return { srv, cookie, token: r.body.device_token };
  }

  it("hello → welcome (desired null on first connect) → presets.sync; time.ping → time.pong", async () => {
    const { srv, token } = await claimed();
    server = srv;
    const d = await rawDevice(srv, token);
    d.ws.send(hello("dl-0000c1", { effects: ["solid", "breathe"] }));
    await waitUntil(() => d.messages.some((m) => m.type === "presets.sync"), "presets.sync");
    expect(d.messages[0].type).toBe("welcome");
    expect(d.messages[0].data).toMatchObject({ desired: null, heartbeat_s: 20, link: { linked: false, peers: [] } });
    const t0 = Date.now();
    d.ws.send(encodeMessage("time.ping", { t0 }));
    await waitUntil(() => d.messages.some((m) => m.type === "time.pong"), "time.pong");
    const pong = d.messages.find((m) => m.type === "time.pong").data;
    expect(pong.t0).toBe(t0);
    expect(pong.t2).toBeGreaterThanOrEqual(pong.t1);
    // Malformed messages after hello get an error, not a disconnect.
    d.ws.send("{nope");
    await waitUntil(() => d.messages.some((m) => m.type === "error"), "error reply");
    // A state.report is applied and echoed back to the lamp that sent it.
    d.ws.send(encodeMessage("state.report", { rev: 1, patch: { brightness: 5 }, origin: "local" }));
    await waitUntil(() => srv.ctx.engine.getDevice("dl-0000c1")!.replica!.state.brightness === 5, "report applied");
    expect(d.messages.some((m) => m.type === "state.set" && m.data.state.brightness === 5)).toBe(true); // echo
    d.ws.close();
  });

  it("closes with 4008 if hello doesn't come within 10 s (shortened here) or the first message isn't hello", async () => {
    const { srv, token } = await claimed();
    server = srv;
    const silent = await rawDevice(srv, token);
    expect(await silent.closed).toBe(CloseCode.ProtocolViolation);
    const wrong = await rawDevice(srv, token);
    wrong.ws.send(encodeMessage("time.ping", { t0: 1 }));
    expect(await wrong.closed).toBe(CloseCode.ProtocolViolation);
  });

  it("closes with 4004 for an unsupported proto and 4001 when the hello names another device", async () => {
    const { srv, token } = await claimed();
    server = srv;
    const old = await rawDevice(srv, token);
    old.ws.send(hello("dl-0000c1", { proto: PROTO_VERSION + 5 }));
    expect(await old.closed).toBe(CloseCode.ProtoUnsupported);
    const other = await rawDevice(srv, token);
    other.ws.send(hello("dl-0000c2"));
    expect(await other.closed).toBe(CloseCode.BadToken);
  });

  it("one connection per device: a new one replaces the old one with 4002", async () => {
    const { srv, token } = await claimed();
    server = srv;
    const first = await rawDevice(srv, token);
    first.ws.send(hello("dl-0000c1"));
    await waitUntil(() => first.messages.some((m) => m.type === "welcome"), "welcome");
    const second = await rawDevice(srv, token);
    expect(await first.closed).toBe(CloseCode.Replaced);
    second.ws.send(hello("dl-0000c1"));
    await waitUntil(() => second.messages.some((m) => m.type === "welcome"), "welcome 2");
    expect(srv.ctx.engine.isOnline("dl-0000c1")).toBe(true);
    second.ws.close();
  });

  it("closes a silent connection after the silence timeout and marks the lamp offline", async () => {
    const { srv, token, cookie } = await claimed();
    server = srv;
    const browser = await srv.browser(cookie);
    const d = await rawDevice(srv, token);
    d.ws.send(hello("dl-0000c1"));
    await browser.waitFor("device.presence", (m) => m.data.online === true);
    expect(await d.closed).toBe(CloseCode.ProtocolViolation);
    await browser.waitFor("device.presence", (m) => m.data.online === false);
    expect(srv.ctx.engine.isOnline("dl-0000c1")).toBe(false);
  });
});

describe("REST resources", () => {
  it("snapshot, rename (name.set), LED config (config.set), identify, nudge, telemetry", async () => {
    const s = await setupPair();
    server = s.server;
    const snap = s.browser.messages.find((m) => m.type === "snapshot")!.data;
    expect(snap.devices).toEqual([]); // the browser connected before the lamps were paired
    const named = s.A.waitFor<string>("name");
    const r = await s.server.api("PATCH", `/api/v1/devices/${s.A.id}`, { cookie: s.cookie, body: { name: "Living room" } });
    expect(r.status).toBe(200);
    expect(r.body.name).toBe("Living room");
    expect(await named).toBe("Living room");
    await waitUntil(() => s.B.link?.peers[0]?.name === "Living room", "B told about its peer's new name");
    const cfg = s.A.waitFor("message", (t) => t === "config.set");
    const c = await s.server.api("PATCH", `/api/v1/devices/${s.A.id}`, { cookie: s.cookie, body: { config: { max_current_ma: 900 } } });
    expect(c.status).toBe(200);
    expect(c.body.config.max_current_ma).toBe(900);
    await cfg;
    await waitUntil(() => s.A.config.max_current_ma === 900, "lamp config");
    const ident = s.A.waitFor("identify");
    expect((await s.server.api("POST", `/api/v1/devices/${s.A.id}/identify`, { cookie: s.cookie, body: { duration_ms: 1500 } })).status).toBe(204);
    expect(await ident).toEqual({ duration_ms: 1500 });
    const nudge = s.B.waitFor("nudge");
    expect((await s.server.api("POST", `/api/v1/devices/${s.B.id}/nudge`, { cookie: s.cookie })).status).toBe(204);
    expect(await nudge).toMatchObject({ from_name: "Test browser", count: 3 });
    // Telemetry arrives shortly after welcome (FAST_LAMP), and shows up in the DeviceView.
    await waitUntil(async () => (await s.server!.api("GET", `/api/v1/devices/${s.A.id}`, { cookie: s.cookie })).body.telemetry !== null, "telemetry");
    await s.browser.waitFor("device.telemetry", (m) => m.data.id === s.A.id);
    // An offline lamp can be renamed (sent after its next welcome) but not reconfigured.
    s.B.setOffline(true);
    await waitUntil(() => !s.server!.ctx.engine.isOnline(s.B.id), "B offline");
    expect((await s.server.api("PATCH", `/api/v1/devices/${s.B.id}`, { cookie: s.cookie, body: { config: { fps: 60 } } })).body.error.code).toBe("offline");
    expect((await s.server.api("POST", `/api/v1/devices/${s.B.id}/identify`, { cookie: s.cookie })).status).toBe(409);
    expect((await s.server.api("PATCH", `/api/v1/devices/${s.B.id}`, { cookie: s.cookie, body: { name: "Bedroom" } })).status).toBe(200);
    const bNamed = s.B.waitFor<string>("name");
    s.B.setOffline(false);
    expect(await bNamed).toBe("Bedroom");
    expect((await s.server.api("GET", "/api/v1/devices/dl-ffffff", { cookie: s.cookie })).status).toBe(404);
  });

  it("unclaim: the lamp gets unclaim + close 4003 and erases its credentials; browsers get device.removed", async () => {
    const s = await setupPair();
    server = s.server;
    const r = await s.server.api("DELETE", `/api/v1/devices/${s.B.id}`, { cookie: s.cookie });
    expect(r.status).toBe(204);
    await waitUntil(() => s.B.status === "unclaimed", "B unclaimed");
    expect(s.B.hasCredentials()).toBe(false);
    await s.browser.waitFor("device.removed", (m) => m.data.id === s.B.id);
    const devices = await s.server.api("GET", "/api/v1/devices", { cookie: s.cookie });
    expect(devices.body.devices.map((d: Json) => d.id)).toEqual([s.A.id]);
    const groups = await s.server.api("GET", "/api/v1/groups", { cookie: s.cookie });
    expect(groups.body.groups[0].members).toEqual([s.A.id]);
    expect((await s.server.api("DELETE", `/api/v1/devices/${s.B.id}`, { cookie: s.cookie })).status).toBe(404);
  });

  it("scenes: save from a lamp, presets.sync to every lamp, apply, reorder, delete", async () => {
    const s = await setupPair();
    server = s.server;
    await s.server.api("POST", `/api/v1/devices/${s.A.id}/state`, { cookie: s.cookie, body: { patch: { on: true, colors: ["#FF8A3D"], effect: { id: "candle" } } } });
    await waitUntil(() => s.A.state.effect.id === "candle", "A on candle");
    const presetsB = s.B.waitFor<Json[]>("presets", (p) => p.length === 1);
    const cozy = await s.server.api("POST", "/api/v1/scenes", { cookie: s.cookie, body: { name: "Cozy", from: { device: s.A.id } } });
    expect(cozy.status).toBe(201);
    expect(cozy.body).toMatchObject({ name: "Cozy", sort: 0, state: { effect: { id: "candle", epoch: 0 } } });
    const p = await presetsB;
    expect(p[0]).toMatchObject({ slot: 0, name: "Cozy" });
    const read = await s.server.api("POST", "/api/v1/scenes", {
      cookie: s.cookie,
      body: { name: "Read", state: { ...DEFAULT_STATE, on: true, brightness: 255, colors: ["#ffffff"] } },
    });
    expect(read.body.state.colors).toEqual(["#FFFFFF"]);
    await s.browser.waitFor("scene.updated", (m) => m.data.scenes.length === 2);
    const applied = await s.server.api("POST", `/api/v1/scenes/${cozy.body.id}/apply`, { cookie: s.cookie, body: { target: { device: s.B.id } } });
    expect(applied.status).toBe(200);
    expect(applied.body.state.effect.id).toBe("candle");
    await waitUntil(() => s.B.state.effect.id === "candle", "B on candle");
    const reordered = await s.server.api("POST", "/api/v1/scenes/reorder", { cookie: s.cookie, body: { ids: [read.body.id, cozy.body.id] } });
    expect(reordered.body.scenes.map((x: Json) => x.name)).toEqual(["Read", "Cozy"]);
    await waitUntil(() => s.A.presets[0]?.name === "Read", "presets reordered on the lamp");
    const upd = await s.server.api("PUT", `/api/v1/scenes/${read.body.id}`, { cookie: s.cookie, body: { name: "Reading" } });
    expect(upd.body.name).toBe("Reading");
    expect((await s.server.api("DELETE", `/api/v1/scenes/${cozy.body.id}`, { cookie: s.cookie })).status).toBe(204);
    expect((await s.server.api("GET", "/api/v1/scenes", { cookie: s.cookie })).body.scenes).toHaveLength(1);
    expect((await s.server.api("POST", "/api/v1/scenes/reorder", { cookie: s.cookie, body: { ids: [999] } })).status).toBe(400);
    expect((await s.server.api("POST", "/api/v1/scenes/999/apply", { cookie: s.cookie, body: { target: { device: s.A.id } } })).status).toBe(404);
  });

  it("schedules: CRUD with next-run times, validation errors name the field", async () => {
    const s = await setupPair();
    server = s.server;
    const body = { name: "Wake up", target: { group: s.groupId }, when: { type: "daily", time: "07:00", days: ["mon", "fri"], tz: "Europe/Berlin" }, action: { type: "sunrise", duration_min: 20 } };
    const r = await s.server.api("POST", "/api/v1/schedules", { cookie: s.cookie, body });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ name: "Wake up", enabled: true, last_run_at: null });
    expect(r.body.next_run_at).toBeGreaterThan(Date.now());
    const bad = await s.server.api("POST", "/api/v1/schedules", { cookie: s.cookie, body: { ...body, when: { ...body.when, tz: "Mars/Base" } } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.field).toBe("when");
    const off = await s.server.api("PUT", `/api/v1/schedules/${r.body.id}`, { cookie: s.cookie, body: { enabled: false } });
    expect(off.body).toMatchObject({ enabled: false, next_run_at: null, name: "Wake up" });
    expect((await s.server.api("GET", "/api/v1/schedules", { cookie: s.cookie })).body.schedules).toHaveLength(1);
    expect((await s.server.api("DELETE", `/api/v1/schedules/${r.body.id}`, { cookie: s.cookie })).status).toBe(204);
    expect((await s.server.api("PUT", `/api/v1/schedules/${r.body.id}`, { cookie: s.cookie, body: { enabled: true } })).status).toBe(404);
  });

  it("validation errors use {error:{code,message,field}}", async () => {
    const s = await setupPair();
    server = s.server;
    const r = await s.server.api("POST", `/api/v1/devices/${s.A.id}/state`, { cookie: s.cookie, body: { patch: { brightness: 999 } } });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatchObject({ code: "invalid", field: "patch.brightness" });
    const m = await s.server.api("PATCH", `/api/v1/groups/${s.groupId}`, { cookie: s.cookie, body: { linked: true, match_from: "dl-ffffff" } });
    expect(m.status).toBe(400);
    expect(m.body.error.field).toBe("match_from");
    const json = await fetch(`${s.server.url}/api/v1/devices/${s.A.id}/state`, {
      method: "POST",
      headers: { cookie: s.cookie, origin: s.server.url, "content-type": "application/json" },
      body: "{not json",
    });
    expect(json.status).toBe(400);
    expect(((await json.json()) as Json).error.code).toBe("invalid");
    expect((await s.server.api("POST", `/api/v1/devices/${s.A.id}/state`, { cookie: s.cookie, body: { patch: { effect: { id: "nope" } } } })).body.error.code).toBe(
      "unknown_effect",
    );
  });

  it("activity log pages newest first", async () => {
    const s = await setupPair();
    server = s.server;
    const all = await s.server.api("GET", "/api/v1/events?limit=500", { cookie: s.cookie });
    const events = all.body.events as Json[];
    expect(events.length).toBeGreaterThan(3);
    expect(events.map((e) => e.kind)).toEqual(expect.arrayContaining(["login", "claim", "connect"]));
    for (let i = 1; i < events.length; i++) expect(events[i].ts).toBeLessThanOrEqual(events[i - 1].ts);
    const page = await s.server.api("GET", `/api/v1/events?limit=2&before=${events[1].id}`, { cookie: s.cookie });
    expect(page.body.events[0].id).toBe(events[2].id);
    const byDevice = await s.server.api("GET", `/api/v1/events?device_id=${s.B.id}`, { cookie: s.cookie });
    expect(byDevice.body.events.every((e: Json) => e.device_id === s.B.id)).toBe(true);
  });
});

describe("static web app and headers", () => {
  it("serves a build hint at / and SPA paths, JSON 404s for API paths, and security headers", async () => {
    server = await TestServer.start();
    const root = await fetch(`${server.url}/`);
    expect(root.status).toBe(200);
    expect(await root.text()).toContain("npm run build -w web");
    expect(root.headers.get("content-security-policy")).toBe(
      "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'",
    );
    expect(root.headers.get("x-content-type-options")).toBe("nosniff");
    expect(root.headers.get("referrer-policy")).toBeTruthy();
    expect(root.headers.get("strict-transport-security")).toBeNull(); // http PUBLIC_URL
    expect((await fetch(`${server.url}/lamps/dl-00000a/settings`)).status).toBe(200);
    const api404 = await fetch(`${server.url}/api/v1/does-not-exist`);
    expect(api404.status).toBe(404);
    expect(((await api404.json()) as Json).error.code).toBe("not_found");
    expect((await fetch(`${server.url}/healthz`)).status).toBe(200);
    expect(await (await fetch(`${server.url}/healthz`)).json()).toEqual({ ok: true });
  });

  it("serves a built web app with an SPA fallback and long-cached hashed assets", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const dist = mkdtempSync(path.join(os.tmpdir(), "dl-dist-"));
    try {
      writeFileSync(path.join(dist, "index.html"), "<!doctype html><title>DoubleLamp</title><div id=root></div>");
      mkdirSync(path.join(dist, "assets"));
      writeFileSync(path.join(dist, "assets", "app-abc123.js"), "console.log('hi')");
      server = await TestServer.start({ env: { WEB_DIST: dist } });
      const root = await fetch(`${server.url}/`);
      expect(await root.text()).toContain("<title>DoubleLamp</title>");
      expect(root.headers.get("cache-control")).toBe("no-cache");
      const deep = await fetch(`${server.url}/settings/firmware`);
      expect(deep.status).toBe(200);
      expect(await deep.text()).toContain("<div id=root>");
      const asset = await fetch(`${server.url}/assets/app-abc123.js`);
      expect(asset.status).toBe(200);
      expect(asset.headers.get("cache-control")).toContain("immutable");
      expect(asset.headers.get("content-security-policy")).toContain("default-src 'self'");
      expect((await fetch(`${server.url}/assets/missing.js`)).status).toBe(404); // files don't fall back
      expect((await fetch(`${server.url}/lamps/dl-00000a`)).status).toBe(200); // app routes do
      const api = await fetch(`${server.url}/api/v1/nope`);
      expect(api.status).toBe(404);
      expect(((await api.json()) as Json).error.code).toBe("not_found");
      expect((await fetch(`${server.url}/fw/nope.bin`)).status).toBe(404);
    } finally {
      await server?.close();
      server = null;
      rmSync(dist, { recursive: true, force: true });
    }
  });

  it("sends HSTS when PUBLIC_URL is https, and derives wss:// for lamps", async () => {
    server = await TestServer.start({ env: { PUBLIC_URL: "https://lamps.example.com" } });
    const r = await fetch(`http://127.0.0.1:${server.ctx.config.port}/healthz`);
    expect(r.headers.get("strict-transport-security")).toMatch(/max-age=\d+/);
    expect(server.ctx.config.deviceWsUrl).toBe("wss://lamps.example.com/ws/device");
  });
});

describe("persistence", () => {
  it("state survives a restart; lamps reconnect; a run missed by < 5 min fires at startup", async () => {
    const s = await setupPair();
    server = s.server;
    await s.server.api("PATCH", `/api/v1/groups/${s.groupId}`, { cookie: s.cookie, body: { linked: true } });
    await s.server.api("POST", `/api/v1/groups/${s.groupId}/state`, { cookie: s.cookie, body: { patch: { on: true, colors: ["#336699"] } } });
    await waitUntil(() => s.A.state.colors[0] === "#336699" && s.B.state.colors[0] === "#336699", "group color");
    const sched = await s.server.api("POST", "/api/v1/schedules", {
      cookie: s.cookie,
      body: { name: "Off", target: { group: s.groupId }, when: { type: "cron", expr: "0 3 * * *", tz: "UTC" }, action: { type: "power", on: false } },
    });
    await sleep(1200); // let the replica writes (≤ 1/s) land
    // Pretend the server was down when the schedule was due two minutes ago.
    s.server.ctx.db.prepare("UPDATE schedules SET next_run_at = ? WHERE id = ?").run(Date.now() - 120_000, sched.body.id);
    await s.server.restart({ schedulerStartupDelayMs: 1500 });
    await waitUntil(() => s.server!.ctx.engine.isOnline(s.A.id) && s.server!.ctx.engine.isOnline(s.B.id), "lamps reconnect", 8000);
    const g = await s.server.api("GET", `/api/v1/groups/${s.groupId}`, { cookie: await s.server.login() });
    expect(g.body).toMatchObject({ linked: true, state: { colors: ["#336699"] } });
    await waitUntil(() => s.A.state.on === false && s.B.state.on === false, "the missed schedule to run", 8000);
    const row = s.server.ctx.scheduler.get(sched.body.id)!;
    expect(row.last_result).toBe("ok");
    expect(row.next_run_at).toBeGreaterThan(Date.now());
  });

  it("a virtual lamp started from the CLI options reuses its stored credentials", async () => {
    server = await TestServer.start();
    const cookie = await server.login();
    const { mkdtempSync, rmSync } = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = mkdtempSync(path.join(os.tmpdir(), "dl-vl-"));
    try {
      const first = new VirtualLamp({ server: server.url, code: await server.pairingCode(cookie), name: "Stored", stateDir: dir, timings: FAST_LAMP });
      await first.start();
      await first.waitOnline();
      first.localChange({ on: true, brightness: 99 });
      await waitUntil(() => server!.ctx.engine.getDevice(first.id)?.replica?.state.brightness === 99, "report");
      await first.stop();
      const second = new VirtualLamp({ server: server.url, name: "Stored", stateDir: dir, timings: FAST_LAMP });
      expect(second.hasCredentials()).toBe(true);
      expect(second.state.brightness).toBe(99);
      await second.start();
      await second.waitOnline();
      await second.stop();
      // The server forgets the lamp (its token stops working); a run with a fresh code pairs again.
      server.ctx.ops.unclaim(second.id);
      const third = new VirtualLamp({ server: server.url, code: await server.pairingCode(cookie), name: "Stored", stateDir: dir, timings: FAST_LAMP });
      expect(third.hasCredentials()).toBe(true); // stale, but it doesn't know yet
      await third.start();
      await third.waitOnline();
      expect(server.ctx.engine.isOnline(third.id)).toBe(true);
      await third.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
