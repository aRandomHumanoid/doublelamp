// Builds the whole server: database, engine, hubs, routes. main.ts listens; tests call buildApp directly.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import cookie from "@fastify/cookie";
import websocket from "@fastify/websocket";
import Fastify, { LogController, type FastifyInstance } from "fastify";
import { LIMITS } from "@doublelamp/protocol";
import { ActivityLog } from "./activity";
import { PasswordStore, ensurePassword } from "./auth/password";
import { claimLimiter, loginLimiter } from "./auth/rate-limit";
import { SessionStore } from "./auth/sessions";
import type { Config } from "./config";
import { Ops, type AppContext } from "./context";
import { openDatabase } from "./db/db";
import { DeviceRegistry } from "./devices";
import { SyncEngine } from "./engine/engine";
import { ClientHub } from "./hubs/client-hub";
import { DeviceHub, type DeviceHubTimings } from "./hubs/device-hub";
import { authRoutes } from "./http/auth-routes";
import { apiAuthHook, registerCommon } from "./http/common";
import { deviceRoutes } from "./http/device-routes";
import { firmwareDownloadRoute, firmwareRoutes } from "./http/firmware-routes";
import { groupRoutes, sceneRoutes, scheduleRoutes } from "./http/group-scene-routes";
import { registerStatic } from "./http/static";
import { wsRoutes } from "./http/ws-routes";
import { loggerOptions, type Logger } from "./log";
import { FirmwareStore } from "./ota/firmware";
import { OtaManager } from "./ota/jobs";
import { PairingCodes } from "./pairing";
import { GroupStore, ReplicaPersister, loadReplicas } from "./persistence";
import { SceneStore } from "./scenes";
import { Scheduler } from "./scheduler";
import { TelemetryRing } from "./telemetry";
import { randomToken } from "./util/crypto";
import { Views } from "./views";

export interface AppOverrides {
  clock?: () => number;
  random?: () => number;
  deviceTimings?: Partial<DeviceHubTimings>;
  otaTimeoutMs?: number;
  otaCheckIntervalMs?: number;
  schedulerStartupDelayMs?: number;
  persistIntervalMs?: number;
  /** Called instead of printing the banner when a first-start password was generated. */
  onGeneratedPassword?: (password: string) => void;
}

export interface App {
  app: FastifyInstance;
  ctx: AppContext;
  /** The password generated on first start (only when APP_PASSWORD was unset and none was stored). */
  generatedPassword?: string;
  close(): Promise<void>;
}

/** SERVER_SECRET from the environment, or generated once and kept in DATA_DIR/secret. */
export function resolveServerSecret(config: Config, log: Logger): string {
  if (config.serverSecret) {
    if (config.serverSecret.length < 32) log.warn("SERVER_SECRET is shorter than 32 characters; use 32+ random bytes");
    return config.serverSecret;
  }
  const file = path.join(config.dataDir, "secret");
  if (existsSync(file)) {
    const s = readFileSync(file, "utf8").trim();
    if (s) return s;
  }
  const s = randomToken(32);
  writeFileSync(file, s + "\n", { mode: 0o600 });
  log.info({ file }, "generated SERVER_SECRET and stored it in DATA_DIR");
  return s;
}

function printGeneratedPassword(password: string): void {
  const line = "=".repeat(66);
  process.stdout.write(
    [
      "",
      line,
      "  DoubleLamp: no password was set (APP_PASSWORD), so one was generated:",
      "",
      `      ${password}`,
      "",
      "  Log in with it, then change it in Settings. It won't be shown again.",
      line,
      "",
    ].join("\n") + "\n",
  );
}

