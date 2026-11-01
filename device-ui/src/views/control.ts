// Control screen (06 §B.3): the server app's control sheet for one lamp, plus its 8 presets.
// Power and brightness sit in a bar at the bottom of the screen for one-thumb use.
import type { EffectDesc, LampState, Preset } from "@doublelamp/protocol/local";
import { ApiError, admin, api, errMsg, session } from "../lib/api";
import { SWATCHES, accents, colorName, hsv16, mix, parseHex, rgbToHsv16, toHex } from "../lib/color";
import { fill, h, rafBatch } from "../lib/dom";
import { type Patch, applyPreset, change, live } from "../live";
import { icon, svg } from "../ui/icons";
import { type Phase, pct, slider } from "../ui/slider";
import { colorWheel } from "../ui/wheel";
import { askLogin, btn, busy, confirmDialog, errorBox, input, isCancel, modal, note, toast } from "../ui/widgets";

type Use = EffectDesc["uses"][number];

/** Effect-specific names for the generic parameters (03 §6). */
const INTENSITY_LABEL: Record<string, string> = {
  breathe: "Depth",
  cycle: "Saturation",
  rainbow: "Hue span",
  candle: "Flicker",
  twinkle: "Density",
};
const SPEED_LABEL: Record<string, string> = { gradient: "Drift" };

export const MANAGED_MSG =
  "This lamp is paired with a server, which manages its presets. Save a scene in the web app instead: its first 8 scenes become this lamp's presets.";

let effects: EffectDesc[] = [];
let presets: Preset[] = [];

export function effectById(id: string): EffectDesc | undefined {
  for (const e of effects) if (e.id === id) return e;
  return undefined;
}

function uses(e: EffectDesc | undefined, u: Use): boolean {
  return !!e && e.uses.indexOf(u) >= 0;
}

/** How many colors the effect uses (0–3). Unknown effects: 1. */
function colorSlots(e: EffectDesc | undefined): number {
  if (!e) return 1;
  return uses(e, "colors3") ? 3 : uses(e, "colors2") ? 2 : uses(e, "colors1") ? 1 : 0;
}

/** Switching effects applies the effect's defaults for speed, intensity and duration (04 §3). */
function effectPatch(e: EffectDesc): NonNullable<Patch["effect"]> {
  const p: NonNullable<Patch["effect"]> = { id: e.id };
  if (e.defaults) {
    p.speed = e.defaults.speed;
    p.intensity = e.defaults.intensity;
    p.duration_ms = e.defaults.duration_ms || 0;
  }
  return p;
}

const RAINBOW = "#FF0000,#FFFF00,#00FF00,#00FFFF,#0000FF,#FF00FF,#FF0000";

function effectPreview(id: string, colors: string[]): string {
  const c0 = colors[0] || "#FFB46B";
  const all = colors.length > 1 ? colors.join(",") : c0 + "," + c0;
  switch (id) {
    case "solid":
      return c0;
    case "breathe":
      return "linear-gradient(90deg," + c0 + "33," + c0 + "," + c0 + "33)";
    case "gradient":
      return "linear-gradient(90deg," + all + ")";
    case "cycle":
    case "rainbow":
      return "linear-gradient(90deg," + RAINBOW + ")";
    case "candle":
      return "linear-gradient(90deg,#FF7A1A,#FFB347,#E86A00,#FFCF70,#FF8C00)";
    case "twinkle":
      return "repeating-linear-gradient(90deg," + c0 + " 0 5px,#0000 5px 13px)";
    case "sunrise":
      return "linear-gradient(90deg,#3A0300,#C81E00,#FF8A3D,#FFD9A0)";
    case "sync_test":
      return "repeating-linear-gradient(90deg,#FFF 0 3px,#0000 3px 14px)";
    default:
      return "";
  }
}

/** A rough, static picture of what the strip shows (the real effect code lives in the firmware). */
function stripColors(s: LampState, n: number): string[] {
  const out: string[] = [];
  const cs = s.colors.map(parseHex);
  for (let i = 0; i < n; i++) {
    const x = (2 * i + 1) / (2 * n);
    let c = cs[0] || parseHex("#FFB46B");
    switch (s.effect.id) {
      case "gradient":
        if (cs.length > 1) {
          const seg = x * (cs.length - 1);
          const k = Math.min(cs.length - 2, Math.floor(seg));
          c = mix(cs[k]!, cs[k + 1]!, Math.round((seg - k) * 255));
        }
        break;
      case "rainbow":
        c = hsv16(Math.round(x * (Math.max(32, s.effect.intensity) / 255) * 65536) & 0xffff, 255, 255);
        break;
      case "cycle":
        c = hsv16(0, s.effect.intensity, 255);
        break;
      case "twinkle":
        c = cs[i % cs.length]!;
        break;
      case "sunrise":
        c = parseHex("#FF8A3D");
        break;
      case "sync_test":
        c = [255, 255, 255];
        break;
    }
    out.push(toHex(c));
  }
  return out;
}

