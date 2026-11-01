// The control sheet (06 A.2): bottom sheet on phones (drag or tap the handle for color and effects),
// side panel on wide screens. Controls the selected lamp, or the group while linked.
import { useEffect, useId, useRef, useState, type RefObject } from "react";
import {
  TRANSITION,
  effectUsesColors,
  findEffect,
  type EffectDesc,
  type StatePatch,
} from "@doublelamp/protocol";
import { cls, fromPercent, percent } from "../lib/format";
import { useWide } from "../lib/media";
import { sendCommand } from "../live/commands";
import { useControlTarget } from "../live/selectors";
import { useApp } from "../live/store";
import { ColorPanel, Swatches, colorSlots } from "./ColorControls";
import { ParamSlider, PowerButton } from "./controls";
import { EffectGallery, EffectParams } from "./EffectControls";
import { IconSun } from "./Icons";

function SheetHandle({ expanded, onChange, controls }: { expanded: boolean; onChange: (v: boolean) => void; controls: string }) {
  const startY = useRef<number | null>(null);
  const dragged = useRef(false);
  return (
    <button
      type="button"
      className="sheet-handle"
      aria-expanded={expanded}
      aria-controls={controls}
      onPointerDown={(e) => {
        startY.current = e.clientY;
        dragged.current = false;
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (startY.current === null) return;
        const dy = e.clientY - startY.current;
        if (Math.abs(dy) > 24) {
          dragged.current = true;
          startY.current = null;
          onChange(dy < 0);
        }
      }}
      onPointerUp={() => {
        startY.current = null;
      }}
      onClick={() => {
        if (dragged.current) {
          dragged.current = false;
          return;
        }
        onChange(!expanded);
      }}
    >
      <span className="grabber" aria-hidden="true" />
      <span className="handle-label">{expanded ? "Less" : "Color and effects"}</span>
    </button>
  );
}

/** Keeps --sheet-h on the page in sync with the collapsed sheet, so content can scroll clear of it. */
function useSheetHeight(ref: RefObject<HTMLElement | null>, active: boolean, expanded: boolean): void {
  useEffect(() => {
    const el = ref.current;
    const root = document.documentElement;
    if (!el || !active) {
      root.style.removeProperty("--sheet-h");
      return;
    }
    const ro = new ResizeObserver(() => {
      if (!expanded) root.style.setProperty("--sheet-h", `${Math.ceil(el.getBoundingClientRect().height)}px`);
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
    };
  }, [ref, active, expanded]);
  useEffect(
    () => () => {
      document.documentElement.style.removeProperty("--sheet-h");
    },
    [],
  );
}

const solidPatch = (): NonNullable<StatePatch["effect"]> => {
  const solid = findEffect("solid");
  return { id: "solid", speed: solid?.defaults.speed ?? 128, intensity: solid?.defaults.intensity ?? 128, duration_ms: 0 };
};

export function ControlSheet() {
  const ct = useControlTarget();
  const live = useApp((s) => s.live);
  const wide = useWide();
  const [open, setOpen] = useState(false);
  const expanded = wide || open;
  const [slot, setSlot] = useState(0);
  const sheetRef = useRef<HTMLElement>(null);
  const moreId = useId();
  useSheetHeight(sheetRef, !wide, expanded);

  const key = ct?.key;
  useEffect(() => setSlot(0), [key]);

  const st = ct?.state ?? null;
  const effect = st ? findEffect(st.effect.id) : undefined;
  const maxSlots = colorSlots(effect);
  useEffect(() => {
    if (slot >= maxSlots) setSlot(0);
  }, [slot, maxSlots]);

  if (!ct) {
    return (
      <aside ref={sheetRef} className="sheet empty" aria-label="Controls">
        <p className="muted">No lamps yet. Add one in Settings → Add lamp.</p>
      </aside>
    );
  }

  const disabled = !live || !st;
  /** Any change while the lamp is off also turns it on, except the power toggle itself. */
  const send = (patch: StatePatch, t: number = TRANSITION.tapMs) => {
    if (!st) return;
    sendCommand(ct.target, st.on || patch.on !== undefined ? patch : { ...patch, on: true }, t);
  };
  const setColors = (colors: string[], t: number) => {
    if (!st) return;
    const patch: StatePatch = { colors };
    // Effects that ignore colors switch to solid when a color is picked (03 §11).
    if (!effectUsesColors(st.effect.id)) patch.effect = solidPatch();
    send(patch, t);
  };
  const pickEffect = (e: EffectDesc) =>
    send({
      effect: { id: e.id, speed: e.defaults.speed, intensity: e.defaults.intensity, duration_ms: e.defaults.duration_ms ?? 0 },
    });

  const sub = !live
    ? "Waiting for the server"
    : !st
      ? "Waiting for the lamp to report"
      : !ct.online
        ? ct.linked
          ? "Both lamps are offline"
          : "Offline: changes won't reach it"
        : ct.linked
          ? "Linked: changes apply to both"
          : st.on
            ? `${percent(st.brightness)} %${effect ? ` · ${effect.name}` : ""}`
            : "Off";

  return (
    <aside ref={sheetRef} className={cls("sheet", expanded && "expanded")} aria-label={`Controls for ${ct.label}`}>
      {!wide && <SheetHandle expanded={open} onChange={setOpen} controls={moreId} />}
      <fieldset className="sheet-body" disabled={disabled}>
        <legend className="sr-only">Controls for {ct.label}</legend>
        <div className="sheet-head">
          <div className="sheet-title-wrap">
            <h2 className="sheet-title">{ct.label}</h2>
            <p className="sheet-sub">{sub}</p>
          </div>
          <PowerButton large on={!!st?.on} label={`${ct.label} power`} onToggle={() => st && send({ on: !st.on })} />
        </div>
        <ParamSlider
          label="Brightness"
          icon={<IconSun size={18} />}
          min={1}
          max={100}
          value={st ? Math.max(1, percent(st.brightness)) : 50}
          format={(v) => `${v} %`}
          trackClass="brightness"
          onChange={(v, t) => send({ brightness: fromPercent(v) }, t)}
        />
        {st && (
          <Swatches
            current={st.colors[Math.min(slot, st.colors.length - 1)] ?? "#FFB46B"}
            onPick={(hex) => {
              const next = [...st.colors];
              next[Math.min(slot, next.length - 1)] = hex;
              setColors(next, TRANSITION.tapMs);
            }}
          />
        )}
        <div id={moreId} className="sheet-more" hidden={!expanded}>
          {st && (
            <>
              <ColorPanel
                colors={st.colors}
                maxSlots={maxSlots}
                slot={slot}
                setSlot={setSlot}
                onColors={setColors}
                disabled={disabled}
              />
              <EffectGallery effects={ct.effects} state={st} pixels={ct.pixels} onPick={pickEffect} />
              <EffectParams
                effect={effect}
                state={st}
                disabled={disabled}
                onEffectPatch={(p, t) => send({ effect: p }, t)}
              />
            </>
          )}
        </div>
      </fieldset>
    </aside>
  );
}
