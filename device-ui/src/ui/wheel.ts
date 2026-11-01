// Hue/saturation wheel on a canvas. Each pixel is colored with hsv16 (integer math identical to the
// firmware), V = 255 because brightness is a separate control (same model as Apple Home, 03 §11).
import { colorName, hsv16, parseHex, rgbToHsv16, toHex } from "../lib/color";
import { h } from "../lib/dom";
import { onDrag } from "./drag";
import type { Phase } from "./slider";

export interface Wheel {
  el: HTMLElement;
  set(hex: string): void;
  redraw(): void;
  readonly dragging: boolean;
}

export function colorWheel(onPick: (hex: string, phase: Phase) => void): Wheel {
  const canvas = h("canvas", { class: "wheel-c", "aria-hidden": "true" });
  const dot = h("span", { class: "wheel-dot", "aria-hidden": "true" });
  const el = h(
    "div",
    {
      class: "wheel",
      role: "slider",
      tabindex: 0,
      "aria-label": "Color wheel. Left and right change the hue, up and down the saturation.",
      "aria-valuemin": 0,
      "aria-valuemax": 359,
    },
    canvas,
    dot,
  );
  let hue = 0; // 0–65535
  let sat = 0; // 0–255
  let hex = "";
  let sent = "";
  let dragging = false;
  let moved = false;
  let start: [number, number, string] = [0, 0, hex];
  let sx = 0;
  let sy = 0;
  let drawnAt = 0;

  function draw() {
    const css = el.clientWidth;
    if (!css) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const n = Math.round(css * dpr);
    if (n === drawnAt) return;
    drawnAt = n;
    canvas.width = canvas.height = n;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const img = ctx.createImageData(n, n);
    const d = img.data;
    const c = n / 2;
    const R = c - 1;
    const TAU = Math.PI * 2;
    for (let y = 0; y < n; y++) {
      const dy = y + 0.5 - c;
      for (let x = 0; x < n; x++) {
        const dx = x + 0.5 - c;
        const r = Math.sqrt(dx * dx + dy * dy);
        if (r > R + 1) continue;
        // hue 0 (red) at the top, increasing clockwise
        let a = Math.atan2(dx, -dy);
        if (a < 0) a += TAU;
        const rgb = hsv16(Math.round((a / TAU) * 65536) & 0xffff, Math.min(255, Math.round((r / R) * 255)), 255);
        const i = (y * n + x) * 4;
        d[i] = rgb[0];
        d[i + 1] = rgb[1];
        d[i + 2] = rgb[2];
        d[i + 3] = r > R ? Math.round((R + 1 - r) * 255) : 255; // anti-aliased edge
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  function place() {
    const a = (hue / 65536) * Math.PI * 2;
    const f = sat / 255;
    dot.style.left = 50 + Math.sin(a) * f * 50 + "%";
    dot.style.top = 50 - Math.cos(a) * f * 50 + "%";
    dot.style.background = hex;
    el.setAttribute("aria-valuenow", String(Math.round((hue * 360) / 65536)));
    el.setAttribute("aria-valuetext", colorName(hex) + ", " + hex);
  }

  function pickAt(x: number, y: number) {
    const r = el.getBoundingClientRect();
    const R = r.width / 2;
    const dx = x - r.left - R;
    const dy = y - r.top - R;
    let a = Math.atan2(dx, -dy);
    if (a < 0) a += Math.PI * 2;
    hue = Math.round((a / (Math.PI * 2)) * 65536) & 0xffff;
    sat = Math.min(255, Math.round((Math.sqrt(dx * dx + dy * dy) / R) * 255));
    hex = toHex(hsv16(hue, sat, 255));
    place();
  }

  onDrag(el, {
    start(x, y) {
      dragging = true;
      moved = false;
      start = [hue, sat, hex];
      sent = hex;
      sx = x;
      sy = y;
      pickAt(x, y);
    },
    move(x, y) {
      if (!dragging) return;
      if (!moved && Math.abs(x - sx) + Math.abs(y - sy) < 4) return;
      moved = true;
      pickAt(x, y);
      if (hex !== sent) {
        sent = hex;
        onPick(hex, "drag");
      }
    },
    end(cancelled) {
      if (!dragging) return;
      dragging = false;
      if (cancelled && !moved) {
        [hue, sat, hex] = start;
        place();
        return;
      }
      onPick(hex, moved ? "end" : "tap");
    },
  });

  el.addEventListener("keydown", (e) => {
    let dh = 0;
    let ds = 0;
    if (e.key === "ArrowLeft") dh = -1;
    else if (e.key === "ArrowRight") dh = 1;
    else if (e.key === "ArrowUp") ds = 16;
    else if (e.key === "ArrowDown") ds = -16;
    else return;
    e.preventDefault();
    hue = (hue + dh * 1365 + 65536) & 0xffff; // 1/48 turn
    sat = Math.max(0, Math.min(255, sat + ds));
    hex = toHex(hsv16(hue, sat, 255));
    place();
    onPick(hex, e.repeat ? "drag" : "tap");
  });

  let rt = 0;
  window.addEventListener("resize", () => {
    clearTimeout(rt);
    rt = window.setTimeout(draw, 150);
  });

  return {
    el,
    set(v: string) {
      if (!drawnAt) requestAnimationFrame(draw);
      if (dragging || v === hex) return;
      hex = v;
      const hsv = rgbToHsv16(parseHex(v));
      hue = hsv[0];
      sat = hsv[1];
      place();
    },
    redraw: draw,
    get dragging() {
      return dragging;
    },
  };
}
