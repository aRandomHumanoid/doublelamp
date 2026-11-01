// Live lamp state: WebSocket /api/v1/ws with a polling fallback, optimistic updates and throttled
// commands (04 §3.1, 06 §A.4 / §B.3).
//
// - The lamp's last reported state is kept apart from local "holds": values the user just set.
//   The view is the lamp state with the holds on top. A hold ends when the lamp reports the same
//   value, or after HOLD_MS, so an echo of an older command never yanks a slider back, and a change
//   the lamp refused quietly falls back to what the lamp actually shows.
// - At most one command per THROTTLE_MS, always including the final value. Drags use
//   transition_ms 120, taps 400.
// - The lamp accepts 3 WebSocket clients; the 4th is closed with 1013. On 1013 or any failure we
//   poll GET /state every 2 s and retry the socket with backoff. Hidden pages give their slot back.
import type { Command, DeviceInfo, LampState, LocalServerMessage, Preset } from "@doublelamp/protocol/local";
import { api, errMsg } from "./lib/api";
import type { Phase } from "./ui/slider";
import { toast } from "./ui/widgets";

export type Patch = Command["patch"];
export type Conn = "connecting" | "live" | "polling" | "offline";
type Key = "on" | "brightness" | "colors" | "effect.id" | "effect.speed" | "effect.intensity" | "effect.duration_ms";

export const TAP_MS = 400;
export const DRAG_MS = 120;
const THROTTLE_MS = 80;
const HOLD_MS = 1500;
const DRAG_HOLD_MS = 5000;
const POLL_MS = 2000;
const EFFECT_KEYS = ["id", "speed", "intensity", "duration_ms"] as const;

let server: LampState | null = null;
let rev = -1;
let info: DeviceInfo | null = null;
let conn: Conn = "connecting";
let busy = false;
const holds: Partial<Record<Key, { v: unknown; until: number }>> = {};
const listeners: Array<() => void> = [];

let ws: WebSocket | null = null;
let wsLive = false;
let wsAttempts = 0;
let wsTimer = 0;
let polling = false;
let pollTimer = 0;
let pollFails = 0;
let polls = 0;
let paused = false;
let hideTimer = 0;
let expTimer = 0;
/** Bumped whenever a command goes out over HTTP, so an in-flight poll can't overwrite it. */
let cmdEpoch = 0;
let patchSeq = 0;
let patchApplied = 0;
let seq = 0;
const inflight: Record<string, Key[]> = {};

function get(s: LampState, k: Key): unknown {
  return k.lastIndexOf("effect.", 0) === 0 ? (s.effect as Record<string, unknown>)[k.slice(7)] : (s as Record<string, unknown>)[k];
}

function put(s: LampState, k: Key, v: unknown): void {
  if (k.lastIndexOf("effect.", 0) === 0) (s.effect as Record<string, unknown>)[k.slice(7)] = v;
  else (s as Record<string, unknown>)[k] = v;
}

function same(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return a.join().toUpperCase() === b.join().toUpperCase();
  return a === b;
}

function leaves(p: Patch): Array<[Key, unknown]> {
  const out: Array<[Key, unknown]> = [];
  if (p.on !== undefined) out.push(["on", p.on]);
  if (p.brightness !== undefined) out.push(["brightness", p.brightness]);
  if (p.colors) out.push(["colors", p.colors]);
  if (p.effect) {
    for (const k of EFFECT_KEYS) {
      const v = (p.effect as Record<string, unknown>)[k];
      if (v !== undefined) out.push([("effect." + k) as Key, v]);
    }
  }
  return out;
}

function view(): LampState | null {
  if (!server) return null;
  const now = Date.now();
  const s: LampState = {
    on: server.on,
    brightness: server.brightness,
    colors: server.colors.slice(),
    effect: Object.assign({}, server.effect),
  };
  for (const k of Object.keys(holds) as Key[]) {
    const hd = holds[k]!;
    if (hd.until < now) delete holds[k];
    else put(s, k, hd.v);
  }
  return s;
}

