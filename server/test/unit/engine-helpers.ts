import type { Link } from "@doublelamp/protocol";
import { SyncEngine, type EngineHooks, type OwnerRef, type StateActivity, type StateChange, type StateSetOut } from "../../src/engine/engine";
import type { Logger } from "../../src/log";

/** A logger that drops everything. */
export function silentLogger(): Logger {
  const noop = () => {};
  const log: Record<string, unknown> = { level: "silent", fatal: noop, error: noop, warn: noop, info: noop, debug: noop, trace: noop, silent: noop };
  log.child = () => log;
  return log as unknown as Logger;
}

export class Recorder implements EngineHooks {
  sent: { deviceId: string; msg: StateSetOut }[] = [];
  links: { deviceId: string; link: Link | null }[] = [];
  changes: StateChange[] = [];
  persisted: OwnerRef[] = [];
  activities: StateActivity[] = [];

  sendState(deviceId: string, msg: StateSetOut): void {
    this.sent.push({ deviceId, msg });
  }
  sendLink(deviceId: string, link: Link | null): void {
    this.links.push({ deviceId, link });
  }
  stateChanged(change: StateChange): void {
    this.changes.push(change);
  }
  persist(owner: OwnerRef): void {
    this.persisted.push(owner);
  }
  activity(rec: StateActivity): void {
    this.activities.push(rec);
  }
  clear(): void {
    this.sent = [];
    this.links = [];
    this.changes = [];
    this.persisted = [];
    this.activities = [];
  }
  sentTo(id: string): StateSetOut[] {
    return this.sent.filter((s) => s.deviceId === id).map((s) => s.msg);
  }
}

export interface Rig {
  engine: SyncEngine;
  rec: Recorder;
  clock: { now: number };
  advance(ms: number): void;
}

/** An engine with a manual clock, a deterministic RNG and two lamps A and B in group 1. */
export function makeRig(opts: { linked?: boolean; online?: boolean } = {}): Rig {
  const clock = { now: 1_761_650_000_000 };
  const rec = new Recorder();
  let seed = 1;
  const engine = new SyncEngine({
    clock: () => clock.now,
    hooks: rec,
    random: () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    },
  });
  engine.addDevice({ id: "dl-00000a", name: "Lamp A" });
  engine.addDevice({ id: "dl-00000b", name: "Lamp B" });
  engine.addGroup({ id: 1, name: "Both lamps", linked: false, members: ["dl-00000a", "dl-00000b"] });
  return {
    engine,
    rec,
    clock,
    advance(ms: number) {
      clock.now += ms;
    },
  };
}

export const A = "dl-00000a";
export const B = "dl-00000b";
