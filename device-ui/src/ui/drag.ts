// One drag helper for pointer events, with a touch + mouse fallback for older iOS webviews
// (Pointer Events arrived in iOS 13; captive-portal sheets can be older).

export interface DragHandlers {
  start(x: number, y: number): void;
  move(x: number, y: number): void;
  /** cancelled = the browser took over (e.g. the user started scrolling). */
  end(cancelled: boolean): void;
}

export function onDrag(el: HTMLElement, hd: DragHandlers): void {
  let active: number | null = null;
  if (typeof window.PointerEvent === "function") {
    el.addEventListener("pointerdown", (e) => {
      if (active !== null || (e.pointerType === "mouse" && e.button !== 0)) return;
      active = e.pointerId;
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      hd.start(e.clientX, e.clientY);
    });
    el.addEventListener("pointermove", (e) => {
      if (e.pointerId === active) hd.move(e.clientX, e.clientY);
    });
    const stop = (cancel: boolean) => (e: PointerEvent) => {
      if (e.pointerId !== active) return;
      active = null;
      hd.end(cancel);
    };
    el.addEventListener("pointerup", stop(false));
    el.addEventListener("pointercancel", stop(true));
    return;
  }
  // Fallback: touch events (we prevent scrolling on move), plus mouse.
  let lastTouch = 0;
  el.addEventListener(
    "touchstart",
    (e) => {
      const t = e.changedTouches[0];
      lastTouch = Date.now();
      if (!t || active !== null) return;
      active = t.identifier;
      hd.start(t.clientX, t.clientY);
    },
    { passive: true },
  );
  el.addEventListener(
    "touchmove",
    (e) => {
      for (let i = 0; i < e.changedTouches.length; i++) {
        const t = e.changedTouches[i]!;
        if (t.identifier === active) {
          e.preventDefault();
          hd.move(t.clientX, t.clientY);
        }
      }
    },
    { passive: false },
  );
  const tend = (cancel: boolean) => (e: TouchEvent) => {
    for (let i = 0; i < e.changedTouches.length; i++) {
      if (e.changedTouches[i]!.identifier === active) {
        active = null;
        hd.end(cancel);
      }
    }
  };
  el.addEventListener("touchend", tend(false));
  el.addEventListener("touchcancel", tend(true));
  el.addEventListener("mousedown", (e) => {
    // Ignore the compatibility mouse events browsers emit after a touch.
    if (e.button !== 0 || active !== null || Date.now() - lastTouch < 1000) return;
    active = -1;
    e.preventDefault();
    hd.start(e.clientX, e.clientY);
    const mm = (ev: MouseEvent) => hd.move(ev.clientX, ev.clientY);
    const mu = () => {
      window.removeEventListener("mousemove", mm);
      window.removeEventListener("mouseup", mu);
      active = null;
      hd.end(false);
    };
    window.addEventListener("mousemove", mm);
    window.addEventListener("mouseup", mu);
  });
}
