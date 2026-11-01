// Everything the routes and hubs share, plus the operations that touch several modules at once.
import type { ClaimRequest, ClaimResponse, GroupView } from "@doublelamp/protocol";
import type { ActivityLog } from "./activity";
import type { PasswordStore } from "./auth/password";
import type { DualLimiter } from "./auth/rate-limit";
import type { SessionStore } from "./auth/sessions";
import type { Config } from "./config";
import type { DB } from "./db/db";
import type { DeviceRegistry } from "./devices";
import type { SyncEngine } from "./engine/engine";
import type { ClientHub } from "./hubs/client-hub";
import type { DeviceHub } from "./hubs/device-hub";
import type { Logger } from "./log";
import type { FirmwareStore } from "./ota/firmware";
import type { OtaManager } from "./ota/jobs";
import type { PairingCodes } from "./pairing";
import { DEFAULT_GROUP_NAME, type GroupStore, type ReplicaPersister } from "./persistence";
import type { SceneStore } from "./scenes";
import type { Scheduler } from "./scheduler";
import type { TelemetryRing } from "./telemetry";
import { randomToken, sha256Hex } from "./util/crypto";
import { ApiError } from "./util/errors";
import type { Views } from "./views";

export interface AppContext {
  config: Config;
  secret: string;
  clock: () => number;
  log: Logger;
  db: DB;
  engine: SyncEngine;
  devices: DeviceRegistry;
  groups: GroupStore;
  sessions: SessionStore;
  passwords: PasswordStore;
  pairing: PairingCodes;
  scenes: SceneStore;
  scheduler: Scheduler;
  firmware: FirmwareStore;
  ota: OtaManager;
  activity: ActivityLog;
  telemetry: TelemetryRing;
  deviceHub: DeviceHub;
  clientHub: ClientHub;
  persister: ReplicaPersister;
  views: Views;
  loginLimiter: DualLimiter;
  claimLimiter: DualLimiter;
  ops: Ops;
}

export class Ops {
  constructor(private readonly ctx: AppContext) {}

  broadcastDevice(id: string): void {
    const view = this.ctx.views.device(id);
    if (view) this.ctx.clientHub.broadcast("device.updated", view);
  }

  broadcastGroup(id: number): void {
    const view = this.ctx.views.group(id);
    if (view) this.ctx.clientHub.broadcast("group.updated", view);
  }

  /** scene.updated to browsers, presets.sync to lamps. */
  scenesChanged(): void {
    this.ctx.clientHub.broadcast("scene.updated", { scenes: this.ctx.scenes.list() });
    this.ctx.deviceHub.pushPresetsAll();
  }

  /**
   * Renames a lamp. From the web app: `name.set` goes to the lamp now, or after its next welcome if it's offline.
   * From the lamp itself (info.name): just record it.
   */
  renameDevice(id: string, name: string, from: { by?: string; lamp?: boolean } = {}): void {
    const rec = this.ctx.devices.get(id);
    if (!rec || rec.name === name) return;
    const old = rec.name;
    const online = this.ctx.engine.isOnline(id);
    this.ctx.devices.update(id, { name, namePending: from.lamp ? false : !online });
    this.ctx.engine.renameDevice(id, name);
    if (!from.lamp && online) this.ctx.deviceHub.send(id, "name.set", { name });
    this.ctx.activity.record("rename", {
      deviceId: id,
      by: from.by ?? null,
      data: { name, from: old, ...(from.lamp ? { source: "lamp" } : {}) },
    });
    this.broadcastDevice(id);
  }

