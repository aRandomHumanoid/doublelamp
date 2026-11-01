#!/usr/bin/env node
// Mock of one lamp's local API (docs/04-protocol.md §3, §3.1) for working on the device UI
// without hardware. It serves dist/index.html (run `npm run build -w device-ui` or `--watch` first)
// and keeps everything in memory.
//
//   node mock-lamp.mjs [options]
//     --setup              start in setup mode (captive-portal wizard); setup then "connects" over a few seconds
//     --port 8080          HTTP port
//     --password <pw>      admin password when not in setup mode (default "doublelamp")
//     --linked             start paired with a server and linked with "Lamp B"
//     --paired             start with Apple Home paired (2 controllers)
//     --dev                report insecure_server_allowed (development firmware)
//     --homekit-every <s>  every s seconds, change the color as if from Apple Home (origin "homekit")
//     --ws-limit <n>       max WebSocket clients before close code 1013 (default 3)
//     --gz                 serve ../firmware/components/device_ui/index.html.gz with Content-Encoding: gzip
//     --ap-close <s>       after setup succeeds, leave setup mode after s seconds (default 60)
//
// Setup simulation (POST /setup): SSID "Nowhere" → no_network, "NoDHCP" → no_ip, "SlowNet" → timeout,
// password "wrongpass" → wrong_password; anything else connects. Pairing codes starting with "0000"
// fail with invalid_code, "9999" with code_expired. OTA accepts any file whose first byte is 0xE9.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import { networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { WebSocketServer } from "ws";

const here = dirname(fileURLToPath(import.meta.url));
const { values: args } = parseArgs({
  options: {
    setup: { type: "boolean", default: false },
    port: { type: "string", default: "8080" },
    password: { type: "string", default: "doublelamp" },
    linked: { type: "boolean", default: false },
    paired: { type: "boolean", default: false },
    dev: { type: "boolean", default: false },
    "homekit-every": { type: "string", default: "0" },
    "ws-limit": { type: "string", default: "3" },
    gz: { type: "boolean", default: false },
    "ap-close": { type: "string", default: "60" },
  },
});

const PORT = Number(args.port);
const WS_LIMIT = Number(args["ws-limit"]);
const ID = "dl-3fa2c1";
const HOST = "doublelamp-3fa2c1.local";
const AP_SSID = "DoubleLamp-3FA2C1";

// Effect catalog: a copy of packages/protocol/src/effects.ts (EFFECTS), as GET /effects returns it.
const EFFECTS = [
  { id: "solid", name: "Solid", uses: ["colors1"], oneshot: false, defaults: { speed: 128, intensity: 128 } },
  { id: "breathe", name: "Breathe", uses: ["colors1", "speed", "intensity"], oneshot: false, defaults: { speed: 96, intensity: 160 } },
  { id: "gradient", name: "Gradient", uses: ["colors1", "colors2", "colors3", "speed"], oneshot: false, defaults: { speed: 0, intensity: 128 } },
  { id: "cycle", name: "Color cycle", uses: ["speed", "intensity"], oneshot: false, defaults: { speed: 64, intensity: 255 } },
  { id: "rainbow", name: "Rainbow", uses: ["speed", "intensity"], oneshot: false, defaults: { speed: 64, intensity: 96 } },
  { id: "candle", name: "Candle", uses: ["colors1", "speed", "intensity"], oneshot: false, defaults: { speed: 128, intensity: 140 } },
  { id: "twinkle", name: "Twinkle", uses: ["colors1", "colors2", "colors3", "speed", "intensity"], oneshot: false, defaults: { speed: 96, intensity: 64 } },
  { id: "sunrise", name: "Sunrise", uses: ["duration"], oneshot: true, defaults: { speed: 128, intensity: 128, duration_ms: 1800000 } },
  { id: "sync_test", name: "Sync test", uses: [], oneshot: false, defaults: { speed: 128, intensity: 128 } },
];
const SCAN = [
  { ssid: "HomeWiFi", rssi: -52, auth: "wpa2" },
  { ssid: "HomeWiFi", rssi: -71, auth: "wpa2" }, // a second access point of the same network
  { ssid: "Neighbors 2.4G", rssi: -68, auth: "wpa2" },
  { ssid: "CoffeeShop", rssi: -80, auth: "open" },
  { ssid: "Campus", rssi: -75, auth: "wpa2-enterprise" },
  { ssid: "NoDHCP", rssi: -60, auth: "wpa2" },
  { ssid: "SlowNet", rssi: -88, auth: "wpa3" },
  { ssid: "", rssi: -63, auth: "wpa2" }, // a hidden network shows up without a name
];
const DEFAULT_CONFIG = {
  pixel_count: 10,
  channels: 3,
  color_order: "RGB",
  max_current_ma: 600,
  ma_per_pixel_white: 42,
  color_correction: [255, 255, 255],
  fps: 100,
  dither: true,
  power_on: "restore",
};
const POWER = { "12v1a": 600, "12v2a": 1400, "12v3a": 2200, "12v5a": 3800 };

