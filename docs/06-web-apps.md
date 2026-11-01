# 06: Web Apps

There are two UIs, and they share one visual language:

| | **A. Server web app** (`web/`) | **B. Device UI** (`device-ui/`) |
|---|---|---|
| Served by | The server, over HTTPS | The lamp, over plain HTTP on the LAN or the lamp's AP |
| Controls | Both lamps, linking, scenes, schedules, OTA | One lamp: setup, local control, settings |
| Needs internet | Yes | No |
| Size budget | ≤ 250 KB gzipped on first load | ≤ 60 KB gzipped, everything inlined |
| Stack | React + Vite + TypeScript, Zustand | Plain TypeScript + esbuild |

## Design principles

1. **One-thumb control.** The main actions (power, brightness, color) are reachable at the bottom of a phone screen. Touch targets are ≥ 44 px.
2. **Dark first.** Lamps get used at night, so the default theme is dark and avoids glaring white surfaces. A light theme follows `prefers-color-scheme`.
3. **Show the actual light.** Every lamp tile shows a live animated **strip preview**, rendered with the real effect code and the sync clock. The app's accent color follows the lamp's current color.
4. **Instant feedback.** UI updates are optimistic. The server's confirmation arrives in about 100 ms and either matches the update or quietly corrects it.
5. **Linked feels linked.** When the lamps are linked, the two tiles visually join into one control. Unlinking splits them apart again.

## Part A: Server web app

### A.1 Screens

