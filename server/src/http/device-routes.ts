// Lamps: list, rename/config, unclaim, commands, overlays, OTA, and the lamps' own claim endpoint.
import type { FastifyInstance } from "fastify";
import {
  claimRequestSchema,
  devicePatchSchema,
  identifyRequestSchema,
  normalizeHex,
  nudgeRequestSchema,
  otaStartRequestSchema,
  stateCommandSchema,
} from "@doublelamp/protocol";
import type { AppContext } from "../context";
import { ApiError, parseBody } from "../util/errors";
import { clientIp, stateResult } from "./common";

type IdParams = { Params: { id: string } };

export function deviceRoutes(app: FastifyInstance, ctx: AppContext): void {
  const requireDevice = (id: string) => {
    const rec = ctx.devices.get(id);
    if (!rec) throw new ApiError("not_found", "no such lamp");
    return rec;
  };
  const requireOnline = (id: string, name: string) => {
    if (!ctx.engine.isOnline(id)) throw new ApiError("offline", `${name} is offline`);
  };

  // ---- lamps' pairing endpoint (no session; rate-limited 5/min/IP, 20/h overall)
  app.post("/devices/claim", { config: { public: true } }, async (req) => {
    const ip = clientIp(req, ctx.config);
    if (ctx.claimLimiter.limited(ip)) throw new ApiError("rate_limited", "too many pairing attempts; try again later");
    ctx.claimLimiter.hit(ip);
    const body = parseBody(claimRequestSchema, req.body);
    return ctx.ops.claim(body);
  });

  app.get("/devices", async () => ({ devices: ctx.views.devicesAll() }));

  app.get<IdParams>("/devices/:id", async (req) => {
    const view = ctx.views.device(req.params.id);
    if (!view) throw new ApiError("not_found", "no such lamp");
    return view;
  });

  app.patch<IdParams>("/devices/:id", async (req) => {
    const id = req.params.id;
    const rec = requireDevice(id);
    const body = parseBody(devicePatchSchema, req.body);
    const config = body.config && Object.keys(body.config).length ? body.config : undefined;
    if (config) requireOnline(id, rec.name);
    if (body.name !== undefined) ctx.ops.renameDevice(id, body.name, { by: req.session!.label });
    if (config) {
      ctx.deviceHub.send(id, "config.set", config);
      // The lamp confirms with an `info` message; show the change right away meanwhile.
      if (rec.config) ctx.devices.update(id, { config: { ...rec.config, ...config } });
      ctx.activity.record("config", { deviceId: id, by: req.session!.label, data: { config } });
      ctx.ops.broadcastDevice(id);
    }
    return ctx.views.device(id)!;
  });

  app.delete<IdParams>("/devices/:id", async (req, reply) => {
    ctx.ops.unclaim(req.params.id, req.session!.label);
    return reply.code(204).send();
  });

  app.post<IdParams>("/devices/:id/state", async (req) => {
    requireDevice(req.params.id);
    const cmd = parseBody(stateCommandSchema, req.body);
    return stateResult(
      ctx.engine.command({ device: req.params.id }, cmd.patch, {
        origin: "web",
        by: req.session!.label,
        transitionMs: cmd.transition_ms,
      }),
    );
  });

  app.post<IdParams>("/devices/:id/identify", async (req, reply) => {
    const rec = requireDevice(req.params.id);
    const body = parseBody(identifyRequestSchema, req.body);
    requireOnline(rec.id, rec.name);
    ctx.deviceHub.send(rec.id, "identify", { duration_ms: body.duration_ms ?? 3000 }, { essential: false });
    return reply.code(204).send();
  });

  app.post<IdParams>("/devices/:id/nudge", async (req, reply) => {
    const rec = requireDevice(req.params.id);
    const body = parseBody(nudgeRequestSchema, req.body);
    requireOnline(rec.id, rec.name);
    const color = body.color ? normalizeHex(body.color) : (ctx.engine.stateOf({ device: rec.id })?.colors[0] ?? "#FFB46B");
    ctx.deviceHub.send(rec.id, "nudge", { from_name: req.session!.label.slice(0, 32), color, count: body.count ?? 3 });
    ctx.activity.record("nudge", { deviceId: rec.id, by: req.session!.label, data: { color } });
    return reply.code(204).send();
  });

  app.post<IdParams>("/devices/:id/ota", async (req, reply) => {
    requireDevice(req.params.id);
    const body = parseBody(otaStartRequestSchema, req.body);
    const job = ctx.ota.start(req.params.id, body);
    return reply.code(201).send(job);
  });
}