// ---------------------------------------------------------------------------------- lamp state

let lamp;
function resetLamp(setup) {
  lamp = {
    setupMode: setup,
    name: setup ? "DoubleLamp" : "Lamp A",
    adminPassword: setup ? null : args.password,
    apPassword: setup ? null : args.password,
    fw: "1.0.0",
    build: "a1b2c3d",
    bootAt: Date.now(),
    rev: 1,
    state: {
      on: !setup,
      brightness: 180,
      colors: ["#FFB46B"],
      effect: { id: "solid", speed: 128, intensity: 128, seed: 12345, epoch: Date.now(), duration_ms: 0 },
    },
    config: { ...DEFAULT_CONFIG, color_correction: [...DEFAULT_CONFIG.color_correction] },
    net: setup ? { mode: "ap", ssid: "", ip: "192.168.4.1", rssi: 0 } : { mode: "sta", ssid: "HomeWiFi", ip: "192.168.1.57", rssi: -58 },
    cloud: args.linked && !setup
      ? { state: "online", url: "https://lamps.example.com", linked: true, group_name: "Lamp B" }
      : { state: "off", url: "", linked: false, group_name: "" },
    homekit: {
      state: setup ? "off" : args.paired ? "paired" : "unpaired",
      controllers: args.paired && !setup ? 2 : 0,
      setup_code: "482-91-376",
      setup_id: "DL3F",
    },
    apAlwaysOn: false,
    presets: setup
      ? []
      : [
          { slot: 0, name: "Cozy", state: preset(true, 120, ["#FF8A3D"], "candle", 128, 140) },
          { slot: 1, name: "Read", state: preset(true, 230, ["#FFD9B0"], "solid", 128, 128) },
          { slot: 3, name: "Party", state: preset(true, 200, ["#FF2A8C", "#7A2BFF", "#00B4FF"], "twinkle", 160, 90) },
        ],
    setupStatus: { state: "idle" },
  };
}
function preset(on, brightness, colors, id, speed, intensity) {
  return { on, brightness, colors, effect: { id, speed, intensity, seed: 1, epoch: 0, duration_ms: 0 } };
}
resetLamp(args.setup);

const sessions = new Map(); // token → expiry (ms)
const loginAttempts = [];
const logs = [];
let unreachableUntil = 0;
let wsSeq = 0;

function log(level, tag, msg) {
  const t = Date.now() - lamp.bootAt;
  logs.push(`${level} (${t}) ${tag}: ${msg}`);
  if (logs.length > 300) logs.shift();
}
log("I", "app", "DoubleLamp mock " + lamp.fw + " starting" + (lamp.setupMode ? " in setup mode" : ""));

function info() {
  return {
    id: ID,
    name: lamp.name,
    fw: lamp.fw,
    proto: 1,
    build: lamp.build,
    host: HOST,
    hw: { chip: "esp32c3", pixels: lamp.config.pixel_count, channels: lamp.config.channels, color_order: lamp.config.color_order },
    net: { ...lamp.net },
    cloud: { ...lamp.cloud },
    homekit: { state: lamp.homekit.state, controllers: lamp.homekit.controllers },
    insecure_server_allowed: args.dev,
    setup_mode: lamp.setupMode,
    uptime_s: Math.floor((Date.now() - lamp.bootAt) / 1000),
  };
}

// ---------------------------------------------------------------------------------- validation

