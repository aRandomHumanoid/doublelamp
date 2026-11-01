// 1:1 port of firmware/components/effects/math8.cpp. Integer-only, bit-exact with the lamps.
// Values that can exceed 2^31 are handled with Math.floor / % instead of bit operators.

export type RGB = [number, number, number];

const QUARTER_SINE = [
  0, 804, 1608, 2410, 3212, 4011, 4808, 5602, 6393, 7179, 7962, 8739, 9512, 10278, 11039, 11793, 12539, 13279,
  14010, 14732, 15446, 16151, 16846, 17530, 18204, 18868, 19519, 20159, 20787, 21403, 22005, 22594, 23170, 23731,
  24279, 24811, 25329, 25832, 26319, 26790, 27245, 27683, 28105, 28510, 28898, 29268, 29621, 29956, 30273, 30571,
  30852, 31113, 31356, 31580, 31785, 31971, 32137, 32285, 32412, 32521, 32609, 32678, 32728, 32757, 32767,
];

/** sin(theta · 2π / 65536) × 32767. theta is taken mod 65536. */
export function sin16(theta: number): number {
  theta &= 0xffff;
  const quadrant = theta >> 14;
  let p = theta & 0x3fff;
  if (quadrant & 1) p = 16384 - p;
  const idx = p >> 8;
  const frac = p & 0xff;
  let v: number;
  if (idx >= 64) v = QUARTER_SINE[64]!;
  else {
    const a = QUARTER_SINE[idx]!;
    const d = QUARTER_SINE[idx + 1]! - a;
    v = a + ((d * frac) >> 8);
  }
  return quadrant >= 2 ? -v : v;
}

export function lerp8(a: number, b: number, f: number): number {
  return Math.floor((a * (255 - f) + b * f + 127) / 255);
}

export function scale8(c: number, s: number): number {
  return Math.floor((c * s + 127) / 255);
}

export function lerpRgb(a: RGB, b: RGB, f: number): RGB {
  return [lerp8(a[0], b[0], f), lerp8(a[1], b[1], f), lerp8(a[2], b[2], f)];
}

export function scaleRgb(c: RGB, s: number): RGB {
  return [scale8(c[0], s), scale8(c[1], s), scale8(c[2], s)];
}

export function hsv16(h: number, s: number, v: number): RGB {
  const h6 = (h & 0xffff) * 6;
  const region = h6 >> 16;
  const rem = (h6 >> 8) & 0xff;
  const p = Math.floor((v * (255 - s) + 127) / 255);
  const q = Math.floor((v * (255 - Math.floor((s * rem + 127) / 255)) + 127) / 255);
  const t = Math.floor((v * (255 - Math.floor((s * (255 - rem) + 127) / 255)) + 127) / 255);
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

function mix32(x: number): number {
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}

/** Counter-based hash; arguments are taken mod 2^32. */
export function hash32(seed: number, a: number, b: number): number {
  let h = mix32((seed ^ 0x9e3779b9) >>> 0);
  h = mix32((h ^ (a >>> 0)) >>> 0);
  h = mix32((h ^ (b >>> 0)) >>> 0);
  return h;
}

export function posQ16(i: number, n: number): number {
  return Math.floor(((2 * i + 1) * 65536) / (2 * n));
}

export function periodMs(speed: number, slowMs: number, fastMs: number): number {
  return slowMs - Math.floor((speed * (slowMs - fastMs)) / 255);
}

export function phase16(t: number, period: number): number {
  return Math.floor(((t % period) * 65536) / period);
}

export function parseHex(s: string): RGB {
  const h = s.replace(/^#/, "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

export function formatHex(c: RGB): string {
  return "#" + c.map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase();
}
