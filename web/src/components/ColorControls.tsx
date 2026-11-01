// ColorPicker (06 A.3): swatches (incl. warm white), recent colors, the react-colorful picker, a
// 2200–6500 K white slider (Kelvin → sRGB here in the client) and up to 3 color slots for effects that
// use them. Every color has a spoken name for screen readers.
import { useEffect, useRef, useState } from "react";
import { HexColorPicker } from "react-colorful";
import { TRANSITION, normalizeHex, type EffectDesc } from "@doublelamp/protocol";
import {
  KELVIN_MAX,
  KELVIN_MIN,
  KELVIN_STEP,
  colorName,
  kelvinToHex,
  nearestKelvin,
} from "../lib/color";
import { capitalize, cls } from "../lib/format";
import { useThrottledCallback } from "../lib/hooks";
import { KEYS, load, save } from "../lib/storage";
import { ParamSlider } from "./controls";
import { IconPlus, IconX } from "./Icons";

export const SWATCHES: { hex: string; name: string }[] = [
  { hex: "#FFB46B", name: "Warm white" },
  { hex: "#FFD6AA", name: "Soft white" },
  { hex: "#FFF4EA", name: "Daylight" },
  { hex: "#FF8A3D", name: "Candle orange" },
  { hex: "#FF2A1A", name: "Red" },
  { hex: "#FFC400", name: "Amber" },
  { hex: "#2BD45C", name: "Green" },
  { hex: "#00C2B8", name: "Teal" },
  { hex: "#2F6BFF", name: "Blue" },
  { hex: "#7A2BFF", name: "Purple" },
  { hex: "#FF3D9A", name: "Pink" },
];

const RECENT_MAX = 5;

export function rememberColor(hex: string): void {
  const h = normalizeHex(hex);
  if (SWATCHES.some((s) => s.hex === h)) return;
  const list = load<string[]>(KEYS.recentColors, []).filter((c) => c !== h);
  save(KEYS.recentColors, [h, ...list].slice(0, RECENT_MAX));
}

/** How many colors an effect uses (03 §6): `colors1`..`colors3`. */
export function colorSlots(e: EffectDesc | undefined): number {
  if (!e) return 1;
  if (e.uses.includes("colors3")) return 3;
  if (e.uses.includes("colors2")) return 2;
  return 1;
}

export function Swatches({ current, onPick }: { current: string; onPick: (hex: string) => void }) {
  const [recent, setRecent] = useState<string[]>(() => load<string[]>(KEYS.recentColors, []));
  const pick = (hex: string) => {
    onPick(hex);
    rememberColor(hex);
    setRecent(load<string[]>(KEYS.recentColors, []));
  };
  const cur = normalizeHex(current);
  const all = [...recent.map((hex) => ({ hex, name: capitalize(colorName(hex)), recent: true })), ...SWATCHES];
  return (
    <div className="swatches" role="group" aria-label="Color presets">
      {all.map((s) => (
        <button
          key={`${s.hex}${"recent" in s ? "r" : ""}`}
          type="button"
          className={cls("swatch", cur === s.hex && "selected", "recent" in s && "recent")}
          aria-pressed={cur === s.hex}
          aria-label={"recent" in s ? `Recent: ${s.name}` : s.name}
          title={s.name}
          style={{ backgroundColor: s.hex }}
          onClick={() => pick(s.hex)}
        />
      ))}
    </div>
  );
}

interface ColorPanelProps {
  colors: string[];
  maxSlots: number;
  slot: number;
  setSlot: (i: number) => void;
  /** Sends a new colors array (already throttled by the caller for drags). */
  onColors: (colors: string[], transitionMs: number) => void;
  disabled: boolean;
}