export async function buildApp(config: Config, overrides: AppOverrides = {}): Promise<App> {
  const clock = overrides.clock ?? Date.now;
  mkdirSync(config.dataDir, { recursive: true });

  const app = Fastify({
    logger: loggerOptions(config.logLevel),
    // Per-request lines come from our own onResponse hook (debug level, URLs redacted).
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 64 * 1024,
    trustProxy: false,
  });
  const log = app.log;
  if (config.devInsecure) log.warn("DEV_INSECURE is on: http:// PUBLIC_URL allowed and cookies are not Secure. Development only (05 §12).");

  const secret = resolveServerSecret(config, log);
  const db = openDatabase(path.join(config.dataDir, "doublelamp.db"));
  const passwords = new PasswordStore(db, clock);
  const initial = await ensurePassword(passwords, config.appPassword);
  if (initial.source === "generated") {
    (overrides.onGeneratedPassword ?? printGeneratedPassword)(initial.password);
    log.warn("generated the initial shared password (printed above, not logged)");
  } else if (initial.source === "env") {
    log.info("stored the shared password from APP_PASSWORD; remove APP_PASSWORD from the environment now (07 §5)");
  } else if (config.appPassword) {
    log.info("a password is already stored, so APP_PASSWORD is ignored");
  }

  // ctx is filled in below; hooks and hubs read it lazily.
  const ctx = { config, secret, clock, log, db } as AppContext;

  const engine = new SyncEngine({
    clock,
    random: overrides.random,
    hooks: {
      sendState: (id, msg) => ctx.deviceHub.sendState(id, msg),
      sendLink: (id, link) => {
        ctx.deviceHub.send(id, "link", link);
      },
      stateChanged: (ch) =>
        ctx.clientHub.broadcast(ch.kind === "group" ? "group.state" : "device.state", {
          id: ch.id,
          state: ch.state,
          origin: ch.origin,
          ...(ch.by !== undefined ? { by: ch.by } : {}),
          ...(ch.applyAt !== undefined ? { apply_at: ch.applyAt } : {}),
        }),
      persist: (owner) => ctx.persister.mark(owner),
      activity: (rec) => ctx.activity.recordState(rec),
    },
  });
  ctx.engine = engine;
  ctx.devices = new DeviceRegistry(db);
  ctx.groups = new GroupStore(db);
  ctx.sessions = new SessionStore(db, clock);
  ctx.passwords = passwords;
  ctx.pairing = new PairingCodes(db, clock);
  ctx.scenes = new SceneStore(db, clock);
  ctx.activity = new ActivityLog(db, clock);
  ctx.telemetry = new TelemetryRing();
  ctx.firmware = new FirmwareStore(db, config.dataDir, clock);
  ctx.persister = new ReplicaPersister(db, () => engine, clock, log, overrides.persistIntervalMs);
  ctx.views = new Views(engine, ctx.devices, ctx.scenes, clock);
  ctx.loginLimiter = loginLimiter(clock);
  ctx.claimLimiter = claimLimiter(clock);
  ctx.ops = new Ops(ctx);

  // Load the engine from SQLite.
  const replicas = loadReplicas(db, log);
  for (const rec of ctx.devices.all()) {
    engine.addDevice({ id: rec.id, name: rec.name, replica: replicas.devices.get(rec.id) ?? null, effects: rec.effects });
  }
  for (const g of ctx.groups.all()) {
    engine.addGroup({ id: g.id, name: g.name, linked: g.linked, members: g.members, replica: replicas.groups.get(g.id) ?? null });
  }

  ctx.clientHub = new ClientHub({ engine, sessions: ctx.sessions, snapshot: () => ctx.views.snapshot(), clock, log });
  ctx.ota = new OtaManager({
    db,
    clock,
    firmware: ctx.firmware,
    devices: ctx.devices,
    engine,
    send: (id, type, data) => ctx.deviceHub.send(id, type, data),
    broadcast: (job) => ctx.clientHub.broadcast("ota.job", job),
    deviceChanged: (id) => ctx.ops.broadcastDevice(id),
    activity: ctx.activity,
    log,
    publicUrl: config.publicUrl,
    secret,
    timeoutMs: overrides.otaTimeoutMs,
  });
  ctx.deviceHub = new DeviceHub({
    engine,
    devices: ctx.devices,
    ota: () => ctx.ota,
    activity: ctx.activity,
    telemetry: ctx.telemetry,
    scenes: ctx.scenes,
    clock,
    log,
    broadcast: (type, data) => ctx.clientHub.broadcast(type, data),
    deviceView: (id) => ctx.views.device(id),
    adoptName: (id, name) => ctx.ops.renameDevice(id, name, { lamp: true }),
    timings: overrides.deviceTimings,
  });
  ctx.scheduler = new Scheduler({
    db,
    clock,
    engine,
    scenes: ctx.scenes,
    activity: ctx.activity,
    log,
    startupDelayMs: overrides.schedulerStartupDelayMs,
  });

  // ---- HTTP
  await app.register(cookie, { secret });
  await app.register(websocket, { options: { maxPayload: LIMITS.browserMessageBytes + 1024 } });
  registerCommon(app, ctx);
  app.get("/healthz", async () => ({ ok: true }));
  wsRoutes(app, ctx);
  firmwareDownloadRoute(app, ctx);
  await app.register(
    async (api) => {
      api.addHook("onRequest", apiAuthHook(ctx));
      authRoutes(api, ctx);
      deviceRoutes(api, ctx);
      groupRoutes(api, ctx);
      sceneRoutes(api, ctx);
      scheduleRoutes(api, ctx);
      firmwareRoutes(api, ctx);
    },
    { prefix: "/api/v1" },
  );
  await registerStatic(app, config.webDist);

  // ---- maintenance
  const retention = () => {
    try {
      const events = ctx.activity.purgeOlderThan();
      const sessions = ctx.sessions.purgeExpired();
      const codes = ctx.pairing.purgeExpired();
      ctx.loginLimiter.sweep();
      ctx.claimLimiter.sweep();
      if (events || sessions || codes) log.info({ events, sessions, codes }, "retention: deleted old rows");
    } catch (err) {
      log.error({ err }, "retention job failed");
    }
  };
  retention();
  const timers = [
    setInterval(retention, 24 * 3600_000),
    setInterval(() => ctx.ota.checkTimeouts(), overrides.otaCheckIntervalMs ?? 30_000),
    setInterval(() => ctx.devices.flushLastSeen(), 60_000),
  ];
  for (const t of timers) t.unref();
  ctx.scheduler.start();

  let closed = false;
  return {
    app,
    ctx,
    generatedPassword: initial.source === "generated" ? initial.password : undefined,
    async close() {
      if (closed) return;
      closed = true;
      for (const t of timers) clearInterval(t);
      ctx.scheduler.stop();
      ctx.deviceHub.closeAll(1001, "server restarting");
      ctx.clientHub.closeAll(1001, "server restarting");
      ctx.deviceHub.stop();
      ctx.clientHub.stop();
      await app.close();
      for (const ws of app.websocketServer?.clients ?? []) ws.terminate();
      ctx.persister.close();
      ctx.devices.flushLastSeen();
      db.close();
    },
  };
}
