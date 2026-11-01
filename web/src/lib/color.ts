// Color helpers: hex ↔ RGB ↔ HSL, Kelvin → sRGB for the white slider, WCAG contrast for the accent,
// and spoken color names for screen readers (06 A.5).

export type RGB = [number, number, number];

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
const to8 = (v: number): number => clamp(Math.round(v), 0, 255);

export function hexToRgb(hex: string): RGB {
  const h = hex.replace(/^#/, "");
  const full = h.length === 3 ? h.replace(/./g, (c) => c + c) : h.slice(0, 6);
  const n = parseInt(full, 16);
  if (Number.isNaN(n)) return [0, 0, 0];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex(c: readonly number[]): string {
  return "#" + [c[0] ?? 0, c[1] ?? 0, c[2] ?? 0].map((v) => to8(v).toString(16).padStart(2, "0")).join("").toUpperCase();
}

// ------------------------------------------------------------------ white temperature

export const KELVIN_MIN = 2200;
export const KELVIN_MAX = 6500;
export const KELVIN_STEP = 50;

/** Black-body color temperature → sRGB (Tanner Helland's fit, good to ±1 % in 1000–40000 K). */
export function kelvinToRgb(kelvin: number): RGB {
  const t = clamp(kelvin, 1000, 40000) / 100;
  let r: number;
  let g: number;
  let b: number;
  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
    b = t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  } else {
    r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
    b = 255;
  }
  return [to8(r), to8(g), to8(b)];
}

export const kelvinToHex = (kelvin: number): string => rgbToHex(kelvinToRgb(kelvin));

/** The white-slider position for a color, or null if the color isn't (close to) a white in range. */
export function nearestKelvin(hex: string, tolerance = 8): number | null {
  const c = hexToRgb(hex);
  let best = KELVIN_MIN;
  let bestD = Infinity;
  for (let k = KELVIN_MIN; k <= KELVIN_MAX; k += KELVIN_STEP) {
    const w = kelvinToRgb(k);
    const d = Math.max(Math.abs(w[0] - c[0]), Math.abs(w[1] - c[1]), Math.abs(w[2] - c[2]));
    if (d < bestD) {
      bestD = d;
      best = k;
    }
  }
  return bestD <= tolerance ? best : null;
}

// ------------------------------------------------------------------ contrast (WCAG 2.x)

function linear(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function luminance(c: readonly number[]): number {
  return 0.2126 * linear(c[0] ?? 0) + 0.7152 * linear(c[1] ?? 0) + 0.0722 * linear(c[2] ?? 0);
}

export function contrastRatio(a: readonly number[], b: readonly number[]): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export function rgbToHsl(c: readonly number[]): [number, number, number] {
  const r = (c[0] ?? 0) / 255;
  const g = (c[1] ?? 0) / 255;
  const b = (c[2] ?? 0) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

export function hslToRgb(h: number, s: number, l: number): RGB {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r, g, b] =
    hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x] : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
  const m = l - c / 2;
  return [to8((r + m) * 255), to8((g + m) * 255), to8((b + m) * 255)];
}

export type Theme = "dark" | "light";

/** The theme surfaces accent-colored text and outlines can sit on (must match styles.css). */
const SURFACES: Record<Theme, RGB[]> = {
  dark: [
    [0x0e, 0x0f, 0x13],
    [0x17, 0x19, 0x1f],
    [0x1f, 0x22, 0x2a],
    [0x28, 0x2c, 0x36],
  ],
  light: [
    [0xff, 0xff, 0xff],
    [0xf5, 0xf5, 0xf2],
    [0xef, 0xee, 0xe9],
    [0xe4, 0xe3, 0xdd],
  ],
};

const worstContrast = (c: RGB, theme: Theme): number => Math.min(...SURFACES[theme].map((s) => contrastRatio(c, s)));

/**
 * The UI accent for a lamp color: same hue and saturation, lightness moved until it has at least
 * `min`:1 contrast with every theme surface (WCAG AA for text), plus the ink color to put on it.
 */
export function accentFor(hex: string, theme: Theme, min = 4.5): { accent: string; ink: string } {
  const [h, s, l0] = rgbToHsl(hexToRgb(hex));
  let l = l0;
  let rgb = hslToRgb(h, s, l);
  for (let i = 0; i < 120 && worstContrast(rgb, theme) < min; i++) {
    l = theme === "dark" ? Math.min(1, l + 0.01) : Math.max(0, l - 0.01);
    rgb = hslToRgb(h, s, l);
  }
  const ink = contrastRatio(rgb, [0, 0, 0]) >= contrastRatio(rgb, [255, 255, 255]) ? "#000000" : "#FFFFFF";
  return { accent: rgbToHex(rgb), ink };
}

// ------------------------------------------------------------------ spoken names

const NAMED: [string, string][] = [
  ["warm white", "#FFB46B"],
  ["candlelight", "#FF9329"],
  ["soft white", "#FFD6AA"],
  ["neutral white", "#FFF1E0"],
  ["cool white", "#E6EEFF"],
  ["white", "#FFFFFF"],
  ["red", "#FF0000"],
  ["crimson", "#DC143C"],
  ["coral", "#FF7F50"],
  ["salmon", "#FA8072"],
  ["orange", "#FF7A00"],
  ["amber", "#FFBF00"],
  ["gold", "#FFD700"],
  ["yellow", "#FFFF00"],
  ["lime", "#BFFF00"],
  ["green", "#00FF00"],
  ["forest green", "#228B22"],
  ["mint", "#98FF98"],
  ["teal", "#008080"],
  ["turquoise", "#40E0D0"],
  ["cyan", "#00FFFF"],
  ["sky blue", "#87CEEB"],
  ["azure", "#007FFF"],
  ["blue", "#0000FF"],
  ["navy", "#000080"],
  ["indigo", "#4B0082"],
  ["violet", "#8F00FF"],
  ["purple", "#800080"],
  ["lavender", "#B57EDC"],
  ["magenta", "#FF00FF"],
  ["hot pink", "#FF69B4"],
  ["pink", "#FFC0CB"],
  ["rose", "#FF007F"],
  ["brown", "#8B4513"],
  ["black", "#000000"],
];

function toLab(c: RGB): [number, number, number] {
  const r = linear(c[0]);
  const g = linear(c[1]);
  const b = linear(c[2]);
  const x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047;
  const y = r * 0.2126 + g * 0.7152 + b * 0.0722;
  const z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

let namedLab: { name: string; lab: [number, number, number] }[] | null = null;

/** The nearest of ~35 everyday color names (CIE76 distance in Lab), e.g. "warm white". */
export function colorName(hex: string): string {
  namedLab ??= NAMED.map(([name, h]) => ({ name, lab: toLab(hexToRgb(h)) }));
  const [l, a, b] = toLab(hexToRgb(hex));
  let best = namedLab[0]!;
  let bestD = Infinity;
  for (const n of namedLab) {
    const d = (n.lab[0] - l) ** 2 + (n.lab[1] - a) ** 2 + (n.lab[2] - b) ** 2;
    if (d < bestD) {
      bestD = d;
      best = n;
    }
  }
  return best.name;
}
