# ADR-0002: Lamps talk to the server over WebSocket + JSON

- **Status:** Accepted
- **Date:** 2026-10-28

## Context

The lamps sit behind home NAT routers, possibly in different homes, so they must connect *out* to the server. Server → lamp commands need low latency, around 100 ms. The link also carries time-sync pings, OTA control and telemetry. Browsers need the same live state, and only two lamps are involved.

## Decision

Each lamp keeps **one persistent WebSocket over TLS** (`wss://…/ws/device`). Messages are **JSON**, one per frame, with the envelope and catalog in [04 §4](../04-protocol.md#4-lamp--server-websocket). Browsers use the same server process on `/ws/client`.

## Alternatives considered

| Option | For | Against |
|---|---|---|
| **MQTT** (Mosquitto + esp-mqtt) | The standard IoT choice. QoS, retained messages, last-will for presence. Home Assistant speaks it. | One more service to run, secure and monitor. Browsers would need MQTT-over-WS, or the app server would have to bridge it anyway. The ordering and merge logic would still live in our server. Retained messages fit poorly with our "server orders and stamps changes" model. |
| **HTTP polling / long-poll** | Simplest to proxy | Polling costs either latency or traffic. There's no server push, so `apply_at` timing is worse. |
| **CoAP / custom UDP** | Lowest overhead | Needs NAT keepalives. Reliability and security (DTLS) would be ours to build. Many networks and proxies block or rate-limit UDP. |
| **Binary encoding** (CBOR / protobuf) | Smaller messages | Messages are already < 1 KB. JSON is easy to debug with browser devtools and `websocat`, and cJSON is already in IDF. |

## Consequences

- **Good:** one port (443) works through Caddy, Cloudflare Tunnel and most firewalls. There's one server process and one way of authenticating.
- **Good:** lamps, browsers and the virtual lamp share the same schemas and test vectors.
- **Cost:** we implement acknowledgments, heartbeats, reconnect backoff and per-connection message merging ourselves, where MQTT would have given us some of that. The protocol is small, so this is acceptable.
- **Later:** if Home Assistant support is wanted, an **MQTT bridge** in the server can publish HA-discovery topics without changing the lamps (roadmap M5).
