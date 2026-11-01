// HTTP plumbing: body parsers, error mapping, security headers, session/origin checks, client IP.
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { LampState } from "@doublelamp/protocol";
import { SESSION_COOKIE, SESSION_TTL_MS, type SessionRecord } from "../auth/sessions";
import type { Config } from "../config";
import type { AppContext } from "../context";
import type { DeviceRecord } from "../devices";
import type { CommandResult } from "../engine/engine";
import { redactUrl } from "../log";
import { MAX_FIRMWARE_BYTES } from "../ota/firmware";
import { ApiError, errorBody } from "../util/errors";

declare module "fastify" {
  interface FastifyRequest {
    session: SessionRecord | null;
    deviceAuth: DeviceRecord | null;
  }
  interface FastifyContextConfig {
    /** No session required (login, lamp claim). */
    public?: boolean;
  }
}

export const CSP = "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function isSafeMethod(method: string): boolean {
  return SAFE_METHODS.has(method);
}

export function originAllowed(config: Config, origin: string | undefined): boolean {
  return origin !== undefined && config.allowedOrigins.includes(origin);
}

/** Client IP for rate limits: CF-Connecting-IP only behind Cloudflare Tunnel (TRUST_PROXY=cloudflare, 07 T18). */
export function clientIp(req: FastifyRequest, config: Config): string {
  if (config.trustProxy === "cloudflare") {
    const h = req.headers["cf-connecting-ip"];
    const v = Array.isArray(h) ? h[0] : h;
    if (v && v.length <= 64) return v.trim();
  }
  return req.ip;
}

export function readSession(req: FastifyRequest, ctx: AppContext): SessionRecord | null {
  const raw = req.cookies?.[SESSION_COOKIE];
  if (!raw) return null;
  const unsigned = req.unsignCookie(raw);
  if (!unsigned.valid || !unsigned.value) return null;
  return ctx.sessions.validate(unsigned.value);
}

export function setSessionCookie(reply: FastifyReply, ctx: AppContext, token: string): void {
  reply.setCookie(SESSION_COOKIE, token, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: ctx.config.secureCookies,
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
    signed: true,
  });
}

export function clearSessionCookie(reply: FastifyReply, ctx: AppContext): void {
  reply.clearCookie(SESSION_COOKIE, { path: "/", httpOnly: true, sameSite: "lax", secure: ctx.config.secureCookies });
}

/** Maps an engine result to `{state}` or throws the matching ApiError (offline → 409). */
export function stateResult(r: CommandResult): { state: LampState } {
  if (!r.ok) throw new ApiError(r.code, r.message, r.field);
  return { state: r.state };
}

export function intParam(raw: string, what = "id"): number {
  if (!/^\d{1,12}$/.test(raw)) throw new ApiError("not_found", `no such ${what}`);
  return Number(raw);
}

export function registerCommon(app: FastifyInstance, ctx: AppContext): void {
  app.decorateRequest("session", null);
  app.decorateRequest("deviceAuth", null);

  // JSON bodies; an empty body is treated as {} so bodiless POSTs work.
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    const text = typeof body === "string" ? body : body.toString("utf8");
    if (text.trim() === "") return done(null, undefined);
    try {
      done(null, JSON.parse(text));
    } catch {
      done(new ApiError("invalid", "malformed JSON body"), undefined);
    }
  });
  // Firmware uploads (POST /firmware): raw bytes, ≤ 4 MB.
  app.addContentTypeParser("application/octet-stream", { parseAs: "buffer", bodyLimit: MAX_FIRMWARE_BYTES }, (_req, body, done) => {
    done(null, body);
  });

  app.addHook("onSend", async (_req, reply, payload) => {
    reply.header("Content-Security-Policy", CSP);
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "same-origin");
    reply.header("X-Frame-Options", "DENY");
    if (ctx.config.https) reply.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    return payload;
  });

  app.addHook("onResponse", async (req, reply) => {
    const entry = { method: req.method, url: redactUrl(req.url), status: reply.statusCode, ms: Math.round(reply.elapsedTime) };
    if (reply.statusCode >= 500) req.log.warn(entry, "request failed");
    else req.log.debug(entry, "request");
  });

  app.setErrorHandler((err: FastifyError | ApiError, req, reply) => {
    if (err instanceof ApiError) return reply.code(err.status).send(errorBody(err.code, err.message, err.field));
    const code = (err as FastifyError).code;
    if (code === "FST_ERR_CTP_BODY_TOO_LARGE") return reply.code(413).send(errorBody("too_large", "request body is too large"));
    if (code === "FST_ERR_CTP_INVALID_MEDIA_TYPE") return reply.code(400).send(errorBody("invalid", "unsupported Content-Type"));
    const status = (err as FastifyError).statusCode;
    if (status !== undefined && status >= 400 && status < 500) {
      const c =
        ({ 401: "auth_required", 403: "forbidden", 404: "not_found", 409: "conflict", 413: "too_large", 429: "rate_limited" } as Record<number, string>)[
          status
        ] ?? "invalid";
      return reply.code(status).send(errorBody(c, err.message));
    }
    req.log.error({ err }, "unhandled error");
    return reply.code(500).send(errorBody("internal", "internal server error"));
  });
}

/** For routes under /api/v1: require a session unless the route is public; check Origin on state changes. */
export function apiAuthHook(ctx: AppContext) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    reply.header("Cache-Control", "no-store");
    req.session = readSession(req, ctx);
    if (req.routeOptions.config?.public) return;
    if (!req.session) throw new ApiError("auth_required", "log in first");
    if (!isSafeMethod(req.method) && !originAllowed(ctx.config, req.headers.origin)) {
      throw new ApiError("forbidden", "the Origin header is missing or not allowed");
    }
  };
}
