// A simulated lamp that speaks the device protocol (04 §4) like the firmware does (03 §4, §10, §12, §15):
// pairing, hello/welcome, dirty tracking with monotonic ages, time sync and apply_at, heartbeats, telemetry,
// reconnect with backoff, close codes, presets, and a simulated OTA that really downloads and checks the image.
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import {
  CloseCode,
  DEFAULT_LED_CONFIG,
  DEFAULT_STATE,
  EFFECT_IDS,
  PROTO_VERSION,
  SyncClock,
  applyPatch,
  claimResponseSchema,
  cloneState,
  decodeMessage,
  encodeMessage,
  lampStateSchema,
  pickFields,
  randomSeed,
  serverToLamp,
  type DataOf,
  type DeviceInfo,
  type Dirty,
  type FieldName,
  type LampState,
  type LedConfig,
  type Link,
  type Preset,
  type StatePatch,
} from "@doublelamp/protocol";

export type ReportOrigin = "local" | "homekit" | "button";
export type LampStatus =
  | "idle"
  | "claiming"
  | "connecting"
  | "online"
  | "offline"
  | "rebooting"
  | "repair_needed"
  | "unclaimed"
  | "proto_unsupported"
  | "stopped";

export interface LampTimings {
  /** time.ping every 5 s for the first 30 s after connecting, then every 20 s (03 §12). */
  fastPingMs: number;
  fastPingWindowMs: number;
  pingMs: number;
  telemetryMs: number;
  firstTelemetryMs: number;
  /** Reconnect backoff: full jitter, 2 s → 60 s; resets after 60 s of stable connection (03 §10). */
  backoffBaseMs: number;
  backoffMaxMs: number;
  stableMs: number;
  /** After close 4004 (proto unsupported): retry every hour. */
  protoRetryMs: number;
  /** How long a simulated reboot keeps the lamp off the network. */
  rebootMs: number;
  /** After an OTA reboot: how long the self-test takes before ota.progress "done". */
  selfTestMs: number;
  /** Reconnect if nothing arrives for this long. */
  silenceTimeoutMs: number;
}

export const DEFAULT_TIMINGS: LampTimings = {
  fastPingMs: 5_000,
  fastPingWindowMs: 30_000,
  pingMs: 20_000,
  telemetryMs: 60_000,
  firstTelemetryMs: 2_000,
  backoffBaseMs: 2_000,
  backoffMaxMs: 60_000,
  stableMs: 60_000,
  protoRetryMs: 3_600_000,
  rebootMs: 1_500,
  selfTestMs: 3_000,
  silenceTimeoutMs: 45_000,
};

export interface VirtualLampOptions {
  /** Server base URL, e.g. http://localhost:8080. */
  server: string;
  /** Pairing code for the first run. */
  code?: string;
  name?: string;
  /** dl-xxxxxx; derived from the name when omitted, so reruns with the same name reuse the credentials. */
  id?: string;
  pixels?: number;
  fw?: string;
  /** Where credentials and state are kept between runs; null keeps them in memory only. Default: OS temp dir. */
  stateDir?: string | null;
  /** Simulated one-way network delay (each direction), ± jitter, in ms. */
  latencyMs?: number;
  jitterMs?: number;
  /** Probability of losing each message (both directions; hello and welcome are never lost). */
  drop?: number;
  /** Go offline after this long, and (optionally) come back after offlineForMs. */
  offlineAfterMs?: number;
  offlineForMs?: number;
  /** The new image "crashes": the lamp comes back on the old firmware and reports rollback: true. */
  crashOnOta?: boolean;
  reportOrigin?: ReportOrigin;
  initialState?: LampState;
  timings?: Partial<LampTimings>;
  /** Local clock (ms). Defaults to performance.timeOrigin + performance.now(). */
  localClock?: () => number;
}

interface Credentials {
  device_token: string;
  ws_url: string;
}

interface StoredLamp {
  id: string;
  name: string;
  server: string;
  fw: string;
  credentials: Credentials | null;
  state: LampState;
  /** Fields changed while offline; their age is unknown after a restart (04 §4.3). */
  dirty: FieldName[];
}

