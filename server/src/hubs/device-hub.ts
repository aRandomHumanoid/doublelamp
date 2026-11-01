// /ws/device (04 §4, 05 §5): bearer-token auth, hello/welcome, heartbeats, outbound queues, lamp reports.
import type WebSocket from "ws";
import {
  CloseCode,
  HEARTBEAT,
  LIMITS,
  PROTO_VERSION,
  decodeMessage,
  encodeMessage,
  lampToServer,
  type DataOf,
  type DeviceView,
  type Hello,
  type serverToLamp,
} from "@doublelamp/protocol";
import type { ActivityLog } from "../activity";
import type { DeviceRecord, DeviceRegistry } from "../devices";
import type { StateSetOut, SyncEngine } from "../engine/engine";
import type { Logger } from "../log";
import type { OtaManager } from "../ota/jobs";
import type { SceneStore } from "../scenes";
import type { TelemetryRing } from "../telemetry";

/** Above this, non-essential messages (presets.sync duplicates, identify) are dropped (05 §5). */
export const DROP_NON_ESSENTIAL_BYTES = 64 * 1024;
/** Above this, state.set waits and coalesces: only the newest full state is kept. */
const COALESCE_BYTES = 8 * 1024;
const WELCOME_HEARTBEAT_S = HEARTBEAT.lampPingIntervalMs / 1000;

export interface DeviceHubTimings {
  helloTimeoutMs: number;
  silenceTimeoutMs: number;
  sweepIntervalMs: number;
}

export const DEFAULT_DEVICE_TIMINGS: DeviceHubTimings = {
  helloTimeoutMs: 10_000,
  silenceTimeoutMs: HEARTBEAT.silenceTimeoutMs,
  sweepIntervalMs: 5_000,
};

export interface DeviceHubDeps {
  engine: SyncEngine;
  devices: DeviceRegistry;
  ota: () => OtaManager;
  activity: ActivityLog;
  telemetry: TelemetryRing;
  scenes: SceneStore;
  clock: () => number;
  log: Logger;
  /** To browsers. */
  broadcast: (type: string, data: unknown) => void;
  deviceView: (id: string) => DeviceView | null;
  /** The lamp renamed itself (info.name): update the name everywhere. */
  adoptName: (id: string, name: string) => void;
  timings?: Partial<DeviceHubTimings>;
}

interface Conn {
  readonly ws: WebSocket;
  readonly deviceId: string;
  readonly ip: string;
  helloDone: boolean;
  lastRx: number;
  helloTimer: NodeJS.Timeout | null;
  killTimer: NodeJS.Timeout | null;
  flushTimer: NodeJS.Timeout | null;
  pendingState: StateSetOut | null;
  lastPresets: string | null;
  lastLogAt: number;
  closing: boolean;
  /** Unclaimed or replaced: closing it must not mark the lamp offline. */
  superseded: boolean;
  /** This connection replaced one that was online (browsers still show the lamp online). */
  replacedOnline: boolean;
  pings: number;
}

function rawToString(data: WebSocket.RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return data.toString("utf8");
}

export class DeviceHub {
  private readonly conns = new Map<string, Conn>();
  private readonly timings: DeviceHubTimings;
  private readonly sweepTimer: NodeJS.Timeout;

  constructor(private readonly deps: DeviceHubDeps) {
    this.timings = { ...DEFAULT_DEVICE_TIMINGS, ...deps.timings };
    this.sweepTimer = setInterval(() => this.sweep(), this.timings.sweepIntervalMs);
    this.sweepTimer.unref();
  }

  /** `Authorization: Bearer <device_token>` → the lamp, or null (→ 401 at upgrade). */
  authenticate(header: string | undefined): DeviceRecord | null {
    const m = /^Bearer\s+([A-Za-z0-9_-]{16,128})\s*$/.exec(header ?? "");
    if (!m) return null;
    return this.deps.devices.byToken(m[1]!) ?? null;
  }

  isConnected(id: string): boolean {
    return this.conns.get(id)?.helloDone ?? false;
  }

  connectionCount(): number {
    return this.conns.size;
  }

