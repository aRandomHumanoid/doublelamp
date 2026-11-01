// Entry point: load server/.env, read config, build the app, listen, shut down gracefully.
import { existsSync } from "node:fs";
import path from "node:path";
import { buildApp } from "./app";
import { ConfigError, SERVER_DIR, loadConfig, type Config } from "./config";

const envFile = path.join(SERVER_DIR, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

let config: Config;
try {
  config = loadConfig();
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(`DoubleLamp server: configuration error: ${err.message}`);
    process.exit(1);
  }
  throw err;
}

let built: Awaited<ReturnType<typeof buildApp>>;
try {
  built = await buildApp(config);
} catch (err) {
  console.error(`DoubleLamp server: failed to start: ${(err as Error).message}`);
  process.exit(1);
}
const { app, close } = built;

try {
  await app.listen({ port: config.port, host: config.host });
} catch (err) {
  app.log.error({ err }, "could not listen");
  await close();
  process.exit(1);
}
app.log.info(
  { publicUrl: config.publicUrl, deviceWsUrl: config.deviceWsUrl, dataDir: config.dataDir, origins: config.allowedOrigins },
  "DoubleLamp server ready",
);

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  app.log.info({ signal }, "shutting down");
  const force = setTimeout(() => process.exit(1), 10_000);
  force.unref();
  try {
    await close();
  } catch (err) {
    app.log.error({ err }, "error during shutdown");
  }
  process.exit(0);
}
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