export interface AppliedState {
  state: LampState;
  apply_at?: number;
  transition_ms: number;
  origin: string;
  /** Sync-clock time at which the visible change happened. */
  appliedAt: number;
}

export function deviceIdForName(name: string): string {
  return "dl-" + createHash("sha256").update(name).digest("hex").slice(0, 6);
}

export function defaultStateDir(): string {
  return path.join(os.tmpdir(), "doublelamp-virtual-lamps");
}

/** -1 / 0 / 1 for dotted versions ("1.10.0" > "1.9.3"); a pre-release sorts before its release. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core, pre] = v.replace(/^v/, "").split("-", 2);
    return { nums: (core ?? "").split(".").map((x) => Number.parseInt(x, 10) || 0), pre: pre ?? null };
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.nums.length, pb.nums.length); i++) {
    const d = (pa.nums[i] ?? 0) - (pb.nums[i] ?? 0);
    if (d) return Math.sign(d);
  }
  if (pa.pre === pb.pre) return 0;
  if (pa.pre === null) return 1;
  if (pb.pre === null) return -1;
  return pa.pre < pb.pre ? -1 : 1;
}

/**
 * Events: "log" (line), "status" (LampStatus), "welcome", "state.set", "applied" (AppliedState), "local",
 * "link", "presets", "identify", "nudge", "ota" ({phase, ...}), "pong", "disconnected", "message" (type, data).
 */
export class VirtualLamp extends EventEmitter {
  readonly id: string;
  name: string;
  fw: string;
  pixels: number;
  config: LedConfig;
  /** Logical state: updated as soon as a change arrives. */
  state: LampState;
  /** What the strip shows: changes from the server become visible at apply_at. */
  visible: LampState;
  presets: Preset[] = [];
  link: Link | null = null;
  status: LampStatus = "idle";
  readonly clock: SyncClock;
  lastStateSet: (DataOf<typeof serverToLamp, "state.set"> & { receivedAt: number }) | null = null;
  lastApplied: AppliedState | null = null;
  readonly stats = { sent: 0, received: 0, dropped: 0, reconnects: 0 };
  /** Overlay shown by the terminal renderer (identify / nudge). */
  overlay: { kind: "identify" | "nudge"; color: string; until: number; count: number } | null = null;

  private readonly opts: VirtualLampOptions;
  private readonly t: LampTimings;
  private readonly local: () => number;
  private credentials: Credentials | null = null;
  private ws: WebSocket | null = null;
  private welcomed = false;
  private stopped = true;
  private forcedOffline = false;
  private rebooting = false;
  private authFailed = false;
  private reclaimTried = false;
  private attempt = 0;
  private rev = 0;
  private bootReason = "power_on";
  private rollback = false;
  private pendingVerify = false;
  private otaDoneJob: number | null = null;
  private otaRunning = false;
  private bootAt: number;
  private connectedAt = 0;
  private lastRx = 0;
  private applySeq = 0;
  private lastAppliedSeq = 0;
  private readonly dirty = new Map<FieldName, number | null>();
  private readonly pendingPings = new Map<number, number>();
  private readonly nextAt = { up: 0, down: 0 };
  private readonly timers = new Set<NodeJS.Timeout>();
  private pingTimer: NodeJS.Timeout | null = null;
  private telemetryTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stableTimer: NodeJS.Timeout | null = null;
  private watchdog: NodeJS.Timeout | null = null;
  private persistTimer: NodeJS.Timeout | null = null;

  constructor(opts: VirtualLampOptions) {
    super();
    this.opts = opts;
    this.t = { ...DEFAULT_TIMINGS, ...opts.timings };
    this.local = opts.localClock ?? (() => performance.timeOrigin + performance.now());
    this.clock = new SyncClock(this.local);
    this.name = opts.name ?? "Virtual lamp";
    this.id = opts.id ?? deviceIdForName(this.name);
    if (!/^dl-[0-9a-f]{6}$/.test(this.id)) throw new Error(`device id must look like dl-xxxxxx, got "${this.id}"`);
    this.fw = opts.fw ?? "1.0.0";
    this.pixels = opts.pixels ?? 10;
    this.config = { ...DEFAULT_LED_CONFIG, pixel_count: this.pixels };
    this.state = cloneState(opts.initialState ?? DEFAULT_STATE);
    this.visible = cloneState(this.state);
    this.bootAt = performance.now();
    this.loadStored();
  }

