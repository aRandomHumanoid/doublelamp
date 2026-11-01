// Numbered migrations, tracked with PRAGMA user_version. Schema per 05 §11, with the additions noted inline.

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "initial schema",
    sql: /* sql */ `
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        token_hash TEXT UNIQUE NOT NULL,
        label TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER,
        expires_at INTEGER NOT NULL,
        user_agent TEXT
      );

      -- Added to 05 §11: telemetry_json (last telemetry), effects_json (hello.effects),
      -- pending_verify, name_pending (a rename made while the lamp was offline).
      CREATE TABLE devices (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        token_hash TEXT UNIQUE,
        fw TEXT,
        hw_json TEXT,
        config_json TEXT,
        info_json TEXT,
        telemetry_json TEXT,
        effects_json TEXT,
        pending_verify INTEGER NOT NULL DEFAULT 0,
        name_pending INTEGER NOT NULL DEFAULT 0,
        claimed_at INTEGER,
        last_seen_at INTEGER
      );

      -- Added: is_default marks the single default group created on first claim.
      CREATE TABLE groups (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        linked INTEGER NOT NULL DEFAULT 0,
        is_default INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE group_members (
        group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
        position INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (group_id, device_id)
      );

      CREATE TABLE replicas (
        owner_type TEXT NOT NULL CHECK (owner_type IN ('device','group')),
        owner_id TEXT NOT NULL,
        state_json TEXT NOT NULL,
        field_ts_json TEXT NOT NULL,
        rev INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (owner_type, owner_id)
      );

      CREATE TABLE scenes (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        state_json TEXT NOT NULL,
        sort INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER
      );

      CREATE TABLE schedules (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL DEFAULT '',
        target_type TEXT NOT NULL,
        target_id TEXT NOT NULL,
        when_json TEXT NOT NULL,
        action_json TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        next_run_at INTEGER,
        last_run_at INTEGER,
        last_result TEXT
      );

      CREATE TABLE pairing_codes (
        code_hash TEXT PRIMARY KEY,
        expires_at INTEGER NOT NULL,
        used_at INTEGER,
        device_id TEXT
      );

      -- Added: project and build_date from esp_app_desc.
      CREATE TABLE firmware (
        sha256 TEXT PRIMARY KEY,
        version TEXT NOT NULL,
        project TEXT,
        idf TEXT,
        build_date TEXT,
        size INTEGER NOT NULL,
        notes TEXT,
        uploaded_at INTEGER NOT NULL
      );

      -- Changed: version/allow_downgrade are copied into the job (so history survives a firmware delete,
      -- hence no FK on sha256), rollout_id/rollout_seq order "update both" rollouts, and jobs go with
      -- their device (ON DELETE CASCADE).
      CREATE TABLE ota_jobs (
        id INTEGER PRIMARY KEY,
        device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
        sha256 TEXT NOT NULL,
        version TEXT NOT NULL,
        allow_downgrade INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        pct INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        rollout_id INTEGER,
        rollout_seq INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX ota_jobs_device ON ota_jobs(device_id, status);

      CREATE TABLE events (
        id INTEGER PRIMARY KEY,
        ts INTEGER NOT NULL,
        kind TEXT NOT NULL,
        device_id TEXT,
        by_label TEXT,
        data_json TEXT
      );
      CREATE INDEX events_ts ON events(ts);
      CREATE INDEX events_device_ts ON events(device_id, ts);
    `,
  },
];
