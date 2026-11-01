// Boots the real Fastify app on a random port with a temp DATA_DIR, plus virtual lamps and a `ws` browser client.
import { mkdtempSync, rmSync } from "node:fs";
import net, { type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { decodeMessage, serverToClient } from "@doublelamp/protocol";
import { VirtualLamp, type LampTimings, type VirtualLampOptions } from "@doublelamp/virtual-lamp";
import { buildApp, type App, type AppOverrides } from "../../src/app";
import { loadConfig, type Config } from "../../src/config";

export const PASSWORD = "correct horse battery staple";

/** Fast lamp timings so tests don't wait for 5 s pings or 2 s backoffs. */
export const FAST_LAMP: Partial<LampTimings> = {
  fastPingMs: 100,
  fastPingWindowMs: 3000,
  pingMs: 250,
  firstTelemetryMs: 50,
  telemetryMs: 60_000,
  backoffBaseMs: 50,
  backoffMaxMs: 250,
  rebootMs: 150,
  selfTestMs: 150,
};

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function waitUntil(pred: () => boolean | Promise<boolean>, what = "condition", timeoutMs = 6000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await pred()) return;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(15);
  }
}

export async function freePort(): Promise<number> {
  const srv = net.createServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as AddressInfo).port;
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = any;

export interface ApiResponse {
  status: number;
  body: Json;
  headers: Headers;
}

export interface WsMessage {
  type: string;
  ref?: string;
  data: Json;
}

export class BrowserClient {
  readonly messages: WsMessage[] = [];
  /** Messages that don't pass the protocol's serverToClient schemas (the web app would drop them). */
  readonly invalid: string[] = [];
  closeInfo: { code: number; reason: string } | null = null;
  private readonly listeners = new Set<() => void>();
  private n = 0;

  private constructor(readonly ws: WebSocket) {
    ws.on("message", (d) => {
      const text = d.toString();
      const checked = decodeMessage(serverToClient, text);
      if (!checked.ok) this.invalid.push(`${checked.type ?? "?"}: ${checked.message}`);
      this.messages.push(JSON.parse(text) as WsMessage);
      for (const l of [...this.listeners]) l();
    });
    ws.on("close", (code, reason) => {
      this.closeInfo = { code, reason: reason.toString() };
      for (const l of [...this.listeners]) l();
    });
  }

  static connect(url: string, headers: Record<string, string>): Promise<BrowserClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { headers });
      const client = new BrowserClient(ws);
      ws.once("open", () => {
        client.waitFor("snapshot").then(() => resolve(client), reject);
      });
      ws.once("error", reject);
    });
  }

  /** The first message (in the whole history) of `type` matching `pred`; waits if there's none yet. */
  waitFor(type: string, pred: (m: WsMessage) => boolean = () => true, timeoutMs = 6000): Promise<WsMessage> {
    return new Promise((resolve, reject) => {
      const check = () => {
        const m = this.messages.find((x) => x.type === type && pred(x));
        if (m) {
          this.listeners.delete(check);
          clearTimeout(timer);
          resolve(m);
        }
      };
      const timer = setTimeout(() => {
        this.listeners.delete(check);
        reject(new Error(`browser: timed out waiting for ${type}`));
      }, timeoutMs);
      this.listeners.add(check);
      check();
    });
  }

  waitClosed(timeoutMs = 6000): Promise<{ code: number; reason: string }> {
    return new Promise((resolve, reject) => {
      const check = () => {
        if (this.closeInfo) {
          this.listeners.delete(check);
          clearTimeout(timer);
          resolve(this.closeInfo);
        }
      };
      const timer = setTimeout(() => reject(new Error("browser: socket did not close")), timeoutMs);
      this.listeners.add(check);
      check();
    });
  }

  last(type: string, pred: (m: WsMessage) => boolean = () => true): WsMessage | undefined {
    return [...this.messages].reverse().find((m) => m.type === type && pred(m));
  }

  send(type: string, data: unknown): void {
    this.ws.send(JSON.stringify({ type, data }));
  }

  /** Sends a `cmd` and resolves with its `ack` or `error` (matched by cid). */
  cmd(target: Json, patch: Json, transition_ms?: number): Promise<WsMessage> {
    const cid = `c${++this.n}-${Math.random().toString(36).slice(2, 7)}`;
    this.send("cmd", { target, patch, cid, ...(transition_ms !== undefined ? { transition_ms } : {}) });
    return Promise.race([this.waitFor("ack", (m) => m.ref === cid), this.waitFor("error", (m) => m.ref === cid)]);
  }

  close(): void {
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) this.ws.close();
  }
}

/** Opens a WebSocket and returns the HTTP status of a rejected upgrade (or 101 if it was accepted). */
export function upgradeStatus(url: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers });
    ws.on("unexpected-response", (_req, res) => {
      resolve(res.statusCode ?? 0);
      ws.terminate();
    });
    ws.on("open", () => {
      resolve(101);
      ws.close();
    });
    ws.on("error", () => {
      /* handled via unexpected-response */
    });
  });
}

export class TestServer {
  readonly lamps: VirtualLamp[] = [];
  readonly browsers: BrowserClient[] = [];
  /** Protocol problems seen by virtual lamps: undecodable server messages, or `error` replies from the server. */
  readonly lampProblems: string[] = [];

  private constructor(
    public app: App,
    private readonly config: Config,
    private readonly overrides: AppOverrides,
    private readonly ownsDir: boolean,
  ) {}

