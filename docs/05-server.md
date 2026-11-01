# 05: Server

## 1. Responsibilities

- Check the shared password (§6) and serve the web app.
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
| Database | SQLite through better-sqlite3 (WAL mode), with plain SQL and a small numbered-migrations runner |
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
├─ db/                   schema, numbered SQL migrations, repositories
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
  if (effectIdChanged && patch.effect?.epoch === undefined) {
    r.state.effect.epoch = now;                // replaced by applyAt below for synced starts
  }
  const members = membersOf(r);                // online lamps that follow this replica
  const applyAt = members.length > 1 ? timing.applyAt(members, now) : undefined;
  if (applyAt && effectIdChanged) r.state.effect.epoch = applyAt;
  for (const m of members) deviceHub.sendState(m, r.state, { applyAt, transitionMs, origin });
  clientHub.broadcastState(r, { origin, by, applyAt });
  events.record({ kind: "state", target, patch, origin, by });
  persist.schedule(r);
}
```

- **Commands from browsers** carry `origin = "web"`, `"scene"` or `"schedule"`, and `by` is the session's label (§6).
- **`state.report` from a lamp** is handled the same way, with `origin = "local"`, `"homekit"` or `"button"`. The server sends `state.set` back to every member, **including the lamp that reported**. That echo is what makes concurrent edits end up identical everywhere ([04 §6](04-protocol.md#6-merge-rules)).
- **Patches are idempotent.** Applying a patch that changes nothing updates no timestamps and sends nothing.

### Calculating `apply_at`

```ts
applyAt(members, now) = now + clamp(max(m.oneWayDelayP90 for m in members) + 40, 80, 500)
```

- **Epoch rule.** Only a new effect id (or an explicit restart, such as a scheduled sunrise) restarts the effect at `apply_at`. Speed, intensity and color changes keep the epoch: both lamps still share it, and dragging a slider doesn't restart the animation on every step. A lamp's own `state.report` carries its epoch, which the server keeps, so the echo never makes the reporting lamp jump.
- **Delay tracking.** `oneWayDelayP90` is the 90th percentile over each lamp's last 20 `time.ping` samples of `t1 − t0`. The lamp stamps `t0` with its sync clock, so once it has synced, `t1 − t0` is the one-way delay. The first ping of a connection and implausible values are ignored; a lamp with no samples counts as 100 ms.
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
4. **Liveness.** Any message counts as traffic; the lamp's `time.ping` arrives at least every 20 s ([04 §4.1](04-protocol.md#41-connection)). Reply to WS pings too. Close the connection after 45 s with no traffic. Mark the device offline and broadcast `device.presence`.
5. **Outbound queue for each device:**
   - `state.set` messages **coalesce**; only the newest full state is kept.
   - If `ws.bufferedAmount` goes over 64 KB, drop non-essential messages: `presets.sync` duplicates and `identify`.
6. **Store what the lamp reports.** `info` and `telemetry` go into memory, and the last values are saved to `devices`. Telemetry history is kept as a 24-hour ring in memory. Long-term graphs are out of scope for v1.

## 6. Login (one shared password)

Everyone who uses the lamps shares **one password**. There are no user accounts and no roles.

- **The password.** It's stored as an argon2id hash in the `settings` table. On first start it comes from `APP_PASSWORD` (§12), which is ignored after that. Change it in Settings with `PUT /auth/password`, which needs the current password.
- **Logging in.** `POST /auth/login {password, label?}`.
  - `label` names the browser, for example "Kitchen iPad". It defaults to a short form of the user agent, such as "iPhone · Safari".
  - The label is the only "who" the server knows. It appears in the activity log and in the list of signed-in browsers.
- **Sessions.** Each one is a 256-bit random token in an `HttpOnly` cookie, and only its hash is stored. Sessions expire after 30 days.
  - Settings lists them (`GET /sessions`). Any one can be revoked (`DELETE /sessions/{id}`).
  - Changing the password revokes every session except the current one.
- **Permissions.** A logged-in session can do everything, including OTA, unpairing lamps and changing the password. This matches assumption A6 (a handful of trusted people).
- **Brute force.** Limited to 5 failed logins per 15 minutes per IP, and 30 per hour overall. Failed logins are logged ([07](07-security.md)).

## 7. Client hub

- **Authentication.** The session cookie is checked on upgrade, and so is the `Origin` header, which must equal `PUBLIC_URL`.
- **On connect,** the browser gets a `snapshot`, then a stream of changes as they happen ([04 §7.2](04-protocol.md#72-websocket-wsclient-session-cookie-origin-header-checked)).
- **Commands.**
  - Each browser connection may send up to **30 `cmd` messages per second**. Anything beyond that is dropped with `rate_limited`.
  - The web app already throttles to about 20 per second.
  - Every command gets an `ack` or `error`, matched by its `cid`.
- **Offline lamps.** Commands to an offline device fail with `offline`. They are **not** queued, because acting on a stale command later would surprise people. For a linked group with one member offline, the group replica still updates, and the offline lamp catches up on reconnect.

## 8. Pairing

- **Creating a code.** `POST /pairing-codes` gives an 8-character Crockford base32 code (40 bits), shown as `XXXX-XXXX`. It expires after 10 minutes and works once. The server stores only `sha256(code)`.
- **Claiming.** `POST /devices/claim` is rate-limited to 5 attempts per minute per IP and 20 per hour overall. On success:
  1. Create or update the `devices` row. If the lamp was paired before, its old token stops working.
  2. Generate `device_token`: 32 random bytes, base64url. Store only its `sha256`.
  3. Add the device to the default group, creating that group on first use.
- **Unclaiming.** `DELETE /devices/{id}` sends `unclaim`, closes the socket with code `4003`, and deletes the token hash.

## 9. Scheduler

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

## 10. Firmware and OTA

- **Upload** (any logged-in session): `POST /firmware` with a signed `.bin`.
  - The server reads `esp_app_desc` from the image (project name, version, IDF version) and computes its sha256.
  - The file goes in `DATA_DIR/firmware/<sha256>.bin`.
  - The server **never holds the signing key**. Signatures are checked by the lamps ([07](07-security.md)).
- **Jobs.** `POST /devices/{id}/ota {version}` creates an `ota_jobs` row and sends `ota.start`.
  - The download URL is `/fw/<sha256>.bin?t=<token>`. The token is an HMAC over `(device_id, sha256, expiry)` using `SERVER_SECRET`, and lasts 15 minutes.
  - Responses carry `Cache-Control: no-store`. Cloudflare caches `.bin` files by default, and a cached copy would ignore the token's expiry.
  - `ota.progress` messages update the job and are broadcast to browsers.
  - The job finishes when the device's next `hello` shows the new version with `pending_verify` cleared. It fails on `failed`, on `rollback: true`, or after 15 minutes with no progress.
- **Rolling out to both lamps.** The web app's "Update both" button updates one lamp, waits until it's verified, then updates the other. A bad build can't take both lamps down at once.

## 11. Database schema (SQLite)

```sql
CREATE TABLE settings     (key TEXT PRIMARY KEY, value TEXT NOT NULL);   -- 'password_hash', 'password_changed_at'
CREATE TABLE sessions     (id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, label TEXT NOT NULL,
                           created_at INTEGER, last_seen_at INTEGER, expires_at INTEGER, user_agent TEXT);
