// Server → browser messages into the store (04 §7.2).
import { decodeMessage, serverToClient } from "@doublelamp/protocol";
import { clock, localNow } from "../lib/clock";
import { KEYS, save } from "../lib/storage";
import { applyServerMessage, reduceError, sweepPending, type ServerMsg } from "./reducers";
import { errorText, targetName } from "./names";
import { toast, useApp } from "./store";

export interface LocalAddress {
  id: string;
  name: string;
  ip: string | null;
  host: string | null;
}

/** Saved so the offline shell can point at the lamps' own pages (06 A.5). */
function rememberLocalAddresses(): void {
  const list: LocalAddress[] = Object.values(useApp.getState().devices)
    .filter((d) => d.info && (d.info.net.ip || d.info.host))
    .map((d) => ({ id: d.id, name: d.name, ip: d.info?.net.ip || null, host: d.info?.host || null }));
  if (list.length) save(KEYS.localAddresses, list);
}

export function handleServerMessage(msg: ServerMsg): void {
  switch (msg.type) {
    case "time.pong":
      clock.addSample(msg.data.t0, msg.data.t1, msg.data.t2, localNow());
      return;
    case "snapshot":
      useApp.setState((s) => ({ ...applyServerMessage(s, msg, Date.now()), live: true, failures: 0 }));
      rememberLocalAddresses();
      return;
    case "error": {
      const before = useApp.getState();
      const { state, pending } = msg.ref ? reduceError(before, msg.ref) : { state: before, pending: null };
      if (state !== before) useApp.setState(state, true);
      toast("error", errorText(msg.data.code, msg.data.message, pending ? targetName(before, pending.target) : null));
      return;
    }
    case "device.updated":
      useApp.setState((s) => applyServerMessage(s, msg, Date.now()));
      rememberLocalAddresses();
      return;
    default:
      useApp.setState((s) => applyServerMessage(s, msg, Date.now()));
  }
}

/** Decodes one text frame with the protocol schemas. Unknown types are ignored (04 §1). */
export function handleServerText(text: string): ServerMsg | null {
  const r = decodeMessage(serverToClient, text);
  if (!r.ok) {
    if (r.code === "unsupported") return null;
    console.warn(`[ws] dropped ${r.type ?? "frame"}: ${r.message}`);
    // Without a snapshot the app can't show anything, so say why instead of "Connecting…" forever.
    if (r.type === "snapshot") toast("error", `The server sent data this app can't read (${r.message}). Update the app or the server.`, 15_000);
    return null;
  }
  handleServerMessage(r.msg);
  return r.msg;
}

let sweeper: ReturnType<typeof setInterval> | null = null;

export function startSweeper(): void {
  sweeper ??= setInterval(() => {
    if (useApp.getState().pending.length) useApp.setState((s) => sweepPending(s, Date.now()));
  }, 1000);
}

export function stopSweeper(): void {
  if (sweeper) clearInterval(sweeper);
  sweeper = null;
}
