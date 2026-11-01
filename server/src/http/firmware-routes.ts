// Firmware library, OTA jobs and rollouts (05 §10), the lamps' download URL, pairing codes, activity, health.
import { createReadStream } from "node:fs";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context";
import { verifyDownloadToken } from "../ota/token";
import { ApiError, parseBody } from "../util/errors";

const rolloutSchema = z.object({ sha256: z.string().regex(/^[0-9a-f]{64}$/, "expected a lowercase hex sha256") });
const eventsQuerySchema = z.object({
  device_id: z.string().max(40).optional(),
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});
const uploadQuerySchema = z.object({ notes: z.string().max(500).optional() });

export function firmwareRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get("/firmware", async () => ({ firmware: ctx.firmware.list() }));

  app.post("/firmware", async (req, reply) => {
    if (!Buffer.isBuffer(req.body)) throw new ApiError("invalid", "send the firmware image as application/octet-stream");
    const query = parseBody(uploadQuerySchema, req.query);
    const { info, created } = ctx.firmware.add(req.body, query.notes?.trim() || null);
    if (created) {
      ctx.activity.record("firmware_uploaded", { by: req.session!.label, data: { sha256: info.sha256, version: info.version } });
      req.log.info({ sha256: info.sha256, version: info.version, size: info.size }, "firmware uploaded");
    }
    return reply.code(created ? 201 : 200).send(info);
  });

  app.delete<{ Params: { sha256: string } }>("/firmware/:sha256", async (req, reply) => {
    const sha = req.params.sha256;
    if (!/^[0-9a-f]{64}$/.test(sha) || !ctx.firmware.get(sha)) throw new ApiError("not_found", "no such firmware");
    const busy = ctx.db
      .prepare("SELECT COUNT(*) AS n FROM ota_jobs WHERE sha256 = ? AND status IN ('pending','sent','download','verify','reboot')")
      .get(sha) as { n: number };
    if (busy.n > 0) throw new ApiError("conflict", "an update using this firmware is still in progress");
    ctx.firmware.remove(sha);
    return reply.code(204).send();
  });

  app.get("/ota-jobs", async () => ({ jobs: ctx.ota.list() }));

  app.post("/ota/rollout", async (req) => {
    const body = parseBody(rolloutSchema, req.body);
    const jobs = ctx.ota.rollout(body.sha256);
    if (jobs.length) {
      ctx.activity.record("ota_rollout", {
        by: req.session!.label,
        data: { sha256: body.sha256, version: jobs[0]!.version, status: "started", lamps: jobs.map((j) => j.device_id) },
      });
    }
    return { jobs };
  });

  app.post("/pairing-codes", async (req, reply) => {
    const { code, expiresIn } = ctx.pairing.create();
    ctx.activity.record("pairing_code", { by: req.session!.label });
    return reply.code(201).send({ code, expires_in: expiresIn });
  });

  app.get("/events", async (req) => {
    const q = parseBody(eventsQuerySchema, req.query);
    return { events: ctx.activity.query({ deviceId: q.device_id, before: q.before, limit: q.limit }) };
  });
}

/** GET /fw/<sha256>.bin?t=<token>: no session, the HMAC token is the credential. Never cached (05 §10). */
export function firmwareDownloadRoute(app: FastifyInstance, ctx: AppContext): void {
  app.get<{ Params: { file: string }; Querystring: { t?: string } }>("/fw/:file", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const m = /^([0-9a-f]{64})\.bin$/.exec(req.params.file);
    if (!m) throw new ApiError("not_found", "no such file");
    const sha = m[1]!;
    const check = verifyDownloadToken(ctx.secret, typeof req.query.t === "string" ? req.query.t : "", sha, ctx.clock());
    if (!check.ok) {
      throw new ApiError("forbidden", check.reason === "expired" ? "this download link has expired" : "invalid download token");
    }
    if (!ctx.devices.get(check.deviceId)) throw new ApiError("forbidden", "this lamp is no longer paired");
    const size = ctx.firmware.fileSize(sha);
    if (size === null) throw new ApiError("not_found", "no such firmware");
    req.log.info({ device: check.deviceId, sha256: sha }, "firmware download");
    return reply
      .header("Content-Type", "application/octet-stream")
      .header("Content-Length", String(size))
      .header("Content-Disposition", `attachment; filename="${sha}.bin"`)
      .send(createReadStream(ctx.firmware.filePath(sha)));
  });
}