CREATE TABLE devices      (id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT UNIQUE,
                           fw TEXT, hw_json TEXT, config_json TEXT, info_json TEXT,
                           claimed_at INTEGER, last_seen_at INTEGER);
CREATE TABLE groups       (id INTEGER PRIMARY KEY, name TEXT NOT NULL, linked INTEGER NOT NULL DEFAULT 0);
CREATE TABLE group_members(group_id INTEGER REFERENCES groups ON DELETE CASCADE,
                           device_id TEXT REFERENCES devices ON DELETE CASCADE,
                           position INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (group_id, device_id));
CREATE TABLE replicas     (owner_type TEXT CHECK (owner_type IN ('device','group')), owner_id TEXT,
                           state_json TEXT NOT NULL, field_ts_json TEXT NOT NULL, rev INTEGER NOT NULL,
                           updated_at INTEGER NOT NULL, PRIMARY KEY (owner_type, owner_id));
CREATE TABLE scenes       (id INTEGER PRIMARY KEY, name TEXT NOT NULL, state_json TEXT NOT NULL,
                           sort INTEGER DEFAULT 0, created_at INTEGER);
CREATE TABLE schedules    (id INTEGER PRIMARY KEY, name TEXT, target_type TEXT, target_id TEXT,
                           when_json TEXT NOT NULL, action_json TEXT NOT NULL, enabled INTEGER DEFAULT 1,
                           next_run_at INTEGER, last_run_at INTEGER, last_result TEXT);