| Screen | Contents |
|---|---|
| **Home** | Two lamp tiles plus a link toggle; the scenes row; the control sheet |
| **Lamp** | Name, status (online, RSSI, firmware, IP with a link to its local UI, Apple Home paired or not), identify, LED config, test patterns, firmware update, unpair. The Apple Home setup code is shown only in the lamp's own UI, never through the server. A "dev build" badge shows when `insecure_server_allowed` is set. |
| **Scenes** | Grid of saved scenes. "Save current as scene", reorder (the first 8 become lamp presets), edit, delete. |
| **Schedules** | A list with next-run times. The editor sets target, time and days or cron, and an action: power, scene, sunrise or fade off. |
| **Activity** | Timeline of state changes ("Lamp B → Candle · web, Kitchen iPad" or "Lamp A → off · Apple Home"), connects and disconnects, OTA results |
| **Settings** | Shared password (change) and signed-in browsers (revoke), "Add lamp" pairing-code dialog, firmware library (upload, versions), about |
| **Login** | One password field, plus an optional "Name this device" field that becomes the session label ([05 §6](05-server.md#6-login-one-shared-password)) |

### A.2 Home layout (phone)

```
┌──────────────────────────────┐
│ DoubleLamp            ⚙  ⋯  │
├──────────────────────────────┤
│ ┌───────────┐ ⛓ ┌───────────┐│   ⛓ = link toggle; when linked, the tiles
│ │ Lamp A  ● │───│ Lamp B  ● ││       join into one wide tile
│ │ ▓▓▒▒░░▒▒▓ │   │ ▓▓▒▒░░▒▒▓ ││   ▓▒░ = live strip preview
│ │ [⏻]  72 % │   │ [⏻]  72 % ││
│ └───────────┘   └───────────┘│
│ Scenes: (Cozy)(Read)(Party)(+)│
├──────────── control sheet ───┤   drag up for color and effects
│ ☀ ━━━━━━━━━━━━━━●━━━━━  72 % │
│      ( color wheel )         │
│  ◯ ◯ ◯ ◯ ◯  warm ━━●━━ cool │   swatches + white-temperature slider
│ [Solid][Breathe][Rainbow][…] │   effect cards with mini previews
│ Speed ━━━━●━━━  Depth ━━●━━━ │   only the parameters the effect uses
└──────────────────────────────┘
```

**Which lamp the sheet controls:** tapping a tile selects that lamp. When the lamps are linked, there's only one target, the group. On wide screens the tiles sit side by side, with the control panel on the right.

### A.3 Components

| Component | Notes |
|---|---|
| `LampTile` | Name, online dot, power, brightness, `StripPreview`. A long press opens the Lamp screen. |
| `StripPreview` | A canvas showing *n* blurred dots. Calls `packages/effects` with `server_now()`, and respects `apply_at` and transitions. It pauses when off-screen or when `prefers-reduced-motion` is set. |
| `LinkToggle` | Confirms linking with "Match Lamp B to Lamp A?" and offers to swap direction. Sends `PATCH /groups/{id} {linked, match_from}`. |
| `ColorPicker` | `react-colorful` hue/saturation wheel, recent and preset swatches, and a 2200–6500 K white slider. Kelvin is converted to sRGB in the client. Up to 3 colors for effects that use them. |
| `EffectGallery` | Built from the `EffectDesc` list, so there's no hard-coded effect list. When linked, it shows only effects **both** lamps support. |
| `ParamSlider` | Throttled sending (A.4), keyboard steps, an `aria-valuetext` label |
| `SceneChip`, `ScheduleEditor`, `PairingDialog`, `OtaPanel` | Standard forms. Zod schemas from `packages/protocol` validate them in the browser. |

### A.4 State and sync in the browser

- **Store.** Zustand is filled from the WS `snapshot` and then the change events ([04 §7.2](04-protocol.md#72-websocket-wsclient-session-cookie-origin-header-checked)). REST is used for create/update/delete screens. The WS stream stays the single source for live state.
- **Optimistic updates.**
  1. A control change is applied to the store right away, tagged with its `cid`.
  2. When the matching `group.state` or `device.state` arrives, it replaces the optimistic value. Ordering is the server's, so later edits from other people still win.
  3. On `error`, the change is rolled back and a toast explains why (for example, "Lamp B is offline").
- **Throttling.** Slider drags send at most one `cmd` every 50 ms, always including the final position. Drags use `transition_ms: 120` so the light moves smoothly between updates; taps use 400.
- **Clock.** The app runs `time.ping` on connect and every 30 s, with the same filtering as the lamps. Previews then animate in phase with the physical lamps.
- **Reconnect.** Backoff 1 s → 15 s. While disconnected, a banner reads "Reconnecting…" and controls are disabled; nothing is queued. Each reconnect triggers a fresh `snapshot`.

### A.5 PWA and platform

- `manifest.webmanifest` sets the name, icons and `display: standalone`, so the app can be added to the home screen.
- A service worker caches only the app shell. It never caches API calls.
- When offline, the cached shell shows "No connection to server" plus a hint: on the same WiFi, the lamp can be opened directly at its saved local address.
- **Accessibility.**
  - Contrast is WCAG AA.
  - Every control works by keyboard.
  - Colors get spoken names (nearest of ~30 names) for screen readers.
  - Animations respect `prefers-reduced-motion`.
- **Tests.** Vitest for the store and throttling. Playwright end-to-end tests run against a real server with two **virtual lamps** ([08](08-testing-and-roadmap.md)).

## Part B: Device UI

### B.1 Constraints

- **Self-contained.** One `index.html.gz` file with CSS, JS, icons (inline SVG) and fonts (system font stack) all inlined. There are no CDN calls, because on the lamp's AP there is no internet.
- **Small.** ≤ 60 KB gzipped. CI fails if the build goes over.
- **Captive-portal browser.** It must work inside the phone's captive-portal browser. That means no reliance on `localStorage`, popups or new tabs during setup, and the wizard's progress is kept on the lamp.
- **Not a secure context.** Plain HTTP means `crypto.subtle` and service workers aren't available, so the UI is built not to need them.

### B.2 Setup wizard (Setup mode only)

1. **Welcome:** "Let's connect your lamp". Tapping *Blink* makes the strip blink so the user knows which lamp this is.
2. **WiFi:** scanned networks sorted by signal (lock icon, signal bars), plus a "hidden network" option.
3. **Password**, with a show/hide toggle.
4. **Name and admin password.** The admin password protects settings and is the lamp's direct-mode WiFi password.
5. **Strip and power supply:**
   - Strip length in meters, in 62.5 mm steps. This sets `pixel_count` to 16 per meter.
   - Supply: 12 V 1 A / 2 A / 3 A / 5 A / custom, which sets `max_current_ma` ([02 §5](02-hardware.md#5-power)).
6. **Server (optional):** URL plus pairing code, with "Skip; I'll use it on its own".
7. **Connecting…:** live status from `/setup/status`, with specific errors ("Wrong password", "Network not found", "No IP address"). Back returns to the step that needs fixing.
8. **Done:**
   - Shows `http://doublelamp-3fa2c1.local` and the IP, an "Open lamp" button, and a note to bookmark it.
   - **Add to Apple Home:** shows the setup code in large digits with a copy button. The page fetches it with the admin password from step 4, which it holds in memory only. Instructions underneath: switch the phone back to home WiFi, then Home app → + → Add Accessory → More options… → enter the code → **Add Anyway** at the "Uncertified Accessory" prompt.

### B.3 Control and settings

- **Control:** the same layout as the server app's control sheet, for one lamp, with the 8 presets. When the lamp is linked, a banner reads *"Linked with Lamp B: changes apply to both"*. Changes made from Apple Home show up live, like any other change.
- **Settings** (admin login, token kept in memory for the session):

| Section | Contains |
|---|---|
| LEDs | Pixel count, channels, color order, current limit, calibration, color correction, fps, dithering, power-on behavior; the color-order and last-pixel **test patterns** |
| Network | Current SSID and RSSI, change WiFi, "direct mode always on" |
| Apple Home | Paired or not, number of paired iPhones, setup code with the add-accessory steps, **Reset Apple Home** (removes all pairings) |
| Server | Status, URL, pair / unpair |
| Security | Change the admin password and the direct-mode password |
| Firmware | Version, build, upload a `.bin` (signature checked on the lamp) |
| System | Logs, reboot, factory reset (typed confirmation) |

### B.4 Build

```
device-ui/src/*.ts, *.css ─esbuild (minify, bundle)─► inline into index.html ─gzip -9─►
    firmware/components/device_ui/index.html.gz   (EMBED_FILES)
```

- **Small toolkit.** A ~1 KB reactive store and a `h()` DOM helper. The color wheel is drawn on a canvas, with HSV math in integers that match the firmware.
- **Kept in sync.** `npm run build:device-ui` runs before `idf.py build`, from a firmware CMake step or a CI step. CI checks that the committed `.gz` matches its source.
