// Tiny in-memory stand-in for the DoubleLamp server, for working on the web app without the real one.
// It speaks the browser API (04 §7) closely enough to click through every screen. Not a test oracle.
//
//   node web/dev/mock-server.mjs                     # API + WS on 127.0.0.1:4790 (use with VITE_SERVER=http://localhost:4790)
//   MOCK_STATIC=web/dist node web/dev/mock-server.mjs # also serves the built app with the strict CSP (07 T7)
//
// Password: MOCK_PASSWORD or "doublelamp-dev". Lamp B goes offline for 20 s every 2 min (MOCK_FLAKY=0 to stop).
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.MOCK_PORT ?? 4790);
const STATIC = process.env.MOCK_STATIC ? resolve(process.env.MOCK_STATIC) : null;
/** Like the real server (05 §7, 07 T6): changes and WS upgrades must carry Origin == PUBLIC_URL. Off unless set. */
const PUBLIC_ORIGIN = process.env.MOCK_PUBLIC_URL ? new URL(process.env.MOCK_PUBLIC_URL).origin : null;
const originOk = (req) => !PUBLIC_ORIGIN || req.headers.origin === PUBLIC_ORIGIN;
let password = process.env.MOCK_PASSWORD ?? "doublelamp-dev";
const now = () => Date.now();
const clone = (x) => JSON.parse(JSON.stringify(x));

// ------------------------------------------------------------------ data

const EFFECTS = ["solid", "breathe", "gradient", "cycle", "rainbow", "candle", "twinkle", "sunrise", "sync_test"];
const CONFIG = { pixel_count: 10, channels: 3, color_order: "RGB", max_current_ma: 600, ma_per_pixel_white: 42, color_correction: [255, 255, 255], fps: 100, dither: true, power_on: "restore" };
const lampState = (colors, effect = "solid", on = true, brightness = 180) => ({
  on, brightness, colors, effect: { id: effect, speed: 96, intensity: 140, seed: 1234, epoch: now(), duration_ms: 0 },
});
function makeDevice(id, name, ip, homekit, state) {
  return {
    id, name, online: true, last_seen_at: now(), fw: "1.0.0", config: clone(CONFIG), state, effects: EFFECTS, group_id: 1, pending_verify: false,
    telemetry: { rssi: -58, heap_free: 92_000, heap_min: 61_000, uptime_s: 3600, fps: 100, reconnects: 0, temp_c: 41 },
    info: {
      id, name, fw: "1.0.0", proto: 1, build: "dev", host: `doublelamp-${id.slice(3)}.local`,
      hw: { chip: "esp32c3", pixels: 10, channels: 3, color_order: "RGB" },
      net: { mode: "sta", ssid: "HomeWiFi", ip, rssi: -58 },
      cloud: { state: "online", url: `http://localhost:${PORT}`, linked: false, group_name: "Home" },
      homekit: { state: homekit, controllers: homekit === "paired" ? 2 : 0 },
      insecure_server_allowed: true, uptime_s: 3600,
    },
  };
}
const devices = new Map([
  ["dl-3fa2c1", makeDevice("dl-3fa2c1", "Lamp A", "192.168.1.57", "paired", lampState(["#FFB46B"], "candle"))],
  ["dl-7b19e4", makeDevice("dl-7b19e4", "Lamp B", "10.0.0.23", "unpaired", lampState(["#7A2BFF", "#FF3D9A"], "gradient"))],
]);
const groups = new Map([[1, { id: 1, name: "Home", linked: false, members: ["dl-3fa2c1", "dl-7b19e4"], state: null }]]);
let scenes = [
  { id: 1, name: "Cozy", sort: 0, state: lampState(["#FFB46B"], "candle", true, 150) },
  { id: 2, name: "Read", sort: 1, state: lampState(["#FFF1E0"], "solid", true, 230) },
  { id: 3, name: "Party", sort: 2, state: lampState(["#FF3D9A"], "rainbow", true, 255) },
];
let schedules = [];
let firmware = [{ sha256: "a".repeat(64), version: "1.0.0", idf: "5.3.1", size: 1_212_416, notes: "first release", uploaded_at: now() - 86_400_000 }];
const otaJobs = new Map();
const events = [];
const sessions = new Map(); // token → session
let ids = 100;

