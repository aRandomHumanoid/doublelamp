// Color math. hsv16 is a 1:1 copy of firmware/components/effects/math8.cpp (integer only), so a
// color picked on the wheel is exactly what the lamp computes for the same hue and saturation.

export type RGB = [number, number, number];

/** Integer HSV: h 0–65535 is one turn of the hue wheel, s and v 0–255. */
export function hsv16(h: number, s: number, v: number): RGB {
  const h6 = (h & 0xffff) * 6;
  const region = h6 >> 16;
  const rem = (h6 >> 8) & 0xff;
  const p = ((v * (255 - s) + 127) / 255) | 0;
  const q = ((v * (255 - (((s * rem + 127) / 255) | 0)) + 127) / 255) | 0;
  const t = ((v * (255 - (((s * (255 - rem) + 127) / 255) | 0)) + 127) / 255) | 0;
  switch (region) {
    case 0:
      return [v, t, p];
    case 1:
      return [q, v, p];
    case 2:
      return [p, v, t];
    case 3:
      return [p, q, v];
    case 4:
      return [t, p, v];
    default:
      return [v, p, q];
  }
}

/** Inverse of hsv16, for placing the wheel marker: [h 0–65535, s 0–255, v 0–255]. */
export function rgbToHsv16(c: RGB): RGB {
  const [r, g, b] = c;
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  let h = 0;
  if (d) {
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
  }
  return [Math.round((h / 6) * 65536) & 0xffff, max ? Math.round((d * 255) / max) : 0, max];
}

export function parseHex(s: string): RGB {
  const x = /^#?([0-9a-f]{6})$/i.exec(s || "");
  const n = x ? parseInt(x[1]!, 16) : 0xffb46b;
  return [n >> 16, (n >> 8) & 255, n & 255];
}

export function toHex(c: RGB): string {
  return "#" + (((1 << 24) | (c[0] << 16) | (c[1] << 8) | c[2]) >>> 0).toString(16).slice(1).toUpperCase();
}

export function normHex(s: string): string {
  return toHex(parseHex(s));
}

/** Linear blend in 8-bit sRGB, like the firmware's lerp8 (f 0–255). */
export function mix(a: RGB, b: RGB, f: number): RGB {
  return [0, 1, 2].map((i) => ((a[i]! * (255 - f) + b[i]! * f + 127) / 255) | 0) as RGB;
}

/** Relative luminance 0–1 (WCAG). */
export function luminance(c: RGB): number {
  const l = c.map((v) => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * l[0]! + 0.7152 * l[1]! + 0.0722 * l[2]!;
}

/** Blends c toward target in steps until ok(c) holds. */
function shift(c: RGB, target: RGB, ok: (c: RGB) => boolean): RGB {
  for (let i = 0; i < 24 && !ok(c); i++) c = mix(c, target, 32);
  return c;
}

/**
 * The UI accent follows the lamp's color (06 design principle 3), adjusted until it has at least
 * 4.5:1 contrast with the page background: lightened on the dark theme, darkened on the light one.
 * Also returns the text color to put on top of each (black or white, whichever contrasts more).
 */
export function accents(hex: string): { dark: string; light: string; onDark: string; onLight: string } {
  let c = parseHex(hex);
  const max = Math.max(c[0], c[1], c[2]);
  if (max) c = c.map((v) => Math.round((v * 255) / max)) as RGB; // brightness is separate: use full value
  const dark = shift(c, [255, 255, 255], (x) => luminance(x) >= 0.25);
  const light = shift(c, [0, 0, 0], (x) => luminance(x) <= 0.16);
  const on = (x: RGB) => (luminance(x) > 0.179 ? "#111214" : "#FFFFFF");
  return { dark: toHex(dark), light: toHex(light), onDark: on(dark), onLight: on(light) };
}

const NAMES: Array<[number, string]> = [
  [12, "red"],
  [32, "orange"],
  [46, "amber"],
  [66, "yellow"],
  [95, "lime"],
  [150, "green"],
  [175, "teal"],
  [198, "cyan"],
  [222, "sky blue"],
  [252, "blue"],
  [272, "indigo"],
  [292, "violet"],
  [322, "purple"],
  [346, "pink"],
  [361, "red"],
];

/** A spoken name for screen readers ("warm white", "pale blue"…). */
export function colorName(hex: string): string {
  const [h16, s, v] = rgbToHsv16(parseHex(hex));
  const deg = (h16 * 360) / 65536;
  if (v < 40) return "black";
  if (s < 28) return "white";
  if (s < 150 && deg >= 15 && deg < 50) return "warm white";
  let name = "red";
  for (const [d, n] of NAMES) {
    if (deg < d) {
      name = n;
      break;
    }
  }
  return (s < 140 ? "pale " : "") + name;
}

export interface Swatch {
  hex: string;
  name: string;
}

/** Quick colors under the wheel. Warm white is the lamp's default (04 §2). */
export const SWATCHES: Swatch[] = [
  { hex: "#FFB46B", name: "Warm white" },
  { hex: "#FF8A3D", name: "Amber" },
  { hex: "#FFFFFF", name: "Cool white" },
  { hex: "#FF1E00", name: "Red" },
  { hex: "#FF5A00", name: "Orange" },
  { hex: "#FFC800", name: "Yellow" },
  { hex: "#3CFF28", name: "Green" },
  { hex: "#00FFB4", name: "Mint" },
  { hex: "#00B4FF", name: "Sky" },
  { hex: "#1E28FF", name: "Blue" },
  { hex: "#7A2BFF", name: "Violet" },
  { hex: "#FF2A8C", name: "Pink" },
];
