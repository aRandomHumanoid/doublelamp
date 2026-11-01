// The /ws/client connection (04 §7.2, 06 A.4): snapshot on every (re)connect, time sync, reconnect with
// backoff 1 s → 15 s. While disconnected the UI shows "Reconnecting…" and controls are disabled; nothing
// is queued.
import { HEARTBEAT, encodeMessage } from "@doublelamp/protocol";
import { localNow } from "../lib/clock";
import { setTransport, type Transport } from "./commands";
import { handleServerText, startSweeper, stopSweeper } from "./dispatch";
import { dropAllPending } from "./reducers";
import { useApp } from "./store";

export type Verify = () => Promise<"ok" | "unauthorized" | "unreachable">;

export interface ConnectionHooks {
  /** Checks the session before reconnecting (a revoked session means back to login, 08 §1.5 #12). */
  verify: Verify;
  onUnauthorized: () => void;
}

const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 15_000;
/** Lamps ping every 5 s for the first 30 s after connecting (03 §12); the browser does the same, then every 30 s. */
const EARLY_PING_MS = 5000;
const EARLY_PHASE_MS = 30_000;
/** No frame at all for this long means the socket is dead even if no close event came (sleep, NAT drop). */
const SILENCE_MS = HEARTBEAT.browserPingIntervalMs + HEARTBEAT.silenceTimeoutMs;

type Timer = ReturnType<typeof setTimeout>;

function detach(ws: WebSocket): void {
  ws.onopen = null;
  ws.onmessage = null;
  ws.onclose = null;
  ws.onerror = null;
}

export class Connection implements Transport {
  private ws: WebSocket | null = null;
  private running = false;
  private attempt = 0;
  private retryTimer: Timer | null = null;
  private pingTimer: Timer | null = null;
  private openedAt = 0;
  private lastRx = 0;
  private hooks: ConnectionHooks | null = null;

  start(hooks: ConnectionHooks): void {
    if (this.running) return;
    this.running = true;
    this.hooks = hooks;
    this.attempt = 0;
    window.addEventListener("online", this.wake);
    document.addEventListener("visibilitychange", this.onVisibility);
    startSweeper();
    this.open();
  }

  stop(): void {
    this.running = false;
    window.removeEventListener("online", this.wake);
    document.removeEventListener("visibilitychange", this.onVisibility);
    stopSweeper();
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      detach(ws);
      ws.close(1000, "signed out");
    }
    useApp.setState({ conn: "idle", live: false });
  }

  send(type: string, data: unknown): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(encodeMessage(type, data));
    return true;
  }

  /** Reconnect now instead of waiting out the backoff (network back, tab visible again). */
  private wake = (): void => {
    if (!this.running || this.ws || !this.retryTimer) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.attempt = 0;
    void this.reconnect();
  };

  private onVisibility = (): void => {
    if (document.visibilityState !== "visible") return;
    if (this.ws?.readyState === WebSocket.OPEN) {
      if (Date.now() - this.lastRx > SILENCE_MS) this.lost();
      else this.ping(); // refresh the clock after the tab slept
    } else this.wake();
  };

  private clearTimers(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.pingTimer) clearTimeout(this.pingTimer);
    this.retryTimer = null;
    this.pingTimer = null;
  }

  private open(): void {
    useApp.setState({ conn: "connecting" });
    const url = new URL("/ws/client", window.location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    let ws: WebSocket;
    try {
      ws = new WebSocket(url.href);
    } catch {
      this.scheduleRetry();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.openedAt = this.lastRx = Date.now();
      useApp.setState({ conn: "open" });
      this.ping();
      this.schedulePing();
    };
    ws.onmessage = (ev: MessageEvent) => {
      this.lastRx = Date.now();
      if (typeof ev.data !== "string") return;
      const msg = handleServerText(ev.data);
      if (msg?.type === "snapshot") this.attempt = 0;
    };
    ws.onclose = () => {
      if (this.ws === ws) this.lost();
    };
    ws.onerror = () => {
      /* a close event follows */
    };
  }

  private lost(): void {
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      detach(ws);
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    }
    if (this.pingTimer) clearTimeout(this.pingTimer);
    this.pingTimer = null;
    useApp.setState((s) => ({ ...dropAllPending(s), conn: "closed", live: false, failures: s.failures + 1 }));
    if (this.running) this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** this.attempt) + Math.random() * 250;
    this.attempt++;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.reconnect();
    }, delay);
  }

  private async reconnect(): Promise<void> {
    if (!this.running || this.ws) return;
    useApp.setState({ conn: "connecting" });
    const r = this.hooks ? await this.hooks.verify() : "ok";
    if (!this.running || this.ws) return;
    if (r === "unauthorized") {
      this.hooks?.onUnauthorized();
      return;
    }
    if (r === "unreachable") {
      useApp.setState((s) => ({ conn: "closed", failures: s.failures + 1 }));
      this.scheduleRetry();
      return;
    }
    this.open();
  }

  private ping(): void {
    this.send("time.ping", { t0: localNow() });
  }

  private schedulePing(): void {
    const early = Date.now() - this.openedAt < EARLY_PHASE_MS;
    this.pingTimer = setTimeout(
      () => {
        this.pingTimer = null;
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        if (Date.now() - this.lastRx > SILENCE_MS) {
          this.lost();
          return;
        }
        this.ping();
        this.schedulePing();
      },
      early ? EARLY_PING_MS : HEARTBEAT.browserPingIntervalMs,
    );
  }
}

export const connection = new Connection();
setTransport(connection);
