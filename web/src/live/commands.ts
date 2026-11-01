// Browser → server commands over the WebSocket, applied optimistically (06 A.4).
import { TRANSITION, randomSeed, type LampState, type StatePatch, type Target } from "@doublelamp/protocol";
import { clock } from "../lib/clock";
import { addPending, displayOf, keyOf } from "./reducers";
import { useApp } from "./store";

export interface Transport {
  send(type: string, data: unknown): boolean;
}

let transport: Transport = { send: () => false };

export function setTransport(t: Transport): void {
  transport = t;
}

let counter = 0;

/** A command id, unique per tab and ≤ 40 chars (04 §7.2). */
export function newCid(): string {
  counter = (counter + 1) % 0x7fffffff;
  return `c${Date.now().toString(36)}${counter.toString(36)}`;
}

/** An effect switch gets a local epoch and seed so the optimistic preview starts now; the server picks its own. */
function localPatch(patch: StatePatch, current: LampState | null): StatePatch {
  const id = patch.effect?.id;
  if (!id || !current || id === current.effect.id) return patch;
  return { ...patch, effect: { epoch: Math.round(clock.now()), seed: randomSeed(), ...patch.effect } };
}

/**
 * Sends `cmd` and overlays the patch at once. Returns the cid, or null when there's no live connection
 * (controls are disabled then, and nothing is queued).
 */
export function sendCommand(target: Target, patch: StatePatch, transitionMs: number = TRANSITION.tapMs): string | null {
  const s = useApp.getState();
  if (!s.live) return null;
  const cid = newCid();
  const local = localPatch(patch, displayOf(s, target));
  if (!transport.send("cmd", { target, patch, transition_ms: transitionMs, cid })) return null;
  useApp.setState((st) => addPending(st, { cid, key: keyOf(target), target, patch: local, transitionMs, sentAt: Date.now() }));
  return cid;
}