  handle(ws: WebSocket, deviceId: string, ip: string): void {
    const old = this.conns.get(deviceId);
    let replacedOnline = false;
    if (old) {
      // One connection per device: the newer one wins (4002).
      old.superseded = true;
      this.closeConn(old, CloseCode.Replaced, "replaced by a newer connection");
      if (old.helloDone || old.replacedOnline) {
        replacedOnline = true;
        this.deps.engine.disconnect(deviceId);
      }
    }
    const now = this.deps.clock();
    const conn: Conn = {
      ws,
      deviceId,
      ip,
      helloDone: false,
      lastRx: now,
      helloTimer: null,
      killTimer: null,
      flushTimer: null,
      pendingState: null,
      lastPresets: null,
      lastLogAt: 0,
      closing: false,
      superseded: false,
      replacedOnline,
      pings: 0,
    };
    this.conns.set(deviceId, conn);
    conn.helloTimer = setTimeout(() => {
      if (!conn.helloDone) this.closeConn(conn, CloseCode.ProtocolViolation, "no hello within 10 s");
    }, this.timings.helloTimeoutMs);
    ws.on("message", (data, isBinary) => {
      try {
        this.onMessage(conn, data, isBinary);
      } catch (err) {
        this.deps.log.error({ err, device: deviceId }, "error handling a lamp message");
      }
    });
    ws.on("close", (code, reason) => this.onClose(conn, code, reason.toString()));
    ws.on("error", (err) => this.deps.log.debug({ err: err.message, device: deviceId }, "device socket error"));
  }

  // ---------------------------------------------------------------- outbound

  private rawSend(conn: Conn, text: string): boolean {
    if (conn.closing || conn.ws.readyState !== conn.ws.OPEN) return false;
    if (text.length > LIMITS.lampMessageBytes) {
      this.deps.log.warn({ device: conn.deviceId, bytes: text.length }, "server → lamp message exceeds 4 KB");
    }
    conn.ws.send(text);
    return true;
  }

  /** Sends to a lamp that has completed hello. Non-essential messages are dropped under backpressure. */
  send(id: string, type: string, data: unknown, opts: { essential?: boolean } = {}): boolean {
    const c = this.conns.get(id);
    if (!c || !c.helloDone) return false;
    if (opts.essential === false && c.ws.bufferedAmount > DROP_NON_ESSENTIAL_BYTES) {
      this.deps.log.debug({ device: id, type }, "dropping a non-essential message (backpressure)");
      return false;
    }
    return this.rawSend(c, encodeMessage(type, data));
  }

  /** state.set coalesces: under backpressure only the newest full state is kept. */
  sendState(id: string, msg: StateSetOut): void {
    const c = this.conns.get(id);
    if (!c || !c.helloDone) return;
    c.pendingState = msg;
    this.flushState(c);
  }

  private flushState(c: Conn): void {
    if (!c.pendingState || c.closing) return;
    if (c.ws.bufferedAmount > COALESCE_BYTES) {
      c.flushTimer ??= setTimeout(() => {
        c.flushTimer = null;
        this.flushState(c);
      }, 25);
      return;
    }
    const msg = c.pendingState;
    c.pendingState = null;
    this.rawSend(c, encodeMessage("state.set", msg));
  }

  private pushPresets(c: Conn, force: boolean): void {
    if (!c.helloDone) return;
    const presets = this.deps.scenes.presets();
    const json = JSON.stringify(presets);
    if (!force && json === c.lastPresets) return;
    if (c.ws.bufferedAmount > DROP_NON_ESSENTIAL_BYTES) return;
    c.lastPresets = json;
    this.rawSend(c, encodeMessage("presets.sync", { presets }));
  }

  /** After a scene change: the first 8 scenes go to every lamp as presets. */
  pushPresetsAll(): void {
    for (const c of this.conns.values()) this.pushPresets(c, false);
  }

  private sendError(c: Conn, ref: string | null | undefined, code: string, message: string): void {
    this.rawSend(c, encodeMessage("error", { code, message }, { ref: ref ?? null }));
  }

  private closeConn(c: Conn, code: number, reason: string): void {
    if (c.closing) return;
    c.closing = true;
    if (c.helloTimer) clearTimeout(c.helloTimer);
    try {
      c.ws.close(code, reason);
    } catch {
      c.ws.terminate();
    }
    c.killTimer = setTimeout(() => c.ws.terminate(), 2000);
    c.killTimer.unref();
  }

  /** DELETE /devices/:id: `unclaim`, then close 4003. */
  unclaim(id: string): void {
    const c = this.conns.get(id);
    if (!c) return;
    c.superseded = true;
    this.rawSend(c, encodeMessage("unclaim", {}));
    this.closeConn(c, CloseCode.Unclaimed, "unclaimed");
    this.conns.delete(id);
  }

  /** Re-claim: the old token stops working, so its connection goes (4001). */
  dropForNewToken(id: string): void {
    const c = this.conns.get(id);
    if (!c) return;
    this.closeConn(c, CloseCode.BadToken, "the lamp was paired again");
  }

  closeAll(code = 1001, reason = "server shutting down"): void {
    for (const c of this.conns.values()) {
      c.superseded = true;
      this.closeConn(c, code, reason);
    }
  }

