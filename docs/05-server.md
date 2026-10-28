# 05: Server

## 1. Responsibilities

- Log users in and serve the web app.
- Pair lamps with the server and issue device tokens.
- Keep one live WSS connection per lamp and per browser tab.
- **Sync engine:** decide the order of changes, merge them, spread them across link groups, and set `apply_at`.
- Store scenes and run schedules.
- Host signed firmware and run OTA jobs.
- Record activity and telemetry.

The server never renders frames, and it never needs to reach a lamp first; all lamp connections are outbound from the lamp.

## 2. Stack

| Concern | Choice |
|---|---|
| Runtime | Node.js (current LTS), TypeScript strict mode, ESM |
| HTTP | Fastify, with `@fastify/static` for the web app and `@fastify/cookie` |
| WebSocket | `ws`, running on Fastify's HTTP server (via `@fastify/websocket`) |
| Validation | zod schemas from `packages/protocol`, applied at every boundary |
| Database | SQLite through better-sqlite3 (WAL mode), with Drizzle ORM and its migrations |
| Passwords | argon2id (`@node-rs/argon2`) |
| Scheduling | `croner` for cron expressions with IANA time zones |
| Logs | pino (JSON) |
| Tests | Vitest |

## 3. Module layout

```
server/src/
├─ main.ts               wiring, config, graceful shutdown
├─ http/                 REST routes (04 §7.1), auth middleware, static web app
├─ hubs/
│  ├─ device-hub.ts      /ws/device: auth, hello/welcome, heartbeats, outbound queues
│  └─ client-hub.ts      /ws/client: sessions, snapshot, fan-out
├─ engine/               sync engine; pure TypeScript with no I/O (§4)
│  ├─ state.ts           apply patch, per-field timestamps, merge
│  ├─ groups.ts          link/unlink, group fan-out, match_from
│  └─ timing.ts          apply_at calculation, delay tracking
├─ timesync.ts           time.ping/pong for lamps and browsers
├─ scheduler.ts          schedules → engine commands
├─ ota/                  firmware store, signed download URLs, jobs
├─ pairing.ts            codes, claim endpoint
├─ db/                   Drizzle schema, migrations, repositories
└─ events.ts             in-process event bus and activity log writer
```

**Runtime model.** A single process. The engine's in-memory state is the source of truth.
- Every accepted change is written to SQLite. Writes for one device or group are batched to at most one per second, so slider drags don't flood the disk.
- On startup, the engine loads its state from SQLite.
- The hubs communicate only through the engine and the event bus. This keeps the engine easy to unit-test.

## 4. Sync engine

**Data held for each device and each group:**

```ts
type FieldName = "on" | "brightness" | "colors" | "effect";
interface Replica {
  state: LampState;
  fieldTs: Record<FieldName, number>;  // server ms when each field last changed
  rev: number;
}
```

A device has its own `Replica`. When its group is linked, the **group's `Replica` is the one in use**, and every member is driven from it.

### Handling a command

```ts
function handleCommand(target, patch, transitionMs, origin, by): void {
  const r = resolveReplica(target);            // the group replica if the target is in a linked group
  const now = clock.now();
  const changed = applyPatch(r, patch, now);   // per-field: update value, set fieldTs[f] = now
  if (changed.has("effect") && patch.effect?.epoch === undefined) {
    r.state.effect.epoch = now;                // replaced by applyAt below for synced starts
  }
  const members = membersOf(r);                // online lamps that follow this replica
  const applyAt = members.length > 1 ? timing.applyAt(members, now) : undefined;
  if (applyAt && changed.has("effect")) r.state.effect.epoch = applyAt;
  for (const m of members) deviceHub.sendState(m, r.state, { applyAt, transitionMs, origin });
  clientHub.broadcastState(r, { origin, by, applyAt });
  events.record({ kind: "state", target, patch, origin, by });
  persist.schedule(r);
}
```