function emit(): void {
  clearTimeout(expTimer);
  let next = Infinity;
  for (const k of Object.keys(holds) as Key[]) next = Math.min(next, holds[k]!.until);
  if (next < Infinity) expTimer = window.setTimeout(emit, Math.max(0, next - Date.now()) + 30);
  for (const f of listeners.slice()) f();
}

function setConn(c: Conn): void {
  if (conn !== c) {
    conn = c;
    emit();
  }
}

function drop(keys: Key[]): void {
  for (const k of keys) delete holds[k];
}

function applyServer(s: LampState, r: number | null): void {
  if (!s || !s.effect || !Array.isArray(s.colors)) return;
  if (r !== null) {
    if (r < rev) return;
    rev = r;
  }
  server = s;
  for (const k of Object.keys(holds) as Key[]) if (same(get(s, k), holds[k]!.v)) delete holds[k];
  emit();
}

// ---------- commands ----------

let pend: Patch | null = null;
let pendT = TAP_MS;
let lastSend = 0;
let qTimer = 0;

function merge(a: Patch | null, b: Patch): Patch {
  if (!a) return b;
  const m: Patch = Object.assign({}, a, b);
  if (a.effect && b.effect) m.effect = Object.assign({}, a.effect, b.effect);
  return m;
}

function flush(): void {
  clearTimeout(qTimer);
  qTimer = 0;
  if (!pend) return;
  const cmd: Command = { patch: pend, transition_ms: pendT };
  pend = null;
  lastSend = Date.now();
  send(cmd);
}

function send(cmd: Command): void {
  const keys = leaves(cmd.patch).map((x) => x[0]);
  if (ws && wsLive && ws.readyState === 1) {
    const id = "c" + ++seq;
    inflight[id] = keys;
    setTimeout(() => delete inflight[id], 10000);
    try {
      ws.send(JSON.stringify({ type: "cmd", id, data: cmd }));
      return;
    } catch {
      /* fall back to HTTP */
    }
  }
  cmdEpoch++;
  const mine = ++patchSeq;
  api<LampState>("PATCH", "/state", cmd).then(
    (s) => {
      if (mine < patchApplied) return;
      patchApplied = mine;
      if (s) applyServer(s, null);
    },
    (e) => {
      drop(keys);
      toast(errMsg(e), "bad");
      emit();
    },
  );
}

/**
 * Applies a change optimistically and sends it. phase "drag" = part of a slider or wheel drag
 * (120 ms fades, held until the drag ends); "end" = the drag's final value; "tap" = a single change.
 */
export function change(patch: Patch, phase: Phase = "tap"): void {
  if (!server) return;
  const until = Date.now() + (phase === "drag" ? DRAG_HOLD_MS : HOLD_MS);
  for (const [k, v] of leaves(patch)) holds[k] = { v, until };
  pend = merge(pend, patch);
  pendT = phase === "tap" ? TAP_MS : DRAG_MS;
  const wait = lastSend + THROTTLE_MS - Date.now();
  if (wait <= 0) flush();
  else if (!qTimer) qTimer = window.setTimeout(flush, wait);
  emit();
}

export async function applyPreset(p: Preset): Promise<void> {
  const until = Date.now() + HOLD_MS;
  const keys = leaves({
    on: p.state.on,
    brightness: p.state.brightness,
    colors: p.state.colors,
    effect: {
      id: p.state.effect.id,
      speed: p.state.effect.speed,
      intensity: p.state.effect.intensity,
      duration_ms: p.state.effect.duration_ms,
    },
  });
  for (const [k, v] of keys) holds[k] = { v, until };
  emit();
  cmdEpoch++;
  try {
    const s = await api<LampState>("POST", "/presets/" + p.slot + "/apply", { transition_ms: TAP_MS });
    if (s) applyServer(s, null);
  } catch (e) {
    drop(keys.map((x) => x[0]));
    toast(errMsg(e), "bad");
    emit();
  }
}

// ---------- connection ----------

