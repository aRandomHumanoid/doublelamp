# DoubleLamp server

Shared login, lamp pairing, the sync engine for linked lamps, scenes, schedules, firmware hosting and OTA.
The design is in [docs/05-server.md](../docs/05-server.md); message formats are in
[docs/04-protocol.md](../docs/04-protocol.md) and [packages/protocol](../packages/protocol).

## Run

From the repository root (Node 22.12+; dependencies installed with `npm install`):

```sh
npm run dev -w server        # tsx watch, restarts on changes
npm start -w server          # plain run
```

On first start, with no `APP_PASSWORD` set, the server generates a 16-character password and prints it once.
Log in at `PUBLIC_URL` (the built web app is served from `../web/dist`; build it with `npm run build -w web`).

Local development on one WiFi (lamps on the LAN talk to your laptop over `ws://`):

```sh
PUBLIC_URL=http://192.168.1.20:8080 DEV_INSECURE=1 npm run dev -w server
```

To use the Vite dev server for the web app, add its origin: `EXTRA_ORIGINS=http://localhost:5173`.

### Without hardware: virtual lamps

```sh
curl -s -c jar -H 'Content-Type: application/json' -d '{"password":"…"}' http://localhost:8080/api/v1/auth/login
curl -s -b jar -X POST -H 'Origin: http://localhost:8080' http://localhost:8080/api/v1/pairing-codes   # → {"code":"K7QM-4ZTX",…}
npm run virtual-lamp -- --server http://localhost:8080 --code K7QM-4ZTX --name "Virtual A"
```

Later runs reuse the stored token (kept in the OS temp dir by default; see `--state-dir`). Try
`--latency 120 --jitter 40`, `--offline-after 30s`, `--crash-on-ota` and `--report-origin homekit`
([08 §1.3](../docs/08-testing-and-roadmap.md)). In a terminal, keys `o + - c e x q` act as local changes.

### Docker

See the root `Dockerfile` and `docker-compose.yml`. `docker compose --profile tunnel up -d` runs the server
and `cloudflared` with no published ports ([05 §13](../docs/05-server.md#13-deployment));
`docker compose --profile local up -d` additionally publishes port 8080 on the host for testing. The image
runs as uid 1000 with a read-only root filesystem, so `./data` must be writable by that user.

## Configuration

Environment variables, or `server/.env` (see [`.env.example`](.env.example)); real environment variables win.

| Variable | Default | Purpose |
|---|---|---|
| `PUBLIC_URL` | `http://localhost:$PORT` | Origin checks, the `ws_url` given to lamps, OTA download links. Must be `https://` unless `DEV_INSECURE=1` or the host is localhost. |
| `PORT` / `HOST` | `8080` / `0.0.0.0` | Listen address |
| `DATA_DIR` | `./data` (relative to `server/`) | SQLite database, firmware files, generated secret |
| `APP_PASSWORD` | generated | Shared password on first start only (12+ characters) |
| `SERVER_SECRET` | generated into `DATA_DIR/secret` | HMAC for download links and cookie signing |
| `TRUST_PROXY` | `false` | `cloudflare`: client IP from `CF-Connecting-IP` (rate limits) |
| `DEV_INSECURE` | off | `1`: allow `http://` `PUBLIC_URL`, drop the cookie `Secure` flag |
| `EXTRA_ORIGINS` | none | More allowed browser origins, comma-separated |
| `LOG_LEVEL` | `info` | pino level |
| `WEB_DIST` | `../web/dist` | Where the built web app is |

## Layout

```
src/
├─ main.ts, app.ts       entry point; buildApp() wires everything (tests use it directly)
├─ config.ts, log.ts     environment, pino options (tokens/passwords/codes are redacted)
├─ engine/               sync engine: pure TS, injected clock, no I/O (state, timing, groups)
├─ hubs/                 /ws/device and /ws/client
├─ http/                 REST routes under /api/v1, /fw downloads, static web app, security headers
├─ auth/                 password (argon2id), sessions, rate limits
├─ ota/                  esp_app_desc parsing, firmware store, download tokens, jobs and rollouts
├─ db/                   better-sqlite3 + numbered migrations (PRAGMA user_version)
└─ scheduler.ts, scenes.ts, pairing.ts, devices.ts, persistence.ts, activity.ts, telemetry.ts
test/
├─ unit/                 engine, merge vectors, timing, pairing, auth, OTA, scheduler, config
└─ integration/          real server + two virtual lamps + a ws browser client (08 §1.5)
```

## Test

```sh
npm test -w server           # vitest: unit + integration
npm run typecheck -w server
```

The merge cases in `packages/protocol/test-vectors/merge/` are the specification for the reconnect merge.
