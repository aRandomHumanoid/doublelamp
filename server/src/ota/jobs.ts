// OTA jobs (05 §10): create row → ota.start (signed 15-min URL) → progress → done / failed.
// A job for an offline lamp stays pending and is sent after its next welcome. "Update both" is a rollout:
// one lamp at a time, the next only after the previous is done; a failure stops the rollout.
import type { Hello, OtaJob } from "@doublelamp/protocol";
import type { ActivityLog } from "../activity";
import type { DB } from "../db/db";
import type { DeviceRegistry } from "../devices";
import type { SyncEngine } from "../engine/engine";
import type { Logger } from "../log";
import { ApiError } from "../util/errors";
import type { FirmwareStore } from "./firmware";
import { DOWNLOAD_TOKEN_TTL_MS, signDownloadToken } from "./token";

export const OTA_NO_PROGRESS_TIMEOUT_MS = 15 * 60_000;

type Status = OtaJob["status"];
const ACTIVE: readonly Status[] = ["pending", "sent", "download", "verify", "reboot"];
const IN_PROGRESS: readonly Status[] = ["sent", "download", "verify", "reboot"];

interface Row {
  id: number;
  device_id: string;
  sha256: string;
  version: string;
  allow_downgrade: number;
  status: Status;
  pct: number;
  error: string | null;
  rollout_id: number | null;
  rollout_seq: number | null;
  created_at: number;
  updated_at: number;
}