function wsUrl(): string {
  return (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/api/v1/ws";
}

function connect(): void {
  clearTimeout(wsTimer);
  wsTimer = 0;
  if (paused || ws || typeof WebSocket === "undefined") return;
  let sock: WebSocket;
  try {
    sock = new WebSocket(wsUrl());
  } catch {
    wsDown(false);
    return;
  }
  ws = sock;
  const openTimer = window.setTimeout(() => sock.close(), 8000);
  sock.onopen = () => clearTimeout(openTimer);
  sock.onmessage = (ev) => {
    let m: LocalServerMessage;
    try {
      m = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    if (m.type === "state" && m.data) {
      if (!wsLive) {
        wsLive = true;
        wsAttempts = 0;
        busy = false;
        rev = -1; // a new connection (or a rebooted lamp) restarts the revision count
        stopPolling();
        pollFails = 0;
        conn = "live";
      }
      applyServer(m.data.state, typeof m.data.rev === "number" ? m.data.rev : null);
    } else if (m.type === "info" && m.data) {
      info = m.data;
      emit();
    } else if (m.type === "error") {
      const keys = m.ref ? inflight[m.ref] : undefined;
      if (keys) {
        drop(keys);
        delete inflight[m.ref!];
      }
      toast((m.data && m.data.message) || "The lamp refused that change.", "bad");
      emit();
    }
  };
  sock.onclose = (ev) => {
    clearTimeout(openTimer);
    if (ws !== sock) return;
    ws = null;
    wsLive = false;
    wsDown(ev.code === 1013);
  };
}

function wsDown(isBusy: boolean): void {
  busy = isBusy;
  if (paused) return;
  startPolling();
  wsAttempts++;
  const d = Math.min(30000, (isBusy ? 5000 : 2000) * Math.pow(2, Math.min(wsAttempts - 1, 4)));
  wsTimer = window.setTimeout(connect, d * (0.75 + Math.random() * 0.5));
  emit();
}

function startPolling(): void {
  if (polling || paused) return;
  polling = true;
  if (conn === "live") conn = "polling";
  poll();
}

function stopPolling(): void {
  polling = false;
  clearTimeout(pollTimer);
}

async function poll(): Promise<void> {
  const epoch = cmdEpoch;
  try {
    const s = await api<LampState>("GET", "/state", undefined, { timeout: 5000 });
    if (epoch === cmdEpoch && !wsLive) applyServer(s, null);
    if (++polls % 5 === 0) info = await api<DeviceInfo>("GET", "/info", undefined, { timeout: 5000 });
    pollFails = 0;
    if (!wsLive) setConn(ws ? "connecting" : "polling");
  } catch {
    pollFails++;
    if (pollFails >= 2 && !wsLive) setConn("offline");
  }
  if (!polling) return;
  pollTimer = window.setTimeout(poll, pollFails ? Math.min(10000, POLL_MS * pollFails) : POLL_MS);
}

function pause(): void {
  paused = true;
  stopPolling();
  clearTimeout(wsTimer);
  if (ws) {
    const s = ws;
    ws = null;
    wsLive = false;
    s.onclose = null;
    s.close(1000);
  }
}

function resume(): void {
  if (!paused) return;
  paused = false;
  wsAttempts = 0;
  startPolling();
  connect();
}

export const live = {
  get state(): LampState | null {
    return view();
  },
  get info(): DeviceInfo | null {
    return info;
  },
  get conn(): Conn {
    return conn;
  },
  /** The lamp turned the WebSocket away (too many open pages). */
  get busy(): boolean {
    return busy;
  },
  setInfo(i: DeviceInfo): void {
    info = i;
    emit();
  },
  async refreshInfo(): Promise<DeviceInfo> {
    const i = await api<DeviceInfo>("GET", "/info");
    live.setInfo(i);
    return i;
  },
  sub(fn: () => void): () => void {
    listeners.push(fn);
    return () => {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    };
  },
  start(i: DeviceInfo, s?: LampState): void {
    info = i;
    if (s) server = s;
    startPolling();
    connect();
    document.addEventListener("visibilitychange", () => {
      clearTimeout(hideTimer);
      if (document.hidden) hideTimer = window.setTimeout(pause, 15000);
      else resume();
    });
    window.addEventListener("pageshow", resume);
  },
  /** Drops the socket and polls until the lamp is back (after reboot / OTA). */
  reconnect(): void {
    pause();
    resume();
  },
};
