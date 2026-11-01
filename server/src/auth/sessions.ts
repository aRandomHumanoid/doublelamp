// Per-browser sessions (05 §6): a 256-bit random token in an HttpOnly cookie; only its sha256 is stored.
import type { SessionInfo } from "@doublelamp/protocol";
import type { DB } from "../db/db";
import { randomHex, randomToken, sha256Hex } from "../util/crypto";

export const SESSION_COOKIE = "dl_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** last_seen_at is written at most this often per session. */
const TOUCH_INTERVAL_MS = 60_000;

export interface SessionRecord {
  id: string;
  label: string;
  createdAt: number;
  lastSeenAt: number | null;
  expiresAt: number;
  userAgent: string | null;
}

interface Row {
  id: string;
  label: string;
  created_at: number;
  last_seen_at: number | null;
  expires_at: number;
  user_agent: string | null;
}

function fromRow(r: Row): SessionRecord {
  return {
    id: r.id,
    label: r.label,
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at,
    expiresAt: r.expires_at,
    userAgent: r.user_agent,
  };
}

export function toSessionInfo(s: SessionRecord, currentId: string | null): SessionInfo {
  return {
    id: s.id,
    label: s.label,
    created_at: s.createdAt,
    last_seen_at: s.lastSeenAt,
    user_agent: s.userAgent,
    current: s.id === currentId,
  };
}

/** "iPhone · Safari" from a User-Agent header (05 §6 default label). */
export function shortUserAgent(ua: string | undefined | null): string {
  if (!ua) return "Browser";
  const device = /iPad/.test(ua)
    ? "iPad"
    : /iPhone/.test(ua)
      ? "iPhone"
      : /Android/.test(ua)
        ? "Android"
        : /Macintosh|Mac OS X/.test(ua)
          ? "Mac"
          : /Windows/.test(ua)
            ? "Windows"
            : /CrOS/.test(ua)
              ? "Chromebook"
              : /Linux/.test(ua)
                ? "Linux"
                : null;
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /OPR\//.test(ua)
      ? "Opera"
      : /Firefox\/|FxiOS/.test(ua)
        ? "Firefox"
        : /Chrome\/|CriOS/.test(ua)
          ? "Chrome"
          : /Safari\//.test(ua)
            ? "Safari"
            : /^curl\//.test(ua)
              ? "curl"
              : null;
  if (device && browser) return `${device} · ${browser}`;
  return device ?? browser ?? ua.slice(0, 24);
}

export class SessionStore {
  constructor(
    private readonly db: DB,
    private readonly clock: () => number,
    private readonly ttlMs = SESSION_TTL_MS,
  ) {}

  create(label: string, userAgent: string | null): { token: string; session: SessionRecord } {
    const now = this.clock();
    const token = randomToken(32);
    const session: SessionRecord = {
      id: randomHex(12),
      label: label.slice(0, 64),
      createdAt: now,
      lastSeenAt: now,
      expiresAt: now + this.ttlMs,
      userAgent: userAgent ? userAgent.slice(0, 256) : null,
    };
    this.db
      .prepare(
        "INSERT INTO sessions (id, token_hash, label, created_at, last_seen_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(session.id, sha256Hex(token), session.label, session.createdAt, session.lastSeenAt, session.expiresAt, session.userAgent);
    return { token, session };
  }

  /** The live session for a raw token, or null. Updates last_seen_at (throttled). */
  validate(token: string): SessionRecord | null {
    if (!token || token.length > 128) return null;
    const row = this.db.prepare("SELECT * FROM sessions WHERE token_hash = ?").get(sha256Hex(token)) as Row | undefined;
    if (!row) return null;
    const now = this.clock();
    if (row.expires_at <= now) {
      this.db.prepare("DELETE FROM sessions WHERE id = ?").run(row.id);
      return null;
    }
    if (row.last_seen_at === null || now - row.last_seen_at > TOUCH_INTERVAL_MS) {
      this.db.prepare("UPDATE sessions SET last_seen_at = ? WHERE id = ?").run(now, row.id);
      row.last_seen_at = now;
    }
    return fromRow(row);
  }

  get(id: string): SessionRecord | null {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ? AND expires_at > ?").get(id, this.clock()) as Row | undefined;
    return row ? fromRow(row) : null;
  }

  isLive(id: string): boolean {
    return this.get(id) !== null;
  }

  list(): SessionRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM sessions WHERE expires_at > ? ORDER BY created_at DESC")
      .all(this.clock()) as Row[];
    return rows.map(fromRow);
  }

  revoke(id: string): boolean {
    return this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id).changes > 0;
  }

  /** Revokes every session except `keepId`; returns the revoked ids. */
  revokeAllExcept(keepId: string): string[] {
    const ids = (this.db.prepare("SELECT id FROM sessions WHERE id != ?").all(keepId) as { id: string }[]).map((r) => r.id);
    this.db.prepare("DELETE FROM sessions WHERE id != ?").run(keepId);
    return ids;
  }

  purgeExpired(): number {
    return this.db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(this.clock()).changes;
  }
}
