// Settings → LEDs: every LedConfig field (04 §2) plus the bring-up test patterns (02 §7).
import type { DeviceInfo, LedConfig, TestPattern } from "@doublelamp/protocol/local";
import { ApiError, admin, errMsg } from "../lib/api";
import { fill, h } from "../lib/dom";
import { live } from "../live";
import { slider } from "../ui/slider";
import { btn, busy, card, errorBox, input, isCancel, note, select, spinner, toast, toggle } from "../ui/widgets";
import { POWER } from "./setup";

const ORDERS3 = ["RGB", "RBG", "GRB", "GBR", "BRG", "BGR"];
const ORDERS4 = ["GRBW", "RGBW"];

const TESTS: Array<[TestPattern, string, string, number]> = [
  [
    "color_order",
    "Color order",
    "Lights the first pixel red, then green, then blue. Pick the color order that spells what you saw: green, red, blue means GRB.",
    10000,
  ],
  [
    "last_pixel",
    "Last pixel",
    "Lights only pixel n − 1, the last one. It should be the final segment of the strip: if an earlier segment lights, the pixel count is too low; if nothing lights, it's too high. Save the pixel count first.",
    10000,
  ],
  ["white_25", "25 % white", "Lights every pixel at 25 % white for 30 s, to measure the current for Calibrate (under Power).", 30000],
];

export function ledsSection(body: HTMLElement, _info: DeviceInfo): void {
  const load = () => {
    fill(body, h("p", { class: "boot" }, spinner(), " Loading…"));
    admin<LedConfig>("GET", "/config").then(
      (cfg) => render(body, cfg),
      (e) => {
        if (isCancel(e)) {
          location.hash = "#settings";
          return;
        }
        fill(body, note(errMsg(e), "bad"), btn("Try again", { kind: "ghost", onclick: load }));
      },
    );
  };
  load();
}