class HttpError extends Error {
  constructor(status, code, message, field) {
    super(message);
    this.status = status;
    this.code = code;
    this.field = field;
  }
}
const bad = (message, field, code = "invalid") => new HttpError(400, code, message, field);
const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const HEX = /^#?[0-9a-fA-F]{6}$/;
const normHex = (s) => "#" + s.replace(/^#/, "").toUpperCase();
const utf8Len = (s) => Buffer.byteLength(s, "utf8");

/** Validates a Command (04 §2) the way the firmware does: all or nothing, unknown fields ignored. */
function checkCommand(cmd) {
  if (!cmd || typeof cmd !== "object") throw bad("expected a command object");
  const p = cmd.patch;
  if (!p || typeof p !== "object") throw bad("patch is required", "patch");
  if (cmd.transition_ms !== undefined && !isInt(cmd.transition_ms, 0, 10000)) throw bad("transition_ms must be 0–10000", "transition_ms");
  if (p.on !== undefined && typeof p.on !== "boolean") throw bad("on must be true or false", "on");
  if (p.brightness !== undefined && !isInt(p.brightness, 0, 255)) throw bad("brightness must be 0–255", "brightness");
  if (p.colors !== undefined) {
    if (!Array.isArray(p.colors) || p.colors.length < 1 || p.colors.length > 3) throw bad("colors must have 1–3 entries", "colors");
    for (const c of p.colors) if (typeof c !== "string" || !HEX.test(c)) throw bad("colors must be #RRGGBB", "colors");
  }
  if (p.effect !== undefined) {
    const e = p.effect;
    if (!e || typeof e !== "object") throw bad("effect must be an object", "effect");
    if (e.id !== undefined && !EFFECTS.some((x) => x.id === e.id)) throw bad("unknown effect " + e.id, "effect.id", "unknown_effect");
    for (const k of ["speed", "intensity"]) if (e[k] !== undefined && !isInt(e[k], 0, 255)) throw bad(k + " must be 0–255", "effect." + k);
    for (const k of ["seed", "duration_ms"]) if (e[k] !== undefined && !isInt(e[k], 0, 0xffffffff)) throw bad(k + " is out of range", "effect." + k);
    if (e.epoch !== undefined && !Number.isInteger(e.epoch)) throw bad("epoch must be an integer", "effect.epoch");
  }
  return p;
}

function applyPatch(p, origin, transition = 400) {
  const s = lamp.state;
  const next = { ...s, colors: [...s.colors], effect: { ...s.effect } };
  if (p.on !== undefined) next.on = p.on;
  if (p.brightness !== undefined) next.brightness = p.brightness;
  if (p.colors !== undefined) next.colors = p.colors.map(normHex);
  if (p.effect !== undefined) {
    const idChanged = p.effect.id !== undefined && p.effect.id !== s.effect.id;
    for (const k of ["id", "speed", "intensity", "seed", "epoch", "duration_ms"]) if (p.effect[k] !== undefined) next.effect[k] = p.effect[k];
    if (idChanged && p.effect.epoch === undefined) next.effect.epoch = Date.now();
    if (idChanged && p.effect.seed === undefined) next.effect.seed = randomBytes(4).readUInt32LE(0);
  }
  if (JSON.stringify(next) === JSON.stringify(s)) return s;
  lamp.state = next;
  lamp.rev++;
  log("I", "state", `rev ${lamp.rev} from ${origin} (${transition} ms): ${JSON.stringify(p)}`);
  broadcast({ type: "state", data: { rev: lamp.rev, state: lamp.state, origin } });
  return next;
}

// ---------------------------------------------------------------------------------- WebSocket

const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });

function broadcast(msg) {
  const text = JSON.stringify(msg);
  for (const c of wss.clients) if (c.readyState === 1) c.send(text);
}
const broadcastInfo = () => broadcast({ type: "info", data: info() });

wss.on("connection", (ws) => {
  const n = ++wsSeq;
  if (wss.clients.size > WS_LIMIT) {
    log("W", "local_api", `ws #${n} refused: ${WS_LIMIT} clients already`);
    ws.close(1013, "try again later");
    return;
  }
  log("I", "local_api", `ws #${n} connected (${wss.clients.size}/${WS_LIMIT})`);
  ws.send(JSON.stringify({ type: "state", data: { rev: lamp.rev, state: lamp.state, origin: "boot" } }));
  ws.send(JSON.stringify({ type: "info", data: info() }));
  ws.on("message", (raw) => {
    let m;
    try {
      m = JSON.parse(String(raw));
    } catch {
      ws.send(JSON.stringify({ type: "error", data: { code: "invalid", message: "malformed JSON" } }));
      return;
    }
    if (m.type !== "cmd") {
      ws.send(JSON.stringify({ type: "error", ref: m.id, data: { code: "unsupported", message: "unknown message type " + m.type } }));
      return;
    }
    try {
      const p = checkCommand(m.data);
      applyPatch(p, "local", m.data.transition_ms);
    } catch (e) {
      ws.send(JSON.stringify({ type: "error", ref: m.id, data: { code: e.code || "invalid", message: e.message } }));
    }
  });
  ws.on("close", () => log("I", "local_api", `ws #${n} closed`));
});

// ---------------------------------------------------------------------------------- HTTP helpers