function record(kind, device_id, by_label, data) {
  events.unshift({ id: ++ids, ts: now(), kind, device_id, by_label, data });
  events.length = Math.min(events.length, 500);
}

// ------------------------------------------------------------------ clients

const clients = new Set();
const send = (ws, type, data, ref) => ws.readyState === 1 && ws.send(JSON.stringify(ref ? { type, ref, data } : { type, data }));
const broadcast = (type, data) => clients.forEach((ws) => send(ws, type, data));
const snapshot = () => ({ devices: [...devices.values()], groups: [...groups.values()], scenes, server_time: now() });

function applyPatch(state, patch, at) {
  const next = clone(state);
  for (const k of ["on", "brightness"]) if (patch[k] !== undefined) next[k] = patch[k];
  if (patch.colors) next.colors = patch.colors.map((c) => "#" + c.replace(/^#/, "").toUpperCase());
  if (patch.effect) {
    const changed = patch.effect.id !== undefined && patch.effect.id !== state.effect.id;
    Object.assign(next.effect, patch.effect);
    if (changed) {
      next.effect.epoch = patch.effect.epoch ?? at;
      next.effect.seed = patch.effect.seed ?? randomBytes(4).readUInt32LE();
    }
  }
  return next;
}

/** handleCommand (05 §4): resolve the replica, apply, fan out with apply_at when linked. */
function handleCommand(target, patch, origin, by) {
  const g = target.group !== undefined ? groups.get(target.group) : [...groups.values()].find((x) => x.linked && x.members.includes(target.device));
  if (target.group !== undefined && !g) return { error: ["not_found", "no such group"] };
  if (g && g.linked) {
    const members = g.members.map((m) => devices.get(m)).filter(Boolean);
    if (!members.some((d) => d.online)) return { error: ["offline", "both lamps are offline"] };
    const applyAt = now() + 150;
    g.state = applyPatch(g.state ?? members[0].state, patch, applyAt);
    broadcast("group.state", { id: g.id, state: g.state, origin, by, apply_at: applyAt });
    for (const d of members) {
      d.state = clone(g.state);
      broadcast("device.state", { id: d.id, state: d.state, origin, by, apply_at: applyAt });
    }
    record("state", null, by ?? null, { target: { group: g.id }, patch, origin });
    return { state: g.state };
  }
  if (target.group !== undefined) {
    // An unlinked group: apply to each member.
    for (const m of g.members) handleCommand({ device: m }, patch, origin, by);
    return { state: devices.get(g.members[0])?.state };
  }
  const d = devices.get(target.device);
  if (!d) return { error: ["not_found", "no such device"] };
  if (!d.online) return { error: ["offline", `${d.name} is offline`] };
  d.state = applyPatch(d.state, patch, now());
  broadcast("device.state", { id: d.id, state: d.state, origin, by });
  record("state", d.id, by ?? null, { target, patch, origin });
  return { state: d.state };
}

function setPresence(d, online) {
  d.online = online;
  d.last_seen_at = now();
  broadcast("device.presence", { id: d.id, online, last_seen_at: d.last_seen_at });
  record(online ? "connect" : "disconnect", d.id, null, {});
}

if (process.env.MOCK_FLAKY !== "0") {
  setInterval(() => {
    const b = devices.get("dl-7b19e4");
    if (!b) return;
    setPresence(b, false);
    setTimeout(() => setPresence(b, true), 20_000);
  }, 120_000);
}
setInterval(() => {
  for (const d of devices.values()) {
    if (!d.online) continue;
    d.telemetry = { ...d.telemetry, rssi: -55 - Math.round(Math.random() * 10), uptime_s: d.telemetry.uptime_s + 10 };
    broadcast("device.telemetry", { id: d.id, telemetry: d.telemetry });
  }
}, 10_000);

function runOta(job) {
  const steps = ["sent", "download", "download", "download", "download", "verify", "reboot", "done"];
  let i = 0;
  const tick = () => {
    job.status = steps[i];
    job.pct = job.status === "download" ? Math.min(100, i * 25) : job.status === "done" ? 100 : job.pct;
    job.updated_at = now();
    broadcast("ota.job", job);
    if (job.status === "done") {
      const d = devices.get(job.device_id);
      if (d) {
        d.fw = job.version;
        d.info.fw = job.version;
        broadcast("device.updated", d);
      }
      record("ota", job.device_id, null, { version: job.version, status: "done" });
      job.onDone?.();
      return;
    }
    i++;
    setTimeout(tick, 700);
  };
  setTimeout(tick, 300);
}

// ------------------------------------------------------------------ http

function nextDaily(when) {
  const [h, m] = when.time.split(":").map(Number);
  const days = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  for (let i = 0; i < 8; i++) {
    const t = new Date();
    t.setDate(t.getDate() + i);
    t.setHours(h, m, 0, 0);
    if (t.getTime() > now() && when.days.includes(days[t.getDay()])) return t.getTime();
  }
  return null;
}

function sessionOf(req) {
  const m = /(?:^|;\s*)dl_session=([^;]+)/.exec(req.headers.cookie ?? "");
  const s = m ? sessions.get(m[1]) : null;
  if (s) s.last_seen_at = now();
  return s ? { token: m[1], s } : null;
}

const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers });
  res.end(body === undefined ? "" : JSON.stringify(body));
};
const fail = (res, status, code, message, field) => json(res, status, { error: { code, message, ...(field ? { field } : {}) } });

