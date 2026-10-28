# 08: Testing and Roadmap

## Part 1: Testing

### 1.1 Test layers

| Layer | What it covers | Tooling | Runs |
|---|---|---|---|
| Firmware host unit tests | `lamp_core` (patch, clamp, dirty tracking), `effects` (golden frames, timing), protocol encode/decode, time-sync math | CMake + Unity (or GoogleTest) on Linux/macOS/Windows | every push |
| Shared vectors | Messages, merge cases, effect frames ([04 §9](04-protocol.md#9-test-vectors)) | The same JSON files are loaded by the C++ and TypeScript tests | every push |
| Server unit tests | Sync engine, apply_at, scheduler next-run (including DST), pairing, OTA tokens | Vitest | every push |
| Server integration tests | Real Fastify + SQLite + two **virtual lamps** over real WebSockets | Vitest + `tools/virtual-lamp` | every push |
| Web E2E | Login, link/unlink, color change shown on both virtual lamps, offline lamp error, scenes | Playwright | every push |
| Firmware target build | Compiles for esp32c3; image size and UI size checked against budgets | `espressif/idf` container | every push |
| Hardware in the loop | Real lamps on a bench | Manual checklist (§1.5) | every release |
| Soak | 72 h with random commands and induced faults | Script + both real lamps | before 1.0, and after big changes |

### 1.2 Golden vectors keep three implementations identical

The firmware C++, the TypeScript port and the virtual lamp must all produce the same pixels. `tools/gen-vectors` holds a set of `(effect, params, t, n)` cases that cover the following:

- every effect;
- edge values (speed 0/255, n = 1, n = 1024);
- time near wraparound;
- a range of seeds.

**The firmware C++ is the reference.** A host binary renders each case and writes the expected `#RRGGBB` arrays to `test-vectors/effects/*.json`. The TypeScript tests must match those arrays **exactly**.

When an effect changes on purpose, regenerate the vectors and review the diff in the PR.

### 1.3 Virtual lamp

`tools/virtual-lamp` is a Node program. It implements the lamp side of the protocol on top of `packages/effects`:

- pairing, `hello`/`welcome` and dirty tracking;
- time sync and `apply_at`;
- OTA progress, simulated.

It renders the strip to the terminal (truecolor blocks) or to a small local web page. It also has fault switches: `--latency 200`, `--jitter 50`, `--drop 0.05`, `--offline-after 30s`, `--crash-on-ota`.

This lets the server and web app be built and tested in CI without hardware, and two virtual lamps side by side show sync bugs right away.

### 1.4 Key scenarios (integration and E2E)

1. **Linked change.** A command to the group reaches both lamps with the same `apply_at` and the same `effect.epoch`.
2. **Concurrent edits.** Lamp A sends a local brightness change while the web sends a color change to the group. Both lamps end with both changes.
3. **Race on one field.** Lamp A sets red locally while the web sets blue at nearly the same moment. Every lamp and browser ends on whichever change the server received last.
4. **Offline edit wins.** Lamp A goes offline, gets a local edit, and reconnects 5 min later. The edit spreads to lamp B because no newer server change exists.
5. **Offline edit loses.** The same, but the web changed the group after A's edit. A gets the server's value.
6. **Unknown age.** Lamp A reboots while offline and its restored state has no age. The server's value wins when it reconnects.
7. **Link direction.** "Match B to A" when linking: B blends to A's look at the shared `apply_at`.
8. **Command to an offline lamp.** Fails with `offline`, nothing is queued, and the toast appears.
9. **OTA failure.** A virtual lamp with `--crash-on-ota` reports `rollback: true`. The job is marked failed and "Update both" doesn't go on to the second lamp.
10. **Missed schedules.** A run less than 5 min late fires at startup; one more than 5 min late is skipped and logged.

### 1.5 Hardware-in-the-loop checklist (each release)

The bring-up steps are in [02 §7](02-hardware.md#7-bring-up-checklist). Then check:

- [ ] Run setup from scratch on an iPhone and an Android phone through the captive portal.
- [ ] LAN command latency: p95 ≤ 150 ms, timed from the local UI log against a slow-motion video.
- [ ] Unplug the router for 5 min. The lamp keeps its state, enters Fallback after 2 min, is controllable over its AP, and returns to Online on its own.
- [ ] Block the internet but keep the LAN. Local control is unaffected, and the web app shows the lamp as offline.
- [ ] Power-cycle 20 times. No boot flash, and the light is restored within 500 ms.
- [ ] Do 5 rapid power cycles; Setup mode starts. Hold 10 s; factory reset starts, and letting go early cancels it.
- [ ] OTA from the server and by local upload. A deliberately broken build rolls back automatically.
- [ ] Free heap stays ≥ 40 KB during TLS + 3 local WS clients + OTA (from telemetry).
- [ ] The current limiter keeps measured current under `max_current_ma` at full white.

### 1.6 Measuring sync between lamps

1. Link both lamps and select the `sync_test` effect, which flashes on each whole second of the sync clock.
2. Put both lamps in the frame of a phone filming 240 fps slow motion.
3. Count the frames between the two flashes. One frame is about 4.2 ms.

Targets: **effect phase skew ≤ 30 ms** (≈ 7 frames), and **change skew with `apply_at` ≤ 50 ms**.

To test across two homes, use a second phone and compare against a shared reference, for example both filming a screen showing a `time.is`-style clock. Or rely on the server's skew estimate: the difference between the two lamps' `offset` errors, reported in telemetry.

### 1.7 Soak and fault injection

Run 72 h with both real lamps plus 2 virtual lamps. A script sends random commands at 0.2–5 Hz and adds faults:

- restart the server every 2 h;
- drop WiFi every 3 h;
- an OTA in the middle of the run.

**Pass criteria:**
- no lamp reboots except the planned OTA;
- `heap_min` doesn't drift downward;
- every reconnect converges within 5 s;
- no lamp's state differs from the server's for more than 2 s.

### 1.8 CI (GitHub Actions)

| Job | Steps |
|---|---|
| `ts` | pnpm install → lint (eslint, tsc) → Vitest (protocol, effects, server, web) → build web + device UI → check size budgets → Playwright with 2 virtual lamps |
| `firmware` | Build the device UI → `idf.py build` in a pinned `espressif/idf` container → check app size ≤ 1.5 MB → host unit tests → check that committed vectors and UI bundle are current |
| `release` (on a tag) | Build the firmware → sign it (protected secret, manual approval) → attach to the GitHub release → optional upload to the server. Build and push the server Docker image. |

## Part 2: Roadmap

Each milestone ends with something usable.

| Milestone | Scope | Done when |
|---|---|---|
| **M0 Bring-up** | Wiring with level shifter; ESP-IDF project; led_strip SPI-DMA on GPIO7; test patterns; current limiter | The strip shows correct colors at 50 fps with WiFi busy; [02 §7](02-hardware.md#7-bring-up-checklist) passes |
| **M1 Standalone lamp** | State store, effects (solid, breathe, gradient, rainbow, candle), NVS persistence and restore, Setup AP + captive portal, local REST + WS, device UI, mDNS, button | A new lamp can be set up from a phone and used daily with no server. Host tests pass. |
| **M2 Server MVP** | Server skeleton, auth, pairing, device hub, web app Home + Lamp screens for individual control, virtual lamp | Both lamps can be controlled from anywhere through the web app |
| **M3 Linked sync** | Groups, link/unlink, time sync, `apply_at`, effect epochs, reconnect merge, previews in the browser | Sync measurements meet the targets (§1.6). The scenarios in §1.4 pass. |
| **M4 Operate** | Signed OTA with rollback, firmware library, scenes → presets, schedules (sunrise), activity log, telemetry | A firmware release goes out with no USB. The soak test (§1.7) passes. |
| **M5 Delight (stretch)** | **Nudge** (double-press sends a pulse to the partner lamp); **span mode** (the two strips act as one long virtual strip); on-device schedules; WPA2-Enterprise; flashing new lamps from the web app (ESP Web Tools + Improv); Matter or a Home Assistant integration (MQTT bridge) | Pick one at a time |

## Part 3: Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| The strip isn't WS281x-compatible (A1) | Low–med | High | Confirm the strip model first (README open question 1). The CCT alternative is described. |
| 3.3 V data line is unreliable | High without a shifter | Med | A 74AHCT125 is in the BOM |
| WiFi interrupts glitch the LED output | Med with RMT | Med | SPI-DMA backend. Glitch test in bring-up. |
| Campus WiFi (WPA2-Enterprise, or devices blocked from each other) | Med | Med | The server path works even when LAN access is blocked. Fallback AP. Enterprise support is a stretch goal. |
| Not enough heap with TLS + HTTP + WS on the C3 | Med | High | Budgets enforced in telemetry and soak tests. At most 3 local WS clients. Fixed buffers. |
| Effects differ between C++ and TypeScript | Med | Low | Golden vectors are checked in CI |
| Signing key lost | Low | High | Back it up, encrypted, in two places. USB reflash is the recovery path. |
| Server down, so schedules don't run | Med | Low | Documented. On-device schedules in M5. |
| Not enough flash for Matter | Med | Med | Measure image size before committing to M5 Matter |
