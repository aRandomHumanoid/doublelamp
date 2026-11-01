# ADR-0004: Apple Home through native HomeKit (HAP over IP), not Matter

- **Status:** Accepted
- **Date:** 2026-10-28

## Context

Each lamp should show up in Apple Home and be controllable from the Home app and Siri. The requirements are:

- **Direct connection.** The iPhone talks to the lamp itself.
- **No hub needed.** Neither household needs a HomePod or Apple TV as a home hub, or a bridge such as Homebridge or Home Assistant.
- **Different homes.** The two lamps are in different homes on different networks, and the server is on a third network. Each lamp therefore joins the Apple Home of the household it sits in.

The firmware already runs on ESP-IDF on a 4 MB ESP32-C3, next to an HTTP server, a TLS WebSocket client and OTA ([ADR-0001](0001-esp-idf-firmware.md)).

## Decision

Each lamp is a **native HomeKit accessory using HAP over IP**. It is built with Espressif's open-source **`esp-homekit-sdk`** (the non-MFi variant) and runs on the lamp next to the local API. It exposes one Lightbulb service: On, Brightness, Hue, Saturation and Identify. HomeKit becomes one more input to the state task, with `origin = HomeKit`, so linking, the server and the other UIs need no special cases. Details are in [03 §11](../03-firmware.md#11-apple-home-homekit).

## Alternatives considered

| Option | For | Against |
|---|---|---|
| **Matter over WiFi** (esp-matter) | The current standard. One integration would also reach Google Home and Alexa. | **Apple Home requires a home hub for Matter accessories**, which rules it out. It's also large: on a 4 MB C3 next to TLS, HTTP and OTA it would take most of an OTA slot. |
| **Bridge on the server** (HAP-NodeJS or Homebridge in the server process) | No firmware work. The bridge could expose effects and presets as extra switches. | HAP is LAN-only and the server is on a third network, so iPhones in the two homes would never see it |
| **A Homebridge or Home Assistant box in each home** | Mature. Could expose more features. | A hub by another name. Two extra machines to run. Explicitly not wanted. |
| **HomeSpan** (Arduino HomeKit library) | Pleasant API, well documented | Arduino framework, which [ADR-0001](0001-esp-idf-firmware.md) rejected. Mixing it in brings back the Arduino-as-component costs. |
| **MFi-certified HomeKit** | No "Uncertified Accessory" warning. WiFi setup from the Home app. | Needs an Apple MFi license and authentication hardware or tokens. Not available for a hobby build. |

## Consequences

- **Good:** works with only an iPhone on the same WiFi. Pairing and sessions are encrypted end to end (Ed25519, ChaCha20-Poly1305), which is better protection than the lamp's plain-HTTP local API.
- **Good:** if a household later adds a home hub, Apple Home remote access and automations start working with no firmware change.
- **Cost:** the Home app shows **"Uncertified Accessory"** while adding the lamp, and the user taps **Add Anyway**. The open-source SDK is for **non-commercial use** only, which fits this project.
- **Cost:** Apple Home only offers what a Lightbulb has: power, brightness and color. Effects, presets and linking stay in the lamp UI and the web app. Color temperature is deferred to the stretch milestone.
- **Cost:** flash, RAM and sockets. The HAP server needs its own `esp_http_server` instance (12 KB stack by default, 4 sockets as configured), pairing keys in NVS, and roughly a few hundred KB of flash. The M0 footprint spike measures this before anything depends on it ([08](../08-testing-and-roadmap.md#part-2-roadmap)).
- **Cost:** HAP needs mDNS and device-to-device traffic on the LAN. Networks that block devices from each other (dorms, hotels) can't use Apple Home. The web app still works there.
- **Cost:** the SDK's release cadence has to be followed. IDF and the SDK are pinned and upgraded together.
- **Not ruled out:** Matter can be revisited if a hub is ever acceptable. HAP and Matter can't easily share the C3's flash, so it would replace HAP rather than sit next to it.
