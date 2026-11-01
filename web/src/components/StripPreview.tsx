// Live strip preview (06 A.3): n blurred dots rendered by packages/effects at the sync-clock time, so the
// tile animates in phase with the physical lamp. A new state starts at max(now, apply_at) and crossfades
// like the lamp's render task (03 §5). Paused while off-screen; a static frame under prefers-reduced-motion.
import { useEffect, useRef } from "react";
import { renderPreview, type PreviewState, type RGB } from "@doublelamp/effects";
import { TRANSITION } from "@doublelamp/protocol";
import { clock } from "../lib/clock";
import { cls } from "../lib/format";
import { useReducedMotion } from "../lib/media";
import { onFrame } from "../lib/ticker";

export type DemoFn = (s: PreviewState, now: number) => PreviewState;

interface Props {
  state: PreviewState | null;
  pixels: number;
  /** Sync-clock ms at which the lamps make this state visible (04 §2 `apply_at`). */
  applyAt?: number | null;
  /** "tile": glowing dots; "mini": cheap bars for effect thumbnails (≈ 30 fps). */
  variant?: "tile" | "mini";
  /** Rewrites the state per frame, e.g. to loop a one-shot effect in its thumbnail. */
  demo?: DemoFn;
  className?: string;
}

/** Changes closer together than this are a drag, so they get the drag transition (06 A.4). */
const RAPID_MS = 250;
const MAX_APPLY_AHEAD_MS = 3000;
const smoothstep = (t: number): number => t * t * (3 - 2 * t);

class PreviewEngine {
  demo: DemoFn | undefined;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private n = 10;
  private w = 0;
  private h = 0;
  private cur: PreviewState | null = null;
  private queued: { state: PreviewState | null; at: number; dur: number } | null = null;
  private from: RGB[] | null = null;
  private fadeStart = 0;
  private fadeDur = 0;
  private last: RGB[] | null = null;
  private lastKey = "";
  private lastChange = -Infinity;
  private lastDraw = -Infinity;
  private visible = false;
  private motion = true;
  private unsub: (() => void) | null = null;

  constructor(private readonly variant: "tile" | "mini") {}

  attach(canvas: HTMLCanvasElement, motion: boolean): () => void {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.motion = motion;
    const ro = new ResizeObserver(() => {
      this.resize();
      this.drawNow();
    });
    ro.observe(canvas);
    const io = new IntersectionObserver((entries) => {
      this.visible = entries.some((e) => e.isIntersecting);
      this.syncLoop();
      if (this.visible) this.drawNow();
    });
    io.observe(canvas);
    this.resize();
    this.drawNow();
    return () => {
      ro.disconnect();
      io.disconnect();
      this.visible = false;
      this.syncLoop();
      this.canvas = null;
      this.ctx = null;
    };
  }

  setPixels(n: number): void {
    const next = Math.max(1, Math.min(1024, Math.round(n)));
    if (next === this.n) return;
    this.n = next;
    this.from = null;
    this.lastKey = "";
    this.drawNow();
  }

  setState(state: PreviewState | null, applyAt: number | null): void {
    if (state === (this.queued ? this.queued.state : this.cur)) return;
    const t = performance.now();
    const dur = t - this.lastChange < RAPID_MS ? TRANSITION.dragMs : TRANSITION.tapMs;
    this.lastChange = t;
    if (!this.unsub || !this.cur) {
      // Not animating (off-screen, reduced motion, first state): show the new state directly.
      this.cur = state;
      this.queued = null;
      this.from = null;
      this.drawNow();
      return;
    }
    const now = clock.now();
    const at = applyAt !== null && applyAt > now && applyAt - now < MAX_APPLY_AHEAD_MS ? applyAt : now;
    this.queued = { state, at, dur };
  }

  private syncLoop(): void {
    const want = this.visible && this.motion && !!this.ctx;
    if (want && !this.unsub) this.unsub = onFrame((now) => this.frame(now, false));
    else if (!want && this.unsub) {
      this.unsub();
      this.unsub = null;
      if (this.queued) {
        this.cur = this.queued.state;
        this.queued = null;
      }
      this.from = null;
    }
  }

