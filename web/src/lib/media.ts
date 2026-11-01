import { useCallback, useSyncExternalStore } from "react";

export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (cb: () => void) => {
      const m = window.matchMedia(query);
      m.addEventListener("change", cb);
      return () => m.removeEventListener("change", cb);
    },
    [query],
  );
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches, () => false);
}

export const useReducedMotion = (): boolean => useMediaQuery("(prefers-reduced-motion: reduce)");
export const useLightTheme = (): boolean => useMediaQuery("(prefers-color-scheme: light)");
/** Side-by-side tiles with the control panel on the right (06 A.2). */
export const useWide = (): boolean => useMediaQuery("(min-width: 900px)");
