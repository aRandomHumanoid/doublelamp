// The one shared password (05 §6), stored as an argon2id hash in `settings`.
import { hash, verify } from "@node-rs/argon2";
import type { DB } from "../db/db";
import { generatePassword } from "../util/crypto";

export const MIN_PASSWORD_LENGTH = 12;

export async function hashPassword(password: string): Promise<string> {
  // @node-rs/argon2 defaults to argon2id (m=19456, t=2, p=1).
  return hash(password);
}

export async function verifyPassword(stored: string, password: string): Promise<boolean> {
  try {
    return await verify(stored, password);
  } catch {
    return false;
  }
}

export class PasswordStore {
  constructor(
    private readonly db: DB,
    private readonly clock: () => number,
  ) {}

  hasPassword(): boolean {
    return this.getHash() !== null;
  }

  private getHash(): string | null {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = 'password_hash'").get() as { value: string } | undefined;
    return row?.value ?? null;
  }

  async set(password: string): Promise<void> {
    const h = await hashPassword(password);
    const upsert = this.db.prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    );
    this.db.transaction(() => {
      upsert.run("password_hash", h);
      upsert.run("password_changed_at", String(this.clock()));
    })();
  }

  async check(password: string): Promise<boolean> {
    const h = this.getHash();
    if (!h) return false;
    return verifyPassword(h, password);
  }
}

export type InitialPassword = { source: "stored" } | { source: "env" } | { source: "generated"; password: string };

/**
 * First start: take APP_PASSWORD (at least 12 characters, 07 T5), or generate a 16-character password when it's
 * unset. Once a password is stored, APP_PASSWORD is ignored.
 */
export async function ensurePassword(store: PasswordStore, appPassword: string | undefined): Promise<InitialPassword> {
  if (store.hasPassword()) return { source: "stored" };
  if (appPassword !== undefined) {
    if (appPassword.length < MIN_PASSWORD_LENGTH) {
      throw new Error(`APP_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters (07 T5)`);
    }
    await store.set(appPassword);
    return { source: "env" };
  }
  const password = generatePassword(16);
  await store.set(password);
  return { source: "generated", password };
}