  private drawNow(): void {
    if (this.ctx) this.frame(clock.now(), true);
  }

  private frame(now: number, force: boolean): void {
    if (!force && this.variant === "mini" && now - this.lastDraw < 33) return;
    this.lastDraw = now;
    const q = this.queued;
    if (q && now >= q.at) {
      this.from = this.last;
      this.cur = q.state;
      this.fadeStart = q.at;
      this.fadeDur = q.dur;
      this.queued = null;
    }
    let px = this.render(this.cur, now);
    const from = this.from;
    if (from && from.length === px.length && now < this.fadeStart + this.fadeDur) {
      const k = smoothstep(Math.max(0, (now - this.fadeStart) / this.fadeDur));
      px = px.map((c, i) => {
        const f = from[i]!;
        return [
          Math.round(f[0] + (c[0] - f[0]) * k),
          Math.round(f[1] + (c[1] - f[1]) * k),
          Math.round(f[2] + (c[2] - f[2]) * k),
        ] as RGB;
      });
    } else this.from = null;
    this.last = px;
    this.paint(px);
  }

  private render(state: PreviewState | null, now: number): RGB[] {
    if (!state) return Array.from({ length: this.n }, () => [0, 0, 0] as RGB);
    return renderPreview(this.demo ? this.demo(state, now) : state, now, this.n);
  }

  private resize(): void {
    const c = this.canvas;
    if (!c) return;
    const r = c.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = r.width;
    this.h = r.height;
    const W = Math.max(1, Math.round(r.width * dpr));
    const H = Math.max(1, Math.round(r.height * dpr));
    if (c.width !== W || c.height !== H) {
      c.width = W;
      c.height = H;
    }
    this.ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.lastKey = "";
  }

  private paint(px: RGB[]): void {
    const ctx = this.ctx;
    if (!ctx || this.w === 0) return;
    const key = px.join(";");
    if (key === this.lastKey) return;
    this.lastKey = key;
    const { w, h } = this;
    const n = px.length;
    const cell = w / n;
    ctx.globalCompositeOperation = "source-over";
    ctx.clearRect(0, 0, w, h);
    if (this.variant === "mini") {
      for (let i = 0; i < n; i++) {
        const [r, g, b] = px[i]!;
        ctx.fillStyle = `rgb(${r},${g},${b})`;
        ctx.fillRect(Math.floor(i * cell), 0, Math.ceil(cell) + 1, h);
      }
      return;
    }
    // Each pixel is a diffused segment: a soft radial glow, added up where neighbours overlap.
    ctx.globalCompositeOperation = "lighter";
    const radius = Math.max(4, Math.min(cell * 0.95, h * 1.1));
    const y = h / 2;
    for (let i = 0; i < n; i++) {
      const [r, g, b] = px[i]!;
      if (r + g + b === 0) continue;
      const x = cell * (i + 0.5);
      const grad = ctx.createRadialGradient(x, y, 0, x, y, radius);
      grad.addColorStop(0, `rgba(${r},${g},${b},1)`);
      grad.addColorStop(0.45, `rgba(${r},${g},${b},0.55)`);
      grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
      ctx.fillStyle = grad;
      ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
    }
  }
}

export function StripPreview({ state, pixels, applyAt = null, variant = "tile", demo, className }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<PreviewEngine | null>(null);
  engineRef.current ??= new PreviewEngine(variant);
  const engine = engineRef.current;
  engine.demo = demo;
  const motion = !useReducedMotion();

  useEffect(() => engine.attach(ref.current!, motion), [engine, motion]);
  useEffect(() => engine.setPixels(pixels), [engine, pixels]);
  useEffect(() => engine.setState(state, applyAt), [engine, state, applyAt]);

  return <canvas ref={ref} className={cls("strip-canvas", `is-${variant}`, className)} aria-hidden="true" />;
}