const allowedHosts = new Set(["localhost", "127.0.0.1", "[::1]", "192.168.4.1", HOST]);
for (const list of Object.values(networkInterfaces())) for (const a of list || []) if (a.family === "IPv4") allowedHosts.add(a.address);
/** 07 §4.1: only the lamp's own names are accepted, against DNS rebinding. */
function hostOk(h) {
  if (!h) return false;
  const name = h.startsWith("[") ? h.slice(0, h.indexOf("]") + 1) : h.split(":")[0];
  return allowedHosts.has(name.toLowerCase());
}

function send(res, status, body, headers = {}) {
  const isJson = body !== undefined && typeof body !== "string" && !Buffer.isBuffer(body);
  const text = body === undefined ? "" : isJson ? JSON.stringify(body) : body;
  res.writeHead(status, {
    "Cache-Control": "no-store",
    ...(isJson ? { "Content-Type": "application/json" } : {}),
    ...headers,
  });
  res.end(text);
}
const sendErr = (res, e) => send(res, e.status, { error: { code: e.code, message: e.message, ...(e.field ? { field: e.field } : {}) } });

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size <= limit) chunks.push(c);
    });
    req.on("end", () =>
      size > limit ? reject(new HttpError(413, "too_large", `request body over ${limit} bytes`)) : resolve(Buffer.concat(chunks)),
    );
    req.on("error", reject);
  });
}

function needAdmin(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || "");
  const exp = m && sessions.get(m[1]);
  if (!exp || exp < Date.now()) throw new HttpError(401, "auth_required", "Log in first");
}
/** admin† routes: no auth needed in setup mode. */
const adminOrSetup = (req) => lamp.setupMode || needAdmin(req);
function setupOnly() {
  if (!lamp.setupMode) throw new HttpError(403, "forbidden", "Only available in setup mode");
}

function slotOf(m) {
  const slot = Number(m[1]);
  if (!isInt(slot, 0, 7)) throw new HttpError(404, "not_found", "No such preset slot");
  return slot;
}
const managed = () => {
  if (lamp.cloud.url) throw new HttpError(409, "managed_by_server", "Presets are managed by the server while the lamp is paired");
};

/** Simulates a restart: the lamp stops answering for a few seconds, sessions and sockets are gone. */
function restart(ms, then) {
  setTimeout(() => {
    log("I", "app", "restarting");
    unreachableUntil = Date.now() + ms;
    sessions.clear();
    for (const c of wss.clients) c.terminate();
    setTimeout(() => {
      then && then();
      lamp.bootAt = Date.now();
      log("I", "app", "booted " + lamp.fw + " (" + lamp.build + ")");
    }, ms);
  }, 800);
}

// ---------------------------------------------------------------------------------- setup simulation

const AP_CLOSE_MS = Number(args["ap-close"]) * 1000;

function runSetup(r) {
  const known = SCAN.find((n) => n.ssid === r.ssid);
  lamp.setupStatus = { state: "connecting" };
  lamp.net = { mode: "apsta", ssid: "", ip: "192.168.4.1", rssi: 0 };
  log("I", "net", `setup: joining "${r.ssid}"`);
  const fail = (reason, ms) =>
    setTimeout(() => {
      lamp.setupStatus = { state: "failed", reason };
      lamp.net = { mode: "ap", ssid: "", ip: "192.168.4.1", rssi: 0 };
      log("W", "net", "setup failed: " + reason);
    }, ms);
  if (r.ssid === "Nowhere") return fail("no_network", 3000);
  if (r.ssid === "NoDHCP") return fail("no_ip", 5000);
  if (r.ssid === "SlowNet") return fail("timeout", 9000);
  if (r.password === "wrongpass") return fail("wrong_password", 3500);
  setTimeout(() => {
    lamp.name = r.name;
    lamp.adminPassword = r.admin_password;
    lamp.apPassword = r.admin_password;
    lamp.config.pixel_count = Math.round(16 * r.strip_m);
    lamp.config.max_current_ma = r.power.preset ? POWER[r.power.preset] : r.power.max_current_ma;
    lamp.net = { mode: "apsta", ssid: r.ssid, ip: "192.168.1.57", rssi: known ? known.rssi : -60 };
    lamp.homekit.state = "unpaired";
    lamp.state = { ...lamp.state, on: true };
    lamp.setupStatus = { state: "online", ip: "192.168.1.57", host: HOST, cloud: r.pairing_code ? "claiming" : "skipped" };
    log("I", "net", `setup: online as 192.168.1.57 on "${r.ssid}"`);
    if (r.pairing_code) {
      setTimeout(() => {
        const err = claimError(r.pairing_code);
        if (err) {
          lamp.setupStatus = { ...lamp.setupStatus, cloud: "failed", cloud_error: err.message };
        } else {
          lamp.setupStatus = { ...lamp.setupStatus, cloud: "online" };
          lamp.cloud = { state: "online", url: r.server_url, linked: false, group_name: "Home" };
        }
      }, 2500);
    }
    setTimeout(() => {
      lamp.setupMode = false;
      lamp.net = { ...lamp.net, mode: lamp.apAlwaysOn ? "apsta" : "sta" };
      log("I", "net", "setup AP closed");
      broadcastInfo();
    }, AP_CLOSE_MS);
  }, 4000);
}

