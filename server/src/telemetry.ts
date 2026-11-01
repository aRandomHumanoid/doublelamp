// Telemetry history: a 24-hour ring per lamp, in memory only (05 §5). The last value is also saved to `devices`.
import type { Telemetry } from "@doublelamp/protocol";

export const TELEMETRY_WINDOW_MS = 24 * 3600_000;
const MAX_POINTS = 2000;

export interface TelemetryPoint {
  ts: number;
  telemetry: Telemetry;
}

export class TelemetryRing {
  private readonly rings = new Map<string, TelemetryPoint[]>();

  constructor(private readonly windowMs = TELEMETRY_WINDOW_MS) {}

  add(deviceId: string, telemetry: Telemetry, now: number): void {
    const ring = this.rings.get(deviceId) ?? [];
    ring.push({ ts: now, telemetry });
    const cutoff = now - this.windowMs;
    while (ring.length && (ring[0]!.ts < cutoff || ring.length > MAX_POINTS)) ring.shift();
    this.rings.set(deviceId, ring);
  }

  history(deviceId: string): readonly TelemetryPoint[] {
    return this.rings.get(deviceId) ?? [];
  }

  remove(deviceId: string): void {
    this.rings.delete(deviceId);
  }
}
