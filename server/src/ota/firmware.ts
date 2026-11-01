// Firmware library: DATA_DIR/firmware/<sha256>.bin plus a `firmware` row. The server never holds the signing
// key; lamps check signatures themselves (07 §2).
import { existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { FirmwareInfo } from "@doublelamp/protocol";
import type { DB } from "../db/db";
import { sha256Hex } from "../util/crypto";
import { ApiError } from "../util/errors";
import { AppDescError, parseDoubleLampImage } from "./app-desc";

export const MAX_FIRMWARE_BYTES = 4 * 1024 * 1024;

interface Row {
  sha256: string;
  version: string;
  project: string | null;
  idf: string | null;
  build_date: string | null;
  size: number;
  notes: string | null;
  uploaded_at: number;
}

function toInfo(r: Row): FirmwareInfo {
  return { sha256: r.sha256, version: r.version, idf: r.idf, size: r.size, notes: r.notes, uploaded_at: r.uploaded_at };
}

export class FirmwareStore {
  readonly dir: string;

  constructor(
    private readonly db: DB,
    dataDir: string,
    private readonly clock: () => number,
  ) {
    this.dir = path.join(dataDir, "firmware");
    mkdirSync(this.dir, { recursive: true });
  }

  list(): FirmwareInfo[] {
    return (this.db.prepare("SELECT * FROM firmware ORDER BY uploaded_at DESC").all() as Row[]).map(toInfo);
  }

  get(sha256: string): FirmwareInfo | null {
    const row = this.db.prepare("SELECT * FROM firmware WHERE sha256 = ?").get(sha256) as Row | undefined;
    return row ? toInfo(row) : null;
  }

  /** The most recently uploaded image with this version. */
  findByVersion(version: string): FirmwareInfo | null {
    const row = this.db.prepare("SELECT * FROM firmware WHERE version = ? ORDER BY uploaded_at DESC LIMIT 1").get(version) as Row | undefined;
    return row ? toInfo(row) : null;
  }

  filePath(sha256: string): string {
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error("bad sha256");
    return path.join(this.dir, `${sha256}.bin`);
  }

  fileSize(sha256: string): number | null {
    const p = this.filePath(sha256);
    return existsSync(p) ? statSync(p).size : null;
  }

  /** Validates the image (esp_app_desc_t, project "doublelamp") and stores it. Re-uploading returns the existing entry. */
  add(image: Buffer, notes: string | null): { info: FirmwareInfo; created: boolean } {
    if (image.length === 0) throw new ApiError("invalid", "empty body; send the .bin as application/octet-stream");
    if (image.length > MAX_FIRMWARE_BYTES) throw new ApiError("too_large", "firmware images are limited to 4 MB");
    let desc;
    try {
      desc = parseDoubleLampImage(image);
    } catch (err) {
      if (err instanceof AppDescError) throw new ApiError("invalid", err.message);
      throw err;
    }
    const sha = sha256Hex(image);
    const existing = this.get(sha);
    if (existing && this.fileSize(sha) === image.length) {
      if (notes && notes !== existing.notes) this.db.prepare("UPDATE firmware SET notes = ? WHERE sha256 = ?").run(notes, sha);
      return { info: this.get(sha)!, created: false };
    }
    const file = this.filePath(sha);
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, image);
    renameSync(tmp, file);
    this.db
      .prepare(
        `INSERT INTO firmware (sha256, version, project, idf, build_date, size, notes, uploaded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(sha256) DO UPDATE SET version = excluded.version, size = excluded.size, notes = excluded.notes, uploaded_at = excluded.uploaded_at`,
      )
      .run(sha, desc.version, desc.projectName, desc.idfVer || null, `${desc.date} ${desc.time}`.trim(), image.length, notes, this.clock());
    return { info: this.get(sha)!, created: true };
  }

  remove(sha256: string): boolean {
    const ok = this.db.prepare("DELETE FROM firmware WHERE sha256 = ?").run(sha256).changes > 0;
    rmSync(this.filePath(sha256), { force: true });
    return ok;
  }
}
