# DoubleLamp

A pair of WiFi lamps, each a Seeed XIAO ESP32-C3 driving 625 mm of 12 V WS2811 COB strip. Each lamp works on its own from its built-in web page and from Apple Home, with no hub. A small server links the two lamps across homes, so a change on one shows on both with animations in step.

- **Start here:** [docs/09-bring-up.md](docs/09-bring-up.md), step by step from the bench to two linked lamps.
- **Design:** [docs/README.md](docs/README.md): architecture, hardware, firmware, protocol, server, apps, security, testing, plus ADRs.

## What's where

| Path | What | Build / run |
|---|---|---|
| `firmware/` | ESP-IDF v5.5 firmware (C++17) | `.\lamp.ps1 build` / `.\lamp.ps1 flash -Port COM5` (after `export.ps1`) |
| `device-ui/` | The lamp's built-in page (setup wizard, control, settings), embedded in the firmware | `npm run build:device-ui` |
| `server/` | Node server: shared login, pairing, sync engine, scenes, schedules, OTA | `npm start` (config in `server/.env`) |
| `web/` | Web app (React PWA) served by the server | `npm run build:web` |
| `packages/protocol/` | Message types, zod schemas and test vectors shared by everything | |
| `packages/effects/` | TypeScript port of the firmware effects, bit-exact with the C++ | |
| `tools/virtual-lamp/` | Simulated lamp for trying the server and web app without hardware | `npm run virtual-lamp -- --help` |

## Checks

```powershell
npm install
npm test             # protocol, effects (golden frames), server (unit + integration), web
npm run typecheck
```

Firmware host tests (pure C++ logic plus the golden-vector check) need a desktop C++ compiler and `IDF_PATH`:

```powershell
cmake -S firmware/test/host -B firmware/test/host/build -G Ninja
cmake --build firmware/test/host/build
ctest --test-dir firmware/test/host/build --output-on-failure
```
