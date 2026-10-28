# DoubleLamp: Design Docs

DoubleLamp is a pair of WiFi lamps. Each one is a Seeed XIAO ESP32-C3 driving a 3-wire addressable COB LED strip from pin **D5**.

- **On its own**, each lamp works like a smart-home light. A phone controls it directly over WiFi, with no server, internet or app install needed.
- **With the server**, one web app controls both lamps. The lamps can also be **linked**: any change applies to both, and their animations stay in step, even when the lamps are in different homes.

## Documents

| Doc | Covers |
|---|---|
| [01 Architecture](01-architecture.md) | Components, deployment options, end-to-end flows, repo layout |
| [02 Hardware](02-hardware.md) | Pin map, wiring, level shifting, power, BOM, bring-up |
| [03 Firmware](03-firmware.md) | ESP-IDF tasks, state store, LED pipeline, effects, WiFi/setup, OTA |
| [04 Protocol](04-protocol.md) | State model, lamp local API, lamp↔server and browser↔server messages |
| [05 Server](05-server.md) | Server modules, sync engine, scheduler, database, deployment |
| [06 Web apps](06-web-apps.md) | The server web app and the lamp's built-in UI |
| [07 Security](07-security.md) | Threat model, secrets, hardening |
| [08 Testing & roadmap](08-testing-and-roadmap.md) | Test strategy, milestones, risks |
| [ADRs](adr/) | Key decisions and the alternatives rejected |

## Goals

1. **Standalone smart light.** A phone on the same WiFi can control power, brightness, color, effects and presets. None of this depends on the server.
2. **Setup without an app.** First-time setup runs in the phone's browser through a captive portal.
3. **Linked pair.** When the lamps are linked, a change from any source applies to both. Sources are the web app, either lamp's built-in UI, and either lamp's button. Animations run in phase.
4. **Works across networks.** Lamps only make outbound connections. No port forwarding is needed, and the two lamps can be on different networks.
5. **Degrades gracefully.** Losing the internet or the server never turns a lamp off and never stops local control. The lamp catches up with the server when it reconnects.
6. **Maintainable.** OTA updates roll back automatically if they fail. A single protocol definition is shared by firmware, server and web apps. Everything except the LEDs can be tested without hardware by using a virtual lamp.

## Non-goals for v1

- Apple Home, Google Home or Matter integration. Nothing in the design rules it out (see the roadmap).
- Server-streamed per-pixel video and music-reactive effects.
- Native iOS or Android apps. Both web apps can be installed as PWAs instead.
- Hosting multiple households on one server. One server serves one household, or one pair of friends.
- Battery power.

## Assumptions

| # | Assumption | If it's wrong |
|---|---|---|
| A1 | "3-wire" means **V+, GND, DATA**: an addressable strip using the WS2812B/WS2811/SK6812 family protocol (800 kHz, one data line). | A 3-wire CCT strip (V+, warm, cool) needs two PWM pins and MOSFETs instead of a data line. That changes the LED driver and the color model ([02](02-hardware.md), [03](03-firmware.md)). |
| A2 | The strip runs on 5 V, 12 V or 24 V. | The firmware is the same for all three. Only the wiring changes. |
| A3 | Each lamp has at most 1024 *addressable pixels*. On WS2811 COB strips, one pixel is one IC driving a segment of LEDs, not one LED. | Larger counts lower the frame rate ([03 §5](03-firmware.md#5-led-output-pipeline)). |
| A4 | Each lamp has a 2.4 GHz WPA2/WPA3-Personal network to join. | WPA2-Enterprise (campus WiFi) is a stretch goal. On networks with web logins, or networks that block devices from seeing each other, use the lamp's own access point or the server path ([01 §3](01-architecture.md#3-control-paths)). |
| A5 | Both lamps can reach the server over HTTPS. The server can be a small VPS or a home machine behind a tunnel. | If both lamps are on the same LAN, a server on that LAN is enough. |
| A6 | Users are a handful of trusted people. | Untrusted users would need per-device permissions ([05](05-server.md)). |

## Glossary

- **Lamp / device**: one XIAO ESP32-C3 plus strip, running DoubleLamp firmware.
- **State**: what a lamp shows: power, brightness, colors and effect ([04 §2](04-protocol.md#2-data-model)).
- **Local control**: a phone talking to a lamp directly, over the LAN or the lamp's own access point.
- **Server control**: browser → server → lamp, over the internet.
- **Link group**: a set of lamps that share one state. v1 has a single group holding both lamps. Setting `linked: false` makes them independent.
- **Sync clock**: the server's clock. Each lamp estimates it and uses it to time changes and keep animations in phase.
- **`apply_at`**: the sync-clock time at which a lamp starts applying a change. Linked lamps use it to change at the same moment.
- **Effect epoch**: the sync-clock time when an effect started. Effect output is a pure function of *(params, now − epoch, pixel position)*.

## Open questions

1. What is the exact strip model, voltage and pixel count for each lamp? This decides the PSU, the level shifter and the default color order.
2. Will both lamps be in the same home, or in different homes? If they share a home, a server on the LAN is enough.
3. Where will the server run, and does it have a domain name?
4. Is Apple Home or Google Home control (Matter) wanted eventually? It affects the flash budget ([03 §14](03-firmware.md#14-ota-and-partitions)).
5. Should each person have their own login, or is one shared login enough?

## Why not WLED?

[WLED](https://kno.wled.ge) runs on the ESP32-C3 and already covers most of goal 1. However, its built-in lamp-to-lamp sync is UDP on one LAN. Remote control would still need MQTT plus a custom app, and it would not keep animations phase-locked across two homes. Writing our own firmware gives one protocol and one state model end to end. WLED remains a fallback: it can drive the same hardware with no wiring changes.
