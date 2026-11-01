// Replicas, per-field timestamps and the reconnect merge (04 §6, 05 §4). Pure functions, no I/O.
import { FIELD_NAMES, cloneState, fieldEquals, type Dirty, type FieldName, type LampState } from "@doublelamp/protocol";

/** Server ms when each top-level field last changed. 0 = never / unknown. */
export type FieldTs = Record<FieldName, number>;

export interface Replica {
  state: LampState;
  fieldTs: FieldTs;
  rev: number;
}

export function zeroFieldTs(): FieldTs {
  return { on: 0, brightness: 0, colors: 0, effect: 0 };
}

export function uniformFieldTs(ts: number): FieldTs {
  return { on: ts, brightness: ts, colors: ts, effect: ts };
}

export function makeReplica(state: LampState, fieldTs: FieldTs = zeroFieldTs(), rev = 0): Replica {
  return { state: cloneState(state), fieldTs: { ...fieldTs }, rev };
}

export function cloneReplica(r: Replica): Replica {
  return makeReplica(r.state, r.fieldTs, r.rev);
}

/** The most recent change on this replica (used for "most recently changed member wins"). */
export function maxFieldTs(r: Replica): number {
  return Math.max(...FIELD_NAMES.map((f) => r.fieldTs[f]));
}

export function copyField(dst: LampState, src: LampState, f: FieldName): void {
  switch (f) {
    case "on":
      dst.on = src.on;
      break;
    case "brightness":
      dst.brightness = src.brightness;
      break;
    case "colors":
      dst.colors = [...src.colors];
      break;
    case "effect":
      dst.effect = { ...src.effect };
      break;
  }
}

/** Server-clock time of a lamp's offline edit, or null when the age is unknown or the field isn't dirty. */
export function lampEditTs(dirty: Dirty | undefined, f: FieldName, now: number): number | null {
  const age = dirty?.[f]?.age_ms;
  return age === undefined || age === null ? null : now - age;
}

export interface HelloInput {
  state: LampState;
  dirty?: Dirty;
}

export interface MergeResult {
  /** The merged replica; becomes the server's replica. */
  replica: Replica;
  /** `welcome.desired`: null when the server had no state and adopted the lamp's (04 §4.4). */
  desired: LampState | null;
  /** Fields where the lamp's value won (every field when adopted). */
  lampWon: FieldName[];
  /** Fields whose server-side value actually changed as a result. */
  changed: FieldName[];
  adopted: boolean;
}

/**
 * Reconnect merge, per top-level field (`effect` counts as one field):
 * - dirty with an age: lamp_ts = now − age_ms; the lamp wins only if lamp_ts > field_ts[f];
 * - not dirty, unknown age, or older: the server wins;
 * - no server state at all: adopt the lamp's whole state (fields with a known age get that time, others 0).
 */
export function mergeHello(server: Replica | null, hello: HelloInput, now: number): MergeResult {
  if (!server) {
    const fieldTs = zeroFieldTs();
    for (const f of FIELD_NAMES) {
      const ts = lampEditTs(hello.dirty, f, now);
      if (ts !== null) fieldTs[f] = ts;
    }
    return {
      replica: { state: cloneState(hello.state), fieldTs, rev: 1 },
      desired: null,
      lampWon: [...FIELD_NAMES],
      changed: [...FIELD_NAMES],
      adopted: true,
    };
  }
  const r = cloneReplica(server);
  const lampWon: FieldName[] = [];
  const changed: FieldName[] = [];
  for (const f of FIELD_NAMES) {
    const lampTs = lampEditTs(hello.dirty, f, now);
    if (lampTs !== null && lampTs > r.fieldTs[f]) {
      if (!fieldEquals(r.state, hello.state, f)) changed.push(f);
      copyField(r.state, hello.state, f);
      r.fieldTs[f] = lampTs;
      lampWon.push(f);
    }
  }
  if (changed.length) r.rev += 1;
  return { replica: r, desired: cloneState(r.state), lampWon, changed, adopted: false };
}