function toJob(r: Row): OtaJob {
  return {
    id: r.id,
    device_id: r.device_id,
    sha256: r.sha256,
    version: r.version,
    status: r.status,
    pct: r.pct,
    error: r.error,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

export interface OtaDeps {
  db: DB;
  clock: () => number;
  firmware: FirmwareStore;
  devices: DeviceRegistry;
  engine: SyncEngine;
  /** Sends a message to a connected lamp; false if it isn't connected. */
  send: (deviceId: string, type: string, data: unknown) => boolean;
  /** `ota.job` to browsers. */
  broadcast: (job: OtaJob) => void;
  /** The lamp's DeviceView changed (pending_verify). */
  deviceChanged: (deviceId: string) => void;
  activity: ActivityLog;
  log: Logger;
  publicUrl: string;
  secret: string;
  timeoutMs?: number;
}

export class OtaManager {
  constructor(private readonly deps: OtaDeps) {}

  private row(id: number): Row | undefined {
    return this.deps.db.prepare("SELECT * FROM ota_jobs WHERE id = ?").get(id) as Row | undefined;
  }

  list(limit = 100): OtaJob[] {
    return (this.deps.db.prepare("SELECT * FROM ota_jobs ORDER BY id DESC LIMIT ?").all(limit) as Row[]).map(toJob);
  }

  get(id: number): OtaJob | null {
    const r = this.row(id);
    return r ? toJob(r) : null;
  }

  private activeRow(deviceId: string): Row | undefined {
    return this.deps.db
      .prepare(`SELECT * FROM ota_jobs WHERE device_id = ? AND status IN (${ACTIVE.map(() => "?").join(",")}) ORDER BY id LIMIT 1`)
      .get(deviceId, ...ACTIVE) as Row | undefined;
  }

  activeJobFor(deviceId: string): OtaJob | null {
    const r = this.activeRow(deviceId);
    return r ? toJob(r) : null;
  }

  private insert(deviceId: string, sha256: string, version: string, allowDowngrade: boolean, rolloutId: number | null, seq: number | null): Row {
    const now = this.deps.clock();
    const id = Number(
      this.deps.db
        .prepare(
          `INSERT INTO ota_jobs (device_id, sha256, version, allow_downgrade, status, pct, rollout_id, rollout_seq, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?)`,
        )
        .run(deviceId, sha256, version, allowDowngrade ? 1 : 0, rolloutId, seq, now, now).lastInsertRowid,
    );
    return this.row(id)!;
  }

  private setStatus(r: Row, status: Status, pct: number, error: string | null = null): Row {
    this.deps.db
      .prepare("UPDATE ota_jobs SET status = ?, pct = ?, error = ?, updated_at = ? WHERE id = ?")
      .run(status, pct, error, this.deps.clock(), r.id);
    const next = this.row(r.id)!;
    this.deps.broadcast(toJob(next));
    return next;
  }

  /** POST /devices/:id/ota */
  start(deviceId: string, req: { sha256?: string; version?: string; allow_downgrade?: boolean }): OtaJob {
    if (!this.deps.devices.get(deviceId)) throw new ApiError("not_found", "no such lamp");
    if (!req.sha256 && !req.version) throw new ApiError("invalid", "give sha256 or version", "sha256");
    const fw = req.sha256 ? this.deps.firmware.get(req.sha256) : this.deps.firmware.findByVersion(req.version!);
    if (!fw) throw new ApiError("not_found", "no such firmware in the library");
    if (this.activeRow(deviceId)) throw new ApiError("conflict", "an update is already in progress for this lamp");
    const r = this.insert(deviceId, fw.sha256, fw.version, req.allow_downgrade ?? false, null, null);
    this.deps.broadcast(toJob(r));
    this.deps.log.info({ job: r.id, device: deviceId, version: fw.version }, "OTA job created");
    this.trySend(r);
    return toJob(this.row(r.id)!);
  }

  /** POST /ota/rollout: every claimed lamp not already on this version, one at a time (online lamps first). */
  rollout(sha256: string): OtaJob[] {
    const fw = this.deps.firmware.get(sha256);
    if (!fw) throw new ApiError("not_found", "no such firmware in the library");
    const lamps = this.deps.devices
      .all()
      .filter((d) => d.fw !== fw.version)
      .sort((a, b) => Number(this.deps.engine.isOnline(b.id)) - Number(this.deps.engine.isOnline(a.id)));
    for (const d of lamps) {
      if (this.activeRow(d.id)) throw new ApiError("conflict", `an update is already in progress for ${d.name}`);
    }
    if (!lamps.length) return [];
    const rolloutId =
      ((this.deps.db.prepare("SELECT COALESCE(MAX(rollout_id), 0) AS m FROM ota_jobs").get() as { m: number }).m ?? 0) + 1;
    const rows = this.deps.db.transaction(() => lamps.map((d, i) => this.insert(d.id, fw.sha256, fw.version, false, rolloutId, i)))();
    for (const r of rows) this.deps.broadcast(toJob(r));
    this.deps.log.info({ rollout: rolloutId, version: fw.version, lamps: lamps.map((d) => d.id) }, "OTA rollout created");
    this.trySend(rows[0]!);
    return rows.map((r) => toJob(this.row(r.id)!));
  }

  /** A rollout job may start only after every earlier job of its rollout is done. */
  private startable(r: Row): boolean {
    if (r.rollout_id === null) return true;
    const blocking = this.deps.db
      .prepare("SELECT COUNT(*) AS n FROM ota_jobs WHERE rollout_id = ? AND rollout_seq < ? AND status != 'done'")
      .get(r.rollout_id, r.rollout_seq) as { n: number };
    return blocking.n === 0;
  }

  private trySend(r: Row): void {
    if (r.status !== "pending" && r.status !== "sent") return;
    if (!this.deps.engine.isOnline(r.device_id) || !this.startable(r)) return;
    const size = this.deps.firmware.fileSize(r.sha256);
    if (size === null) {
      this.finish(r, "failed", "the firmware file is missing from the library");
      return;
    }
    const exp = this.deps.clock() + DOWNLOAD_TOKEN_TTL_MS;
    const token = signDownloadToken(this.deps.secret, r.device_id, r.sha256, exp);
    const url = `${this.deps.publicUrl}/fw/${r.sha256}.bin?t=${encodeURIComponent(token)}`;
    const sent = this.deps.send(r.device_id, "ota.start", {
      job_id: r.id,
      version: r.version,
      url,
      sha256: r.sha256,
      size,
      allow_downgrade: r.allow_downgrade === 1,
    });
    if (sent) {
      this.setStatus(r, "sent", 0);
      this.deps.log.info({ job: r.id, device: r.device_id, version: r.version }, "ota.start sent");
    }
  }

  /** Starts whatever pending jobs can start now. */
  kick(): void {
    const rows = this.deps.db.prepare("SELECT * FROM ota_jobs WHERE status IN ('pending','sent') ORDER BY id").all() as Row[];
    for (const r of rows) this.trySend(r);
  }

  private finish(r: Row, status: "done" | "failed", error: string | null = null): void {
    const done = this.setStatus(r, status, status === "done" ? 100 : r.pct, error);
    const dev = this.deps.devices.get(r.device_id);
    this.deps.activity.record("ota", {
      deviceId: r.device_id,
      data: { job_id: r.id, version: r.version, status, ...(error ? { error } : {}) },
    });
    this.deps.log.info({ job: r.id, device: r.device_id, status, error }, "OTA job finished");
    if (done.rollout_id !== null) {
      if (status === "failed") {
        const later = this.deps.db
          .prepare("SELECT * FROM ota_jobs WHERE rollout_id = ? AND rollout_seq > ? AND status = 'pending'")
          .all(done.rollout_id, done.rollout_seq) as Row[];
        for (const l of later) this.setStatus(l, "failed", 0, `rollout stopped: the update of ${dev?.name ?? r.device_id} failed`);
      } else {
        this.kick();
      }
    }
  }

  /** ota.progress from a lamp. */
  onProgress(deviceId: string, p: { job_id: number; phase: "download" | "verify" | "reboot" | "done" | "failed"; pct: number; error?: string }): void {
    const r = this.row(p.job_id);
    if (!r || r.device_id !== deviceId) {
      this.deps.log.warn({ device: deviceId, job: p.job_id }, "ota.progress for an unknown job");
      return;
    }
    if (r.status === "done" || r.status === "failed") return;
    if (p.phase === "failed") return this.finish(r, "failed", p.error ?? "the lamp reported a failure");
    if (p.phase === "done") {
      this.clearPendingVerify(deviceId);
      return this.finish(r, "done");
    }
    this.setStatus(r, p.phase, p.pct);
  }

  /** hello: a rollback fails the job; a verified new version after "reboot" completes it. */
  onHello(deviceId: string, hello: Pick<Hello, "fw" | "rollback" | "pending_verify">): void {
    const r = this.activeRow(deviceId);
    if (!r) return;
    if (hello.rollback && IN_PROGRESS.includes(r.status)) {
      this.finish(r, "failed", "the new firmware failed its self-test and the lamp rolled back");
    } else if (r.status === "reboot" && hello.fw === r.version && !hello.pending_verify) {
      this.finish(r, "done");
    }
  }

  /** After welcome: send a job that is waiting for this lamp. */
  onWelcome(deviceId: string): void {
    const r = this.activeRow(deviceId);
    if (r && (r.status === "pending" || r.status === "sent")) this.trySend(r);
  }

  /** A lamp that disconnects before starting a sent job gets it again after its next welcome. */
  onDisconnect(deviceId: string): void {
    const r = this.activeRow(deviceId);
    if (r && r.status === "sent") this.setStatus(r, "pending", 0);
  }

  private clearPendingVerify(deviceId: string): void {
    const d = this.deps.devices.get(deviceId);
    if (d?.pendingVerify) {
      this.deps.devices.update(deviceId, { pendingVerify: false });
      this.deps.deviceChanged(deviceId);
    }
  }

  /** Fails jobs with no progress for 15 minutes. */
  checkTimeouts(): void {
    const cutoff = this.deps.clock() - (this.deps.timeoutMs ?? OTA_NO_PROGRESS_TIMEOUT_MS);
    const rows = this.deps.db
      .prepare(`SELECT * FROM ota_jobs WHERE status IN (${IN_PROGRESS.map(() => "?").join(",")}) AND updated_at < ?`)
      .all(...IN_PROGRESS, cutoff) as Row[];
    for (const r of rows) this.finish(r, "failed", "no progress for 15 minutes");
  }
}
