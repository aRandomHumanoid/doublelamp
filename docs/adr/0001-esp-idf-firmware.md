# ADR-0001: Build the firmware on ESP-IDF (C++17)

- **Status:** Accepted
- **Date:** 2026-10-28

## Context

The firmware has to do all of these at once on a single-core ESP32-C3 with no FPU and about 400 KB of RAM:

- drive a WS281x strip without glitches while WiFi is busy;
- serve an HTTP + WebSocket API and a captive portal;
- hold a TLS WebSocket connection to the server;
- run signed OTA updates with rollback.

Reliability under concurrent load matters more than how fast the first prototype comes together.

## Decision

Use **ESP-IDF v5.x** (version pinned) with C++17, built with `idf.py` (or the ESP-IDF VS Code extension), and pull extra pieces from the IDF Component Manager:

- `led_strip`, using its SPI-DMA backend
- `mdns`
- `esp_websocket_client`

## Alternatives considered

| Option | For | Against |
|---|---|---|
| **Arduino-ESP32 + PlatformIO** (FastLED or NeoPixelBus, ESPAsyncWebServer, WiFiManager) | Gentler learning curve; many examples | Libraries are maintained by different people and versioned separately. The async web server and WS libraries have a history of stability problems under load. LED timing on the C3 depends on how each library uses RMT. PlatformIO's support for current Arduino-ESP32 releases lags (it relies on a community fork). |
| **Arduino as an ESP-IDF component** | Arduino libraries plus IDF control | Two build systems' worth of complexity and a larger image, without needing any Arduino-only library |
| **ESPHome** | YAML config, Home Assistant integration, OTA | No custom server protocol, no phase-synced effects across homes, little control over the local UI |
| **WLED** | Finished product; supports the ESP32-C3 | Sync is LAN UDP only. Its UI and data model aren't ours. Getting cross-home phase sync would mean forking it ([README](../README.md#why-not-wled)). |

## Consequences

- **Good:** Espressif maintains, releases and tests every critical part together:
  - LED SPI-DMA driver
  - `esp_http_server` with WebSocket support
  - `esp_https_ota` with app rollback and signed-image checks
  - NVS
  - certificate bundle
  - core dumps
- **Good:** FreeRTOS task priorities are directly under our control, which is how render smoothness is guaranteed ([03 §3](../03-firmware.md#3-tasks-and-priorities)).
- **Cost:** more code than Arduino for setup work such as WiFi events and the HTTP route table. This is offset by keeping the pure logic (`lamp_core`, `effects`) free of IDF headers and unit-testing it on the host.
- **Cost:** the ESP-IDF version has to be pinned and upgraded on purpose. CI builds inside the pinned `espressif/idf` container.
