// Small shared controls: power toggle, online dot, the throttled parameter slider.
import { useId, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { TRANSITION } from "@doublelamp/protocol";
import { cls, timeAgo } from "../lib/format";
import { useThrottledCallback } from "../lib/hooks";
import { IconPower } from "./Icons";

export function PowerButton({
  on,
  label,
  onToggle,
  disabled,
  large,
}: {
  on: boolean;
  label: string;
  onToggle: () => void;
  disabled?: boolean;
  large?: boolean;
}) {
  return (
    <button
      type="button"
      className={cls("power", on && "on", large && "large")}
      aria-pressed={on}
      aria-label={label}
      title={label}
      onClick={onToggle}
      disabled={disabled}
    >
      <IconPower size={large ? 26 : 22} />
    </button>
  );
}

export function OnlineDot({ online, lastSeen }: { online: boolean; lastSeen?: number | null }) {
  const text = online ? "Online" : `Offline${lastSeen ? `, last seen ${timeAgo(lastSeen)}` : ""}`;
  return <span className={cls("dot", online ? "online" : "offline")} role="img" aria-label={text} title={text} />;
}

interface ParamSliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  /** Spoken and shown value, e.g. "72 %" or "3000 K, warm white". */
  format: (v: number) => string;
  /** Throttled to one call per 50 ms; the final position is always delivered (06 A.4). */
  onChange: (value: number, transitionMs: number) => void;
  icon?: ReactNode;
  trackClass?: string;
  disabled?: boolean;
  hideLabel?: boolean;
}

/**
 * A native range input (keyboard steps, screen-reader support) with throttled sending. While the user
 * interacts it shows its own value, so in-flight server echoes don't make the thumb jump.
 */
export function ParamSlider({
  label,
  value,
  min,
  max,
  step = 1,
  format,
  onChange,
  icon,
  trackClass,
  disabled,
  hideLabel,
}: ParamSliderProps) {
  const id = useId();
  const [local, setLocal] = useState<number | null>(null);
  const lastInput = useRef(-Infinity);
  const idle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const send = useThrottledCallback(onChange, 50);
  const shown = local ?? value;
  const fill = max > min ? ((shown - min) / (max - min)) * 100 : 0;

  const onInput = (v: number) => {
    const now = performance.now();
    const t = now - lastInput.current < 250 ? TRANSITION.dragMs : TRANSITION.tapMs;
    lastInput.current = now;
    setLocal(v);
    send(v, t);
    if (idle.current) clearTimeout(idle.current);
    idle.current = setTimeout(() => setLocal(null), 700);
  };

  return (
    <div className={cls("slider", trackClass)}>
      <div className={cls("slider-head", hideLabel && "sr-only")}>
        <label htmlFor={id}>
          {icon}
          <span>{label}</span>
        </label>
        <output htmlFor={id} aria-hidden="true">
          {format(shown)}
        </output>
      </div>
      <input
        id={id}
        className="range"
        type="range"
        min={min}
        max={max}
        step={step}
        value={shown}
        disabled={disabled}
        aria-valuetext={format(shown)}
        style={{ "--fill": `${fill}%` } as CSSProperties}
        onChange={(e) => onInput(Number(e.currentTarget.value))}
      />
    </div>
  );
}
