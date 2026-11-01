// One shared requestAnimationFrame loop for every strip preview. It runs only while some preview is
// visible and animating, and passes the sync-clock time so previews stay in phase with the lamps.
import { clock } from "./clock";

type FrameFn = (syncNow: number) => void;

const subs = new Set<FrameFn>();
let raf = 0;

function loop(): void {
  raf = 0;
  if (subs.size === 0) return;
  const now = clock.now();
  for (const fn of subs) fn(now);
  raf = requestAnimationFrame(loop);
}

export function onFrame(fn: FrameFn): () => void {
  subs.add(fn);
  if (!raf) raf = requestAnimationFrame(loop);
  return () => {
    subs.delete(fn);
    if (subs.size === 0 && raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
  };
}
