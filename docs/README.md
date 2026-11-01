# DoubleLamp: Design Docs

DoubleLamp is a pair of WiFi lamps. Each one is a Seeed XIAO ESP32-C3 driving about 24 in (625 mm, **10 pixels**) of **12 V WS2811 COB strip** (BTF-LIGHTING FCOB) from pin **D5**, through a 74AHCT125 level shifter. A 12 V → 5 V buck converter powers the board from the strip's supply.

- **On its own**, each lamp works like a smart-home light. A phone controls it directly over WiFi, from the lamp's built-in web page or from **Apple Home** and Siri. There's no server, internet, hub or app install needed.
- **With the server**, one web app controls both lamps. The lamps can also be **linked**: any change applies to both, and their animations stay in step. The lamps are in different homes, on different networks. The server runs on a local machine on a third network, published through Cloudflare Tunnel.

## Documents

| Doc | Covers |
|---|---|
| [01 Architecture](01-architecture.md) | Components, deployment options, end-to-end flows, repo layout |
| [02 Hardware](02-hardware.md) | The chosen strip, pin map, wiring, level shifter, buck converter, power, BOM, bring-up |
| [03 Firmware](03-firmware.md) | ESP-IDF tasks, state store, LED pipeline, effects, WiFi/setup, Apple Home, OTA |
| [04 Protocol](04-protocol.md) | State model, lamp local API, lamp↔server and browser↔server messages |
| [05 Server](05-server.md) | Server modules, sync engine, shared login, scheduler, database, deployment |
| [06 Web apps](06-web-apps.md) | The server web app and the lamp's built-in UI |
| [07 Security](07-security.md) | Threat model, secrets, hardening |
| [08 Testing & roadmap](08-testing-and-roadmap.md) | Test strategy, one-WiFi test setup, milestones, risks |
| [09 Bring-up guide](09-bring-up.md) | Step by step: install the tools, flash and set up both lamps, Apple Home, server, linking, OTA |
| [ADRs](adr/) | Key decisions and the alternatives rejected |

## Goals