async function body(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const buf = Buffer.concat(chunks);
  return req.headers["content-type"]?.includes("json") ? (buf.length ? JSON.parse(buf.toString()) : {}) : buf;
}

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json", ".json": "application/json" };

function serveStatic(req, res) {
  const url = new URL(req.url, "http://x");
  let file = join(STATIC, decodeURIComponent(url.pathname));
  if (!file.startsWith(STATIC) || !existsSync(file) || statSync(file).isDirectory()) file = join(STATIC, "index.html");
  res.writeHead(200, {
    "Content-Type": MIME[extname(file)] ?? "application/octet-stream",
    "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
    "Cache-Control": file.includes("/assets/") || file.includes("\\assets\\") ? "public, max-age=31536000, immutable" : "no-cache",
  });
  res.end(readFileSync(file));
}

async function api(req, res, path) {
  const method = req.method;
  const auth = sessionOf(req);
  if (method === "POST" && path === "/auth/login") {
    const b = await body(req);
    if (b.password !== password) return fail(res, 401, "auth_required", "wrong password");
    const token = randomBytes(32).toString("base64url");
    const s = { id: createHash("sha256").update(token).digest("hex").slice(0, 16), label: b.label || "Browser", created_at: now(), last_seen_at: now(), user_agent: req.headers["user-agent"] ?? null };
    sessions.set(token, s);
    record("login", null, s.label, {});
    return json(res, 200, { session: { ...s, current: true } }, { "Set-Cookie": `dl_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000` });
  }
  if (!auth) return fail(res, 401, "auth_required", "sign in first");
  const by = auth.s.label;
  const me = { ...auth.s, current: true };
  let m;

  if (method === "GET" && path === "/me") return json(res, 200, { session: me, server_time: now() });
  if (method === "POST" && path === "/_mock/presence") {
    // Mock only: {id, online} flips a lamp's connection, to try the offline paths.
    const b = await body(req);
    const d = devices.get(b.id);
    if (!d) return fail(res, 404, "not_found", "no such device");
    setPresence(d, !!b.online);
    return json(res, 204);
  }
  if (method === "POST" && path === "/_mock/drop") {
    // Mock only: closes every browser socket, like a server restart (the browsers reconnect).
    setTimeout(() => clients.forEach((ws) => ws.close(1012, "restart")), 50);
    return json(res, 204);
  }
  if (method === "POST" && path === "/_mock/revoke-all") {
    // Mock only: ends every session, like a password change from elsewhere.
    setTimeout(() => {
      sessions.clear();
      clients.forEach((ws) => ws.close(4401, "revoked"));
    }, 50);
    return json(res, 204);
  }
  if (method === "POST" && path === "/auth/logout") {
    sessions.delete(auth.token);
    return json(res, 204);
  }
  if (method === "PUT" && path === "/auth/password") {
    const b = await body(req);
    if (b.current !== password) return fail(res, 401, "auth_required", "current password is wrong", "current");
    if ((b.next ?? "").length < 12) return fail(res, 400, "invalid", "at least 12 characters", "next");
    password = b.next;
    for (const t of [...sessions.keys()]) if (t !== auth.token) sessions.delete(t);
    for (const ws of clients) if (ws.token !== auth.token) ws.close(4401, "password changed");
    record("password_changed", null, by, {});
    return json(res, 204);
  }
  if (method === "GET" && path === "/sessions") {
    return json(res, 200, { sessions: [...sessions.entries()].map(([t, s]) => ({ ...s, current: t === auth.token })) });
  }
  if (method === "DELETE" && (m = /^\/sessions\/([^/]+)$/.exec(path))) {
    for (const [t, s] of sessions) if (s.id === m[1]) {
      sessions.delete(t);
      for (const ws of clients) if (ws.token === t) ws.close(4401, "revoked");
    }
    return json(res, 204);
  }

  if (method === "GET" && path === "/devices") return json(res, 200, { devices: [...devices.values()] });
  if ((m = /^\/devices\/(dl-[0-9a-f]{6})(\/.*)?$/.exec(path))) {
    const d = devices.get(m[1]);
    if (!d) return fail(res, 404, "not_found", "no such device");
    const sub = m[2] ?? "";
    if (method === "GET" && !sub) return json(res, 200, d);
    if (method === "PATCH" && !sub) {
      const b = await body(req);
      if (b.name) d.name = d.info.name = b.name;
      if (b.config) Object.assign(d.config, b.config);
      broadcast("device.updated", d);
      return json(res, 200, d);
    }
    if (method === "DELETE" && !sub) {
      devices.delete(d.id);
      for (const g of groups.values()) g.members = g.members.filter((x) => x !== d.id);
      broadcast("device.removed", { id: d.id });
      record("unpair", d.id, by, {});
      return json(res, 204);
    }
    if (method === "POST" && sub === "/state") {
      const b = await body(req);
      const r = handleCommand({ device: d.id }, b.patch ?? {}, "web", by);
      return r.error ? fail(res, r.error[0] === "offline" ? 409 : 404, ...r.error) : json(res, 200, { state: r.state });
    }
    if (method === "POST" && (sub === "/identify" || sub === "/nudge")) return d.online ? json(res, 204) : fail(res, 409, "offline", `${d.name} is offline`);
    if (method === "POST" && sub === "/ota") {
      const b = await body(req);
      const fw = firmware.find((f) => f.sha256 === b.sha256 || f.version === b.version);
      if (!fw) return fail(res, 404, "not_found", "no such firmware");
      const job = { id: ++ids, device_id: d.id, sha256: fw.sha256, version: fw.version, status: "pending", pct: 0, error: null, created_at: now(), updated_at: now() };
      otaJobs.set(job.id, job);
      runOta(job);
      return json(res, 200, job);
    }
  }

  if (method === "GET" && path === "/groups") return json(res, 200, { groups: [...groups.values()] });
  if ((m = /^\/groups\/(\d+)(\/state)?$/.exec(path))) {
    const g = groups.get(Number(m[1]));
    if (!g) return fail(res, 404, "not_found", "no such group");
    const b = await body(req);
    if (method === "PATCH" && !m[2]) {
      if (b.name) g.name = b.name;
      if (b.linked === true && !g.linked) {
        g.linked = true;
        const src = devices.get(b.match_from ?? g.members[0]) ?? devices.get(g.members[0]);
        g.state = clone(src.state);
        const applyAt = now() + 200;
        broadcast("group.updated", g);
        broadcast("group.state", { id: g.id, state: g.state, origin: "web", by, apply_at: applyAt });
        for (const id of g.members) {
          const d = devices.get(id);
          if (!d) continue;
          d.state = clone(g.state);
          broadcast("device.state", { id, state: d.state, origin: "web", by, apply_at: applyAt });
        }
        record("link", null, by, { linked: true, match_from: src.id });
      } else if (b.linked === false && g.linked) {
        g.linked = false;
        for (const id of g.members) if (devices.get(id)) devices.get(id).state = clone(g.state);
        broadcast("group.updated", g);
        record("link", null, by, { linked: false });
      }
      return json(res, 200, g);
    }
    if (method === "POST" && m[2]) {
      const r = handleCommand({ group: g.id }, b.patch ?? {}, "web", by);
      return r.error ? fail(res, 409, ...r.error) : json(res, 200, { state: r.state });
    }
  }

  if (path === "/scenes" && method === "GET") return json(res, 200, { scenes });
  if (path === "/scenes" && method === "POST") {
    const b = await body(req);
    const from = b.from ? (b.from.group !== undefined ? groups.get(b.from.group)?.state ?? devices.get(groups.get(b.from.group)?.members[0])?.state : devices.get(b.from.device)?.state) : b.state;
    const sc = { id: ++ids, name: b.name, sort: scenes.length, state: clone(from) };
    scenes.push(sc);
    broadcast("scene.updated", { scenes });
    return json(res, 200, sc);
  }
  if (path === "/scenes/reorder" && method === "POST") {
    const b = await body(req);
    scenes = b.ids.map((id, i) => ({ ...scenes.find((s) => s.id === id), sort: i })).filter((s) => s.id);
    broadcast("scene.updated", { scenes });
    return json(res, 200, { scenes });
  }
  if ((m = /^\/scenes\/(\d+)(\/apply)?$/.exec(path))) {
    const sc = scenes.find((s) => s.id === Number(m[1]));
    if (!sc) return fail(res, 404, "not_found", "no such scene");
    const b = await body(req);
    if (m[2] && method === "POST") {
      const { epoch: _e, ...effect } = sc.state.effect;
      const r = handleCommand(b.target, { on: sc.state.on, brightness: sc.state.brightness, colors: sc.state.colors, effect }, "scene", by);
      return r.error ? fail(res, 409, ...r.error) : json(res, 200, { state: r.state });
    }
    if (method === "PUT") {
      Object.assign(sc, b);
      broadcast("scene.updated", { scenes });
      return json(res, 200, sc);
    }
    if (method === "DELETE") {
      scenes = scenes.filter((s) => s !== sc);
      broadcast("scene.updated", { scenes });
      return json(res, 204);
    }
  }

  if (path === "/schedules" && method === "GET") return json(res, 200, { schedules });
  if (path === "/schedules" && method === "POST") {
    const b = await body(req);
    const s = { id: ++ids, ...b, next_run_at: b.when.type === "daily" ? nextDaily(b.when) : now() + 3_600_000, last_run_at: null, last_result: null };
    schedules.push(s);
    return json(res, 200, s);
  }
  if ((m = /^\/schedules\/(\d+)$/.exec(path))) {
    const s = schedules.find((x) => x.id === Number(m[1]));
    if (!s) return fail(res, 404, "not_found", "no such schedule");
    if (method === "PUT") {
      Object.assign(s, await body(req));
      s.next_run_at = s.when.type === "daily" ? nextDaily(s.when) : now() + 3_600_000;
      return json(res, 200, s);
    }
    if (method === "DELETE") {
      schedules = schedules.filter((x) => x !== s);
      return json(res, 204);
    }
  }

  if (path === "/pairing-codes" && method === "POST") return json(res, 200, { code: "K7QM-4ZTX", expires_in: 600 });

  if (path === "/firmware" && method === "GET") return json(res, 200, { firmware });
  if (path.startsWith("/firmware") && method === "POST") {
    const buf = await body(req);
    const url = new URL(req.url, "http://x");
    const info = { sha256: createHash("sha256").update(buf).digest("hex"), version: `1.0.${firmware.length}`, idf: "5.3.1", size: buf.length, notes: url.searchParams.get("notes"), uploaded_at: now() };
    firmware = [...firmware.filter((f) => f.sha256 !== info.sha256), info];
    return json(res, 200, info);
  }
  if ((m = /^\/firmware\/([0-9a-f]{64})$/.exec(path)) && method === "DELETE") {
    firmware = firmware.filter((f) => f.sha256 !== m[1]);
    return json(res, 204);
  }
  if (path === "/ota-jobs" && method === "GET") return json(res, 200, { jobs: [...otaJobs.values()] });
  if (path === "/ota/rollout" && method === "POST") {
    const b = await body(req);
    const fw = firmware.find((f) => f.sha256 === b.sha256);
    if (!fw) return fail(res, 404, "not_found", "no such firmware");
    const jobs = [...devices.values()].map((d) => ({ id: ++ids, device_id: d.id, sha256: fw.sha256, version: fw.version, status: "pending", pct: 0, error: null, created_at: now(), updated_at: now() }));
    jobs.forEach((j) => otaJobs.set(j.id, j));
    jobs.forEach((j, i) => (j.onDone = () => jobs[i + 1] && runOta(jobs[i + 1])));
    if (jobs[0]) runOta(jobs[0]);
    return json(res, 200, { jobs });
  }
  if (path === "/events" && method === "GET") {
    const q = new URL(req.url, "http://x").searchParams;
    const before = q.get("before") ? Number(q.get("before")) : Infinity;
    const list = events.filter((e) => e.ts < before && (!q.get("device_id") || e.device_id === q.get("device_id")));
    return json(res, 200, { events: list.slice(0, Number(q.get("limit") ?? 50)) });
  }
  return fail(res, 404, "not_found", `no route ${method} ${path}`);
}

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname.startsWith("/api/v1/")) {
    if (req.method !== "GET" && !originOk(req)) return fail(res, 403, "forbidden", `bad origin ${req.headers.origin}`);
    api(req, res, url.pathname.slice(7)).catch((e) => fail(res, 500, "internal", String(e)));
    return;
  }
  if (url.pathname === "/healthz") return json(res, 200, { ok: true });
  if (STATIC) return serveStatic(req, res);
  fail(res, 404, "not_found", "the mock serves only the API; run the Vite dev server for the app");
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
server.on("upgrade", (req, socket, head) => {
  const auth = new URL(req.url, "http://x").pathname === "/ws/client" ? sessionOf(req) : null;
  if (!auth || !originOk(req)) {
    socket.end(auth ? "HTTP/1.1 403 Forbidden\r\n\r\n" : "HTTP/1.1 401 Unauthorized\r\n\r\n");
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.token = auth.token;
    clients.add(ws);
    send(ws, "snapshot", snapshot());
    ws.on("close", () => clients.delete(ws));
    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg.type === "time.ping") return send(ws, "time.pong", { t0: msg.data.t0, t1: now(), t2: now() });
      if (msg.type === "cmd") {
        const { target, patch, cid } = msg.data;
        setTimeout(() => {
          const r = handleCommand(target, patch, "web", sessions.get(ws.token)?.label);
          if (r.error) send(ws, "error", { code: r.error[0], message: r.error[1] }, cid);
          else send(ws, "ack", {}, cid);
        }, 40); // a little latency, like a real round trip
      }
    });
  });
});

server.listen(PORT, process.env.MOCK_HOST ?? "127.0.0.1", () => console.log(`mock DoubleLamp server on http://localhost:${PORT}${STATIC ? ` (serving ${STATIC})` : ""}; password "${password}"`));