export interface ControlView {
  el: HTMLElement;
  shown(): void;
}

export function controlView(): ControlView {
  let slot = 0; // which color the wheel edits

  // ----- header -----
  const title = h("h1", { class: "top-t" }, "DoubleLamp");
  const status = h("span", { class: "chip st" });
  const header = h(
    "header",
    { class: "top" },
    h("div", { class: "top-l" }, title, status),
    h("a", { class: "ib", href: "#settings", "aria-label": "Settings", title: "Settings", html: svg("gear") }),
  );

  const linked = h("div", { class: "banner link", role: "status", hidden: true });
  const offline = note("", "bad");
  offline.setAttribute("role", "status");
  const busyNote = note("Live updates are paused: too many pages have this lamp open. Checking every 2 s instead.", "subtle");

  // ----- strip preview -----
  const strip = h("div", { class: "strip", "aria-hidden": "true" });

  // ----- presets -----
  const presetRow = h("div", { class: "chips", role: "group", "aria-label": "Presets" });
  const presetsSec = h("section", { class: "sec" }, h("h2", { class: "sec-t" }, "Presets"), presetRow);

  // ----- color -----
  const wheel = colorWheel((hex, phase) => pickColor(hex, phase));
  const swatches = h(
    "div",
    { class: "sw-grid", role: "group", "aria-label": "Quick colors" },
    SWATCHES.map((sw) =>
      h("button", {
        type: "button",
        class: "swatch",
        style: "background:" + sw.hex,
        "aria-label": sw.name,
        title: sw.name,
        "data-hex": sw.hex,
        onclick: () => pickColor(sw.hex, "tap"),
      }),
    ),
  );
  const slotRow = h("div", { class: "slots", role: "group", "aria-label": "Effect colors" });
  const colorSec = h("section", { class: "sec" }, h("h2", { class: "sec-t" }, "Color"), slotRow, wheel.el, swatches);

  // ----- effects + parameters -----
  const fxGrid = h("div", { class: "fx", role: "radiogroup", "aria-label": "Effect" });
  const speed = slider({
    label: "Speed",
    min: 0,
    max: 255,
    value: 128,
    text: pct,
    onChange: (v, ph) => change({ effect: { speed: v } }, ph),
  });
  const intensity = slider({
    label: "Intensity",
    min: 0,
    max: 255,
    value: 128,
    text: pct,
    onChange: (v, ph) => change({ effect: { intensity: v } }, ph),
  });
  const duration = slider({
    label: "Duration",
    min: 5,
    max: 60,
    value: 30,
    text: (m) => m + " min",
    onChange: (m, ph) => change({ effect: { duration_ms: m * 60000 } }, ph),
  });
  const fxSec = h(
    "section",
    { class: "sec" },
    h("h2", { class: "sec-t" }, "Effect"),
    fxGrid,
    h("div", { class: "params" }, speed.el, intensity.el, duration.el),
  );

  // ----- bottom bar: power + brightness -----
  const power = h("button", {
    type: "button",
    class: "pwr",
    "aria-label": "Power",
    "aria-pressed": "false",
    html: svg("power"),
    onclick: () => {
      const s = live.state;
      if (s) change({ on: !s.on }, "tap");
    },
  });
  const bright = slider({
    label: "Brightness",
    min: 1,
    max: 255,
    value: 128,
    text: pct,
    cls: "bright",
    onChange: (v, ph) => {
      const s = live.state;
      const p: Patch = { brightness: v };
      if (s && !s.on) p.on = true;
      change(p, ph);
    },
  });
  const bar = h("div", { class: "bar" }, h("div", { class: "bar-in" }, power, bright.el));

  const main = h(
    "main",
    { class: "page has-bar" },
    header,
    linked,
    offline,
    busyNote,
    strip,
    presetsSec,
    colorSec,
    fxSec,
  );
  const el = h("div", null, main, bar);

  function pickColor(hex: string, phase: Phase) {
    const s = live.state;
    if (!s) return;
    const e = effectById(s.effect.id);
    const colors = s.colors.slice();
    const n = colorSlots(e);
    colors[n > 1 ? Math.min(slot, colors.length) : 0] = hex;
    const p: Patch = { colors };
    // A color only shows with an effect that uses colors; otherwise switch to solid, like Apple Home (03 §11).
    if (e && n === 0) {
      const solid = effectById("solid");
      p.effect = solid ? effectPatch(solid) : { id: "solid" };
    }
    if (!s.on) p.on = true;
    change(p, phase);
  }

  function renderSlots(s: LampState, n: number) {
    fill(slotRow);
    slotRow.hidden = n < 2;
    if (n < 2) return;
    const have = Math.min(n, s.colors.length);
    if (slot >= have) slot = Math.max(0, have - 1);
    for (let i = 0; i < n && i <= s.colors.length; i++) {
      const has = i < s.colors.length;
      const sel = has && i === slot;
      slotRow.appendChild(
        h(
          "button",
          {
            type: "button",
            class: "slot" + (sel ? " on" : "") + (has ? "" : " add"),
            style: has ? "background:" + s.colors[i] : "",
            "aria-pressed": String(sel),
            "aria-label": has ? "Edit color " + (i + 1) + ", " + colorName(s.colors[i]!) : "Add color " + (i + 1),
            onclick: () => {
              const st = live.state;
              if (!st) return;
              if (i >= st.colors.length) {
                // a new color starts a third of the way around the wheel from the last one
                const hue = rgbToHsv16(parseHex(st.colors[st.colors.length - 1] || "#FFB46B"))[0];
                change({ colors: st.colors.concat(toHex(hsv16((hue + 21845) & 0xffff, 255, 255))) }, "tap");
              }
              slot = i;
              update();
            },
          },
          has ? h("span", { class: "n" }, String(i + 1)) : icon("plus"),
        ),
      );
    }
    if (slot > 0 && slot < s.colors.length) {
      slotRow.appendChild(
        btn("Remove " + (slot + 1), {
          kind: "ghost sm",
          onclick: () => {
            const st = live.state;
            if (!st || st.colors.length < 2) return;
            const cs = st.colors.slice();
            cs.splice(slot, 1);
            slot = Math.max(0, slot - 1);
            change({ colors: cs }, "tap");
          },
        }),
      );
    }
  }

  let fxBuilt = "";
  function renderEffects(s: LampState) {
    if (!effects.length) {
      if (fxBuilt !== "-") {
        fxBuilt = "-";
        fill(
          fxGrid,
          h(
            "p",
            { class: "muted sm" },
            "Couldn't load the effect list. ",
            btn("Retry", { kind: "ghost sm", onclick: () => loadEffects().then(update, (e) => toast(errMsg(e), "bad")) }),
          ),
        );
      }
      return;
    }
    const key = effects.map((e) => e.id).join();
    if (key !== fxBuilt) {
      fxBuilt = key;
      fill(
        fxGrid,
        effects.map((e) =>
          h(
            "button",
            {
              type: "button",
              class: "fx-b",
              role: "radio",
              "data-id": e.id,
              onclick: () => {
                const st = live.state;
                if (!st) return;
                const p: Patch = { effect: effectPatch(e) };
                if (!st.on) p.on = true;
                change(p, "tap");
              },
            },
            h("span", { class: "fx-p" }),
            h("span", { class: "fx-n" }, e.name),
          ),
        ),
      );
    }
    const kids = fxGrid.children;
    for (let i = 0; i < kids.length; i++) {
      const b = kids[i] as HTMLElement;
      const on = b.getAttribute("data-id") === s.effect.id;
      b.classList.toggle("on", on);
      b.setAttribute("aria-checked", String(on));
      b.tabIndex = on || (!effectById(s.effect.id) && i === 0) ? 0 : -1;
      (b.firstChild as HTMLElement).style.background = effectPreview(b.getAttribute("data-id")!, s.colors);
    }
  }

  // arrow keys move within the effect radio group
  fxGrid.addEventListener("keydown", (e) => {
    const d = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!d) return;
    const kids = Array.prototype.slice.call(fxGrid.children) as HTMLElement[];
    const i = kids.indexOf(document.activeElement as HTMLElement);
    if (i < 0) return;
    e.preventDefault();
    const next = kids[(i + d + kids.length) % kids.length]!;
    next.focus();
    next.click();
  });

  let presetKey = "";
  function renderPresets() {
    const key = JSON.stringify(presets) + !!session.token;
    if (key === presetKey) return;
    presetKey = key;
    fill(
      presetRow,
      presets.map((p) =>
        h(
          "button",
          { type: "button", class: "chip pre", onclick: () => applyPreset(p) },
          h("span", { class: "dot", style: "background:" + (p.state.colors[0] || "#FFB46B") }),
          p.name,
        ),
      ),
      presets.length ? null : h("span", { class: "muted sm" }, "No presets yet."),
      h("button", { type: "button", class: "chip add", onclick: savePreset }, icon("plus"), "Save current"),
    );
  }

  function renderStrip(s: LampState) {
    const n = Math.max(1, Math.min(48, (live.info && live.info.hw && live.info.hw.pixels) || 10));
    const cols = stripColors(s, n);
    while (strip.childNodes.length > n) strip.removeChild(strip.lastChild!);
    while (strip.childNodes.length < n) strip.appendChild(h("i"));
    // brightness dims the dots, not the strip's dark backing (which would turn gray on the light theme)
    const dim = s.on ? "brightness(" + (0.35 + (0.65 * s.brightness) / 255).toFixed(2) + ")" : "";
    for (let i = 0; i < n; i++) {
      const d = strip.childNodes[i] as HTMLElement;
      d.style.background = s.on ? cols[i]! : "";
      d.style.boxShadow = s.on ? "0 0 10px " + cols[i] : "";
      d.style.filter = dim;
      d.style.animationDelay = (((i * 7919) % 13) / 13) * 2 + "s";
    }
    strip.className = "strip fx-" + s.effect.id + (s.on ? "" : " off");
    strip.style.animationDuration = 2 + ((255 - s.effect.speed) / 255) * 8 + "s";
  }

  let lastAccent = "";
  function renderAccent(s: LampState) {
    const c = s.colors[0] || "#FFB46B";
    if (c === lastAccent) return;
    lastAccent = c;
    const a = accents(c);
    const st = document.documentElement.style;
    st.setProperty("--accent", a.dark);
    st.setProperty("--accent-l", a.light);
    st.setProperty("--on-accent", a.onDark);
    st.setProperty("--on-accent-l", a.onLight);
  }

  const update = rafBatch(() => {
    const s = live.state;
    const info = live.info;
    const name = (info && info.name) || "DoubleLamp";
    title.textContent = name;
    document.title = name;
    const c = live.conn;
    status.textContent = c === "live" ? "Live" : c === "polling" ? "Updating every 2 s" : c === "offline" ? "Offline" : "Connecting…";
    status.className = "chip st " + c;

    const cloud = info && info.cloud;
    if (cloud && cloud.linked) {
      // The firmware lists the partner lamps' names in cloud.peers; fall back to the group name.
      const peers = ((cloud as { peers?: string[] }).peers || []).filter(Boolean);
      const partner = peers.length ? peers.join(" and ") : cloud.group_name;
      const who = partner ? "Linked with " + partner : "Linked";
      fill(
        linked,
        icon("link"),
        h(
          "span",
          null,
          cloud.state === "online"
            ? who + ": changes apply to both"
            : who + ", but the server is unreachable: changes apply to this lamp only until it reconnects",
        ),
      );
    }
    linked.hidden = !(cloud && cloud.linked);
    offline.textContent = "Can't reach the lamp. Retrying…";
    offline.hidden = c !== "offline";
    busyNote.hidden = !(live.busy && c === "polling");

    const disabled = !s || c === "offline";
    main.classList.toggle("dis", disabled);
    bar.classList.toggle("dis", disabled);
    bright.setDisabled(disabled);
    if (!s) return;

    power.classList.toggle("on", s.on);
    power.setAttribute("aria-pressed", String(s.on));
    power.setAttribute("aria-label", s.on ? "Turn off" : "Turn on");
    bright.set(Math.max(1, s.brightness));

    const e = effectById(s.effect.id);
    const n = colorSlots(e);
    renderSlots(s, n);
    const cur = s.colors[n > 1 ? Math.min(slot, s.colors.length - 1) : 0] || s.colors[0]!;
    wheel.set(cur);
    const kids = swatches.children;
    for (let i = 0; i < kids.length; i++) {
      const b = kids[i] as HTMLElement;
      const on = b.getAttribute("data-hex") === cur;
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", String(on));
    }

    renderEffects(s);
    const useSpeed = uses(e, "speed");
    const useInt = uses(e, "intensity");
    const useDur = uses(e, "duration");
    speed.el.hidden = !useSpeed;
    intensity.el.hidden = !useInt;
    duration.el.hidden = !useDur;
    speed.setLabel(SPEED_LABEL[s.effect.id] || "Speed");
    intensity.setLabel(INTENSITY_LABEL[s.effect.id] || "Intensity");
    speed.set(s.effect.speed);
    intensity.set(s.effect.intensity);
    duration.set(Math.round((s.effect.duration_ms || 1800000) / 60000));

    renderPresets();
    renderStrip(s);
    renderAccent(s);
  });

  async function loadPresets() {
    try {
      const list = await api<Preset[]>("GET", "/presets");
      presets = (Array.isArray(list) ? list : []).slice().sort((a, b) => a.slot - b.slot);
      update();
    } catch {
      /* keep the old list */
    }
  }

  async function savePreset() {
    if (!session.token) {
      try {
        await askLogin();
      } catch (e) {
        if (!isCancel(e)) toast(errMsg(e), "bad");
        return;
      }
    }
    const used: Record<number, Preset> = {};
    for (const p of presets) used[p.slot] = p;
    let chosen = 0;
    while (chosen < 7 && used[chosen]) chosen++;
    const name = input({ label: "Name", maxlength: 32, value: "", placeholder: "e.g. Cozy", autocapitalize: "sentences" });
    const err = errorBox();
    const slots = h("div", { class: "slot-grid", role: "radiogroup", "aria-label": "Preset slot" });
    const del = btn("Delete", { kind: "ghost danger-t", icon: "trash" });
    const save = btn("Save", { kind: "primary", type: "submit" });
    const paintSlots = () => {
      fill(
        slots,
        [0, 1, 2, 3, 4, 5, 6, 7].map((i) =>
          h(
            "button",
            {
              type: "button",
              role: "radio",
              "aria-checked": String(i === chosen),
              class: "pslot" + (i === chosen ? " on" : ""),
              onclick: () => {
                chosen = i;
                if (used[i] && !name.input.value) name.input.value = used[i]!.name;
                paintSlots();
              },
            },
            h("b", null, String(i + 1)),
            h("span", null, used[i] ? used[i]!.name : "Empty"),
          ),
        ),
      );
      del.hidden = !used[chosen];
      save.textContent = used[chosen] ? "Replace" : "Save";
    };
    paintSlots();
    const fail = (e: unknown) => {
      if (isCancel(e)) return;
      err.set(e instanceof ApiError && e.code === "managed_by_server" ? MANAGED_MSG : errMsg(e));
    };
    del.onclick = async () => {
      const p = used[chosen];
      if (!p) return;
      if (!(await confirmDialog({ title: "Delete preset?", text: "Delete “" + p.name + "”?", ok: "Delete", danger: true }))) return;
      busy(del, true);
      try {
        await admin("DELETE", "/presets/" + chosen, {});
        m.close();
        toast("Preset deleted", "good");
        loadPresets();
      } catch (e) {
        fail(e);
      } finally {
        busy(del, false);
      }
    };
    const form = h(
      "form",
      {
        class: "stack",
        novalidate: true,
        onsubmit: async (ev: Event) => {
          ev.preventDefault();
          err.set("");
          const nm = name.input.value.trim();
          if (!nm) {
            err.set("Give the preset a name.");
            name.input.focus();
            return;
          }
          busy(save, true);
          try {
            await admin("PUT", "/presets/" + chosen, { name: nm });
            m.close();
            toast("Saved “" + nm + "”", "good");
            loadPresets();
          } catch (e) {
            fail(e);
          } finally {
            busy(save, false);
          }
        },
      },
      h("p", { class: "muted" }, "Saves what the lamp shows now: power, brightness, colors and effect."),
      name.el,
      h("div", { class: "lbl" }, "Slot"),
      slots,
      err.el,
      h("div", { class: "row end" }, del, save),
    );
    const m = modal("Save preset", [form]);
  }

  live.sub(update);
  return {
    el,
    shown() {
      update();
      loadPresets();
      requestAnimationFrame(() => wheel.redraw());
    },
  };
}

export async function loadEffects(): Promise<void> {
  const list = await api<EffectDesc[]>("GET", "/effects");
  effects = Array.isArray(list) ? list : [];
}

/** For the settings screen: true while the user has an admin session. */
export function loggedIn(): boolean {
  return !!session.token;
}
