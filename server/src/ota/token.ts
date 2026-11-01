// Short-lived firmware download tokens (05 §10): HMAC over (device_id, sha256, expiry) with SERVER_SECRET.
import { createHmac } from "node:crypto";
import { safeEqualString } from "../util/crypto";

export const DOWNLOAD_TOKEN_TTL_MS = 15 * 60_000;

function mac(secret: string, deviceId: string, sha256: string, exp: number): string {
  return createHmac("sha256", secret).update(`fw\n${deviceId}\n${sha256}\n${exp}`).digest("base64url");
}

/** Token format: `<device_id>.<expiry ms>.<base64url hmac>`. */
export function signDownloadToken(secret: string, deviceId: string, sha256: string, expiresAt: number): string {
  return `${deviceId}.${expiresAt}.${mac(secret, deviceId, sha256, expiresAt)}`;
}

export type TokenCheck = { ok: true; deviceId: string; expiresAt: number } | { ok: false; reason: "malformed" | "bad_signature" | "expired" };

export function verifyDownloadToken(secret: string, token: string, sha256: string, now: number): TokenCheck {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [deviceId, expRaw, sig] = parts as [string, string, string];
  if (!/^dl-[0-9a-f]{6}$/.test(deviceId) || !/^\d{1,16}$/.test(expRaw)) return { ok: false, reason: "malformed" };
  const exp = Number(expRaw);
  if (!safeEqualString(sig, mac(secret, deviceId, sha256, exp))) return { ok: false, reason: "bad_signature" };
  if (exp <= now) return { ok: false, reason: "expired" };
  return { ok: true, deviceId, expiresAt: exp };
}