  stop(): void {
    clearInterval(this.sweepTimer);
    for (const c of this.conns.values()) {
      if (c.helloTimer) clearTimeout(c.helloTimer);
      if (c.flushTimer) clearTimeout(c.flushTimer);
    }
  }

  /** Closes connections silent for 45 s; any message counts as traffic. */
  private sweep(): void {
    const now = this.deps.clock();
    for (const c of this.conns.values()) {
      if (!c.closing && now - c.lastRx > this.timings.silenceTimeoutMs) {
        this.deps.log.info({ device: c.deviceId }, "closing a silent lamp connection");
        this.closeConn(c, CloseCode.ProtocolViolation, "no traffic for 45 s");
      }
    }
  }

  // ---------------------------------------------------------------- inbound

  private onMessage(c: Conn, data: WebSocket.RawData, isBinary: boolean): void {
    const t1 = this.deps.clock();
    if (c.closing) return;
    c.lastRx = t1;
    if (c.helloDone) this.deps.devices.touch(c.deviceId, t1);
    if (isBinary) return this.sendError(c, null, "unsupported", "binary frames are not supported");
    const text = rawToString(data);
    if (Buffer.byteLength(text) > LIMITS.lampMessageBytes) return this.sendError(c, null, "too_large", "messages are limited to 4 KB");
    const r = decodeMessage(lampToServer, text);
    if (!r.ok) {
      if (!c.helloDone) return this.closeConn(c, CloseCode.ProtocolViolation, `bad hello: ${r.message}`.slice(0, 120));
      return this.sendError(c, r.id, r.code, r.message);
    }
    const msg = r.msg;
    if (!c.helloDone) {
      if (msg.type !== "hello") return this.closeConn(c, CloseCode.ProtocolViolation, "the first message must be hello");
      return this.onHello(c, msg.data);
    }
    const ack = () => {
      if (msg.id) this.rawSend(c, encodeMessage("ack", {}, { ref: msg.id }));
    };
    switch (msg.type) {
      case "hello":
        return this.closeConn(c, CloseCode.ProtocolViolation, "hello sent twice");
      case "time.ping": {
        const t2 = this.deps.clock();
        this.rawSend(c, encodeMessage("time.pong", { t0: msg.data.t0, t1, t2 }, msg.id ? { ref: msg.id } : {}));
        // t1 − t0 ≈ half the round trip once the lamp's sync clock is set (see DelayTracker). The first ping of a
        // connection may predate that, so it's not used.
        c.pings += 1;
        if (c.pings > 1) this.deps.engine.recordDelay(c.deviceId, t1 - msg.data.t0);
        return;
      }
      case "state.report": {
        const res = this.deps.engine.report(c.deviceId, msg.data.patch, msg.data.origin);
        if (!res.ok) return this.sendError(c, msg.id, res.code, res.message);
        return ack();
      }
      case "ota.progress":
        this.deps.ota().onProgress(c.deviceId, msg.data);
        return ack();
      case "event":
        this.onEvent(c, msg.data);
        return ack();
      case "telemetry": {
        const now = this.deps.clock();
        this.deps.telemetry.add(c.deviceId, msg.data, now);
        this.deps.devices.update(c.deviceId, { telemetry: msg.data });
        this.deps.broadcast("device.telemetry", { id: c.deviceId, telemetry: msg.data });
        return ack();
      }
      case "info": {
        const rec = this.deps.devices.get(c.deviceId);
        if (!rec) return;
        this.deps.devices.update(c.deviceId, { info: msg.data.info, ...(msg.data.config ? { config: msg.data.config } : {}) });
        if (!rec.namePending && msg.data.info.name && msg.data.info.name !== rec.name) this.deps.adoptName(c.deviceId, msg.data.info.name);
        this.broadcastDevice(c.deviceId);
        return ack();
      }
      case "ack":
      case "error":
        this.deps.log.debug({ device: c.deviceId, type: msg.type, ref: msg.ref, data: msg.data }, "lamp reply");
        return;
    }
  }

  private broadcastDevice(id: string): void {
    const view = this.deps.deviceView(id);
    if (view) this.deps.broadcast("device.updated", view);
  }

