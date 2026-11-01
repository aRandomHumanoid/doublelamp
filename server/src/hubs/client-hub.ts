// /ws/client (04 §7.2, 05 §7): snapshot on connect, then change events; `cmd` → ack/error by cid; time sync.
import type WebSocket from "ws";
import { LIMITS, TRANSITION, clientToServer, decodeMessage, encodeMessage } from "@doublelamp/protocol";
import type { SessionRecord, SessionStore } from "../auth/sessions";
import type { SyncEngine } from "../engine/engine";
import type { Logger } from "../log";

export const MAX_CMDS_PER_SECOND = 30;
/** A browser that falls this far behind is disconnected (it reconnects and gets a fresh snapshot). */
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
const KEEPALIVE_MS = 30_000;
/** Close code for a revoked or expired session; the web app returns to the login screen. */
export const CLIENT_CLOSE_AUTH = 4001;

export interface ClientHubDeps {
  engine: SyncEngine;
  sessions: SessionStore;
  snapshot: () => unknown;
  clock: () => number;
  log: Logger;
}

interface ClientConn {
  readonly ws: WebSocket;
  readonly session: SessionRecord;
  cmdTimes: number[];
  alive: boolean;
}

function rawToString(data: WebSocket.RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return data.toString("utf8");
}

/** Best effort: the cid of a malformed cmd, so the error can still be matched to the optimistic update. */
function extractCid(text: string): string | undefined {
  try {
    const raw = JSON.parse(text) as { data?: { cid?: unknown } };
    const cid = raw?.data?.cid;
    return typeof cid === "string" && cid.length <= 40 ? cid : undefined;
  } catch {
    return undefined;
  }
}

export class ClientHub {
  private readonly conns = new Set<ClientConn>();
  private readonly keepalive: NodeJS.Timeout;

  constructor(private readonly deps: ClientHubDeps) {
    this.keepalive = setInterval(() => this.heartbeat(), KEEPALIVE_MS);
    this.keepalive.unref();
  }

  connectionCount(): number {
    return this.conns.size;
  }

  handle(ws: WebSocket, session: SessionRecord): void {
    const c: ClientConn = { ws, session, cmdTimes: [], alive: true };
    this.conns.add(c);
    ws.on("pong", () => {
      c.alive = true;
    });
    ws.on("message", (data, isBinary) => {
      try {
        this.onMessage(c, data, isBinary);
      } catch (err) {
        this.deps.log.error({ err }, "error handling a browser message");
      }
    });
    ws.on("close", () => this.conns.delete(c));
    ws.on("error", (err) => this.deps.log.debug({ err: err.message }, "client socket error"));
    this.sendTo(c, "snapshot", this.deps.snapshot());
  }

  private sendTo(c: ClientConn, type: string, data: unknown, ref?: string): void {
    if (c.ws.readyState !== c.ws.OPEN) return;
    c.ws.send(encodeMessage(type, data, ref !== undefined ? { ref } : {}));
  }

  broadcast(type: string, data: unknown): void {
    if (!this.conns.size) return;
    const text = encodeMessage(type, data);
    for (const c of this.conns) {
      if (c.ws.readyState !== c.ws.OPEN) continue;
      if (c.ws.bufferedAmount > MAX_BUFFERED_BYTES) {
        this.deps.log.warn({ session: c.session.id }, "dropping a browser connection that fell behind");
        c.ws.terminate();
        continue;
      }
      c.ws.send(text);
    }
  }

  /** Closes the sockets of revoked sessions (password change, logout, revoke). */
  closeSessions(ids: readonly string[], reason = "session revoked"): void {
    const set = new Set(ids);
    for (const c of this.conns) if (set.has(c.session.id)) c.ws.close(CLIENT_CLOSE_AUTH, reason);
  }

  closeAll(code = 1001, reason = "server shutting down"): void {
    for (const c of this.conns) c.ws.close(code, reason);
  }

  stop(): void {
    clearInterval(this.keepalive);
  }

  private rateLimited(c: ClientConn, now: number): boolean {
    c.cmdTimes = c.cmdTimes.filter((t) => now - t < 1000);
    if (c.cmdTimes.length >= MAX_CMDS_PER_SECOND) return true;
    c.cmdTimes.push(now);
    return false;
  }

  private onMessage(c: ClientConn, data: WebSocket.RawData, isBinary: boolean): void {
    const t1 = this.deps.clock();
    c.alive = true;
    if (isBinary) return this.sendTo(c, "error", { code: "unsupported", message: "binary frames are not supported" });
    const text = rawToString(data);
    if (Buffer.byteLength(text) > LIMITS.browserMessageBytes) {
      return this.sendTo(c, "error", { code: "too_large", message: "messages are limited to 16 KB" }, extractCid(text));
    }
    if (!this.deps.sessions.isLive(c.session.id)) {
      c.ws.close(CLIENT_CLOSE_AUTH, "session expired");
      return;
    }
    const r = decodeMessage(clientToServer, text);
    if (!r.ok) {
      const ref = extractCid(text) ?? r.id ?? undefined;
      return this.sendTo(c, "error", { code: r.code, message: r.message }, ref);
    }
    const msg = r.msg;
    switch (msg.type) {
      case "time.ping":
        return this.sendTo(c, "time.pong", { t0: msg.data.t0, t1, t2: this.deps.clock() }, msg.id ?? undefined);
      case "cmd": {
        const { target, patch, transition_ms, cid } = msg.data;
        if (this.rateLimited(c, t1)) {
          return this.sendTo(c, "error", { code: "rate_limited", message: `at most ${MAX_CMDS_PER_SECOND} commands per second` }, cid);
        }
        const res = this.deps.engine.command(target, patch, {
          origin: "web",
          by: c.session.label,
          transitionMs: transition_ms ?? TRANSITION.tapMs,
        });
        if (res.ok) return this.sendTo(c, "ack", {}, cid);
        return this.sendTo(c, "error", { code: res.code, message: res.message }, cid);
      }
    }
  }

  /** WS ping frames detect dead browser connections; also drops sockets whose session expired. */
  private heartbeat(): void {
    for (const c of this.conns) {
      if (!c.alive) {
        c.ws.terminate();
        continue;
      }
      if (!this.deps.sessions.isLive(c.session.id)) {
        c.ws.close(CLIENT_CLOSE_AUTH, "session expired");
        continue;
      }
      c.alive = false;
      try {
        c.ws.ping();
      } catch {
        c.ws.terminate();
      }
    }
  }
}
