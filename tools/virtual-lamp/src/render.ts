// One refreshing terminal status line: the strip as truecolor blocks, rendered with the real effect code.
import { renderPreview, type RGB } from "@doublelamp/effects";
import { parseHex } from "@doublelamp/effects";
import type { VirtualLamp } from "./lamp";

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";

function block([r, g, b]: RGB): string {
  return `\x1b[38;2;${r};${g};${b}m██`;
}

/** Pixel colors as they'd appear now, including identify / nudge overlays. */
export function stripPixels(lamp: VirtualLamp, now = lamp.syncNow()): RGB[] {
  const n = Math.max(1, Math.min(lamp.pixels, 64));
  const o = lamp.overlay;
  if (o && performance.now() < o.until) {
    const on = Math.floor(performance.now() / (o.kind === "identify" ? 250 : 350)) % 2 === 0;
    const c = on ? parseHex(o.color) : ([0, 0, 0] as RGB);
    return Array.from({ length: n }, () => c);
  }
  return renderPreview(lamp.visible, now, n);
}

export function statusLine(lamp: VirtualLamp, color: boolean): string {
  const s = lamp.visible;
  const strip = color ? stripPixels(lamp).map(block).join("") + RESET : "";
  const linked = lamp.link?.linked ? ` ⛓ ${lamp.link.name}` : "";
  const state = `${s.on ? "on " : "off"} ${String(Math.round((s.brightness / 255) * 100)).padStart(3)}% ${s.colors.join(",")} ${s.effect.id}`;
  const status = lamp.status === "online" ? "\x1b[32monline\x1b[0m" : `\x1b[33m${lamp.status}\x1b[0m`;
  const ctl = `${DIM}[o]n/off [+/-] [c]olor [e]ffect [x] net [q]uit${RESET}`;
  return `${lamp.name} ${color ? status : lamp.status} ${strip} ${state}${linked} fw ${lamp.firmware}  ${ctl}`;
}
