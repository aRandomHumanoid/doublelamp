// WebSocket endpoints. Auth runs in onRequest hooks, before the upgrade: a failure answers with a plain HTTP
// 401/403, which is what a rejected upgrade must look like (04 §4.1).
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context";
import { ApiError } from "../util/errors";
import { clientIp, originAllowed, readSession } from "./common";

export function wsRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get(
    "/ws/device",
    {
      websocket: true,
      onRequest: async (req) => {
        const device = ctx.deviceHub.authenticate(req.headers.authorization);
        if (!device) throw new ApiError("auth_required", "bad or missing device token");
        req.deviceAuth = device;
      },
    },
    (socket, req) => {
      ctx.deviceHub.handle(socket, req.deviceAuth!.id, clientIp(req, ctx.config));
    },
  );

  app.get(
    "/ws/client",
    {
      websocket: true,
      onRequest: async (req) => {
        if (!originAllowed(ctx.config, req.headers.origin)) throw new ApiError("forbidden", "the Origin header is missing or not allowed");
        req.session = readSession(req, ctx);
        if (!req.session) throw new ApiError("auth_required", "log in first");
      },
    },
    (socket, req) => {
      ctx.clientHub.handle(socket, req.session!);
    },
  );
}