  // ------------------------------------------------------------------ public API

  get online(): boolean {
    return this.welcomed;
  }

  get serverUrl(): string {
    return this.opts.server.replace(/\/+$/, "");
  }

  /** Current estimate of the server clock. */
  syncNow(): number {
    return this.clock.now();
  }

  get firmware(): string {
    return this.fw;
  }

  hasCredentials(): boolean {
    return this.credentials !== null;
  }

  /** Claims with the pairing code if needed, then connects (doesn't wait for welcome). */
  async start(): Promise<void> {
    this.stopped = false;
    if (!this.credentials) {
      if (!this.opts.code) throw new Error("this lamp has no stored credentials; pass a pairing code (--code XXXX-XXXX)");
      this.reclaimTried = true; // this run's code is used up
      await this.claim(this.opts.code);
    }
    this.connect();
    if (this.opts.offlineAfterMs !== undefined) {
      this.later(() => {
        this.setOffline(true);
        if (this.opts.offlineForMs !== undefined) this.later(() => this.setOffline(false), this.opts.offlineForMs);
      }, this.opts.offlineAfterMs);
    }
  }

  async stop(): Promise<void> {
    if (this.stopped && !this.ws) return;
    this.stopped = true;
    this.setStatus("stopped");
    this.clearConnectionTimers();
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const ws = this.ws;
    this.ws = null;
    this.welcomed = false;
    if (ws && ws.readyState !== WebSocket.CLOSED) {
      await new Promise<void>((resolve) => {
        const done = setTimeout(() => {
          ws.terminate();
          resolve();
        }, 1000);
        ws.once("close", () => {
          clearTimeout(done);
          resolve();
        });
        try {
          ws.close(1000, "stopping");
        } catch {
          ws.terminate();
        }
      });
    }
    this.persistNow();
  }

  /** Waits until welcome has been received. */
  waitOnline(timeoutMs = 10_000): Promise<void> {
    if (this.welcomed) return Promise.resolve();
    return this.waitFor("welcome", () => true, timeoutMs).then(() => undefined);
  }