  static async start(opts: { dataDir?: string; overrides?: AppOverrides; env?: Record<string, string> } = {}): Promise<TestServer> {
    const dataDir = opts.dataDir ?? mkdtempSync(path.join(os.tmpdir(), "dl-it-"));
    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    const config = loadConfig({
      PORT: String(port),
      HOST: "127.0.0.1",
      DATA_DIR: dataDir,
      PUBLIC_URL: url,
      APP_PASSWORD: PASSWORD,
      LOG_LEVEL: process.env.TEST_LOG_LEVEL ?? "silent",
      WEB_DIST: path.join(dataDir, "no-web-dist"),
      ...opts.env,
    });
    const overrides: AppOverrides = { schedulerStartupDelayMs: 300, otaCheckIntervalMs: 200, ...opts.overrides };
    const app = await buildApp(config, overrides);
    await app.app.listen({ port, host: "127.0.0.1" });
    return new TestServer(app, config, overrides, opts.dataDir === undefined);
  }

  get url(): string {
    return this.config.publicUrl;
  }

  get ctx() {
    return this.app.ctx;
  }

  get dataDir(): string {
    return this.config.dataDir;
  }

  async api(method: string, p: string, opts: { body?: unknown; cookie?: string | null; origin?: string | null; raw?: Buffer } = {}): Promise<ApiResponse> {
    const headers: Record<string, string> = {};
    if (opts.cookie) headers.cookie = opts.cookie;
    const origin = opts.origin === undefined ? (method === "GET" ? null : this.url) : opts.origin;
    if (origin) headers.origin = origin;
    let body: Buffer | string | undefined;
    if (opts.raw) {
      headers["content-type"] = "application/octet-stream";
      body = opts.raw;
    } else if (opts.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(opts.body);
    }
    const res = await fetch(this.url + p, { method, headers, body });
    const text = await res.text();
    let parsed: Json = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // not JSON
    }
    return { status: res.status, body: parsed, headers: res.headers };
  }

  /** Logs in and returns the `dl_session=…` cookie pair. */
  async login(label = "Test browser", password = PASSWORD): Promise<string> {
    const r = await fetch(`${this.url}/api/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: this.url },
      body: JSON.stringify({ password, label }),
    });
    if (r.status !== 200) throw new Error(`login failed: HTTP ${r.status}`);
    return r.headers.get("set-cookie")!.split(";")[0]!;
  }

  async pairingCode(cookie: string): Promise<string> {
    const r = await this.api("POST", "/api/v1/pairing-codes", { cookie });
    if (r.status !== 201) throw new Error(`pairing code: HTTP ${r.status}`);
    return r.body.code as string;
  }

  /** Pairs a new virtual lamp and waits until it's online. */
  async lamp(cookie: string, name: string, opts: Partial<VirtualLampOptions> = {}): Promise<VirtualLamp> {
    const code = await this.pairingCode(cookie);
    const lamp = new VirtualLamp({ server: this.url, code, name, stateDir: null, timings: FAST_LAMP, ...opts });
    this.lamps.push(lamp);
    lamp.on("log", (line: string) => {
      if (line.startsWith("ignoring a bad message")) this.lampProblems.push(`${name}: ${line}`);
    });
    lamp.on("message", (type: string, data: unknown) => {
      if (type === "error") this.lampProblems.push(`${name}: server error ${JSON.stringify(data)}`);
    });
    await lamp.start();
    await lamp.waitOnline(6000);
    return lamp;
  }

  async browser(cookie: string, origin: string = this.url): Promise<BrowserClient> {
    const b = await BrowserClient.connect(`${this.url.replace(/^http/, "ws")}/ws/client`, { cookie, origin });
    this.browsers.push(b);
    return b;
  }

  /** Stops the server (lamps keep running and reconnect), then starts it again on the same port and DATA_DIR. */
  async restart(overrides: AppOverrides = {}): Promise<void> {
    await this.app.close();
    this.app = await buildApp(this.config, { ...this.overrides, ...overrides });
    await this.app.app.listen({ port: this.config.port, host: "127.0.0.1" });
  }

  /** Stops everything; throws if any browser or lamp saw a message that breaks the protocol schemas. */
  async close(): Promise<void> {
    for (const b of this.browsers) b.close();
    await Promise.all(this.lamps.map((l) => l.stop()));
    await this.app.close();
    if (this.ownsDir) rmSync(this.config.dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    const problems = [...this.browsers.flatMap((b) => b.invalid.map((m) => `browser: ${m}`)), ...this.lampProblems];
    if (problems.length) throw new Error(`protocol violations:\n${problems.join("\n")}`);
  }
}

/** A server, a logged-in browser, and two online lamps A and B in the default group. */
export async function setupPair(
  opts: { a?: Partial<VirtualLampOptions>; b?: Partial<VirtualLampOptions>; overrides?: AppOverrides } = {},
): Promise<{ server: TestServer; cookie: string; browser: BrowserClient; A: VirtualLamp; B: VirtualLamp; groupId: number }> {
  const server = await TestServer.start({ overrides: opts.overrides });
  const cookie = await server.login();
  const browser = await server.browser(cookie);
  const A = await server.lamp(cookie, "Lamp A", { id: "dl-00000a", ...opts.a });
  const B = await server.lamp(cookie, "Lamp B", { id: "dl-00000b", ...opts.b });
  const groups = await server.api("GET", "/api/v1/groups", { cookie });
  const groupId = groups.body.groups[0].id as number;
  return { server, cookie, browser, A, B, groupId };
}
