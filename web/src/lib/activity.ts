// Activity log lines (06 A.1): "Lamp B → Candle · web, Kitchen iPad", "Lamp A → off · Apple Home".
// The server's event `data` is free-form, so this reads it defensively.
import { findEffect, type EventRecord } from "@doublelamp/protocol";
import { colorName } from "./color";
import { capitalize, percent } from "./format";

export interface ActivityContext {
  deviceName(id: string): string;
  groupName(id: number): string;
  sceneName?(id: number): string | undefined;
}

export type ActivityTone = "state" | "presence" | "offline" | "ota" | "security" | "info" | "error";

export interface ActivityLine {
  text: string;
  /** Where the change came from: "web, Kitchen iPad", "Apple Home", … */
  source: string | null;
  tone: ActivityTone;
}

const ORIGINS: Record<string, string> = {
  web: "web",
  local: "lamp UI",
  homekit: "Apple Home",
  button: "button",
  timer: "timer",
  schedule: "schedule",
  scene: "scene",
  boot: "lamp restart",
  cloud: "server",
  server: "server",
};

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

export function originLabel(origin: unknown): string | null {
  const o = str(origin);
  return o ? (ORIGINS[o] ?? o) : null;
}

export function sourceText(origin: unknown, by: string | null | undefined): string | null {
  const parts = [originLabel(origin), by || null].filter((x): x is string => !!x);
  return parts.length ? parts.join(", ") : null;
}

/** "Candle", "off", "Amber, 72 %": what a patch (or a full state) changes. */
export function describeChange(p: unknown): string {
  if (!isObj(p)) return "changed";
  if (p.on === false) return "off";
  const parts: string[] = [];
  const effect = isObj(p.effect) ? p.effect : null;
  const id = effect ? str(effect.id) : undefined;
  if (id) parts.push(findEffect(id)?.name ?? id);
  if (Array.isArray(p.colors) && p.colors.length) {
    parts.push(
      p.colors
        .filter((c): c is string => typeof c === "string")
        .map((c) => capitalize(colorName(c)))
        .join(" + "),
    );
  }
  const b = num(p.brightness);
  if (b !== undefined) parts.push(`${percent(b)} %`);
  if (!id && effect && Object.keys(effect).length) parts.push("effect settings");
  if (!parts.length) return p.on === true ? "on" : "changed";
  return parts.join(", ");
}

function subjectOf(e: EventRecord, d: Obj, ctx: ActivityContext): string {
  const t = isObj(d.target) ? d.target : null;
  const g = t ? num(t.group) : undefined;
  if (g !== undefined) return ctx.groupName(g);
  if (e.device_id) return ctx.deviceName(e.device_id);
  const dev = t ? str(t.device) : str(d.device_id);
  if (dev) return ctx.deviceName(dev);
  const gid = num(d.group_id);
  if (gid !== undefined) return ctx.groupName(gid);
  return "";
}

function humanize(kind: string): string {
  return capitalize(kind.replace(/[._]/g, " "));
}