function render(body: HTMLElement, cfg: LedConfig): void {
  const err = errorBox();
  const px = input({
    label: "Pixel count",
    type: "number",
    inputmode: "numeric",
    min: 1,
    max: 1024,
    value: cfg.pixel_count,
    hint: " ",
    oninput: () => lenHint(),
  });
  const lenHint = () => {
    const n = Number(px.input.value) || 0;
    const hint = px.el.querySelector(".hint");
    if (hint) hint.textContent = "16 per meter on this strip: " + n + " pixels = " + +((n / 16).toFixed(4)) + " m.";
  };
  lenHint();

  const orderSel = select("Color order", [], cfg.color_order, "Find it with the color order test below.");
  const fillOrders = (ch: number, cur: string) => {
    const list = ch === 4 ? ORDERS4 : ORDERS3;
    fill(
      orderSel.input,
      list.map((o) => h("option", { value: o, selected: o === cur }, o)),
    );
    orderSel.input.value = list.indexOf(cur) >= 0 ? cur : list[0]!;
  };
  const chSel = select(
    "Channels",
    [
      ["3", "3: RGB"],
      ["4", "4: RGBW"],
    ],
    String(cfg.channels),
    "This strip is RGB (3 channels).",
    (v) => fillOrders(Number(v), orderSel.input.value),
  );
  fillOrders(cfg.channels, cfg.color_order);

  const maxMa = input({
    label: "Current limit (mA)",
    type: "number",
    inputmode: "numeric",
    min: 100,
    max: 20000,
    value: cfg.max_current_ma,
    hint: "The lamp dims itself to stay under this. Use 80 % of the supply's rating minus 200 mA.",
  });
  const supplyChips = h(
    "div",
    { class: "chips" },
    POWER.map((p) =>
      h("button", { type: "button", class: "chip", onclick: () => (maxMa.input.value = String(p[2])) }, p[1] + " → " + p[2]),
    ),
  );

  const mapw = input({
    label: "mA per pixel at full white",
    type: "number",
    inputmode: "numeric",
    min: 1,
    max: 200,
    value: cfg.ma_per_pixel_white,
    hint: "42 for this strip (8 W/m ÷ 16 pixels/m ÷ 12 V).",
  });
  // Calibration helper (02 §5): measure at 25 % white, subtract the "off" current, × 4, ÷ pixels.
  const at25 = input({ label: "Current at 25 % white (mA)", type: "number", inputmode: "numeric" });
  const off = input({ label: "Current with the lamp off (mA)", type: "number", inputmode: "numeric" });
  const calOut = h("p", { class: "readout", "aria-live": "polite" });
  const calc = () => {
    const a = Number(at25.input.value);
    const o = Number(off.input.value) || 0;
    const n = Number(px.input.value) || cfg.pixel_count;
    const v = Math.round(((a - o) * 4) / n);
    if (a > o && v >= 1 && v <= 200) {
      fill(calOut, "≈ " + v + " mA per pixel ", btn("Use it", { kind: "ghost sm", onclick: () => (mapw.input.value = String(v)) }));
    } else fill(calOut, a ? "Check the readings: the result must be 1–200 mA per pixel." : "");
  };
  at25.input.addEventListener("input", calc);
  off.input.addEventListener("input", calc);
  const calib = h(
    "details",
    { class: "more" },
    h("summary", null, "Calibrate"),
    h("p", { class: "hint" }, "Run the 25 % white test below, measure the current on the 12 V side, then measure again with the lamp off."),
    at25.el,
    off.el,
    calOut,
  );

  const cc = cfg.color_correction.slice();
  const ccSliders = ["Red", "Green", "Blue"].map((name, i) =>
    slider({
      label: name,
      min: 0,
      max: 255,
      value: cc[i]!,
      text: (v) => String(v),
      cls: "cc cc" + i,
      onChange: (v) => (cc[i] = v),
    }),
  );

  const fps = input({ label: "Frame rate (fps)", type: "number", inputmode: "numeric", min: 10, max: 100, value: cfg.fps });
  let dither = cfg.dither;
  const dith = toggle("Dithering", dither, (on) => (dither = on), "Smooths very dim fades. Turns itself off below 60 fps.");
  const powerOn = select(
    "At power-on",
    [
      ["restore", "Restore the last state"],
      ["on", "Turn on with preset 1"],
      ["off", "Stay off"],
    ],
    cfg.power_on,
  );

  const save = btn("Save", { kind: "primary wide", type: "submit" });
  const fields: Record<string, HTMLElement> = {
    pixel_count: px.input,
    channels: chSel.input,
    color_order: orderSel.input,
    max_current_ma: maxMa.input,
    ma_per_pixel_white: mapw.input,
    fps: fps.input,
    power_on: powerOn.input,
  };

  const num = (el: HTMLInputElement) => (el.value.trim() === "" ? NaN : Number(el.value));
  function collect(): [Partial<LedConfig>, string, string] {
    const next: LedConfig = {
      pixel_count: num(px.input),
      channels: Number(chSel.input.value) as 3 | 4,
      color_order: orderSel.input.value as LedConfig["color_order"],
      max_current_ma: num(maxMa.input),
      ma_per_pixel_white: num(mapw.input),
      color_correction: [cc[0]!, cc[1]!, cc[2]!],
      fps: num(fps.input),
      dither,
      power_on: powerOn.input.value as LedConfig["power_on"],
    };
    const ranges: Array<[keyof LedConfig, number, number, string]> = [
      ["pixel_count", 1, 1024, "Pixel count"],
      ["max_current_ma", 100, 20000, "Current limit"],
      ["ma_per_pixel_white", 1, 200, "mA per pixel"],
      ["fps", 10, 100, "Frame rate"],
    ];
    for (const [k, lo, hi, name] of ranges) {
      const v = next[k] as number;
      if (!(v >= lo && v <= hi) || Math.round(v) !== v) return [{}, k, name + " must be a whole number from " + lo + " to " + hi + "."];
    }
    const patch: Partial<LedConfig> = {};
    for (const k of Object.keys(next) as Array<keyof LedConfig>) {
      if (JSON.stringify(next[k]) !== JSON.stringify(cfg[k])) (patch as Record<string, unknown>)[k] = next[k];
    }
    return [patch, "", ""];
  }

  const form = h(
    "form",
    {
      class: "stack",
      novalidate: true,
      onsubmit: async (e: Event) => {
        e.preventDefault();
        err.set("");
        for (const k in fields) fields[k]!.classList.remove("bad");
        const [patch, badField, msg] = collect();
        if (msg) {
          err.set(msg);
          fields[badField]!.classList.add("bad");
          fields[badField]!.focus();
          return;
        }
        if (!Object.keys(patch).length) {
          toast("Nothing changed");
          return;
        }
        busy(save, true);
        try {
          const res = await admin<LedConfig | undefined>("PUT", "/config", patch);
          cfg = res && typeof res.pixel_count === "number" ? res : Object.assign({}, cfg, patch);
          toast("LED settings saved", "good");
          live.refreshInfo().catch(() => undefined);
        } catch (x) {
          if (isCancel(x)) return;
          err.set(errMsg(x));
          if (x instanceof ApiError && x.field && fields[x.field]) {
            fields[x.field]!.classList.add("bad");
            fields[x.field]!.focus();
          }
        } finally {
          busy(save, false);
        }
      },
    },
    card("Strip", px.el, chSel.el, orderSel.el),
    card("Power", maxMa.el, supplyChips, mapw.el, calib),
    card("Color correction", h("p", { class: "hint" }, "Scales each channel. Many COB whites look bluish: lower blue a little to warm them."), ccSliders.map((s) => s.el)),
    card("Output", fps.el, dith.el, powerOn.el),
    err.el,
    save,
  );

  const tests = card(
    "Test patterns",
    TESTS.map(([id, name, how, ms]) => {
      const b = btn(name, {
        kind: "ghost",
        onclick: async () => {
          busy(b, true);
          try {
            await admin("POST", "/test-pattern", { pattern: id, duration_ms: ms });
            toast(name + " test: running for " + ms / 1000 + " s");
          } catch (x) {
            if (!isCancel(x)) toast(errMsg(x), "bad");
          } finally {
            busy(b, false);
          }
        },
      });
      return h("div", { class: "test" }, b, h("p", { class: "hint" }, how));
    }),
  );

  fill(body, form, tests);
}
