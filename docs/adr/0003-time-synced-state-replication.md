# ADR-0003: Sync lamps by sharing state and a clock, not frames

- **Status:** Accepted
- **Date:** 2026-10-28

## Context

"Linked" lamps have to look the same, including animations, even when they're in different homes on ordinary internet with 20–200 ms of latency and jitter. Each lamp must also keep working on its own when the server is unreachable. Changes can come from several places at once: the web app, either lamp's local UI, and either button.

## Decision

1. **Replicate the state, not the pixels.** Lamps receive a small `LampState` (power, brightness, colors, effect parameters) and render it themselves.
2. **Effects are pure functions of time.** Output is `f(params, now − epoch, normalized pixel position)`, with randomness from a seeded counter-based hash. Two lamps with the same state and clock render the same thing, whatever their pixel counts.
3. **A shared clock.** Every lamp and browser estimates the server's clock with NTP-style ping/pong over its WebSocket ([03 §12](../03-firmware.md#12-time-sync)).
4. **Scheduled application.** For linked changes, the server sets `apply_at` just past the slowest member's measured delay. Every lamp starts its transition at that moment. Effect `epoch` is set to `apply_at`, so phases line up.
5. **The server decides the order while connected.** It timestamps each accepted change per field and sends the full state to every member, including the sender. This guarantees all lamps end up identical.
6. **Offline edits report their age.** A reconnecting lamp reports the age of fields it changed while offline, measured on its monotonic clock. The server merges per field, and the newest change wins. A field with unknown age loses to the server ([04 §6](../04-protocol.md#6-merge-rules)).

## Alternatives considered

| Option | Why rejected |
|---|---|
| **Stream frames from the server** (DDP/E1.31-style over the internet) | About 45 KB/s per lamp at 300 px × 50 fps. Internet jitter shows up as visible stutter. Lamps go dark or freeze when the server drops. |
| **Peer-to-peer between lamps** (LAN UDP like WLED, or WebRTC) | LAN UDP doesn't cross homes. WebRTC on the C3 is heavy and still needs a signaling server, so there's no gain. |
| **Lamp-owned state, server only relays** | Without one authority deciding order, two simultaneous edits can leave the lamps different. Fixing that means vector clocks on the lamps. |
| **Full CRDTs with hybrid logical clocks on every lamp** | Correct, but more firmware complexity than two lamps need. Server ordering plus age-stamped offline edits gets the same result in our setup. |
| **Wall-clock timestamps for offline edits** | Wrong after a reboot without internet (the lamp has no valid time). Ages on the monotonic clock avoid needing a wall clock at all. |

## Consequences

- **Good:** bandwidth is tiny. Sync quality depends on clock-estimate error (typically 5–30 ms) rather than network jitter. Each lamp keeps running if the server disappears.
- **Good:** the browser preview is exact, because it runs the same effect math on the same clock.
- **Cost:** effects must stay deterministic. No state from frame to frame, integer math only, and identical C++ and TypeScript versions. Golden vectors in CI enforce this ([08 §1.2](../08-testing-and-roadmap.md#12-golden-vectors-keep-three-implementations-identical)).
- **Cost:** a change made on a lamp's own UI shows on the partner about one round trip later. A change from the web app shows on both at once. This is accepted, because local control must feel instant.
- **Cost:** a lamp whose clock estimate is poor (bad link) applies changes late but with the right phase. Once `apply_at` passes, the lamp applies changes as they arrive.
