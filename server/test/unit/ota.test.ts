import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { openDatabase } from "../../src/db/db";
import { APP_DESC_MAGIC, buildTestImage, parseAppDesc, parseDoubleLampImage } from "../../src/ota/app-desc";
import { FirmwareStore } from "../../src/ota/firmware";
import { DOWNLOAD_TOKEN_TTL_MS, signDownloadToken, verifyDownloadToken } from "../../src/ota/token";
import { ApiError } from "../../src/util/errors";

const SECRET = "test-secret-0123456789abcdef0123456789";
const SHA = "a".repeat(64);
const OTHER_SHA = "b".repeat(64);

describe("download tokens", () => {
  const now = 1_761_650_000_000;
  const token = signDownloadToken(SECRET, "dl-3fa2c1", SHA, now + DOWNLOAD_TOKEN_TTL_MS);

  it("verify for the right firmware before expiry", () => {
    expect(verifyDownloadToken(SECRET, token, SHA, now)).toEqual({ ok: true, deviceId: "dl-3fa2c1", expiresAt: now + DOWNLOAD_TOKEN_TTL_MS });
    expect(DOWNLOAD_TOKEN_TTL_MS).toBe(15 * 60_000);
  });

  it("expire after 15 minutes", () => {
    expect(verifyDownloadToken(SECRET, token, SHA, now + DOWNLOAD_TOKEN_TTL_MS)).toEqual({ ok: false, reason: "expired" });
  });

  it("are bound to the sha256, the device and the expiry, and the secret", () => {
    expect(verifyDownloadToken(SECRET, token, OTHER_SHA, now)).toMatchObject({ ok: false, reason: "bad_signature" });
    expect(verifyDownloadToken(SECRET, token.replace("dl-3fa2c1", "dl-3fa2c2"), SHA, now)).toMatchObject({ ok: false, reason: "bad_signature" });
    const [d, , sig] = token.split(".");
    expect(verifyDownloadToken(SECRET, `${d}.${now + 10 * DOWNLOAD_TOKEN_TTL_MS}.${sig}`, SHA, now)).toMatchObject({ ok: false });
    expect(verifyDownloadToken("another-secret-0123456789abcdef", token, SHA, now)).toMatchObject({ ok: false, reason: "bad_signature" });
  });

  it("reject malformed input", () => {
    for (const t of ["", "x", "a.b", "dl-3fa2c1.notanumber.sig", "evil.123.sig", "a.b.c.d"]) {
      expect(verifyDownloadToken(SECRET, t, SHA, now)).toMatchObject({ ok: false });
    }
  });
});

describe("esp_app_desc_t parsing", () => {
  it("reads version, project, time, date and IDF version at offset 32", () => {
    const img = buildTestImage({ version: "1.3.0", idf: "v5.3.1" });
    expect(img.readUInt32LE(32)).toBe(APP_DESC_MAGIC);
    expect(parseAppDesc(img)).toEqual({ version: "1.3.0", projectName: "doublelamp", time: "12:00:00", date: "Oct 28 2026", idfVer: "v5.3.1" });
  });

  it("checks the field offsets byte by byte", () => {
    const img = Buffer.alloc(256);
    img.writeUInt32LE(0xabcd5432, 32);
    img.write("2.0.0-rc1", 48);
    img.write("doublelamp", 80);
    img.write("01:02:03", 112);
    img.write("Jan  1 2027", 128);
    img.write("v5.4", 144);
    expect(parseDoubleLampImage(img)).toMatchObject({ version: "2.0.0-rc1", projectName: "doublelamp", time: "01:02:03", date: "Jan  1 2027", idfVer: "v5.4" });
  });

  it("rejects images without the magic word, too short, or from another project", () => {
    const img = buildTestImage({ version: "1.0.0" });
    img.writeUInt32LE(0x12345678, 32);
    expect(() => parseAppDesc(img)).toThrow(/magic/);
    expect(() => parseAppDesc(Buffer.alloc(100))).toThrow(/too short/);
    expect(() => parseDoubleLampImage(buildTestImage({ version: "1.0.0", project: "blinky" }))).toThrow(/project_name/);
  });
});

describe("FirmwareStore", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dl-fw-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("stores DATA_DIR/firmware/<sha256>.bin and dedupes re-uploads", () => {
    const db = openDatabase(":memory:");
    const store = new FirmwareStore(db, dir, () => 1000);
    const img = buildTestImage({ version: "1.3.0", size: 8192 });
    const a = store.add(img, "first");
    expect(a.created).toBe(true);
    expect(a.info).toMatchObject({ version: "1.3.0", size: 8192, notes: "first", idf: "v5.3.1" });
    expect(store.fileSize(a.info.sha256)).toBe(8192);
    expect(store.filePath(a.info.sha256)).toBe(path.join(dir, "firmware", `${a.info.sha256}.bin`));
    const b = store.add(img, null);
    expect(b.created).toBe(false);
    expect(store.findByVersion("1.3.0")?.sha256).toBe(a.info.sha256);
    expect(store.list()).toHaveLength(1);
    expect(store.remove(a.info.sha256)).toBe(true);
    expect(store.fileSize(a.info.sha256)).toBeNull();
  });

  it("refuses images that aren't DoubleLamp apps", () => {
    const db = openDatabase(":memory:");
    const store = new FirmwareStore(db, dir, () => 1000);
    expect(() => store.add(buildTestImage({ version: "1.0.0", project: "other" }), null)).toThrow(ApiError);
    expect(() => store.add(Buffer.alloc(0), null)).toThrow(ApiError);
  });
});
