# 04: Protocol

This document is the source of truth for every message format. `packages/protocol` turns it into TypeScript types and zod schemas, plus JSON test vectors that the firmware's host tests also load.

## 1. Conventions

- **Encoding.** JSON in UTF-8. Every WebSocket text frame holds exactly one message.
- **Time.** Timestamps are Unix ms on the **sync clock** (the server's clock). Durations are ms.
- **Colors.** `"#RRGGBB"` strings, either case on input, uppercase on output.
- **Partial updates.** A *patch* is any subset of the state fields. Missing fields keep their value.
- **Compatibility.** Receivers **ignore unknown fields**. Senders never change what an existing field means; they add new fields instead. A breaking change bumps `proto`. The current value is **1**.
- **Size limits.** Lamp → server and server → lamp messages are ≤ 4 KB. Browser → server messages are ≤ 16 KB.

## 2. Data model

### LampState

| Field | Type | Range / values | Default |
|---|---|---|---|
| `on` | bool | | `false` |
| `brightness` | int | 0–255 (perceptual) | 128 |
| `colors` | string[] | 1–3 × `#RRGGBB` | `["#FFB46B"]` (warm white) |
| `effect.id` | string | an id from `GET /effects` | `"solid"` |
| `effect.speed` | int | 0–255 | 128 |
| `effect.intensity` | int | 0–255 | 128 |
| `effect.seed` | uint32 | | random on change |
| `effect.epoch` | int64 | sync-clock ms when the effect started | set by the lamp or server |
| `effect.duration_ms` | uint32 | 0 = none. Used by one-shot effects such as `sunrise`. | 0 |

```json
{
  "on": true,
  "brightness": 180,
  "colors": ["#FF8A3D", "#7A2BFF"],
  "effect": { "id": "gradient", "speed": 40, "intensity": 128, "seed": 91823, "epoch": 1761650000000, "duration_ms": 0 }
}
```

### Command (patch + delivery)

```json
{ "patch": { "brightness": 90 }, "transition_ms": 150 }
```

| Field | Type | Meaning |
|---|---|---|
| `patch` | partial LampState | The fields to change. Nested `effect` fields merge one by one. |
| `transition_ms` | int 0–10000 | Fade length. Default 400 for taps. The UI sends ~120 while a slider is being dragged. |
| `apply_at` | int64? | Server → lamp only. When to start the visible change. |

### Other objects

| Object | Fields |
|---|---|
| `DeviceInfo` | `id`, `name`, `fw`, `proto`, `build`, `hw {chip:"esp32c3", pixels, channels, color_order}`, `net {mode:"sta"\|"ap"\|"apsta", ssid, ip, rssi}`, `cloud {state:"off"\|"connecting"\|"online", url, linked, group_name}`, `uptime_s` |
| `LedConfig` | `pixel_count` (1–1024), `channels` (3\|4), `color_order` (`"GRB"`, `"RGB"`, `"BRG"`, …, `"GRBW"`), `max_current_ma` (100–20000), `ma_per_pixel_white` (1–200), `color_correction` (`[r,g,b]`, each 0–255), `fps` (10–100), `dither` (bool), `power_on` (`"restore"\|"on"\|"off"`) |
| `EffectDesc` | `id`, `name`, `uses` (subset of `["colors1","colors2","colors3","speed","intensity","duration"]`), `oneshot` (bool) |
| `Preset` | `slot` (0–7), `name`, `state` (a full LampState with no `epoch`) |

## 3. Lamp local API

The base URL is `http://<lamp>/api/v1`. "Admin" means the request needs `Authorization: Bearer <session>` from `POST /auth/login`. In Setup mode, routes marked † work without auth.

| Method & path | Auth | Body → Response |
|---|---|---|
| `GET /info` | none | → `DeviceInfo` |
| `GET /state` | none | → `LampState` |
| `PATCH /state` | none | `Command` → `LampState` |
| `GET /effects` | none | → `EffectDesc[]` |
| `GET /presets` | none | → `Preset[]` |
| `POST /presets/{slot}/apply` | none | `{transition_ms?}` → `LampState` |
| `PUT /presets/{slot}` | admin | `Preset` → `Preset`. Returns `409 managed_by_server` while claimed. |
| `POST /auth/login` | none | `{password}` → `{token, expires_in}`. The session lives 30 days in RAM and is lost on reboot. |
| `GET /config` · `PUT /config` | admin | `LedConfig`, full or partial |
| `POST /test-pattern` | admin† | `{pattern:"color_order"\|"last_pixel"\|"white_25", duration_ms}` |
| `GET /wifi/scan` | admin† | → `[{ssid, rssi, auth}]` |
| `PUT /wifi` | admin | `{ssid, password, [eap…]}` → `202`. The lamp reconnects. |
| `POST /setup` | † only | `{ssid, password, name, admin_password, power:{preset\|max_current_ma}, server_url?, pairing_code?}` → `202` |
| `GET /setup/status` | † only | → `{state:"idle"\|"connecting"\|"online"\|"failed", reason?, ip?, host?}` |
| `POST /cloud/claim` | admin† | `{server_url, code}` → `{state:"online"}` or an error |
| `DELETE /cloud` | admin | Unpairs: erases the URL and token |
| `POST /ota` | admin | `application/octet-stream` firmware image → `202`, then reboot |
| `GET /logs` | admin | → `text/plain` from the ring buffer |
| `POST /identify` | none | `{duration_ms?}` |
| `POST /reboot` · `POST /factory-reset` | admin | → `202` |
| `GET /ws` | none | WebSocket upgrade (§3.1) |

**Errors** come back as `{"error": {"code": "invalid", "message": "brightness must be 0–255", "field": "brightness"}}`:

| HTTP status | Code |
|---|---|
| 400 | `invalid` |
| 401 | `auth_required` |
| 403 | `forbidden` |
| 404 | `not_found` |
| 409 | `conflict` / `managed_by_server` |
| 413 | `too_large` |
| 429 | `rate_limited` |
| 503 | `busy` |

### 3.1 Local WebSocket `/api/v1/ws`

| Direction | Message | Data |
|---|---|---|
| lamp → client | `state` | `{rev, state, origin}`, sent on connect and on every change |
| lamp → client | `info` | `DeviceInfo`, sent on connect and when network or cloud status changes |
| client → lamp | `cmd` | a `Command`, the same as `PATCH /state` |
| lamp → client | `error` | `{ref?, code, message}` |

Every message uses the envelope in §4.2.

## 4. Lamp ↔ server WebSocket

### 4.1 Connection

- **URL.** `wss://<server>/ws/device`, with header `Authorization: Bearer <device_token>`.
- **Rejected upgrades** get `401`. An already-open socket can be closed with an application close code:

| Close code | Meaning | What the lamp does |
|---|---|---|
| 4001 | Bad token | Stops retrying until the token changes. Shows "re-pair needed". |
| 4002 | Replaced by a newer connection from the same device | Reconnects normally |
| 4003 | Device was unclaimed | Erases its credentials |
| 4004 | `proto` not supported | Retries every 1 h. Shows "firmware update needed". |
| 4008 | Protocol violation | Backs off, then reconnects |

- **Liveness.** The lamp sends WS pings every 20 s. The server closes a connection after 45 s of silence.

### 4.2 Envelope

```json
{ "type": "state.set", "id": "s-1042", "ref": null, "data": { } }
```

- `id` is optional and unique per sender. Only messages that expect a reply carry one.
- `ref` holds the `id` being answered, in `ack` and `error`.

### 4.3 Lamp → server

| type | Data | Notes |
|---|---|---|
| `hello` | `{device_id, proto, fw, build, hw, state, dirty, boot_reason, rollback, pending_verify, uptime_s, ip, rssi, effects:[ids]}` | First message on every connection |
| `state.report` | `{rev, patch, origin:"local"\|"button"\|"timer"}` | A change that didn't come from the server |
| `time.ping` | `{t0}` | §5 |
| `ack` / `error` | `{}` / `{code, message}` | Replies to server messages that carried an `id` |
| `ota.progress` | `{job_id, phase:"download"\|"verify"\|"reboot"\|"done"\|"failed", pct, error?}` | |
| `event` | `{kind:"button", gesture}` · `{kind:"crash", summary}` · `{kind:"log", level, msg}` | Logs are warnings and errors only, at most 1 per second |
| `telemetry` | `{rssi, heap_free, heap_min, uptime_s, fps, reconnects, temp_c}` | Every 60 s |

`dirty` lists the fields changed while disconnected, with how long ago each changed according to the lamp's monotonic clock. A field restored from flash after a reboot has an unknown age, so it is reported as `null` or left out.

```json
"dirty": { "colors": { "age_ms": 300000 }, "on": { "age_ms": 12000 } }
```

### 4.4 Server → lamp

| type | Data | Notes |
|---|---|---|
| `welcome` | `{server_time, heartbeat_s, desired: LampState\|null, link: {group_id, name, linked, peers:[{id,name}]}\|null}` | `desired` is the merged result of §6. It is `null` for a lamp the server has never seen, in which case the server adopts the lamp's state. |
| `state.set` | `{state: LampState, apply_at?, transition_ms, origin}` | Always the **full** state, so delivery is idempotent |
| `time.pong` | `{t0, t1, t2}` | |
| `link` | same shape as `welcome.link` | Sent when linking changes |
| `config.set` | partial `LedConfig` | |
| `presets.sync` | `Preset[]` | Server scenes pushed down as lamp presets, so local UIs and the button can use them |
| `identify` | `{duration_ms}` | |
| `nudge` | `{from_name, color, count}` | |
| `ota.start` | `{job_id, version, url, sha256, size, allow_downgrade}` | `url` carries a token that expires in 15 min |
| `reboot` · `unclaim` | `{}` | |

### 4.5 Pairing (HTTP)

```
POST /api/v1/devices/claim        (no auth; rate-limited)
{ "code": "K7QM-4ZTX", "device_id": "dl-3fa2c1", "name": "Lamp A", "fw": "1.0.0", "hw": { "pixels": 240, "channels": 3 } }
→ 200 { "device_token": "<43-char base64url>", "ws_url": "wss://lamps.example.com/ws/device" }
→ 400 invalid_code | 410 code_expired | 429 rate_limited
```

## 5. Time sync

```
lamp:   t0 = sync_now()  ──time.ping{t0}──►  server: t1 = now() on receive
lamp:   t3 = sync_now()  ◄──time.pong{t0,t1,t2}──  server: t2 = now() just before send
offset = ((t1 − t0) + (t2 − t3)) / 2      delay = (t3 − t0) − (t2 − t1)
```

The filtering and correction rules are in [03 §11](03-firmware.md#11-time-sync). Browsers run the same exchange over their own WebSocket, so previews stay in phase with the real lamps.

## 6. Merge rules

**While a lamp is connected,** the server alone orders changes. It timestamps every accepted change with its own clock, per field, as `field_ts[f] = server_now`. Then it sends the full resulting state to every affected lamp and browser. Since each change is applied in arrival order and broadcast to everyone, all parties end up with the same state.

**On reconnect** (`hello`), for each top-level field `f`, where `effect` counts as one field:

| Case | Result |
|---|---|
| `f` is in `dirty` with an `age_ms`, so `lamp_ts = server_now − age_ms`, and `lamp_ts > field_ts[f]` | The **lamp's value wins**. `field_ts[f] = lamp_ts`. If the lamp is linked, the value spreads to the group. |
| Anything else: not dirty, unknown age, or older than the server's value | The **server's value wins** |
| The server has no stored state for the device (first connect) | The server adopts the lamp's whole state |

The merged state goes back in `welcome.desired`.

**When two lamps are linked,** the group's state starts as the state of the member that changed most recently, by highest `max(field_ts)`. The web app can override this by asking for "match B to A" ([05 §4](05-server.md#4-sync-engine)).

## 7. Browser ↔ server

### 7.1 REST (`/api/v1`, session cookie)

| Method & path | Purpose |
|---|---|
| `POST /auth/login` · `POST /auth/logout` · `GET /me` | Session management |
| `GET /devices` · `GET/PATCH/DELETE /devices/{id}` | List devices, rename them, change LED config, unclaim |
| `POST /devices/{id}/state` · `POST /groups/{id}/state` | Send a `Command`. Same as the WS `cmd`; handy for scripts. |
| `POST /devices/{id}/identify` · `POST /devices/{id}/nudge` | Overlays |
| `GET/PATCH /groups/{id}` | Toggle `linked`, rename, `{"match_from": "<device_id>"}` |
| `GET/POST/PUT/DELETE /scenes[/{id}]` · `POST /scenes/{id}/apply` | Scenes; apply takes `{target}` |
| `GET/POST/PUT/DELETE /schedules[/{id}]` | Schedules |
| `POST /pairing-codes` | → `{code, expires_in}` |
| `GET/POST /firmware` · `POST /devices/{id}/ota` · `GET /ota-jobs` | Firmware and OTA (admin only) |
| `GET /events?device_id&before&limit` | Activity log |
| `GET/POST/DELETE /users[/{id}]` | Users (admin only) |

### 7.2 WebSocket `/ws/client` (session cookie; Origin header checked)

| Direction | type | Data |
|---|---|---|
| server → browser | `snapshot` | `{devices:[{id, name, online, info, state, telemetry}], groups:[…], scenes:[…], server_time}`, sent on connect |
| server → browser | `device.state` · `group.state` | `{id, state, origin, by?, apply_at?}` |
| server → browser | `device.presence` | `{id, online, last_seen}` |
| server → browser | `device.updated` · `group.updated` · `scene.updated` · `ota.job` | changed objects |
| browser → server | `cmd` | `{target: {device: id} \| {group: id}, patch, transition_ms, cid}` |
| browser → server | `time.ping` | `{t0}` → server replies `time.pong` |
| server → browser | `ack` · `error` | `{ref: cid}` / `{ref: cid, code, message}` |

`cid` is an id the browser chooses for each command. The server echoes it back as `ref`, so the browser can match responses to its optimistic updates ([06 §A.4](06-web-apps.md#a4-state-and-sync-in-the-browser)).

## 8. Error codes

| Code | Meaning |
|---|---|
| `invalid` | Schema or range check failed |
| `unknown_effect` | Effect id isn't supported by this lamp's firmware |
| `auth_required` / `forbidden` | Not logged in / not allowed |
| `offline` | Target lamp isn't connected. Server only; the command is not queued. |
| `managed_by_server` | A local edit was refused because the server manages that resource |
| `rate_limited` · `too_large` · `busy` | Limits |
| `unsupported` | Unknown message type for this `proto` |

## 9. Test vectors

`packages/protocol/test-vectors/` holds:

| File(s) | Contents | Checked by |
|---|---|---|
| `messages/*.json` | One valid example per message type, plus invalid cases tagged with the expected error | zod in TypeScript; the cJSON decoder in firmware host tests |
| `merge/*.json` | Merge cases: server state + `hello.dirty` + timestamps → expected merged state | Server sync engine tests |
| `effects/*.json` | Golden frames: `{effect, params, t, n} → [#RRGGBB…]` | Firmware `effects` and `packages/effects` |
