// Small formatting helpers shared by the screens.
import { clamp } from "./color";

/** LampState brightness (0–255) → percent, the same mapping the lamp's Apple Home bridge uses (03 §11). */
export const percent = (b: number): number => Math.round((b * 100) / 255);
export const fromPercent = (p: number): number => Math.round((clamp(p, 0, 100) * 255) / 100);

export function cls(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

export function capitalize(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

export function timeAgo(ts: number | null | undefined, now = Date.now()): string {
  if (ts == null) return "never";
  const s = Math.round((now - ts) / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} h ago`;
  const d = Math.round(h / 24);
  return `${d} d ago`;
}

export function formatDateTime(ts: number): string {
  return new Date(ts).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function formatUptime(s: number): string {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d} d ${h} h`;
  if (h) return `${h} h ${m} min`;
  return `${m} min`;
}

/** Compares dotted versions ("1.10.0" > "1.9.2"); pre-release suffixes sort before the release. */
export function compareVersions(a: string, b: string): number {
  const split = (v: string) => {
    const [core = "", pre] = v.replace(/^v/, "").split("-", 2);
    return { nums: core.split(".").map((x) => parseInt(x, 10) || 0), pre };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d) return d;
  }
  if (x.pre && !y.pre) return -1;
  if (!x.pre && y.pre) return 1;
  return (x.pre ?? "").localeCompare(y.pre ?? "");
}

/** Signal quality for an RSSI in dBm. */
export function signal(rssi: number): { bars: 1 | 2 | 3 | 4; label: string } {
  if (rssi >= -55) return { bars: 4, label: "excellent" };
  if (rssi >= -67) return { bars: 3, label: "good" };
  if (rssi >= -75) return { bars: 2, label: "fair" };
  return { bars: 1, label: "weak" };
}