  /** POST /devices/claim (05 §8). The caller has validated the body and applied the rate limit. */
  claim(req: ClaimRequest): ClaimResponse {
    const result = this.ctx.pairing.consume(req.code, req.device_id);
    if (result === "invalid") throw new ApiError("invalid_code", "that pairing code is wrong or was already used", "code");
    if (result === "expired") throw new ApiError("code_expired", "that pairing code has expired; create a new one", "code");
    const token = randomToken(32);
    const now = this.ctx.clock();
    const existed = this.ctx.devices.get(req.device_id) !== undefined;
    if (existed) this.ctx.deviceHub.dropForNewToken(req.device_id);
    this.ctx.devices.claim({ id: req.device_id, name: req.name, fw: req.fw, hw: req.hw, tokenHash: sha256Hex(token), now });
    if (this.ctx.engine.getDevice(req.device_id)) this.ctx.engine.renameDevice(req.device_id, req.name);
    else this.ctx.engine.addDevice({ id: req.device_id, name: req.name });

    let gid = this.ctx.groups.defaultGroupId();
    if (gid === null) {
      gid = this.ctx.groups.create(DEFAULT_GROUP_NAME, true);
      this.ctx.engine.addGroup({ id: gid, name: DEFAULT_GROUP_NAME, linked: false });
    }
    if (this.ctx.engine.getDevice(req.device_id)?.groupId === null) {
      this.ctx.groups.addMember(gid, req.device_id);
      this.ctx.engine.addMember(gid, req.device_id);
    }
    this.ctx.activity.record("claim", { deviceId: req.device_id, data: { name: req.name, fw: req.fw, ...(existed ? { reclaim: true } : {}) } });
    this.ctx.log.info({ device: req.device_id, reclaim: existed }, "lamp claimed");
    this.broadcastDevice(req.device_id);
    this.broadcastGroup(gid);
    return { device_token: token, ws_url: this.ctx.config.deviceWsUrl };
  }

  /** DELETE /devices/:id: `unclaim`, close 4003, forget the lamp and its token. */
  unclaim(id: string, by?: string): void {
    const rec = this.ctx.devices.get(id);
    if (!rec) throw new ApiError("not_found", "no such lamp");
    const gid = this.ctx.engine.getDevice(id)?.groupId ?? null;
    this.ctx.deviceHub.unclaim(id);
    this.ctx.engine.removeDevice(id);
    this.ctx.devices.remove(id);
    this.ctx.telemetry.remove(id);
    this.ctx.persister.mark({ type: "device", id });
    this.ctx.activity.record("unclaim", { deviceId: id, by: by ?? null, data: { name: rec.name } });
    this.ctx.log.info({ device: id }, "lamp unclaimed");
    this.ctx.clientHub.broadcast("device.removed", { id });
    if (gid !== null) this.broadcastGroup(gid);
    this.ctx.ota.kick();
  }

  /** PATCH /groups/:id */
  updateGroup(id: number, patch: { name?: string; linked?: boolean; match_from?: string }, by?: string): GroupView {
    const g = this.ctx.engine.getGroup(id);
    if (!g) throw new ApiError("not_found", "no such group");
    if (patch.match_from !== undefined && !g.members.includes(patch.match_from)) {
      throw new ApiError("invalid", "match_from must be a lamp in this group", "match_from");
    }
    if (patch.name !== undefined && patch.name !== g.name) {
      this.ctx.groups.update(id, { name: patch.name });
      this.ctx.engine.renameGroup(id, patch.name);
    }
    if (patch.linked !== undefined) {
      const r = this.ctx.engine.setLinked(id, patch.linked, patch.match_from);
      if (!r.ok) throw new ApiError(r.code, r.message, r.field);
      if (r.changed) {
        this.ctx.groups.update(id, { linked: patch.linked });
        this.ctx.activity.record(patch.linked ? "link" : "unlink", {
          by: by ?? null,
          data: { group_id: id, ...(patch.linked && r.sourceId ? { match_from: r.sourceId } : {}) },
        });
        this.ctx.log.info({ group: id, linked: patch.linked, source: r.ok ? r.sourceId : undefined }, "group link changed");
      }
    }
    this.broadcastGroup(id);
    for (const m of g.members) this.broadcastDevice(m);
    return this.ctx.views.group(id)!;
  }
}
