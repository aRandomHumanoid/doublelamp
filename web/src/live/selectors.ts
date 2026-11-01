// Derived data for components. Selectors only pick stable slices; derivations run in useMemo so
// Zustand never sees a fresh object per call.
import { useMemo } from "react";
import { EFFECTS, type DeviceView, type EffectDesc, type GroupView, type LampState, type Target } from "@doublelamp/protocol";
import { clamp } from "../lib/color";
import { deviceKey, groupKey, linkedGroupOf, type LiveState } from "./reducers";
import { groupLabel } from "./names";
import { useApp, type AppState } from "./store";

export type LayoutItem = { kind: "group"; group: GroupView; members: string[] } | { kind: "single"; id: string };

/** Groups with two or more known members first (as pairs), then lamps on their own, by name. */
export function computeLayout(devices: Record<string, DeviceView>, groups: Record<number, GroupView>): LayoutItem[] {
  const out: LayoutItem[] = [];
  const placed = new Set<string>();
  for (const g of Object.values(groups).sort((a, b) => a.id - b.id)) {
    const members = g.members.filter((m) => devices[m] && !placed.has(m));
    if (members.length < 2) continue;
    out.push({ kind: "group", group: g, members });
    for (const m of members) placed.add(m);
  }
  const rest = Object.values(devices)
    .filter((d) => !placed.has(d.id))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  for (const d of rest) out.push({ kind: "single", id: d.id });
  return out;
}

export const layoutIds = (layout: readonly LayoutItem[]): string[] =>
  layout.flatMap((i) => (i.kind === "group" ? i.members : [i.id]));

export function useLayout(): LayoutItem[] {
  const devices = useApp((s) => s.devices);
  const groups = useApp((s) => s.groups);
  return useMemo(() => computeLayout(devices, groups), [devices, groups]);
}

/** The selected device id, falling back to the first lamp. */
export function resolveSelected(s: Pick<AppState, "devices" | "groups" | "selected">): string | null {
  if (s.selected && s.devices[s.selected]) return s.selected;
  return layoutIds(computeLayout(s.devices, s.groups))[0] ?? null;
}

export function useSelectedId(): string | null {
  const devices = useApp((s) => s.devices);
  const groups = useApp((s) => s.groups);
  const selected = useApp((s) => s.selected);
  return useMemo(() => resolveSelected({ devices, groups, selected }), [devices, groups, selected]);
}

/** Effects every targeted lamp supports (06 A.3). A lamp that hasn't reported its list doesn't filter. */
export function supportedEffects(devices: readonly DeviceView[]): EffectDesc[] {
  return EFFECTS.filter((e) => devices.every((d) => d.effects.length === 0 || d.effects.includes(e.id)));
}

/** Pixel count for previews: what the lamp reports (02 §3: 10 on this build). */
export function pixelsOf(d: DeviceView | undefined): number {
  return clamp(Math.round(d?.info?.hw.pixels ?? d?.config?.pixel_count ?? 10), 1, 1024);
}

export interface ControlTarget {
  /** Where commands go: the group while linked (06 A.2), otherwise the lamp. */
  target: Target;
  key: string;
  label: string;
  deviceIds: string[];
  devices: DeviceView[];
  state: LampState | null;
  linked: boolean;
  group: GroupView | null;
  online: boolean;
  effects: EffectDesc[];
  pixels: number;
}

export function resolveControlTarget(
  s: Pick<LiveState, "devices" | "groups" | "view"> & Pick<AppState, "selected">,
): ControlTarget | null {
  const sel = resolveSelected(s);
  if (!sel) return null;
  const g = linkedGroupOf(s, sel);
  if (g) {
    const devices = g.members.map((m) => s.devices[m]).filter((d): d is DeviceView => !!d);
    return {
      target: { group: g.id },
      key: groupKey(g.id),
      label: groupLabel(g),
      deviceIds: devices.map((d) => d.id),
      devices,
      state: s.view.groups[g.id] ?? null,
      linked: true,
      group: g,
      online: devices.some((d) => d.online),
      effects: supportedEffects(devices),
      pixels: pixelsOf(devices[0]),
    };
  }
  const d = s.devices[sel]!;
  return {
    target: { device: sel },
    key: deviceKey(sel),
    label: d.name,
    deviceIds: [sel],
    devices: [d],
    state: s.view.devices[sel] ?? null,
    linked: false,
    group: null,
    online: d.online,
    effects: supportedEffects([d]),
    pixels: pixelsOf(d),
  };
}

export function useControlTarget(): ControlTarget | null {
  const devices = useApp((s) => s.devices);
  const groups = useApp((s) => s.groups);
  const view = useApp((s) => s.view);
  const selected = useApp((s) => s.selected);
  return useMemo(() => resolveControlTarget({ devices, groups, view, selected }), [devices, groups, view, selected]);
}
