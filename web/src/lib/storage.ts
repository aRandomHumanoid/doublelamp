// localStorage that never throws (private mode, quota, or no storage at all in tests).

function store(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function load<T>(key: string, fallback: T): T {
  try {
    const raw = store()?.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function save(key: string, value: unknown): void {
  try {
    store()?.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

export const KEYS = {
  selected: "dl.selected",
  label: "dl.label",
  recentColors: "dl.recentColors",
  localAddresses: "dl.localAddresses",
} as const;
