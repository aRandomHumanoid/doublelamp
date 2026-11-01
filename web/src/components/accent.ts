// The accent color follows the selected lamp's current color (06 principle 3), adjusted for WCAG AA
// contrast on the current theme. Set through CSSOM, which the strict CSP allows.
import { useEffect } from "react";
import { effectUsesColors } from "@doublelamp/protocol";
import { accentFor } from "../lib/color";
import { useLightTheme } from "../lib/media";
import { resolveControlTarget } from "../live/selectors";
import { useApp, type AppState } from "../live/store";

export const DEFAULT_ACCENT = "#FFB46B";

function accentSource(s: AppState): string {
  if (s.auth !== "ready") return DEFAULT_ACCENT;
  const st = resolveControlTarget(s)?.state;
  if (!st || !effectUsesColors(st.effect.id)) return DEFAULT_ACCENT;
  return st.colors[0] ?? DEFAULT_ACCENT;
}

export function useAccentSync(): void {
  const raw = useApp(accentSource);
  const light = useLightTheme();
  useEffect(() => {
    const { accent, ink } = accentFor(raw, light ? "light" : "dark");
    const root = document.documentElement.style;
    root.setProperty("--accent", accent);
    root.setProperty("--accent-ink", ink);
    root.setProperty("--accent-raw", raw);
  }, [raw, light]);
}
