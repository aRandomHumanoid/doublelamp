// Names for lamps, groups and targets, and error text for toasts.
import type { GroupView, Target } from "@doublelamp/protocol";
import type { LiveState } from "./reducers";
import { ApiError } from "../api/http";

export function deviceName(s: Pick<LiveState, "devices">, id: string): string {
  return s.devices[id]?.name ?? id;
}

/** "Both lamps" for the usual pair, otherwise the group's own name. */
export function groupLabel(g: GroupView | undefined): string {
  if (!g) return "Lamps";
  return g.members.length === 2 ? "Both lamps" : g.name || "Lamps";
}

export function targetName(s: Pick<LiveState, "devices" | "groups">, t: Target): string {
  return "device" in t ? deviceName(s, t.device) : groupLabel(s.groups[t.group]);
}

/** Toast text for an error code (04 §8). `subject` is the lamp or group the request was about. */
export function errorText(code: string, message: string, subject?: string | null): string {
  const who = subject || "The lamp";
  switch (code) {
    case "offline":
      return `${who} ${subject === "Both lamps" ? "are" : "is"} offline`;
    case "unknown_effect":
      return `${who} doesn't support that effect`;
    case "rate_limited":
      return "Too many changes at once. Try again in a moment.";
    case "network":
      return "No connection to server";
    case "auth_required":
      return "Please sign in again";
    case "forbidden":
      return message || "Not allowed";
    case "too_large":
      return "That's too large for the server";
    case "busy":
      return "The server is busy. Try again.";
    case "server_error":
      return message || "Server error";
    default:
      return message || code.replace(/_/g, " ");
  }
}

export function describeError(e: unknown, subject?: string | null): string {
  if (e instanceof ApiError) return errorText(e.code, e.message, subject);
  if (e instanceof Error) return e.message;
  return "Something went wrong";
}