export function ColorPanel({ colors, maxSlots, slot, setSlot, onColors, disabled }: ColorPanelProps) {
  const active = Math.min(slot, colors.length - 1);
  const current = colors[active] ?? "#FFB46B";
  const [local, setLocal] = useState<string | null>(null);
  const lastInput = useRef(-Infinity);
  const idle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shown = local ?? current;

  const sendColor = useThrottledCallback((hex: string, t: number) => {
    const next = [...colors];
    next[active] = normalizeHex(hex);
    onColors(next, t);
  }, 50);

  const onWheel = (hex: string) => {
    const now = performance.now();
    const t = now - lastInput.current < 250 ? TRANSITION.dragMs : TRANSITION.tapMs;
    lastInput.current = now;
    setLocal(hex);
    sendColor(hex, t);
    if (idle.current) clearTimeout(idle.current);
    idle.current = setTimeout(() => setLocal(null), 700);
  };

  // Spoken color name, announced once the color settles.
  const [announce, setAnnounce] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setAnnounce(`Color ${active + 1}: ${colorName(shown)}`), 700);
    return () => clearTimeout(t);
  }, [shown, active]);

  const kelvin = nearestKelvin(shown);
  const [lastKelvin, setLastKelvin] = useState(3000);
  useEffect(() => {
    if (kelvin !== null) setLastKelvin(kelvin);
  }, [kelvin]);

  const addSlot = () => {
    if (colors.length >= maxSlots) return;
    const seed = ["#7A2BFF", "#2F6BFF", "#FF3D9A"].find((c) => !colors.includes(c)) ?? "#FFFFFF";
    onColors([...colors, seed], TRANSITION.tapMs);
    setSlot(colors.length);
  };
  const removeSlot = (i: number) => {
    if (colors.length <= 1) return;
    onColors(
      colors.filter((_, j) => j !== i),
      TRANSITION.tapMs,
    );
    setSlot(Math.max(0, i - 1));
  };

  return (
    <div className="color-panel">
      {maxSlots > 1 && (
        <div className="slots" role="group" aria-label="Effect colors">
          {colors.slice(0, maxSlots).map((c, i) => (
            <span key={i} className="slot-wrap">
              <button
                type="button"
                className={cls("slot", i === active && "selected")}
                aria-pressed={i === active}
                aria-label={`Color ${i + 1}: ${colorName(c)}`}
                style={{ backgroundColor: c }}
                onClick={() => setSlot(i)}
              >
                <span className="slot-num" aria-hidden="true">
                  {i + 1}
                </span>
              </button>
              {i > 0 && i === active && (
                <button
                  type="button"
                  className="icon-btn small slot-remove"
                  aria-label={`Remove color ${i + 1}`}
                  onClick={() => removeSlot(i)}
                >
                  <IconX size={16} />
                </button>
              )}
            </span>
          ))}
          {colors.length < maxSlots && (
            <button type="button" className="slot add" onClick={addSlot} aria-label="Add a color">
              <IconPlus size={18} />
            </button>
          )}
        </div>
      )}
      <div className={cls("wheel", disabled && "disabled")} inert={disabled}>
        <HexColorPicker
          color={shown}
          onChange={onWheel}
          onChangeEnd={(hex) => rememberColor(hex)}
          aria-label={`Color ${active + 1} picker`}
        />
      </div>
      <p className="color-readout">
        <span className="color-chip" style={{ backgroundColor: shown }} aria-hidden="true" />
        <span>{capitalize(colorName(shown))}</span>
        <span className="muted mono">{normalizeHex(shown)}</span>
      </p>
      <p className="sr-only" aria-live="polite">
        {announce}
      </p>
      <ParamSlider
        label="White"
        min={KELVIN_MIN}
        max={KELVIN_MAX}
        step={KELVIN_STEP}
        value={kelvin ?? lastKelvin}
        format={(k) => `${k} K, ${colorName(kelvinToHex(k))}`}
        trackClass="kelvin"
        disabled={disabled}
        onChange={(k, t) => {
          setLastKelvin(k);
          const next = [...colors];
          next[active] = kelvinToHex(k);
          onColors(next, t);
        }}
      />
    </div>
  );
}
