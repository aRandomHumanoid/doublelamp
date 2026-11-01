// A custom slider (role="slider"): the whole 44 px row is the hit area, tapping the track jumps
// there (iOS range inputs don't), and the caller learns whether a change is a drag or a tap so it
// can pick transition_ms 120 or 400 (04 §2).
import { h, nextId } from "../lib/dom";
import { onDrag } from "./drag";

export type Phase = "drag" | "end" | "tap";

export interface SliderOpts {
  label: string;
  min: number;
  max: number;
  step?: number;
  value: number;
  /** Shown next to the label and used as aria-valuetext. */
  text: (v: number) => string;
  onChange: (v: number, phase: Phase) => void;
  cls?: string;
}

export interface Slider {
  el: HTMLElement;
  track: HTMLElement;
  set(v: number): void;
  setLabel(label: string): void;
  setDisabled(d: boolean): void;
  readonly dragging: boolean;
}

const PAD = 14; // half the thumb width: the rail is inset by this much on both sides

export function slider(o: SliderOpts): Slider {
  const id = nextId("sl");
  const step = o.step || 1;
  const kstep = Math.max(step, Math.round((o.max - o.min) / 100 / step) * step);
  const out = h("span", { class: "sl-val", "aria-hidden": "true" });
  const fillEl = h("span", { class: "sl-fill" });
  const thumb = h("span", { class: "sl-thumb" });
  const track = h(
    "div",
    {
      class: "sl-track",
      role: "slider",
      tabindex: 0,
      "aria-labelledby": id,
      "aria-valuemin": o.min,
      "aria-valuemax": o.max,
    },
    h("span", { class: "sl-rail" }, fillEl),
    thumb,
  );
  const lab = h("span", { class: "sl-label", id }, o.label);
  const el = h("div", { class: "sl" + (o.cls ? " " + o.cls : "") }, h("div", { class: "sl-head" }, lab, out), track);

  let value = o.value;
  let dragging = false;
  let moved = false;
  let disabled = false;
  let startValue = value;
  let sent = value;
  let startX = 0;

  const clamp = (v: number) => Math.min(o.max, Math.max(o.min, Math.round(v / step) * step));
  function paint(v: number) {
    const f = (v - o.min) / (o.max - o.min || 1);
    fillEl.style.width = f * 100 + "%";
    thumb.style.left = "calc(" + PAD + "px + (100% - " + 2 * PAD + "px) * " + f.toFixed(4) + ")";
    const t = o.text(v);
    out.textContent = t;
    track.setAttribute("aria-valuenow", String(v));
    track.setAttribute("aria-valuetext", t);
  }
  function fromX(x: number) {
    const r = track.getBoundingClientRect();
    const f = (x - r.left - PAD) / Math.max(1, r.width - 2 * PAD);
    return clamp(o.min + Math.min(1, Math.max(0, f)) * (o.max - o.min));
  }

  onDrag(track, {
    start(x) {
      if (disabled) return;
      dragging = true;
      moved = false;
      startValue = sent = value;
      startX = x;
      value = fromX(x);
      paint(value);
    },
    move(x) {
      if (!dragging) return;
      if (!moved && Math.abs(x - startX) < 4) return;
      moved = true;
      const v = fromX(x);
      if (v !== value) {
        value = v;
        paint(v);
      }
      if (value !== sent) {
        sent = value;
        o.onChange(value, "drag");
      }
    },
    end(cancelled) {
      if (!dragging) return;
      dragging = false;
      if (cancelled && !moved) {
        // the browser started a scroll instead: undo the jump
        value = startValue;
        paint(value);
        return;
      }
      o.onChange(value, moved ? "end" : "tap");
    },
  });

  track.addEventListener("keydown", (e) => {
    if (disabled) return;
    let v = value;
    const big = Math.max(kstep, Math.round((o.max - o.min) / 10));
    switch (e.key) {
      case "ArrowLeft":
      case "ArrowDown":
        v -= kstep;
        break;
      case "ArrowRight":
      case "ArrowUp":
        v += kstep;
        break;
      case "PageDown":
        v -= big;
        break;
      case "PageUp":
        v += big;
        break;
      case "Home":
        v = o.min;
        break;
      case "End":
        v = o.max;
        break;
      default:
        return;
    }
    e.preventDefault();
    v = clamp(v);
    if (v !== value) {
      value = v;
      paint(v);
      o.onChange(v, e.repeat ? "drag" : "tap");
    }
  });

  paint(value);
  return {
    el,
    track,
    set(v: number) {
      if (dragging) return;
      v = clamp(v);
      if (v !== value || !out.textContent) {
        value = v;
        paint(v);
      }
    },
    setLabel(l: string) {
      lab.textContent = l;
    },
    setDisabled(d: boolean) {
      disabled = d;
      el.classList.toggle("dis", d);
      track.setAttribute("aria-disabled", String(d));
    },
    get dragging() {
      return dragging;
    },
  };
}

/** "72 %" with a no-break space, so the unit never wraps onto its own line. */
export const pct = (v: number) => Math.round((v * 100) / 255) + " %";
