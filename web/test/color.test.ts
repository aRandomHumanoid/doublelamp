import { describe, expect, it } from "vitest";
import {
  KELVIN_MAX,
  KELVIN_MIN,
  accentFor,
  colorName,
  contrastRatio,
  hexToRgb,
  kelvinToHex,
  kelvinToRgb,
  nearestKelvin,
} from "../src/lib/color";
import { fromPercent, percent } from "../src/lib/format";

describe("kelvin → sRGB", () => {
  it("covers the 2200–6500 K slider from deep warm to near white", () => {
    expect(kelvinToHex(2200)).toBe("#FF9227");
    expect(kelvinToHex(6500)).toBe("#FFFEFA");
    let lastBlue = -1;
    for (let k = KELVIN_MIN; k <= KELVIN_MAX; k += 100) {
      const [r, g, b] = kelvinToRgb(k);
      expect(r).toBe(255);
      expect(g).toBeGreaterThan(140);
      expect(b).toBeGreaterThan(lastBlue);
      lastBlue = b;
    }
  });

  it("finds the slider position of a white, and none for a saturated color", () => {
    for (const k of [2200, 2700, 3000, 4000, 5000, 6500]) {
      expect(Math.abs((nearestKelvin(kelvinToHex(k)) ?? 0) - k)).toBeLessThanOrEqual(50);
    }
    expect(nearestKelvin("#FFB46B")).not.toBeNull(); // the default warm white is ~3000 K
    expect(nearestKelvin("#2F6BFF")).toBeNull();
  });
});

describe("spoken color names", () => {
  it("names common lamp colors", () => {
    expect(colorName("#FFB46B")).toBe("warm white");
    expect(colorName("#FF0000")).toBe("red");
    expect(colorName("#00FF00")).toBe("green");
    expect(colorName("#0000FF")).toBe("blue");
    expect(colorName("#FFFFFF")).toBe("white");
    expect(colorName("#7A2BFF")).toMatch(/violet|purple|indigo/);
  });
});

describe("accent contrast", () => {
  const DARK = ["#0E0F13", "#17191F", "#1F222A", "#282C36"];
  const LIGHT = ["#FFFFFF", "#F5F5F2", "#EFEEE9", "#E4E3DD"];
  it.each(["#0000FF", "#FFB46B", "#000000", "#7A2BFF", "#FF0000"])("%s meets AA on every dark surface", (hex) => {
    const { accent } = accentFor(hex, "dark");
    for (const bg of DARK) expect(contrastRatio(hexToRgb(accent), hexToRgb(bg))).toBeGreaterThanOrEqual(4.5);
  });
  it.each(["#FFFF00", "#FFB46B", "#FFFFFF", "#00FF00"])("%s meets AA on every light surface", (hex) => {
    const { accent } = accentFor(hex, "light");
    for (const bg of LIGHT) expect(contrastRatio(hexToRgb(accent), hexToRgb(bg))).toBeGreaterThanOrEqual(4.5);
  });
  it("picks a readable ink for text on the accent", () => {
    const { accent, ink } = accentFor("#FFB46B", "dark");
    expect(contrastRatio(hexToRgb(accent), hexToRgb(ink))).toBeGreaterThanOrEqual(4.5);
  });
  it("computes WCAG ratios", () => {
    expect(contrastRatio([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 5);
  });
});

describe("brightness percent", () => {
  it("round-trips every percent like the lamp's Apple Home mapping (03 §11)", () => {
    for (let p = 0; p <= 100; p++) expect(percent(fromPercent(p))).toBe(p);
    expect(percent(128)).toBe(50);
  });
});
