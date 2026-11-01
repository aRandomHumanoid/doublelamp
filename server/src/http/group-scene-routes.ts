// Link groups, scenes and schedules.
import type { FastifyInstance } from "fastify";
import {
  groupPatchSchema,
  sceneApplySchema,
  sceneCreateSchema,
  sceneReorderSchema,
  sceneUpdateSchema,
  scheduleCreateSchema,
  scheduleUpdateSchema,
  stateCommandSchema,
} from "@doublelamp/protocol";
import type { AppContext } from "../context";
import { scenePatch } from "../scenes";
import { ApiError, parseBody } from "../util/errors";
import { intParam, stateResult } from "./common";

type IdParams = { Params: { id: string } };

export function groupRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get("/groups", async () => ({ groups: ctx.views.groupsAll() }));

  app.get<IdParams>("/groups/:id", async (req) => {
    const view = ctx.views.group(intParam(req.params.id, "group"));
    if (!view) throw new ApiError("not_found", "no such group");
    return view;
  });

  app.patch<IdParams>("/groups/:id", async (req) => {
    const id = intParam(req.params.id, "group");
    const body = parseBody(groupPatchSchema, req.body);
    return ctx.ops.updateGroup(id, body, req.session!.label);
  });

  app.post<IdParams>("/groups/:id/state", async (req) => {
    const id = intParam(req.params.id, "group");
    const cmd = parseBody(stateCommandSchema, req.body);
    return stateResult(ctx.engine.command({ group: id }, cmd.patch, { origin: "web", by: req.session!.label, transitionMs: cmd.transition_ms }));
  });
}

export function sceneRoutes(app: FastifyInstance, ctx: AppContext): void {
  const requireScene = (raw: string) => {
    const scene = ctx.scenes.get(intParam(raw, "scene"));
    if (!scene) throw new ApiError("not_found", "no such scene");
    return scene;
  };

  app.get("/scenes", async () => ({ scenes: ctx.scenes.list() }));

  app.post("/scenes", async (req, reply) => {
    const body = parseBody(sceneCreateSchema, req.body);
    let state;
    if ("state" in body) {
      state = body.state;
    } else {
      const t = body.from;
      const exists = "device" in t ? ctx.engine.getDevice(t.device) : ctx.engine.getGroup(t.group);
      if (!exists) throw new ApiError("not_found", "from: no such lamp or group", "from");
      state = ctx.engine.stateOf(t);
      if (!state) throw new ApiError("conflict", "that lamp or group has no known state yet", "from");
    }
    const scene = ctx.scenes.create(body.name, state);
    ctx.activity.record("scene_saved", { by: req.session!.label, data: { scene_id: scene.id, name: scene.name } });
    ctx.ops.scenesChanged();
    return reply.code(201).send(scene);
  });

  // Registered before /scenes/:id routes for clarity; the router would pick the static path anyway.
  app.post("/scenes/reorder", async (req) => {
    const body = parseBody(sceneReorderSchema, req.body);
    const res = ctx.scenes.reorder(body.ids);
    if (!Array.isArray(res)) throw new ApiError("invalid", `ids: no scene ${res.unknown}`, "ids");
    ctx.ops.scenesChanged();
    return { scenes: res };
  });

  app.put<IdParams>("/scenes/:id", async (req) => {
    const scene = requireScene(req.params.id);
    const body = parseBody(sceneUpdateSchema, req.body);
    const updated = ctx.scenes.update(scene.id, body)!;
    ctx.ops.scenesChanged();
    return updated;
  });

  app.delete<IdParams>("/scenes/:id", async (req, reply) => {
    const scene = requireScene(req.params.id);
    ctx.scenes.remove(scene.id);
    ctx.ops.scenesChanged();
    return reply.code(204).send();
  });

  app.post<IdParams>("/scenes/:id/apply", async (req) => {
    const scene = requireScene(req.params.id);
    const body = parseBody(sceneApplySchema, req.body);
    return stateResult(
      ctx.engine.command(body.target, scenePatch(scene.state), {
        origin: "scene",
        by: req.session!.label,
        transitionMs: body.transition_ms,
      }),
    );
  });
}

export function scheduleRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get("/schedules", async () => ({ schedules: ctx.scheduler.list() }));

  app.post("/schedules", async (req, reply) => {
    const body = parseBody(scheduleCreateSchema, req.body);
    const s = ctx.scheduler.create(body);
    return reply.code(201).send(s);
  });

  app.put<IdParams>("/schedules/:id", async (req) => {
    const id = intParam(req.params.id, "schedule");
    const body = parseBody(scheduleUpdateSchema, req.body);
    const s = ctx.scheduler.update(id, body);
    if (!s) throw new ApiError("not_found", "no such schedule");
    return s;
  });

  app.delete<IdParams>("/schedules/:id", async (req, reply) => {
    if (!ctx.scheduler.remove(intParam(req.params.id, "schedule"))) throw new ApiError("not_found", "no such schedule");
    return reply.code(204).send();
  });
}
