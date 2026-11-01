// The TS effects must match the firmware's golden frames exactly (08 §1.2).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EFFECTS } from "@doublelamp/protocol";
import { formatHex, parseHex, renderEffect, RENDERERS } from "../src";

interface GoldenCase {
  effect: string;
  speed: number;
  intensity: number;
  seed: number;
  duration_ms: number;
  t: number;
  n: number;
  colors: string[];
  out: string[];
}

const file = fileURLToPath(new URL("../../protocol/test-vectors/effects/golden.json", import.meta.url));
const golden = JSON.parse(readFileSync(file, "utf8")) as { version: number; cases: GoldenCase[] };

describe("golden effect frames", () => {
  it("covers every effect in the catalog", () => {
    const ids = new Set(golden.cases.map((c) => c.effect));
    for (const e of EFFECTS) {
      expect(ids.has(e.id)).toBe(true);
      expect(RENDERERS[e.id]).toBeTypeOf("function");
    }
  });

  for (const id of new Set(golden.cases.map((c) => c.effect))) {
    it(`${id} matches the firmware bit for bit`, () => {
      const cases = golden.cases.filter((c) => c.effect === id);
      for (const c of cases) {
        const out = renderEffect(
          c.effect,
          { speed: c.speed, intensity: c.intensity, seed: c.seed, duration_ms: c.duration_ms, colors: c.colors.map(parseHex) },
          c.t,
          c.n,
        ).map(formatHex);
        if (out.join() !== c.out.join()) {
          expect({ case: { ...c, out: undefined }, out }).toEqual({ case: { ...c, out: undefined }, out: c.out });
        }
      }
    });
  }
});
