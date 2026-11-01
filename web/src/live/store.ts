// The app store (Zustand). Live lamp state comes only from the WebSocket (06 A.4); the rest is session,
// connection and UI state.
import { create } from "zustand";
import type { SessionInfo } from "@doublelamp/protocol";
import { emptyLive, type LiveState } from "./reducers";
import { KEYS, load, save } from "../lib/storage";

export type AuthStatus = "checking" | "offline" | "login" | "ready";
export type ConnStatus = "idle" | "connecting" | "open" | "closed";

export interface Toast {
  id: number;
  kind: "error" | "info" | "ok";
  text: string;
}

export interface AppState extends LiveState {
  auth: AuthStatus;
  /** Shown on the login screen, e.g. after a session was revoked. */
  authNotice: string | null;
  session: SessionInfo | null;
  conn: ConnStatus;
  /** Socket open and a snapshot received on it: controls are enabled only then. */
  live: boolean;
  /** Failed connection attempts since the last snapshot. */
  failures: number;
  /** The tile the control sheet follows (a device id; its linked group when linked). */
  selected: string | null;
  toasts: Toast[];
}

export function initialState(): AppState {
  return {
    ...emptyLive(),
    auth: "checking",
    authNotice: null,
    session: null,
    conn: "idle",
    live: false,
    failures: 0,
    selected: load<string | null>(KEYS.selected, null),
    toasts: [],
  };
}

export const useApp = create<AppState>()(() => initialState());

let toastSeq = 0;

export function toast(kind: Toast["kind"], text: string, ms = kind === "error" ? 6000 : 3500): void {
  const id = ++toastSeq;
  useApp.setState((s) => ({ toasts: [...s.toasts.filter((t) => t.text !== text), { id, kind, text }].slice(-4) }));
  setTimeout(() => dismissToast(id), ms);
}

export function dismissToast(id: number): void {
  useApp.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}

export function selectDevice(id: string): void {
  useApp.setState({ selected: id });
  save(KEYS.selected, id);
}

/** Clears live state (on sign-out). */
export function resetLive(): void {
  useApp.setState({ ...emptyLive(), conn: "idle", live: false, failures: 0 });
}
