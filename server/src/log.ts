// pino options shared by Fastify and the services. Tokens, passwords and pairing codes are never logged (07 §5).
import type { FastifyBaseLogger } from "fastify";

export type Logger = FastifyBaseLogger;

/** Removes secrets that can appear in URLs (OTA download tokens). */
export function redactUrl(url: string): string {
  return url.replace(/([?&](?:t|token|code|password)=)[^&#]*/gi, "$1[redacted]");
}

export const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "res.headers['set-cookie']",
  "headers.authorization",
  "headers.cookie",
  "password",
  "*.password",
  "current",
  "next",
  "*.current",
  "*.next",
  "token",
  "*.token",
  "device_token",
  "*.device_token",
  "token_hash",
  "*.token_hash",
  "pairing_code",
  "*.pairing_code",
  "body.code",
  "*.body.code",
];

interface RawReq {
  method?: string;
  url?: string;
  ip?: string;
  socket?: { remoteAddress?: string };
}

export function loggerOptions(level: string) {
  return {
    level,
    redact: { paths: REDACT_PATHS, censor: "[redacted]" },
    serializers: {
      req(req: RawReq) {
        return {
          method: req.method,
          url: redactUrl(req.url ?? ""),
          remoteAddress: req.ip ?? req.socket?.remoteAddress,
        };
      },
    },
  };
}