1. **Standalone smart light.** A phone on the same WiFi can control power, brightness, color, effects and presets. None of this depends on the server.
2. **Apple Home, directly.** Each lamp is a native HomeKit accessory. The Home app and Siri control power, brightness and color over the LAN, with no home hub or bridge ([ADR-0004](adr/0004-apple-home-via-hap.md)).
3. **Setup without an app.** First-time setup runs in the phone's browser through a captive portal.
4. **Linked pair.** When the lamps are linked, a change from any source applies to both. Sources are the web app, either lamp's built-in UI, Apple Home on either side, and either lamp's button. Animations run in phase.
5. **Works across networks.** The two lamps are on two different networks and the server is on a third. Lamps only make outbound connections, and no port forwarding is needed.
6. **Testable on one WiFi.** For development, both lamps, the server and the phones can all share one network ([08 §1.4](08-testing-and-roadmap.md#14-test-bed-everything-on-one-wifi)).
7. **Degrades gracefully.** Losing the internet or the server never turns a lamp off and never stops local control or Apple Home. The lamp catches up with the server when it reconnects.
8. **Maintainable.** OTA updates roll back automatically if they fail. A single protocol definition is shared by firmware, server and web apps. Everything except the LEDs and Apple Home can be tested without hardware by using a virtual lamp.

## Non-goals for v1

- **Apple Home through a home hub.** Remote access and automations in Apple Home need a HomePod or Apple TV, which isn't planned. The web app and server schedules cover them instead. If a hub is ever added, Apple Home remote access works with no change to the lamps.
- **Matter and Google Home.** Apple Home only accepts Matter accessories through a home hub, so Matter would defeat goal 2 ([ADR-0004](adr/0004-apple-home-via-hap.md)).
- **Effects in Apple Home.** The Home app has no concept of effects. They stay in the lamp UI and the web app.
- Server-streamed per-pixel video and music-reactive effects.
- Native iOS or Android apps. Both web apps can be installed as PWAs instead.
- **Per-person accounts.** One shared login is enough.
- Hosting multiple households on one server. One server serves one pair of lamps and the people around them.
- Battery power.

## Decisions (2026-10-28)

| # | Question | Decision | Effect on the design |
|---|---|---|---|
| D1 | Which strip? | BTF-LIGHTING FCOB WS2811, **12 V**, RGB, 576 LEDs/m. 16 addressable pixels per meter (62.5 mm segments), max 8 W/m, 3 wires (+12V, DIN, GND). | 12 V wiring with a buck converter, 74AHCT125 shifter, PSU sizing and the current-limit defaults ([02](02-hardware.md)) |
| D1b | How long is each lamp's strip? | **About 24 in**, cut at 10 segments: 625 mm (24.6 in), **10 pixels**, 5 W at full white | 12 V 1 A supply per lamp. Effect defaults tuned for 10 pixels ([02 §3](02-hardware.md#3-the-strip), [03 §6](03-firmware.md#6-effects)). |
| D2 | Same home or different homes? | **Different networks**. The server is on a **third** network. | The public server option (T3) is required ([01 §4](01-architecture.md#4-deployment-options), [05 §13](05-server.md#13-deployment)) |
| D3 | Can everything share one network for testing? | **Yes, this is wanted.** | Local dev mode: development firmware accepts `ws://` to private addresses, and the server runs with `DEV_INSECURE`. Also a staging mode with real TLS ([05 §13](05-server.md#13-deployment), [08 §1.4](08-testing-and-roadmap.md#14-test-bed-everything-on-one-wifi)). |
| D4 | Apple Home or Google Home? | **Direct Apple Home connection, no hub.** | Native HAP over IP with `esp-homekit-sdk` ([03 §11](03-firmware.md#11-apple-home-homekit), [ADR-0004](adr/0004-apple-home-via-hap.md)). New roadmap milestone M2, plus a footprint spike in M0. |
| D5 | Per-person logins? | **One shared login.** | No users table or roles. Per-browser sessions with labels for the activity log ([05 §6](05-server.md#6-login-one-shared-password)). |
| D6 | Where does the server run? | **On a local always-on machine, published through Cloudflare Tunnel** | Compose file with `server` + `cloudflared`, no open ports. Cloudflare settings that let the lamps through. App-level 20 s heartbeat for Cloudflare's 100 s idle timeout. `no-store` on firmware downloads. Cloudflare is inside the trust boundary ([05 §13](05-server.md#13-deployment), [07 §2](07-security.md#2-trust-boundaries)). |

## Assumptions

| # | Assumption | If it's wrong |
|---|---|---|
| A1 | The strip's WS2811 runs in 800 kHz mode and accepts WS2812 bit timing. | Switch the driver to a 400 kHz WS2811 timing. Effects and wiring are unaffected ([03 §5](03-firmware.md#5-led-output-pipeline)). |
| A2 | Both lamps get the same length (10 pixels), so linked effects line up segment for segment. | Different lengths still work. Effects use normalized position, but the bands won't line up exactly ([03 §6](03-firmware.md#6-effects)). |
| A3 | Each lamp has a 2.4 GHz WPA2/WPA3-Personal network to join, which allows devices to see each other (needed for Apple Home and the local UI). | WPA2-Enterprise (campus WiFi) is a stretch goal. On networks that block devices from seeing each other, only the server path works ([01 §3](01-architecture.md#3-control-paths)). |
| A4 | The iPhones that use Apple Home are on the same WiFi as their lamp. | Without a hub, Apple Home can't reach the lamp from elsewhere. Use the web app. |
| A5 | Both lamps can reach Cloudflare over HTTPS on port 443, and the server machine stays on. | A network that blocks outbound 443 also blocks linking. While the server machine is off, the lamps work locally only. |
| A6 | Users are a handful of trusted people who share one password. | Untrusted users would need per-person accounts and per-device permissions ([05](05-server.md)). |
| A7 | This is a non-commercial project. | The open-source HomeKit SDK is licensed for non-commercial use only. A product would need Apple's MFi program. |

## Open questions

1. **Domain name.** Cloudflare Tunnel needs a domain whose DNS is on Cloudflare. Which domain, and which hostname (for example `lamps.<your-domain>`)? See [05 §13](05-server.md#13-deployment).
2. **Color order** of the strip. Not published; the bring-up test finds it ([02 §7](02-hardware.md#7-bring-up-checklist)).

## Glossary

- **Lamp / device**: one XIAO ESP32-C3 plus strip, running DoubleLamp firmware.
- **Pixel**: one WS2811 IC and the 62.5 mm segment of 36 LEDs it drives.
- **State**: what a lamp shows: power, brightness, colors and effect ([04 §2](04-protocol.md#2-data-model)).
- **Local control**: a phone talking to a lamp directly, over the LAN or the lamp's own access point. Includes Apple Home.
- **HAP**: HomeKit Accessory Protocol, which the Home app uses to talk to the lamp over the LAN.
- **Server control**: browser → server → lamp, over the internet.
- **Link group**: a set of lamps that share one state. v1 has a single group holding both lamps. Setting `linked: false` makes them independent.
- **Sync clock**: the server's clock. Each lamp estimates it and uses it to time changes and keep animations in phase.
- **`apply_at`**: the sync-clock time at which a lamp starts applying a change. Linked lamps use it to change at the same moment.
- **Effect epoch**: the sync-clock time when an effect started. Effect output is a pure function of *(params, now − epoch, pixel position)*.

## Why not WLED?

[WLED](https://kno.wled.ge) runs on the ESP32-C3, drives this strip and already covers most of goal 1. However:
- its built-in lamp-to-lamp sync is UDP on one LAN, and it would not keep animations phase-locked across two homes;
- remote control would still need MQTT plus a custom app;
- it has no native Apple Home support, and getting one needs a bridge such as Homebridge or Home Assistant, which is the hub this design avoids.

Writing our own firmware gives one protocol and one state model end to end. WLED remains a fallback: it can drive the same hardware with no wiring changes.