function claimError(code) {
  const c = String(code).toUpperCase();
  if (c.startsWith("0000")) return new HttpError(400, "invalid_code", "The server doesn't know that pairing code");
  if (c.startsWith("9999")) return new HttpError(410, "code_expired", "That pairing code has expired");
  return null;
}

function checkSetup(r) {
  if (!r || typeof r !== "object") throw bad("expected an object");
  if (typeof r.ssid !== "string" || !r.ssid || utf8Len(r.ssid) > 32) throw bad("ssid must be 1–32 bytes", "ssid");
  if (typeof r.password !== "string" || r.password.length > 64) throw bad("password must be at most 64 characters", "password");
  if (typeof r.name !== "string" || !r.name.trim() || r.name.length > 32) throw bad("name must be 1–32 characters", "name");
  if (typeof r.admin_password !== "string" || r.admin_password.length < 8 || r.admin_password.length > 63)
    throw bad("admin_password must be 8–63 characters", "admin_password");
  if (typeof r.strip_m !== "number" || !(r.strip_m >= 0.0625 && r.strip_m <= 64)) throw bad("strip_m must be 0.0625–64", "strip_m");
  const p = r.power;
  if (!p || typeof p !== "object") throw bad("power is required", "power");
  if (p.preset !== undefined ? !(p.preset in POWER) : !isInt(p.max_current_ma, 100, 20000)) throw bad("power must be a preset or max_current_ma 100–20000", "power");
  if (!!r.server_url !== !!r.pairing_code) throw bad("server_url and pairing_code go together", r.server_url ? "pairing_code" : "server_url");
  if (r.server_url) checkServerUrl(r.server_url, "server_url");
  if (r.pairing_code && !/^[0-9A-Z]{4}-?[0-9A-Z]{4}$/i.test(r.pairing_code)) throw bad("pairing_code must look like XXXX-XXXX", "pairing_code");
}

function checkServerUrl(u, field) {
  let url;
  try {
    url = new URL(u);
  } catch {
    throw bad("not a URL", field);
  }
  if (!["https:", "wss:"].includes(url.protocol) && !(args.dev && ["http:", "ws:"].includes(url.protocol)))
    throw bad("the server URL must use https://", field);
}

// ---------------------------------------------------------------------------------- routes

const routes = [];
const route = (method, path, fn) => routes.push({ method, re: new RegExp("^" + path + "$"), fn });