CREATE TABLE pairing_codes(code_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, used_at INTEGER, device_id TEXT);
CREATE TABLE firmware     (sha256 TEXT PRIMARY KEY, version TEXT NOT NULL, idf TEXT, size INTEGER,
                           notes TEXT, uploaded_at INTEGER);
CREATE TABLE ota_jobs     (id INTEGER PRIMARY KEY, device_id TEXT REFERENCES devices, sha256 TEXT REFERENCES firmware,
                           status TEXT, pct INTEGER, error TEXT, created_at INTEGER, updated_at INTEGER);
CREATE TABLE events       (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, kind TEXT NOT NULL,
                           device_id TEXT, by_label TEXT, data_json TEXT);
CREATE INDEX events_ts ON events(ts);
```

- **No users table.** There is one shared password (§6). `events.by_label` copies the session label at the time of the event, so the log still reads correctly after a session is revoked.
- **Scenes become presets.** The first 8 scenes by `sort` are pushed to each lamp as presets 0–7.
- **Retention.** A daily job deletes `events` older than 30 days, plus expired sessions and pairing codes.

## 12. Configuration (environment)

| Variable | Example | Purpose |
|---|---|---|
| `PUBLIC_URL` | `https://lamps.<your-domain>` | Origin checks, cookie domain, the `ws_url` returned at pairing |
| `DATA_DIR` | `/data` | SQLite file + firmware files |
| `SERVER_SECRET` | 32+ random bytes | HMAC for download URLs, cookie signing |
| `APP_PASSWORD` | 12+ characters | Sets the shared password on first start, when none is stored. Ignored after that (§6). |
| `PORT` | `8080` | Listen port. Reachable only from `cloudflared`, never published to the LAN or the router. |
| `LOG_LEVEL` | `info` | |
| `TRUST_PROXY` | `cloudflare` | Take the client IP for rate limits from `CF-Connecting-IP`. This is only safe because nothing but `cloudflared` can reach the port. `false` in local dev mode. |
| `DEV_INSECURE` | `1` | Development only. Allows an `http://` `PUBLIC_URL` and drops the `Secure` cookie flag (§13). The server refuses to start with an `http://` URL without it, and logs a warning on every start with it. |

## 13. Deployment