  /** Resolves with the arguments of the next `event` for which `pred` returns true. */
  waitFor<T = unknown>(event: string, pred: (arg: T) => boolean = () => true, timeoutMs = 10_000): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off(event, handler);
        reject(new Error(`${this.name}: timed out waiting for "${event}"`));
      }, timeoutMs);
      const handler = (arg: T) => {
        if (!pred(arg)) return;
        clearTimeout(timer);
        this.off(event, handler);
        resolve(arg);
      };
      this.on(event, handler);
    });
  }

  /**
   * A change made on the lamp itself (local UI, button, Apple Home). Applied at once; reported with the configured
   * origin while connected, otherwise remembered as dirty with its monotonic change time.
   */
  localChange(patch: StatePatch, origin: ReportOrigin = this.opts.reportOrigin ?? "local"): FieldName[] {
    const { state, changed } = applyPatch(this.state, patch, { now: Math.round(this.clock.now()), newSeed: randomSeed });
    if (!changed.length) return [];
    this.state = state;
    this.visible = cloneState(state);
    this.rev += 1;
    this.applySeq += 1;
    this.lastAppliedSeq = this.applySeq;
    if (this.welcomed) {
      // Whole fields (the full effect object, epoch included) so the server keeps this lamp's phase.
      this.send("state.report", { rev: this.rev, patch: pickFields(state, changed), origin });
    } else {
      const now = performance.now();
      for (const f of changed) this.dirty.set(f, now);
    }
    this.persistSoon();
    this.emit("local", { patch, changed, origin });
    return changed;
  }

  /** Simulates losing (or regaining) the network. */
  setOffline(offline: boolean): void {
    if (offline === this.forcedOffline) return;
    this.forcedOffline = offline;
    if (offline) {
      this.log("network down (simulated)");
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      const ws = this.ws;
      if (ws) ws.terminate();
      this.setStatus("offline");
    } else {
      this.log("network up (simulated)");
      this.attempt = 0;
      this.connect();
    }
  }

  get isForcedOffline(): boolean {
    return this.forcedOffline;
  }

  /** Simulates a reboot: the connection drops, and fields changed while offline lose their known age. */
  reboot(reason = "sw_reset", opts: { fw?: string; rollback?: boolean; pendingVerify?: boolean } = {}): void {
    this.log(`rebooting (${reason})`);
    for (const f of this.dirty.keys()) this.dirty.set(f, null);
    this.bootReason = reason;
    this.bootAt = performance.now();
    if (opts.fw) this.fw = opts.fw;
    this.rollback = opts.rollback ?? false;
    this.pendingVerify = opts.pendingVerify ?? false;
    this.rebooting = true;
    this.setStatus("rebooting");
    this.clearConnectionTimers();
    const ws = this.ws;
    this.ws = null;
    this.welcomed = false;
    if (ws) {
      try {
        ws.close(1001, "rebooting");
      } catch {
        ws.terminate();
      }
    }
    this.persistNow();
    this.later(() => {
      this.rebooting = false;
      if (!this.stopped) this.connect();
    }, this.t.rebootMs);
  }

  info(): DeviceInfo {
    return {
      id: this.id,
      name: this.name,
      fw: this.fw,
      proto: PROTO_VERSION,
      build: "virtual",
      host: `doublelamp-${this.id.slice(3)}.local`,
      hw: { chip: "virtual", pixels: this.pixels, channels: 3, color_order: this.config.color_order },
      net: { mode: "sta", ssid: "virtual-wifi", ip: "127.0.0.1", rssi: this.rssi() },
      cloud: {
        state: this.welcomed ? "online" : "connecting",
        url: this.serverUrl,
        linked: this.link?.linked ?? false,
        group_name: this.link?.name ?? "",
      },
      homekit: { state: "off", controllers: 0 },
      insecure_server_allowed: true,
      uptime_s: this.uptimeS(),
    };
  }

  // ------------------------------------------------------------------ pairing & persistence

  private stateFile(): string | null {
    if (this.opts.stateDir === null) return null;
    return path.join(this.opts.stateDir ?? defaultStateDir(), `${this.id}.json`);
  }

  private loadStored(): void {
    const file = this.stateFile();
    if (!file) return;
    let stored: StoredLamp;
    try {
      stored = JSON.parse(readFileSync(file, "utf8")) as StoredLamp;
    } catch {
      return;
    }
    if (stored.server?.replace(/\/+$/, "") !== this.serverUrl) {
      this.log(`stored credentials are for ${stored.server}; pairing again with ${this.serverUrl}`);
      return;
    }
    this.credentials = stored.credentials ?? null;
    if (!this.opts.name && stored.name) this.name = stored.name;
    if (stored.fw && !this.opts.fw) this.fw = stored.fw;
    const st = lampStateSchema.safeParse(stored.state);
    if (st.success && !this.opts.initialState) {
      this.state = st.data as LampState;
      this.visible = cloneState(this.state);
    }
    // Restored from "flash": the age of offline edits is unknown now.
    for (const f of stored.dirty ?? []) this.dirty.set(f, null);
  }

  private persistSoon(): void {
    if (this.persistTimer || !this.stateFile()) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persistNow();
    }, 500);
  }

  private persistNow(): void {
    const file = this.stateFile();
    if (!file) return;
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = null;
    const data: StoredLamp = {
      id: this.id,
      name: this.name,
      server: this.serverUrl,
      fw: this.fw,
      credentials: this.credentials,
      state: this.state,
      dirty: [...this.dirty.keys()],
    };
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(data, null, 2));
    } catch (err) {
      this.log(`could not save state: ${(err as Error).message}`);
    }
  }

  private eraseCredentials(): void {
    this.credentials = null;
    const file = this.stateFile();
    if (file) {
      try {
        rmSync(file, { force: true });
      } catch {
        // ignore
      }
    }
  }

  /** POST /api/v1/devices/claim (04 §4.5). */
  async claim(code: string): Promise<void> {
    this.setStatus("claiming");
    const res = await fetch(`${this.serverUrl}/api/v1/devices/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": `DoubleLamp/${this.fw} (virtual)` },
      body: JSON.stringify({
        code,
        device_id: this.id,
        name: this.name,
        fw: this.fw,
        hw: { chip: "virtual", pixels: this.pixels, channels: 3 },
      }),
    });
    const body = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
    if (!res.ok) {
      this.setStatus("idle");
      throw new Error(`claim failed: HTTP ${res.status} ${body.error?.code ?? ""}: ${body.error?.message ?? ""}`.trim());
    }
    this.credentials = claimResponseSchema.parse(body);
    this.log(`claimed as ${this.id}; device socket ${this.credentials.ws_url}`);
    this.persistNow();
  }

  // ------------------------------------------------------------------ connection

  private setStatus(s: LampStatus): void {
    if (this.status === s) return;
    this.status = s;
    this.emit("status", s);
  }

  private log(line: string): void {
    this.emit("log", line);
  }

  private later(fn: () => void, ms: number): NodeJS.Timeout {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      fn();
    }, ms);
    this.timers.add(timer);
    return timer;
  }

  private connect(): void {
    if (this.stopped || this.forcedOffline || this.rebooting || !this.credentials || this.ws) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.setStatus("connecting");
    this.authFailed = false;
    const ws = new WebSocket(this.credentials.ws_url, {
      headers: { Authorization: `Bearer ${this.credentials.device_token}`, "User-Agent": `DoubleLamp/${this.fw} (virtual)` },
      handshakeTimeout: 10_000,
    });
    this.ws = ws;
    ws.on("open", () => {
      if (this.ws !== ws) return;
      this.lastRx = performance.now();
      this.sendHello();
      this.watchdog = setInterval(() => {
        if (this.ws === ws && performance.now() - this.lastRx > this.t.silenceTimeoutMs) {
          this.log("no traffic from the server; reconnecting");
          ws.terminate();
        }
      }, Math.min(5_000, this.t.silenceTimeoutMs));
    });
    ws.on("message", (data) => this.netIn(ws, data.toString()));
    ws.on("error", (err) => {
      const m = /Unexpected server response: (\d+)/.exec(err.message);
      if (m && m[1] === "401") this.authFailed = true;
      this.log(`socket error: ${err.message}`);
    });
    ws.on("close", (code, reason) => this.onClose(ws, code, reason.toString()));
  }

  private clearConnectionTimers(): void {
    for (const timer of [this.pingTimer, this.telemetryTimer, this.stableTimer]) if (timer) clearTimeout(timer);
    if (this.watchdog) clearInterval(this.watchdog);
    this.pingTimer = this.telemetryTimer = this.stableTimer = this.watchdog = null;
    this.pendingPings.clear();
  }

  private onClose(ws: WebSocket, code: number, reason: string): void {
    if (this.ws !== ws) {
      // A socket we already let go of (reboot, stop).
      return;
    }
    this.ws = null;
    const wasOnline = this.welcomed;
    this.welcomed = false;
    this.clearConnectionTimers();
    this.emit("disconnected", { code, reason });
    if (wasOnline) this.stats.reconnects += 1;
    this.log(`disconnected (${code}${reason ? ` ${reason}` : ""})`);
    if (this.stopped || this.rebooting) return;
    if (this.authFailed || code === CloseCode.BadToken) {
      if (this.opts.code && !this.reclaimTried) {
        // A pairing code was given this run: the stored token is stale, so pair again with it once.
        this.reclaimTried = true;
        this.log("the server rejected the stored token; pairing again with the given code");
        this.credentials = null;
        this.claim(this.opts.code).then(
          () => this.connect(),
          (err: Error) => {
            this.log(`${err.message}; re-pair needed`);
            this.setStatus("repair_needed");
          },
        );
        return;
      }
      this.log("the server rejected the token: re-pair needed (not retrying)");
      this.setStatus("repair_needed");
      return;
    }
    if (code === CloseCode.Unclaimed) {
      this.log("unclaimed by the server: credentials erased");
      this.eraseCredentials();
      this.setStatus("unclaimed");
      return;
    }
    if (this.forcedOffline) {
      this.setStatus("offline");
      return;
    }
    if (code === CloseCode.ProtoUnsupported) {
      this.log("protocol version not supported: firmware update needed; retrying in 1 h");
      this.setStatus("proto_unsupported");
      this.reconnectTimer = setTimeout(() => this.connect(), this.t.protoRetryMs);
      return;
    }
    const delay = Math.random() * Math.min(this.t.backoffMaxMs, this.t.backoffBaseMs * 2 ** this.attempt);
    this.attempt = Math.min(this.attempt + 1, 16);
    this.setStatus("connecting");
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  // ------------------------------------------------------------------ simulated network

  private netDelay(dir: "up" | "down"): number {
    const lat = this.opts.latencyMs ?? 0;
    const jit = this.opts.jitterMs ?? 0;
    if (lat <= 0 && jit <= 0) return 0;
    const d = Math.max(0, lat + (Math.random() * 2 - 1) * jit);
    const now = performance.now();
    // FIFO, like a TCP stream: a message never overtakes the previous one.
    const at = Math.max(this.nextAt[dir], now + d);
    this.nextAt[dir] = at;
    return at - now;
  }

  private send(type: string, data: unknown, opts: { id?: string; ref?: string } = {}): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    if (type !== "hello" && this.opts.drop && Math.random() < this.opts.drop) {
      this.stats.dropped += 1;
      return true;
    }
    const text = encodeMessage(type, data, opts);
    const delay = this.netDelay("up");
    this.stats.sent += 1;
    if (delay <= 0) ws.send(text);
    else
      this.later(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(text);
      }, delay);
    return true;
  }

  private netIn(ws: WebSocket, text: string): void {
    if (this.ws !== ws) return;
    if (this.opts.drop && !text.includes('"type":"welcome"') && Math.random() < this.opts.drop) {
      this.stats.dropped += 1;
      return;
    }
    const delay = this.netDelay("down");
    if (delay <= 0) this.onMessage(ws, text);
    else
      this.later(() => {
        if (this.ws === ws) this.onMessage(ws, text);
      }, delay);
  }

  // ------------------------------------------------------------------ protocol

  private rssi(): number {
    return -50 - Math.round(Math.random() * 15);
  }

  private uptimeS(): number {
    return Math.floor((performance.now() - this.bootAt) / 1000);
  }

  private dirtyForHello(): Dirty {
    const out: Dirty = {};
    const now = performance.now();
    for (const [f, t] of this.dirty) out[f] = { age_ms: t === null ? null : Math.max(0, Math.round(now - t)) };
    return out;
  }

  private sendHello(): void {
    this.send("hello", {
      device_id: this.id,
      proto: PROTO_VERSION,
      fw: this.fw,
      build: "virtual",
      hw: { chip: "virtual", pixels: this.pixels, channels: 3, color_order: this.config.color_order },
      state: this.state,
      dirty: this.dirtyForHello(),
      boot_reason: this.bootReason,
      rollback: this.rollback,
      pending_verify: this.pendingVerify,
      uptime_s: this.uptimeS(),
      ip: "127.0.0.1",
      rssi: this.rssi(),
      effects: [...EFFECT_IDS],
      info: this.info(),
      config: this.config,
    });
    this.rollback = false; // reported once
  }

  private sendInfo(): void {
    if (this.welcomed) this.send("info", { info: this.info(), config: this.config });
  }

  private sendPing(): void {
    const t0local = this.local();
    const t0 = Math.round(this.clock.now());
    this.pendingPings.set(t0, t0local);
    if (this.pendingPings.size > 16) this.pendingPings.delete(this.pendingPings.keys().next().value!);
    this.send("time.ping", { t0 });
  }

  private schedulePing(): void {
    const since = performance.now() - this.connectedAt;
    const interval = since < this.t.fastPingWindowMs ? this.t.fastPingMs : this.t.pingMs;
    this.pingTimer = setTimeout(() => {
      this.sendPing();
      this.schedulePing();
    }, interval);
  }

  private sendTelemetry(): void {
    this.send("telemetry", {
      rssi: this.rssi(),
      heap_free: 120_000 + Math.round(Math.random() * 8000),
      heap_min: 96_000,
      uptime_s: this.uptimeS(),
      fps: this.config.fps,
      reconnects: this.stats.reconnects,
      temp_c: 41 + Math.round(Math.random() * 30) / 10,
    });
  }

  private onMessage(ws: WebSocket, text: string): void {
    if (this.ws !== ws) return;
    this.lastRx = performance.now();
    this.stats.received += 1;
    const r = decodeMessage(serverToLamp, text);
    if (!r.ok) {
      this.log(`ignoring a bad message: ${r.message}`);
      if (r.id) this.send("error", { code: r.code, message: r.message }, { ref: r.id });
      return;
    }
    const m = r.msg;
    this.emit("message", m.type, m.data);
    switch (m.type) {
      case "welcome":
        this.onWelcome(m.data);
        break;
      case "state.set":
        this.onStateSet(m.data);
        break;
      case "time.pong": {
        const t0local = this.pendingPings.get(m.data.t0);
        if (t0local === undefined) break;
        this.pendingPings.delete(m.data.t0);
        const sample = this.clock.addSample(t0local, m.data.t1, m.data.t2, this.local());
        this.emit("pong", sample);
        break;
      }
      case "link":
        this.link = m.data;
        this.emit("link", m.data);
        this.sendInfo();
        break;
      case "config.set":
        this.config = { ...this.config, ...m.data };
        this.pixels = this.config.pixel_count;
        this.log(`LED config updated: ${JSON.stringify(m.data)}`);
        this.sendInfo();
        break;
      case "presets.sync":
        this.presets = m.data.presets;
        this.emit("presets", this.presets);
        break;
      case "identify":
        this.overlay = { kind: "identify", color: "#FFFFFF", until: performance.now() + m.data.duration_ms, count: 0 };
        this.emit("identify", m.data);
        break;
      case "nudge":
        this.overlay = { kind: "nudge", color: m.data.color, until: performance.now() + m.data.count * 700, count: m.data.count };
        this.emit("nudge", m.data);
        break;
      case "ota.start":
        void this.onOtaStart(m.data);
        break;
      case "reboot":
        this.later(() => this.reboot("sw_reset"), 50);
        break;
      case "unclaim":
        this.eraseCredentials();
        break;
      case "name.set":
        this.name = m.data.name;
        this.log(`renamed to "${this.name}" by the server`);
        this.persistSoon();
        this.sendInfo();
        this.emit("name", this.name);
        break;
      case "ack":
      case "error":
        break;
    }
    if (m.id && m.type !== "ack" && m.type !== "error") this.send("ack", {}, { ref: m.id });
  }

  private onWelcome(data: DataOf<typeof serverToLamp, "welcome">): void {
    this.welcomed = true;
    this.setStatus("online");
    this.link = data.link;
    if (data.desired) {
      this.state = cloneState(data.desired);
      this.visible = cloneState(data.desired);
      this.applySeq += 1;
      this.lastAppliedSeq = this.applySeq;
    }
    this.dirty.clear();
    this.connectedAt = performance.now();
    this.sendPing();
    this.schedulePing();
    this.telemetryTimer = setTimeout(() => {
      this.sendTelemetry();
      this.telemetryTimer = setInterval(() => this.sendTelemetry(), this.t.telemetryMs);
    }, this.t.firstTelemetryMs);
    this.stableTimer = setTimeout(() => {
      this.attempt = 0;
    }, this.t.stableMs);
    this.persistSoon();
    this.log(`online${data.desired ? "" : " (server adopted our state)"}${data.link?.linked ? `, linked in "${data.link.name}"` : ""}`);
    this.emit("welcome", data);
    if (this.otaDoneJob !== null) {
      const job = this.otaDoneJob;
      this.otaDoneJob = null;
      this.later(() => {
        // Self-test passed: mark the app valid (03 §15).
        this.pendingVerify = false;
        this.send("ota.progress", { job_id: job, phase: "done", pct: 100 });
        this.log(`firmware ${this.fw} verified`);
        this.emit("ota", { phase: "done", job_id: job, fw: this.fw });
      }, this.t.selfTestMs);
    }
  }

  private onStateSet(data: DataOf<typeof serverToLamp, "state.set">): void {
    // The logical state updates at once; apply_at only delays the visible change (03 §4).
    this.state = cloneState(data.state);
    this.lastStateSet = { ...data, receivedAt: this.clock.now() };
    this.emit("state.set", data);
    const seq = ++this.applySeq;
    const apply = () => {
      if (seq < this.lastAppliedSeq) return;
      this.lastAppliedSeq = seq;
      this.visible = cloneState(data.state);
      this.lastApplied = { state: cloneState(data.state), apply_at: data.apply_at, transition_ms: data.transition_ms, origin: data.origin, appliedAt: this.clock.now() };
      this.emit("applied", this.lastApplied);
    };
    const delay = data.apply_at !== undefined ? data.apply_at - this.clock.now() : 0;
    if (delay > 1) this.later(apply, delay);
    else apply();
    this.persistSoon();
  }

  private async onOtaStart(d: DataOf<typeof serverToLamp, "ota.start">): Promise<void> {
    const progress = (phase: "download" | "verify" | "reboot" | "done" | "failed", pct: number, error?: string) => {
      this.send("ota.progress", { job_id: d.job_id, phase, pct, ...(error ? { error } : {}) });
      this.emit("ota", { phase, pct, job_id: d.job_id, ...(error ? { error } : {}) });
    };
    if (this.otaRunning) {
      progress("failed", 0, "an update is already running");
      return;
    }
    this.otaRunning = true;
    this.log(`OTA ${this.fw} → ${d.version}: downloading`);
    try {
      if (!d.allow_downgrade && compareVersions(d.version, this.fw) < 0) throw new Error(`downgrade from ${this.fw} to ${d.version} refused`);
      progress("download", 0);
      const res = await fetch(d.url, { headers: { "User-Agent": `DoubleLamp/${this.fw} (virtual)` } });
      if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
      const reader = res.body.getReader();
      const chunks: Buffer[] = [];
      let received = 0;
      let reported = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(Buffer.from(value));
        received += value.byteLength;
        const pct = Math.min(100, Math.floor((received / d.size) * 100));
        if (pct >= reported + 10 && pct < 100) {
          reported = pct - (pct % 10);
          progress("download", reported);
        }
      }
      progress("download", 100);
      const image = Buffer.concat(chunks);
      progress("verify", 0);
      if (image.length !== d.size) throw new Error(`size mismatch: got ${image.length} bytes, expected ${d.size}`);
      const sha = createHash("sha256").update(image).digest("hex");
      if (sha !== d.sha256) throw new Error("sha256 mismatch");
      progress("verify", 100);
      progress("reboot", 100);
      // Reboot once the progress messages have left (they may sit in the simulated link for a while).
      const flushIn = Math.max(0, this.nextAt.up - performance.now()) + 100;
      this.later(() => {
        this.otaRunning = false;
        if (this.opts.crashOnOta) {
          this.log(`firmware ${d.version} crashed during its self-test; the bootloader rolled back to ${this.fw}`);
          this.reboot("panic", { rollback: true });
        } else {
          this.otaDoneJob = d.job_id;
          this.reboot("ota", { fw: d.version, pendingVerify: true });
        }
      }, flushIn);
    } catch (err) {
      this.otaRunning = false;
      this.log(`OTA failed: ${(err as Error).message}`);
      progress("failed", 0, (err as Error).message);
    }
  }
}