- **Commands from browsers** carry `origin = "web"`, `"scene"` or `"schedule"`, and `by` is the user id.
- **`state.report` from a lamp** is handled the same way, with `origin = "local"` or `"button"`. The server sends `state.set` back to every member, **including the lamp that reported**. That echo is what makes concurrent edits end up identical everywhere ([04 §6](04-protocol.md#6-merge-rules)).
- **Patches are idempotent.** Applying a patch that changes nothing updates no timestamps and sends nothing.

### Calculating `apply_at`

```ts
applyAt(members, now) = now + clamp(max(m.oneWayDelayP90 for m in members) + 40, 80, 500)
```

- **Delay tracking.** `oneWayDelayP90` is the 90th percentile of half the round-trip time over each lamp's last 20 `time.ping` exchanges.
- **If a lamp's link is slow,** the 500 ms cap holds. That lamp applies the change late, but its effect phase is still right, because the epoch is the same on both lamps.
- **Single lamps** (unlinked) get no `apply_at`, so they react as quickly as possible.

### Link and unlink

- **Linking** (`PATCH /groups/{id} {linked:true}`) starts the group replica from the most recently changed member. That is the member with the highest `max(fieldTs)`, unless `match_from` names a different one. The server then pushes the replica to every member at a shared `apply_at`, so both lamps visibly blend into the same look together.
- **Unlinking** copies the group state into each device's own replica. Nothing changes visibly; from then on the lamps simply take commands separately.
- **When a member goes offline,** it misses changes. When it reconnects, the merge rules in [04 §6](04-protocol.md#6-merge-rules) apply against the group replica.

### Reconnect merge (`hello`)

```ts
for (const f of FIELDS) {
  const d = hello.dirty?.[f];
  const lampTs = d?.age_ms != null ? now - d.age_ms : -Infinity;
  if (lampTs > r.fieldTs[f]) { r.state[f] = hello.state[f]; r.fieldTs[f] = lampTs; wonByLamp.add(f); }
}
// send welcome.desired = r.state to the lamp; if any field was won by the lamp and r is a group,
// fan out to the other members (with apply_at) and broadcast to browsers.
```

The cases in `packages/protocol/test-vectors/merge/` are the specification for this code.

## 5. Device hub

1. **Authenticate.** On upgrade, check `Authorization: Bearer`: compute `sha256(token)` and look it up in `devices.token_hash` with a constant-time comparison. Reject with `401` if it doesn't match.
2. **One connection per device.** A new connection closes the old one with code `4002`.
3. **Expect `hello` within 10 s,** otherwise close with `4008`. Check `proto`, then run the merge (§4) and send `welcome`. Then push presets (`presets.sync`), and any OTA job waiting for this device.
4. **Liveness.** Reply to WS pings. Close the connection after 45 s with no traffic. Mark the device offline and broadcast `device.presence`.
5. **Outbound queue for each device:**
   - `state.set` messages **coalesce**; only the newest full state is kept.
   - If `ws.bufferedAmount` goes over 64 KB, drop non-essential messages: `presets.sync` duplicates and `identify`.
6. **Store what the lamp reports.** `info` and `telemetry` go into memory, and the last values are saved to `devices`. Telemetry history is kept as a 24-hour ring in memory. Long-term graphs are out of scope for v1.

## 6. Client hub

- **Authentication.** The session cookie is checked on upgrade, and so is the `Origin` header, which must equal `PUBLIC_URL`.
- **On connect,** the browser gets a `snapshot`, then a stream of changes as they happen ([04 §7.2](04-protocol.md#72-websocket-wsclient-session-cookie-origin-header-checked)).
- **Commands.**
  - Each browser connection may send up to **30 `cmd` messages per second**. Anything beyond that is dropped with `rate_limited`.
  - The web app already throttles to about 20 per second.
  - Every command gets an `ack` or `error`, matched by its `cid`.
- **Offline lamps.** Commands to an offline device fail with `offline`. They are **not** queued, because acting on a stale command later would surprise people. For a linked group with one member offline, the group replica still updates, and the offline lamp catches up on reconnect.

## 7. Pairing

- **Creating a code.** `POST /pairing-codes` gives an 8-character Crockford base32 code (40 bits), shown as `XXXX-XXXX`. It expires after 10 minutes and works once. The server stores only `sha256(code)`.
- **Claiming.** `POST /devices/claim` is rate-limited to 5 attempts per minute per IP and 20 per hour overall. On success:
  1. Create or update the `devices` row. If the lamp was paired before, its old token stops working.
  2. Generate `device_token`: 32 random bytes, base64url. Store only its `sha256`.
  3. Add the device to the default group, creating that group on first use.
- **Unclaiming.** `DELETE /devices/{id}` sends `unclaim`, closes the socket with code `4003`, and deletes the token hash.

## 8. Scheduler

**Schedule fields:** `{target, when, action, enabled}`

- **`target`:** a device or a group.
- **`when`:** one of
  - `{type: "daily", time: "07:00", days: ["mon",…], tz: "America/New_York"}`
  - `{type: "cron", expr, tz}`
- **`action`:** one of
  - `{type: "power", on}`
  - `{type: "scene", scene_id, transition_ms}`
  - `{type: "sunrise", duration_min}`, which sets `effect: sunrise` with `duration_ms` and ends on `solid`
  - `{type: "fade_off", duration_min}`

**Execution.** croner computes the next run in the schedule's time zone, so daylight-saving changes are handled. Each run calls `handleCommand` with `origin = "schedule"`.

**Missed runs.** If the server was down at the scheduled time, a run less than 5 minutes late fires at startup. Anything later is skipped and logged.

**Limitation.** Schedules live on the server, so they don't run while the server is unreachable. On-device schedules would fix this and are on the roadmap.

## 9. Firmware and OTA

- **Upload** (admin only): `POST /firmware` with a signed `.bin`.
  - The server reads `esp_app_desc` from the image (project name, version, IDF version) and computes its sha256.
  - The file goes in `DATA_DIR/firmware/<sha256>.bin`.
  - The server **never holds the signing key**. Signatures are checked by the lamps ([07](07-security.md)).
- **Jobs.** `POST /devices/{id}/ota {version}` creates an `ota_jobs` row and sends `ota.start`.
  - The download URL is `/fw/<sha256>.bin?t=<token>`. The token is an HMAC over `(device_id, sha256, expiry)` using `SERVER_SECRET`, and lasts 15 minutes.
  - `ota.progress` messages update the job and are broadcast to browsers.
  - The job finishes when the device's next `hello` shows the new version with `pending_verify` cleared. It fails on `failed`, on `rollback: true`, or after 15 minutes with no progress.
- **Rolling out to both lamps.** The web app's "Update both" button updates one lamp, waits until it's verified, then updates the other. A bad build can't take both lamps down at once.

## 10. Database schema (SQLite)

```sql
CREATE TABLE users        (id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
                           role TEXT NOT NULL CHECK (role IN ('admin','member')), created_at INTEGER NOT NULL);
CREATE TABLE sessions     (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users ON DELETE CASCADE,
                           token_hash TEXT UNIQUE NOT NULL, created_at INTEGER, expires_at INTEGER, user_agent TEXT);
CREATE TABLE devices      (id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT UNIQUE,
                           fw TEXT, hw_json TEXT, config_json TEXT, info_json TEXT,
                           claimed_at INTEGER, claimed_by INTEGER REFERENCES users, last_seen_at INTEGER);
CREATE TABLE groups       (id INTEGER PRIMARY KEY, name TEXT NOT NULL, linked INTEGER NOT NULL DEFAULT 0);
CREATE TABLE group_members(group_id INTEGER REFERENCES groups ON DELETE CASCADE,
                           device_id TEXT REFERENCES devices ON DELETE CASCADE,
                           position INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (group_id, device_id));
CREATE TABLE replicas     (owner_type TEXT CHECK (owner_type IN ('device','group')), owner_id TEXT,
                           state_json TEXT NOT NULL, field_ts_json TEXT NOT NULL, rev INTEGER NOT NULL,
                           updated_at INTEGER NOT NULL, PRIMARY KEY (owner_type, owner_id));
CREATE TABLE scenes       (id INTEGER PRIMARY KEY, name TEXT NOT NULL, state_json TEXT NOT NULL,
                           sort INTEGER DEFAULT 0, created_by INTEGER REFERENCES users, created_at INTEGER);
CREATE TABLE schedules    (id INTEGER PRIMARY KEY, name TEXT, target_type TEXT, target_id TEXT,
                           when_json TEXT NOT NULL, action_json TEXT NOT NULL, enabled INTEGER DEFAULT 1,
                           next_run_at INTEGER, last_run_at INTEGER, last_result TEXT);
CREATE TABLE pairing_codes(code_hash TEXT PRIMARY KEY, created_by INTEGER REFERENCES users,
                           expires_at INTEGER NOT NULL, used_at INTEGER, device_id TEXT);
CREATE TABLE firmware     (sha256 TEXT PRIMARY KEY, version TEXT NOT NULL, idf TEXT, size INTEGER,
                           notes TEXT, uploaded_by INTEGER REFERENCES users, uploaded_at INTEGER);
CREATE TABLE ota_jobs     (id INTEGER PRIMARY KEY, device_id TEXT REFERENCES devices, sha256 TEXT REFERENCES firmware,
                           status TEXT, pct INTEGER, error TEXT, created_at INTEGER, updated_at INTEGER);
CREATE TABLE events       (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, kind TEXT NOT NULL,
                           device_id TEXT, user_id INTEGER, data_json TEXT);
CREATE INDEX events_ts ON events(ts);
```

- **Scenes become presets.** The first 8 scenes by `sort` are pushed to each lamp as presets 0–7.
- **Retention.** A daily job deletes `events` older than 30 days, plus expired sessions and pairing codes.

## 11. Configuration (environment)

| Variable | Example | Purpose |
|---|---|---|
| `PUBLIC_URL` | `https://lamps.example.com` | Origin checks, cookie domain, the `ws_url` returned at pairing |
| `DATA_DIR` | `/data` | SQLite file + firmware files |
| `SERVER_SECRET` | 32+ random bytes | HMAC for download URLs, cookie signing |
| `BOOTSTRAP_ADMIN` | `admin:<password>` | Creates the first admin if there are no users. Ignored after that. |
| `PORT` | `8080` | Listen port (behind Caddy) |
| `LOG_LEVEL` | `info` | |
| `TRUST_PROXY` | `true` | Use `X-Forwarded-For` for rate limits when behind Caddy or a tunnel |

## 12. Deployment

`docker-compose.yml`:

```yaml
services:
  server:
    image: ghcr.io/<you>/doublelamp-server:1
    env_file: .env
    volumes: ["./data:/data"]
    restart: unless-stopped
  caddy:
    image: caddy:2
    ports: ["80:80", "443:443"]
    volumes: ["./Caddyfile:/etc/caddy/Caddyfile", "caddy_data:/data"]
    restart: unless-stopped
volumes: { caddy_data: {} }
```

`Caddyfile`:

```
lamps.example.com {
  encode gzip
  reverse_proxy server:8080
}
```

- **Hosting options:** any 1 vCPU / 512 MB VPS, or a Raspberry Pi at home using Cloudflare Tunnel or Tailscale Funnel instead of opening ports.
  - The 20 s WebSocket pings keep connections alive through proxy idle timeouts.
- **Backups:** a nightly `sqlite3 /data/doublelamp.db ".backup /data/backup/doublelamp-$(date +%F).db"`, keeping the last 14. Also back up the firmware directory.
- **Upgrades:** pull a new image and restart. Migrations run at startup. While the server restarts, lamps reconnect and nothing visibly changes.

## 13. Observability

- **`GET /healthz`** returns 200 once the database opens and the engine has loaded.
- **`GET /metrics`** (admin, or a localhost-only listener) reports in Prometheus text format:
  - devices online
  - WS connections by type
  - commands per second
  - p50/p90 one-way delay per lamp
  - OTA jobs by status
- **Activity log** (`events`): who changed what and from where, plus device connects and disconnects, crashes, OTA results and failed logins. The web app shows it ([06](06-web-apps.md)).

## 14. Capacity

The design load is 2 lamps and a few browsers, which is trivial. As a safety margin, the target is 100 lamps and 50 browsers on 1 vCPU with p95 command fan-out under 20 ms of server time. Handling many households would need per-user device permissions and a shared pub/sub layer; that is out of scope ([README](README.md)).
