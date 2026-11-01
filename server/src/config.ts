// Configuration from the environment (05 §12). Dev-friendly defaults; production sets PUBLIC_URL etc.
import path from "node:path";
import { fileURLToPath } from "node:url";

/** server/ (this file lives in server/src). */
export const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export type TrustProxy = "false" | "cloudflare";

export interface Config {
  port: number;
  host: string;
  /** Absolute. SQLite file, firmware files and the generated secret live here. */
  dataDir: string;
  /** No trailing slash, e.g. "https://lamps.example.com". */
  publicUrl: string;
  /** Origin of PUBLIC_URL, e.g. "https://lamps.example.com". */
  publicOrigin: string;
  /** PUBLIC_URL's origin plus EXTRA_ORIGINS. */
  allowedOrigins: string[];
  /** PUBLIC_URL with http→ws / https→wss + "/ws/device". Returned to lamps at pairing. */
  deviceWsUrl: string;
  https: boolean;
  serverSecret?: string;
  appPassword?: string;
  trustProxy: TrustProxy;
  devInsecure: boolean;
  /** Cookie `Secure` flag: on unless DEV_INSECURE. */
  secureCookies: boolean;
  logLevel: string;
  /** Built web app (../web/dist). */
  webDist: string;
}

export class ConfigError extends Error {}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const LOG_LEVELS = new Set(["fatal", "error", "warn", "info", "debug", "trace", "silent"]);

function truthy(v: string | undefined): boolean {
  return v !== undefined && ["1", "true", "yes", "on"].includes(v.trim().toLowerCase());
}

function parsePort(v: string | undefined): number {
  if (v === undefined || v.trim() === "") return 8080;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new ConfigError(`PORT must be an integer 0–65535, got "${v}"`);
  return n;
}

function parseOrigin(raw: string, name: string): string {
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("bad protocol");
    return u.origin;
  } catch {
    throw new ConfigError(`${name}: "${raw}" is not an http(s) URL`);
  }
}

export function loadConfig(env: Record<string, string | undefined> = process.env, serverDir = SERVER_DIR): Config {
  const port = parsePort(env.PORT);
  const host = env.HOST?.trim() || "0.0.0.0";
  const dataDir = path.resolve(serverDir, env.DATA_DIR?.trim() || "data");

  const rawPublic = (env.PUBLIC_URL?.trim() || `http://localhost:${port}`).replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(rawPublic);
  } catch {
    throw new ConfigError(`PUBLIC_URL "${rawPublic}" is not a valid URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new ConfigError("PUBLIC_URL must start with http:// or https://");
  const https = url.protocol === "https:";
  const devInsecure = truthy(env.DEV_INSECURE);
  if (!https && !devInsecure && !LOCAL_HOSTS.has(url.hostname)) {
    throw new ConfigError(
      `PUBLIC_URL "${rawPublic}" uses http://. Use an https:// URL, or set DEV_INSECURE=1 for local development on one WiFi (05 §13).`,
    );
  }
  const publicUrl = url.origin + url.pathname.replace(/\/+$/, "");
  const publicOrigin = url.origin;

  const extra = (env.EXTRA_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((o) => parseOrigin(o, "EXTRA_ORIGINS"));
  const allowedOrigins = [...new Set([publicOrigin, ...extra])];

  const tp = (env.TRUST_PROXY ?? "false").trim().toLowerCase();
  let trustProxy: TrustProxy;
  if (tp === "cloudflare") trustProxy = "cloudflare";
  else if (["", "false", "0", "no", "off"].includes(tp)) trustProxy = "false";
  else throw new ConfigError(`TRUST_PROXY must be "false" or "cloudflare", got "${env.TRUST_PROXY}"`);

  const logLevel = (env.LOG_LEVEL?.trim() || "info").toLowerCase();
  if (!LOG_LEVELS.has(logLevel)) throw new ConfigError(`LOG_LEVEL "${logLevel}" is not a pino level`);

  return {
    port,
    host,
    dataDir,
    publicUrl,
    publicOrigin,
    allowedOrigins,
    deviceWsUrl: publicUrl.replace(/^http/, "ws") + "/ws/device",
    https,
    serverSecret: env.SERVER_SECRET?.trim() || undefined,
    appPassword: env.APP_PASSWORD || undefined,
    trustProxy,
    devInsecure,
    secureCookies: !devInsecure,
    logLevel,
    webDist: path.resolve(serverDir, env.WEB_DIST?.trim() || "../web/dist"),
  };
}