The two lamps are on different home networks and the server is on a third. So in production the server **must be reachable from the internet over HTTPS** (option T3 in [01 §4](01-architecture.md#4-deployment-options)). It runs on a local machine behind Cloudflare Tunnel. For testing, everything can sit on one WiFi (see "Development on one WiFi" below).

### Production: a local machine behind Cloudflare Tunnel

The server runs on an **always-on machine on its own network**, such as a Raspberry Pi, mini PC or NAS, and is published through **Cloudflare Tunnel**.
- `cloudflared` makes an outbound connection to Cloudflare. There's no port forwarding on the router, and the home IP stays hidden.
- Cloudflare's edge terminates TLS with its own certificate, so there's no Caddy and no Let's Encrypt setup.
- If the machine ever moves into one of the lamp homes, nothing changes: that lamp still reaches it through Cloudflare.

**Needs:**
- **A domain whose DNS is on Cloudflare**, for example `lamps.<your-domain>`. A Quick Tunnel (random `trycloudflare.com` name) won't do, because its URL changes on every restart and the lamps store the URL.
- **A machine that doesn't sleep.** Wired Ethernet is preferred. While it's down the lamps keep working locally, but linking, schedules and remote control stop.

`docker-compose.yml`:

```yaml
services:
  server:
    image: ghcr.io/<you>/doublelamp-server:1
    env_file: .env            # PUBLIC_URL=https://lamps.<your-domain>, TRUST_PROXY=cloudflare, …
    volumes: ["./data:/data"]
    restart: unless-stopped
    # no "ports:"; only cloudflared can reach it, over the compose network
  cloudflared:
    image: cloudflare/cloudflared:<pinned version>
    command: tunnel --no-autoupdate run
    environment: ["TUNNEL_TOKEN=${TUNNEL_TOKEN}"]
    restart: unless-stopped
```

In the Cloudflare dashboard, give the tunnel a public hostname `lamps.<your-domain>` → `http://server:8080`.

**Cloudflare settings for this hostname.** The lamps aren't browsers and can't solve challenges, so some protections must stay off or be skipped for lamp traffic:

| Setting | Value | Why |
|---|---|---|
| WebSockets | On (the default) | Lamps and browsers use them |
| **Bot Fight Mode** | **Off** | It would challenge the lamps, and on the free plan it can't be skipped for chosen paths |
| Under Attack Mode | Never on | It challenges every request, so lamps would be locked out |
| WAF custom rule | **Skip** Browser Integrity Check and Security Level when the path starts with `/ws/device`, `/api/v1/devices/claim` or `/fw/` | These are the lamps' paths. Auth on those routes still applies. |
| Cache rule | **Bypass cache** for `/api/*`, `/ws/*` and `/fw/*` | Belt and braces next to the server's `no-store` (§10) |
| Always Use HTTPS, HSTS | On | Redirects plain HTTP at the edge. The server also sends `Strict-Transport-Security`. |
| Minimum TLS version | 1.2 | The lamps support TLS 1.2 and 1.3 |
| Rocket Loader | Off | It injects scripts that the web app's CSP blocks ([07](07-security.md)) |

- **Keepalive.** Cloudflare closes WebSockets that carry no data for 100 s. Lamps send `time.ping` every 20 s and browsers every 30 s, so connections stay open. Cloudflare also restarts edge servers from time to time; lamps and browsers reconnect with backoff, and the light doesn't change.
- **Alternatives**, if Cloudflare doesn't work out: a VPS with Caddy and Let's Encrypt, or Tailscale Funnel (no domain needed). Only the `cloudflared` service would change.
- **Backups:** a nightly `sqlite3 /data/doublelamp.db ".backup /data/backup/doublelamp-$(date +%F).db"`, keeping the last 14. Also back up the firmware directory.
- **Upgrades:** pull a new image and restart. Migrations run at startup. While the server restarts, lamps reconnect and nothing visibly changes.

### Development on one WiFi

For testing, both lamps, the server, the dev machine and the phones can all be on one WiFi network. There are two ways to run it:

| Mode | Server | Lamps | What it tests |
|---|---|---|---|
| **Local dev** | `npm run dev` on the laptop with `PUBLIC_URL=http://<laptop-ip>:8080` and `DEV_INSECURE=1` | Development firmware (`LAMP_ALLOW_INSECURE_SERVER=y`, [03 §10](03-firmware.md#10-cloud-link)) with server URL `ws://<laptop-ip>:8080` | Everything except TLS. Fastest edit-and-run loop. |
| **Staging** | The production compose file, with a second tunnel hostname such as `lamps-staging.<your-domain>` so test lamps stay apart from the real ones | Release firmware with the staging `https://` URL | The real Cloudflare and TLS path. The lamps reach the server through Cloudflare even though they share its WiFi, and no router changes are needed. |

- Pairing, linking, `apply_at`, OTA and Apple Home all work the same on one network.
- One shared network hides the delay and asymmetry of two homes. Use the virtual lamp's `--latency` and `--jitter` switches, or put one lamp on a phone hotspot, to bring them back ([08 §1.4](08-testing-and-roadmap.md#14-test-bed-everything-on-one-wifi)).
- Use a DHCP reservation for the laptop so its address doesn't change under the lamps.

## 14. Observability

- **`GET /healthz`** returns 200 once the database opens and the engine has loaded.
- **`GET /metrics`** (logged-in session, or a localhost-only listener) reports in Prometheus text format:
  - devices online
  - WS connections by type
  - commands per second
  - p50/p90 one-way delay per lamp
  - OTA jobs by status
- **Activity log** (`events`): what changed, from where (web, a lamp's UI, Apple Home, a button, a schedule), and which browser by session label, plus device connects and disconnects, crashes, OTA results and failed logins. The web app shows it ([06](06-web-apps.md)).

## 15. Capacity

The design load is 2 lamps and a few browsers, which is trivial. As a safety margin, the target is 100 lamps and 50 browsers on 1 vCPU with p95 command fan-out under 20 ms of server time. Handling many households would need per-user device permissions and a shared pub/sub layer; that is out of scope ([README](README.md)).

## 16. Implementation notes

Choices the implementation made where this document was silent or loose. `server/src/db/migrations.ts` is the source of truth for the schema; §11 shows the core tables.

- **Schema additions:** `devices.telemetry_json`, `effects_json`, `pending_verify`, `name_pending`; `groups.is_default`; `firmware.project`, `build_date`; `ota_jobs.version`, `allow_downgrade`, `rollout_id`, `rollout_seq`. OTA jobs keep their history when a firmware file is deleted.
- **Unpairing** deletes the device row and broadcasts `device.removed`. The activity log keeps its history.
- **Linking** stamps every field of the group replica with the link time, so a member's offline edits from before the link lose.
- **Unlinked group commands** apply to each online lamp separately, without `apply_at`. A group with no online lamp returns `offline`.
- **Missed schedule runs** (under 5 min late) are decided at startup and fire 10 s later, so the lamps have time to reconnect. Cron expressions have 5 fields.
- **`fade_off`** fades linearly to 0, turns the lamp off, then restores the original brightness while it's off. It stops if someone else changes the light during the fade.
- **Status codes:** creates return 201 (re-uploading the same firmware returns 200). A wrong current password on `PUT /auth/password` returns 403 with `field: "current"`, because the web app treats any 401 as "logged out". Login with a foreign `Origin` is 403; a missing `Origin` is allowed so scripts can log in.
- **`GET /events?before=`:** values below 1e11 are event ids (exclusive), larger values are timestamps (inclusive). Repeated state changes from the same source and target within 3 s are merged into one activity row, so slider drags don't flood the log.
- **Revoked sessions:** the server closes that browser's `/ws/client` socket with code 4001.
- **Extras:** `GET /groups/:id`; `X-Frame-Options: DENY`; `Cache-Control: no-store` on API responses; 409 when deleting firmware an update is using; rollouts skip lamps already on that version; a renamed lamp that's offline gets `name.set` after its next welcome.
- **Not built yet:** `GET /metrics` (§14), a route for the 24 h telemetry history, the button double-press nudge (button events are only logged). Whether `web/dist` exists is checked at startup, so build the web app before starting the server.