route("GET", "/info", () => [200, info()]);
route("GET", "/state", () => [200, lamp.state]);
route("PATCH", "/state", ({ body }) => {
  const p = checkCommand(body);
  return [200, applyPatch(p, "local", body.transition_ms)];
});
route("GET", "/effects", () => [200, EFFECTS]);
route("GET", "/presets", () => [200, lamp.presets.slice().sort((a, b) => a.slot - b.slot)]);
route("POST", "/presets/(\\d+)/apply", ({ m, body }) => {
  const slot = slotOf(m);
  const p = lamp.presets.find((x) => x.slot === slot);
  if (!p) throw new HttpError(404, "not_found", "Preset slot " + slot + " is empty");
  const t = body.transition_ms ?? 400;
  if (!isInt(t, 0, 10000)) throw bad("transition_ms must be 0–10000", "transition_ms");
  const { epoch, ...effect } = p.state.effect;
  return [200, applyPatch({ ...p.state, effect }, "local", t)];
});
route("PUT", "/presets/(\\d+)", ({ req, m, body }) => {
  needAdmin(req);
  const slot = slotOf(m);
  managed();
  if (typeof body.name !== "string" || !body.name.trim() || body.name.length > 32) throw bad("name must be 1–32 characters", "name");
  let state = lamp.state;
  if (body.state !== undefined) {
    checkCommand({ patch: body.state });
    state = { ...lamp.state, ...body.state, effect: { ...lamp.state.effect, ...(body.state.effect || {}) } };
  }
  const p = { slot, name: body.name.trim(), state: { ...state, effect: { ...state.effect, epoch: 0 } } };
  lamp.presets = lamp.presets.filter((x) => x.slot !== slot).concat(p);
  return [200, p];
});
route("DELETE", "/presets/(\\d+)", ({ req, m }) => {
  needAdmin(req);
  const slot = slotOf(m);
  managed();
  if (!lamp.presets.some((x) => x.slot === slot)) throw new HttpError(404, "not_found", "Preset slot " + slot + " is empty");
  lamp.presets = lamp.presets.filter((x) => x.slot !== slot);
  return [204];
});
route("POST", "/auth/login", async ({ body }) => {
  const now = Date.now();
  while (loginAttempts.length && loginAttempts[0] < now - 60000) loginAttempts.shift();
  if (loginAttempts.length >= 5) throw new HttpError(429, "rate_limited", "Too many login attempts. Wait a minute.");
  loginAttempts.push(now);
  await new Promise((r) => setTimeout(r, 250)); // PBKDF2 takes a moment on the lamp
  if (!lamp.adminPassword) throw new HttpError(403, "forbidden", "No admin password set yet: finish setup first");
  if (typeof body.password !== "string" || body.password !== lamp.adminPassword) throw new HttpError(401, "auth_required", "Wrong password");
  const token = randomBytes(24).toString("base64url");
  sessions.set(token, now + 30 * 86400 * 1000);
  return [200, { token, expires_in: 30 * 86400 }];
});
route("POST", "/auth/logout", ({ req }) => {
  needAdmin(req);
  sessions.delete(req.headers.authorization.slice(7));
  return [204];
});
route("GET", "/config", ({ req }) => (needAdmin(req), [200, lamp.config]));
route("PUT", "/config", ({ req, body }) => {
  needAdmin(req);
  const c = { ...lamp.config, ...body };
  if (!isInt(c.pixel_count, 1, 1024)) throw bad("pixel_count must be 1–1024", "pixel_count");
  if (c.channels !== 3 && c.channels !== 4) throw bad("channels must be 3 or 4", "channels");
  const orders = c.channels === 4 ? ["GRBW", "RGBW"] : ["RGB", "RBG", "GRB", "GBR", "BRG", "BGR"];
  if (!orders.includes(c.color_order)) throw bad("color_order doesn't match the channel count", "color_order");
  if (!isInt(c.max_current_ma, 100, 20000)) throw bad("max_current_ma must be 100–20000", "max_current_ma");
  if (!isInt(c.ma_per_pixel_white, 1, 200)) throw bad("ma_per_pixel_white must be 1–200", "ma_per_pixel_white");
  if (!Array.isArray(c.color_correction) || c.color_correction.length !== 3 || !c.color_correction.every((v) => isInt(v, 0, 255)))
    throw bad("color_correction must be [r,g,b] with 0–255 each", "color_correction");
  if (!isInt(c.fps, 10, 100)) throw bad("fps must be 10–100", "fps");
  if (typeof c.dither !== "boolean") throw bad("dither must be true or false", "dither");
  if (!["restore", "on", "off"].includes(c.power_on)) throw bad("power_on must be restore, on or off", "power_on");
  const pick = Object.fromEntries(Object.keys(DEFAULT_CONFIG).map((k) => [k, c[k]]));
  lamp.config = pick;
  log("I", "led", "config " + JSON.stringify(body));
  broadcastInfo();
  return [200, lamp.config];
});
route("POST", "/test-pattern", ({ req, body }) => {
  adminOrSetup(req);
  if (!["color_order", "last_pixel", "white_25"].includes(body.pattern)) throw bad("unknown pattern", "pattern");
  if (body.duration_ms !== undefined && !isInt(body.duration_ms, 0, 60000)) throw bad("duration_ms must be 0–60000", "duration_ms");
  log("I", "led", `test pattern ${body.pattern} for ${body.duration_ms ?? 5000} ms`);
  return [202, {}];
});
route("GET", "/wifi/scan", async ({ req }) => {
  adminOrSetup(req);
  await new Promise((r) => setTimeout(r, 1500));
  return [200, SCAN];
});
route("PUT", "/wifi", ({ req, body }) => {
  needAdmin(req);
  if (typeof body.ssid !== "string" || !body.ssid || utf8Len(body.ssid) > 32) throw bad("ssid must be 1–32 bytes", "ssid");
  if (typeof body.password !== "string" || body.password.length > 64) throw bad("password must be at most 64 characters", "password");
  log("I", "net", `switching to "${body.ssid}"`);
  setTimeout(() => {
    const known = SCAN.find((n) => n.ssid === body.ssid);
    lamp.net = { ...lamp.net, ssid: body.ssid, rssi: known ? known.rssi : -65 };
    broadcastInfo();
  }, 3000);
  return [202, {}];
});
route("GET", "/network", ({ req }) => (needAdmin(req), [200, { ap_always_on: lamp.apAlwaysOn }]));
route("PUT", "/network", ({ req, body }) => {
  needAdmin(req);
  if (typeof body.ap_always_on !== "boolean") throw bad("ap_always_on must be true or false", "ap_always_on");
  lamp.apAlwaysOn = body.ap_always_on;
  if (!lamp.setupMode) lamp.net = { ...lamp.net, mode: lamp.apAlwaysOn ? "apsta" : "sta" };
  broadcastInfo();
  return [200, { ap_always_on: lamp.apAlwaysOn }];
});
route("PUT", "/security", ({ req, body }) => {
  needAdmin(req);
  if (body.current_password !== lamp.adminPassword)
    throw new HttpError(401, "auth_required", "The current password is wrong", "current_password");
  if (!body.admin_password && !body.ap_password) throw bad("nothing to change");
  for (const k of ["admin_password", "ap_password"])
    if (body[k] !== undefined && (typeof body[k] !== "string" || body[k].length < 8 || body[k].length > 63)) throw bad(k + " must be 8–63 characters", k);
  if (body.admin_password) lamp.adminPassword = body.admin_password;
  if (body.ap_password) lamp.apPassword = body.ap_password;
  log("I", "auth", "passwords changed");
  return [204];
});
route("POST", "/setup", ({ body }) => {
  setupOnly();
  if (lamp.setupStatus.state === "connecting") throw new HttpError(409, "conflict", "Setup is already connecting");
  checkSetup(body);
  runSetup(body);
  return [202, {}];
});
route("GET", "/setup/status", () => (setupOnly(), [200, lamp.setupStatus]));
route("GET", "/homekit", ({ req }) => (needAdmin(req), [200, { ...lamp.homekit }]));
route("POST", "/homekit/reset", ({ req }) => {
  needAdmin(req);
  lamp.homekit.controllers = 0;
  if (lamp.homekit.state === "paired") lamp.homekit.state = "unpaired";
  log("I", "homekit", "all pairings removed");
  broadcastInfo();
  return [202, {}];
});
route("POST", "/cloud/claim", async ({ req, body }) => {
  adminOrSetup(req);
  if (typeof body.server_url !== "string" || !body.server_url) throw bad("server_url is required", "server_url");
  checkServerUrl(body.server_url, "server_url");
  if (typeof body.code !== "string" || !/^[0-9A-Z]{4}-?[0-9A-Z]{4}$/i.test(body.code)) throw bad("code must look like XXXX-XXXX", "code");
  await new Promise((r) => setTimeout(r, 1500));
  const err = claimError(body.code);
  if (err) throw err;
  lamp.cloud = { state: "online", url: body.server_url, linked: false, group_name: "Home" };
  log("I", "cloud", "claimed by " + body.server_url);
  broadcastInfo();
  return [200, { state: "online" }];
});
route("DELETE", "/cloud", ({ req }) => {
  needAdmin(req);
  lamp.cloud = { state: "off", url: "", linked: false, group_name: "" };
  log("I", "cloud", "unpaired");
  broadcastInfo();
  return [204];
});
route("POST", "/ota", ({ req, raw }) => {
  needAdmin(req);
  if (!raw.length || raw[0] !== 0xe9) throw bad("not an ESP32 app image");
  const [maj, min, patch] = lamp.fw.split(".").map(Number);
  log("I", "ota", `received ${raw.length} bytes, signature ok, rebooting`);
  restart(4000, () => {
    lamp.fw = `${maj}.${min}.${patch + 1}`;
    lamp.build = randomBytes(4).toString("hex").slice(0, 7);
  });
  return [202, {}];
});
route("GET", "/logs", ({ req }) => (needAdmin(req), [200, logs.join("\n") + "\n", { "Content-Type": "text/plain; charset=utf-8" }]));
route("POST", "/identify", ({ body }) => {
  if (body.duration_ms !== undefined && !isInt(body.duration_ms, 0, 60000)) throw bad("duration_ms must be 0–60000", "duration_ms");
  log("I", "led", "identify");
  return [202, {}];
});
route("POST", "/reboot", ({ req }) => (needAdmin(req), restart(3000), [202, {}]));
route("POST", "/factory-reset", ({ req }) => {
  needAdmin(req);
  restart(3000, () => {
    resetLamp(true);
    lamp.homekit.setup_code = "731-06-925";
  });
  return [202, {}];
});

