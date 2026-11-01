// Pairing codes (05 §8): 8 Crockford base32 characters (40 bits) shown as XXXX-XXXX, 10 minutes, single use.
// Only sha256(code) is stored.
import { randomBytes } from "node:crypto";
import type { DB } from "./db/db";
import { sha256Hex } from "./util/crypto";

export const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const PAIRING_CODE_TTL_MS = 10 * 60_000;

/** 40 random bits as 8 Crockford base32 characters, formatted "XXXX-XXXX". */
export function generatePairingCode(bytes: Buffer = randomBytes(5)): string {
  if (bytes.length !== 5) throw new Error("need exactly 5 bytes");
  let bits = 0n;
  for (const b of bytes) bits = (bits << 8n) | BigInt(b);
  let out = "";
  for (let i = 7; i >= 0; i--) out += CROCKFORD_ALPHABET[Number((bits >> BigInt(i * 5)) & 31n)];
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

/**
 * Canonical form of a typed code: case-insensitive, hyphens/spaces ignored, I/L read as 1 and O as 0
 * (Crockford decoding). Null if it isn't 8 valid characters.
 */
export function normalizePairingCode(input: string): string | null {
  const s = input
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0");
  if (s.length !== 8) return null;
  for (const c of s) if (!CROCKFORD_ALPHABET.includes(c)) return null;
  return s;
}

export function hashPairingCode(normalized: string): string {
  return sha256Hex(`pairing:${normalized}`);
}

export type ConsumeResult = "ok" | "invalid" | "expired";

export class PairingCodes {
  constructor(
    private readonly db: DB,
    private readonly clock: () => number,
    private readonly ttlMs = PAIRING_CODE_TTL_MS,
  ) {}

  create(): { code: string; expiresIn: number } {
    const code = generatePairingCode();
    const now = this.clock();
    this.db
      .prepare("INSERT INTO pairing_codes (code_hash, expires_at) VALUES (?, ?)")
      .run(hashPairingCode(normalizePairingCode(code)!), now + this.ttlMs);
    return { code, expiresIn: Math.round(this.ttlMs / 1000) };
  }

  /** Marks the code used by `deviceId`. Single use: a second claim with the same code is "invalid". */
  consume(input: string, deviceId: string): ConsumeResult {
    const norm = normalizePairingCode(input);
    if (!norm) return "invalid";
    const h = hashPairingCode(norm);
    const now = this.clock();
    return this.db.transaction((): ConsumeResult => {
      const row = this.db.prepare("SELECT expires_at, used_at FROM pairing_codes WHERE code_hash = ?").get(h) as
        | { expires_at: number; used_at: number | null }
        | undefined;
      if (!row || row.used_at !== null) return "invalid";
      if (row.expires_at <= now) return "expired";
      this.db.prepare("UPDATE pairing_codes SET used_at = ?, device_id = ? WHERE code_hash = ?").run(now, deviceId, h);
      return "ok";
    })();
  }

  /** Deletes codes that expired more than a day ago (kept briefly so "expired" can be told apart from "invalid"). */
  purgeExpired(): number {
    return this.db.prepare("DELETE FROM pairing_codes WHERE expires_at <= ?").run(this.clock() - 24 * 3600_000).changes;
  }
}
