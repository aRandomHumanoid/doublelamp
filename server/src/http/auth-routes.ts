// Shared-password login and sessions (05 §6).
import type { FastifyInstance } from "fastify";
import { loginRequestSchema, passwordChangeSchema } from "@doublelamp/protocol";
import { shortUserAgent, toSessionInfo } from "../auth/sessions";
import type { AppContext } from "../context";
import { ApiError, parseBody } from "../util/errors";
import { clearSessionCookie, clientIp, originAllowed, setSessionCookie } from "./common";

export function authRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post("/auth/login", { config: { public: true } }, async (req, reply) => {
    // Browsers always send Origin on POST; refusing foreign ones stops login CSRF. Scripts may omit it.
    if (req.headers.origin !== undefined && !originAllowed(ctx.config, req.headers.origin)) {
      throw new ApiError("forbidden", "the Origin header is not allowed");
    }
    const ip = clientIp(req, ctx.config);
    if (ctx.loginLimiter.limited(ip)) throw new ApiError("rate_limited", "too many failed logins; try again later");
    const body = parseBody(loginRequestSchema, req.body);
    if (!(await ctx.passwords.check(body.password))) {
      ctx.loginLimiter.hit(ip);
      ctx.activity.record("login_failed", { data: { ip } });
      req.log.warn({ ip }, "failed login");
      throw new ApiError("auth_required", "wrong password");
    }
    // Sessions rotate on login.
    if (req.session) {
      ctx.sessions.revoke(req.session.id);
      ctx.clientHub.closeSessions([req.session.id], "logged in again");
    }
    const ua = req.headers["user-agent"] ?? null;
    const label = body.label?.trim() || shortUserAgent(ua);
    const { token, session } = ctx.sessions.create(label, ua);
    setSessionCookie(reply, ctx, token);
    ctx.activity.record("login", { by: session.label });
    return { session: toSessionInfo(session, session.id) };
  });

  app.post("/auth/logout", async (req, reply) => {
    const s = req.session!;
    ctx.sessions.revoke(s.id);
    clearSessionCookie(reply, ctx);
    ctx.clientHub.closeSessions([s.id], "logged out");
    ctx.activity.record("logout", { by: s.label });
    return reply.code(204).send();
  });

  app.get("/me", async (req) => {
    const s = req.session!;
    return { session: toSessionInfo(s, s.id), server_time: ctx.clock() };
  });

  app.put("/auth/password", async (req, reply) => {
    const s = req.session!;
    const ip = clientIp(req, ctx.config);
    if (ctx.loginLimiter.limited(ip)) throw new ApiError("rate_limited", "too many failed attempts; try again later");
    const body = parseBody(passwordChangeSchema, req.body);
    if (!(await ctx.passwords.check(body.current))) {
      ctx.loginLimiter.hit(ip);
      ctx.activity.record("login_failed", { by: s.label, data: { ip, during: "password_change" } });
      // 403, not 401: the session is fine, the current password isn't.
      throw new ApiError("forbidden", "the current password is wrong", "current");
    }
    await ctx.passwords.set(body.next);
    const revoked = ctx.sessions.revokeAllExcept(s.id);
    ctx.clientHub.closeSessions(revoked, "password changed");
    ctx.activity.record("password_changed", { by: s.label, data: { revoked_sessions: revoked.length } });
    req.log.info({ revoked: revoked.length }, "shared password changed");
    return reply.code(204).send();
  });

  app.get("/sessions", async (req) => {
    const current = req.session!.id;
    return { sessions: ctx.sessions.list().map((s) => toSessionInfo(s, current)) };
  });

  app.delete<{ Params: { id: string } }>("/sessions/:id", async (req, reply) => {
    const target = ctx.sessions.get(req.params.id);
    if (!target) throw new ApiError("not_found", "no such session");
    ctx.sessions.revoke(target.id);
    ctx.clientHub.closeSessions([target.id], "session revoked");
    if (target.id === req.session!.id) clearSessionCookie(reply, ctx);
    ctx.activity.record("session_revoked", { by: req.session!.label, data: { label: target.label } });
    return reply.code(204).send();
  });
}
