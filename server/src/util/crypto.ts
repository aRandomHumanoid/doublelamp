import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

export function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** `bytes` random bytes as base64url (32 bytes → 43 characters). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function randomHex(bytes = 8): string {
  return randomBytes(bytes).toString("hex");
}

/** Constant-time comparison of two hex digests. */
export function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length || a.length % 2 !== 0) return false;
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  if (ba.length !== bb.length || ba.length * 2 !== a.length) return false;
  return timingSafeEqual(ba, bb);
}

/** Constant-time comparison of two strings (by their UTF-8 bytes). */
export function safeEqualString(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

const PASSWORD_ALPHABET = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** A random password without look-alike characters. */
export function generatePassword(length = 16): string {
  let s = "";
  for (let i = 0; i < length; i++) s += PASSWORD_ALPHABET[randomInt(PASSWORD_ALPHABET.length)];
  return s;
}