  private onHello(c: Conn, hello: Hello): void {
    const id = c.deviceId;
    if (hello.device_id !== id) return this.closeConn(c, CloseCode.BadToken, "this token belongs to a different device_id");
    if (hello.proto !== PROTO_VERSION && hello.proto !== PROTO_VERSION - 1) {
      return this.closeConn(c, CloseCode.ProtoUnsupported, `proto ${hello.proto} is not supported (server speaks ${PROTO_VERSION})`);
    }
    const rec = this.deps.devices.get(id);
    if (!rec) return this.closeConn(c, CloseCode.Unclaimed, "this lamp is not claimed");
    c.helloDone = true;
    if (c.helloTimer) clearTimeout(c.helloTimer);
    c.helloTimer = null;
    const now = this.deps.clock();

    this.deps.devices.update(id, {
      fw: hello.fw,
      hw: hello.hw,
      ...(hello.effects.length ? { effects: hello.effects } : {}),
      pendingVerify: hello.pending_verify,
      lastSeenAt: now,
      ...(hello.info ? { info: hello.info } : {}),
      ...(hello.config ? { config: hello.config } : {}),
    });
    // A rename made in the web app while the lamp was offline wins; otherwise take the lamp's own name.
    if (!rec.namePending && hello.info?.name && hello.info.name !== rec.name) this.deps.adoptName(id, hello.info.name);
    this.deps.ota().onHello(id, hello);

    const res = this.deps.engine.connect(id, { state: hello.state, dirty: hello.dirty, effects: hello.effects });
    this.rawSend(
      c,
      encodeMessage("welcome", {
        server_time: this.deps.clock(),
        heartbeat_s: WELCOME_HEARTBEAT_S,
        desired: res.desired,
        link: res.link,
      } satisfies DataOf<typeof serverToLamp, "welcome">),
    );
    if (rec.namePending) {
      this.rawSend(c, encodeMessage("name.set", { name: rec.name }));
      this.deps.devices.update(id, { namePending: false });
    }
    this.pushPresets(c, true);
    this.deps.ota().onWelcome(id);

    this.deps.broadcast("device.presence", { id, online: true, last_seen_at: now });
    this.broadcastDevice(id);
    this.deps.activity.record("connect", {
      deviceId: id,
      data: {
        fw: hello.fw,
        ip: hello.ip ?? c.ip,
        ...(hello.boot_reason ? { boot_reason: hello.boot_reason } : {}),
        ...(hello.rollback ? { rollback: true } : {}),
        ...(hello.pending_verify ? { pending_verify: true } : {}),
        ...(res.lampWon.length && !res.adopted ? { offline_edits_won: res.lampWon } : {}),
      },
    });
    this.deps.log.info({ device: id, fw: hello.fw, adopted: res.adopted, lampWon: res.lampWon }, "lamp connected");
  }

  private onEvent(c: Conn, ev: DataOf<typeof lampToServer, "event">): void {
    const id = c.deviceId;
    switch (ev.kind) {
      case "button":
        this.deps.activity.record("button", { deviceId: id, data: { gesture: ev.gesture } });
        return;
      case "crash":
        this.deps.log.warn({ device: id, summary: ev.summary }, "lamp reported a crash");
        this.deps.activity.record("crash", { deviceId: id, data: { summary: ev.summary } });
        return;
      case "log": {
        const now = this.deps.clock();
        if (now - c.lastLogAt < 1000) return; // at most 1 per second (04 §4.3)
        c.lastLogAt = now;
        const entry = { device: id, lampLevel: ev.level, msg: ev.msg.slice(0, 300) };
        if (ev.level === "error") this.deps.log.error(entry, "lamp log");
        else this.deps.log.warn(entry, "lamp log");
        return;
      }
    }
  }

  private onClose(c: Conn, code: number, reason: string): void {
    if (c.helloTimer) clearTimeout(c.helloTimer);
    if (c.flushTimer) clearTimeout(c.flushTimer);
    if (c.killTimer) clearTimeout(c.killTimer);
    if (this.conns.get(c.deviceId) === c) this.conns.delete(c.deviceId);
    if (c.superseded) return;
    const id = c.deviceId;
    const now = this.deps.clock();
    if (!c.helloDone) {
      // A replacement connection that never said hello: the lamp is offline after all.
      if (c.replacedOnline && !this.conns.has(id) && this.deps.devices.get(id)) {
        this.deps.ota().onDisconnect(id);
        this.deps.broadcast("device.presence", { id, online: false, last_seen_at: this.deps.devices.get(id)!.lastSeenAt });
      }
      return;
    }
    this.deps.engine.disconnect(id);
    this.deps.ota().onDisconnect(id);
    if (this.deps.devices.get(id)) this.deps.devices.update(id, { lastSeenAt: now });
    this.deps.broadcast("device.presence", { id, online: false, last_seen_at: now });
    this.deps.activity.record("disconnect", { deviceId: id, data: { code, ...(reason ? { reason } : {}) } });
    this.deps.log.info({ device: id, code, reason }, "lamp disconnected");
  }
}