export function formatEvent(e: EventRecord, ctx: ActivityContext): ActivityLine {
  const d: Obj = isObj(e.data) ? e.data : {};
  const subject = subjectOf(e, d, ctx);
  const who = subject || "A lamp";
  const kind = e.kind.toLowerCase();
  const source = sourceText(d.origin, e.by_label);

  if (kind === "state" || kind === "command" || kind === "state.report" || kind === "state.change") {
    const change = d.patch !== undefined ? d.patch : d.state !== undefined ? d.state : d;
    return { text: `${who} → ${describeChange(change)}`, source, tone: "state" };
  }
  if (kind.startsWith("scene")) {
    const sid = num(d.scene_id) ?? num(d.id);
    const name = str(d.name) ?? (sid !== undefined ? ctx.sceneName?.(sid) : undefined) ?? "a scene";
    return { text: subject ? `${subject} → scene “${name}”` : `Scene “${name}” ${kind.includes("apply") ? "applied" : "changed"}`, source, tone: "state" };
  }
  if (["connect", "connected", "online", "device.online", "device.connect"].includes(kind)) {
    return { text: `${who} connected`, source: null, tone: "presence" };
  }
  if (["disconnect", "disconnected", "offline", "device.offline", "device.disconnect"].includes(kind)) {
    return { text: `${who} disconnected`, source: null, tone: "offline" };
  }
  if (kind === "presence") {
    return { text: `${who} ${d.online === false ? "disconnected" : "connected"}`, source: null, tone: d.online === false ? "offline" : "presence" };
  }
  if (kind.startsWith("ota") || kind === "firmware") {
    const version = str(d.version);
    const status = str(d.status) ?? str(d.phase) ?? str(d.result);
    const error = str(d.error);
    const what = version ? `firmware ${version}` : "firmware update";
    const tail = status === "done" ? "installed" : status === "failed" ? `failed${error ? `: ${error}` : ""}` : (status ?? "started");
    return { text: `${who} ${what} ${tail}`, source, tone: status === "failed" ? "error" : "ota" };
  }
  if (kind === "login" || kind === "auth.login") return { text: "Signed in", source: e.by_label, tone: "security" };
  if (kind.includes("login") && (kind.includes("fail") || kind.includes("denied"))) {
    const ip = str(d.ip);
    return { text: `Failed sign-in attempt${ip ? ` from ${ip}` : ""}`, source: null, tone: "error" };
  }
  if (kind === "logout" || kind === "auth.logout") return { text: "Signed out", source: e.by_label, tone: "security" };
  if (kind.includes("password")) return { text: "Shared password changed", source: e.by_label, tone: "security" };
  if (kind.includes("session") && kind.includes("revok")) {
    return { text: `Signed out ${str(d.label) ?? "a browser"}`, source: e.by_label, tone: "security" };
  }
  if (["claim", "claimed", "pair", "paired", "device.claimed", "device.paired"].includes(kind)) {
    return { text: `${who} paired with the server`, source: e.by_label, tone: "info" };
  }
  if (["unclaim", "unclaimed", "unpair", "unpaired", "device.removed", "removed"].includes(kind)) {
    return { text: `${who} unpaired`, source: e.by_label, tone: "info" };
  }
  if (kind.startsWith("link") || kind === "unlink" || kind.startsWith("group")) {
    const linked = d.linked === true || kind === "link" || kind === "linked";
    const unlinked = d.linked === false || kind === "unlink" || kind === "unlinked";
    const from = str(d.match_from);
    if (linked && !unlinked) {
      return { text: `Lamps linked${from ? ` · matched to ${ctx.deviceName(from)}` : ""}`, source: e.by_label, tone: "info" };
    }
    if (unlinked) return { text: "Lamps unlinked", source: e.by_label, tone: "info" };
  }
  if (kind === "button") return { text: `${who} button: ${str(d.gesture) ?? "pressed"}`, source: null, tone: "info" };
  if (kind === "crash") return { text: `${who} restarted after a crash${str(d.summary) ? `: ${str(d.summary)}` : ""}`, source: null, tone: "error" };
  if (kind === "log") {
    const level = str(d.level) ?? "log";
    return { text: `${who}: ${str(d.msg) ?? level}`, source: null, tone: level === "error" ? "error" : "info" };
  }
  if (kind.startsWith("schedule")) {
    const name = str(d.name);
    const result = str(d.result) ?? str(d.last_result);
    return { text: `Schedule${name ? ` “${name}”` : ""} ran${result ? `: ${result}` : ""}`, source: null, tone: "info" };
  }
  if (kind === "rename" || kind === "device.renamed") {
    return { text: `${who} renamed${str(d.name) ? ` to “${str(d.name)}”` : ""}`, source: e.by_label, tone: "info" };
  }
  return { text: subject ? `${humanize(e.kind)} · ${subject}` : humanize(e.kind), source, tone: "info" };
}
