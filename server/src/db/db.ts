// SQLite via better-sqlite3 in WAL mode, with a small numbered-migrations runner (instead of Drizzle).
import Database from "better-sqlite3";
import { MIGRATIONS, type Migration } from "./migrations";

export type DB = Database.Database;

export function openDatabase(file: string, migrations: readonly Migration[] = MIGRATIONS): DB {
  const db = new Database(file);
  if (file !== ":memory:") db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.pragma("synchronous = NORMAL");
  migrate(db, migrations);
  return db;
}

/** Applies every migration newer than PRAGMA user_version, each in its own transaction. Returns the new version. */
export function migrate(db: DB, migrations: readonly Migration[] = MIGRATIONS): number {
  let current = db.pragma("user_version", { simple: true }) as number;
  for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
    if (m.version <= current) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.pragma(`user_version = ${m.version}`);
    })();
    current = m.version;
  }
  return current;
}

export function jsonOrNull<T>(text: string | null | undefined): T | null {
  if (text === null || text === undefined || text === "") return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}