async function handleApi(req, res, path) {
  const isOta = path === "/ota";
  const changes = req.method !== "GET" && req.method !== "HEAD";
  // 07 §4.2: state-changing requests must be JSON (OTA is raw bytes); simple form posts get 415.
  const type = (req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
  if (changes && type !== (isOta ? "application/octet-stream" : "application/json"))
    return sendErr(res, new HttpError(415, "invalid", `Content-Type must be ${isOta ? "application/octet-stream" : "application/json"}`));
  const raw = await readBody(req, isOta ? 1920 * 1024 : 4096);
  let body = {};
  if (changes && !isOta && raw.length) {
    try {
      body = JSON.parse(raw.toString("utf8"));
    } catch {
      return sendErr(res, bad("malformed JSON"));
    }
  }
  if (body === null || typeof body !== "object") body = {};
  let methodMismatch = false;
  for (const r of routes) {
    const m = r.re.exec(path);
    if (!m) continue;
    if (r.method !== req.method) {
      methodMismatch = true;
      continue;
    }
    const [status, out, headers] = await r.fn({ req, m, body, raw });
    return send(res, status, out, headers);
  }
  throw methodMismatch ? new HttpError(405, "invalid", "Method not allowed") : new HttpError(404, "not_found", "No such endpoint");
}

const PROBES = new Set(["/generate_204", "/hotspot-detect.html", "/connecttest.txt", "/ncsi.txt"]);

function serveUi(res) {
  try {
    if (args.gz) {
      const gz = readFileSync(join(here, "..", "firmware", "components", "device_ui", "index.html.gz"));
      return send(res, 200, gz, { "Content-Type": "text/html; charset=utf-8", "Content-Encoding": "gzip", "Cache-Control": "no-cache", ETag: '"' + lamp.build + '"' });
    }
    const html = readFileSync(join(here, "dist", "index.html"));
    send(res, 200, html, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
  } catch {
    send(res, 503, "The UI isn't built yet. Run: npm run build -w device-ui\n", { "Content-Type": "text/plain; charset=utf-8" });
  }
}

const server = http.createServer(async (req, res) => {
  if (Date.now() < unreachableUntil) return req.socket.destroy(); // "rebooting"
  const url = new URL(req.url, "http://lamp");
  const path = url.pathname;
  if (!hostOk(req.headers.host)) return sendErr(res, new HttpError(421, "forbidden", "Unknown Host header"));
  const t0 = Date.now();
  res.on("finish", () => {
    if (path !== "/api/v1/state" || req.method !== "GET") log("D", "http", `${req.method} ${path} ${res.statusCode} ${Date.now() - t0} ms`);
  });
  try {
    if (path.startsWith("/api/v1/")) return await handleApi(req, res, path.slice(7));
    if (req.method === "GET" && (path === "/" || path === "/setup" || path === "/index.html")) return serveUi(res);
    if (lamp.setupMode && (PROBES.has(path) || req.method === "GET")) {
      // 03 §8: captive-portal probes (and anything else) are redirected to the wizard
      return send(res, 302, "", { Location: "/setup" });
    }
    send(res, 404, "Not found\n", { "Content-Type": "text/plain" });
  } catch (e) {
    if (e instanceof HttpError) sendErr(res, e);
    else {
      console.error(e);
      sendErr(res, new HttpError(500, "internal", String(e && e.message)));
    }
  }
});

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, "http://lamp");
  const origin = req.headers.origin;
  // 07 §4.6: upgrades check Host and Origin the same way
  const originOk = !origin || hostOk(origin.replace(/^https?:\/\//, ""));
  if (Date.now() < unreachableUntil || url.pathname !== "/api/v1/ws" || !hostOk(req.headers.host) || !originOk) {
    socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

const every = Number(args["homekit-every"]);
if (every > 0) {
  setInterval(() => {
    if (lamp.setupMode) return;
    const hue = Math.floor(Math.random() * 360);
    const c = hslHex(hue);
    const usesColors = (EFFECTS.find((e) => e.id === lamp.state.effect.id)?.uses || []).includes("colors1");
    applyPatch({ on: true, colors: [c, ...lamp.state.colors.slice(1)], ...(usesColors ? {} : { effect: { id: "solid" } }) }, "homekit");
  }, every * 1000);
}
function hslHex(h) {
  const f = (n) => {
    const k = (n + h / 30) % 12;
    return Math.round(255 * (0.5 - 0.5 * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return "#" + [f(0), f(8), f(4)].map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase();
}

server.listen(PORT, () => {
  console.log(`mock lamp on http://localhost:${PORT}  (${lamp.setupMode ? "setup mode" : "admin password: " + args.password})`);
});
