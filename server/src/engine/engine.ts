// The sync engine (05 §4): orders changes, merges them, spreads them across link groups and sets apply_at.
// Pure TypeScript: no I/O. Time comes from an injected clock; output goes through EngineHooks.
import {
  DEFAULT_STATE,
  FIELD_NAMES,
  LIMITS,
  TRANSITION,
  applyPatch,
  cloneState,
  fieldEquals,
  pickFields,
  type Dirty,
  type FieldName,
  type LampState,
  type Link,
  type StatePatch,
  type Target,
} from "@doublelamp/protocol";
import { cloneReplica, makeReplica, mergeHello, uniformFieldTs, type Replica } from "./state";
import { DelayTracker, computeApplyAt } from "./timing";
import { pickLinkSource } from "./groups";

export type OwnerRef = { type: "device"; id: string } | { type: "group"; id: number };

/** Data of a `state.set` message to a lamp. */
export interface StateSetOut {
  state: LampState;
  apply_at?: number;
  transition_ms: number;
  origin: string;
}

/** A replica changed; becomes `device.state` / `group.state` for browsers. */
export interface StateChange {
  kind: "device" | "group";
  id: string | number;
  state: LampState;
  origin: string;
  by?: string;
  applyAt?: number;
}

/** One accepted change, for the activity log. */
export interface StateActivity {
  target: Target;
  deviceId: string | null;
  patch: StatePatch;
  origin: string;
  by?: string;
  extra?: Record<string, unknown>;
}

export interface EngineHooks {
  sendState(deviceId: string, msg: StateSetOut): void;
  sendLink(deviceId: string, link: Link | null): void;
  stateChanged(change: StateChange): void;
  persist(owner: OwnerRef): void;
  activity(rec: StateActivity): void;
}

export interface DeviceNode {
  readonly id: string;
  name: string;
  online: boolean;
  groupId: number | null;
  /** The lamp's own replica. While its group is linked this is kept equal to the group replica. */
  replica: Replica | null;
  /** Effect ids from hello.effects; empty = unknown (no check). */
  effects: string[];
  readonly delays: DelayTracker;
}

export interface GroupNode {
  readonly id: number;
  name: string;
  linked: boolean;
  members: string[];
  /** In use while linked. Null until some member's state is known. */
  replica: Replica | null;
}

export type EngineErrorCode = "not_found" | "offline" | "unknown_effect" | "invalid";
export interface EngineError {
  ok: false;
  code: EngineErrorCode;
  message: string;
  field?: string;
}
export type CommandResult = { ok: true; state: LampState; changed: FieldName[]; applyAt?: number } | EngineError;

export interface CommandOptions {
  /** "web", "scene", "schedule", … (05 §4). */
  origin: string;
  /** Session label of the browser that sent it. */
  by?: string;
  transitionMs?: number;
  /** Restart the effect (new epoch) even if the effect fields are unchanged, e.g. a scheduled sunrise. */
  restartEffect?: boolean;
  /** Skip the activity log (fade_off steps). */
  quiet?: boolean;
}

export interface ConnectResult {
  /** `welcome.desired`; null when the server adopted the lamp's state. */
  desired: LampState | null;
  link: Link | null;
  lampWon: FieldName[];
  adopted: boolean;
}

export type LinkResult = { ok: true; changed: boolean; applyAt?: number; sourceId?: string | null } | EngineError;

/** Fade length used when linking makes both lamps blend into the same look. */
export const LINK_TRANSITION_MS = 800;

/**
 * How a patch without an explicit `effect.epoch` gets one:
 * - "command" (web/scene/schedule): a new effect id (or restartEffect) sets epoch = apply_at, or now (05 §4);
 *   parameter changes keep the epoch so animations don't restart while a slider is dragged;
 * - "lamp" (state.report): mirror the firmware, which only restarts the effect when its id changes (03 §4),
 *   so the reporting lamp's animation doesn't jump when the echo arrives.
 */
type EpochPolicy = "command" | "lamp";

function fail(code: EngineErrorCode, message: string, field?: string): EngineError {
  return field ? { ok: false, code, message, field } : { ok: false, code, message };
}

function clampTransition(ms: number | undefined): number {
  const v = ms ?? TRANSITION.tapMs;
  return Math.max(0, Math.min(LIMITS.maxTransitionMs, Math.round(v)));
}

export class SyncEngine {
  private readonly devices = new Map<string, DeviceNode>();
  private readonly groups = new Map<number, GroupNode>();
  private readonly clock: () => number;
  private readonly hooks: EngineHooks;
  private readonly newSeed: () => number;

  constructor(opts: { clock: () => number; hooks: EngineHooks; random?: () => number }) {
    this.clock = opts.clock;
    this.hooks = opts.hooks;
    const rnd = opts.random ?? Math.random;
    this.newSeed = () => Math.floor(rnd() * 0x100000000) >>> 0;
  }

  // ------------------------------------------------------------------ topology

  addDevice(d: { id: string; name: string; replica?: Replica | null; effects?: string[] }): DeviceNode {
    const existing = this.devices.get(d.id);
    if (existing) {
      existing.name = d.name;
      if (d.effects) existing.effects = [...d.effects];
      if (d.replica !== undefined) existing.replica = d.replica;
      return existing;
    }
    const node: DeviceNode = {
      id: d.id,
      name: d.name,
      online: false,
      groupId: null,
      replica: d.replica ?? null,
      effects: d.effects ? [...d.effects] : [],
      delays: new DelayTracker(),
    };
    this.devices.set(d.id, node);
    return node;
  }

  removeDevice(id: string): void {
    const d = this.devices.get(id);
    if (!d) return;
    this.devices.delete(id);
    if (d.groupId !== null) {
      const g = this.groups.get(d.groupId);
      if (g) {
        g.members = g.members.filter((m) => m !== id);
        this.notifyLink(g);
      }
    }
  }

  addGroup(g: { id: number; name: string; linked: boolean; members?: string[]; replica?: Replica | null }): GroupNode {
    const node: GroupNode = { id: g.id, name: g.name, linked: g.linked, members: [], replica: g.replica ?? null };
    this.groups.set(g.id, node);
    for (const m of g.members ?? []) {
      const d = this.devices.get(m);
      if (!d) continue;
      node.members.push(m);
      d.groupId = node.id;
    }
    return node;
  }

  /** Adds a lamp to a group (a lamp is in at most one group). Joining a linked group adopts the group's state. */
  addMember(groupId: number, deviceId: string): void {
    const g = this.groups.get(groupId);
    const d = this.devices.get(deviceId);
    if (!g || !d) throw new Error(`addMember: unknown group ${groupId} or device ${deviceId}`);
    if (d.groupId !== null && d.groupId !== groupId) {
      const old = this.groups.get(d.groupId);
      if (old) {
        old.members = old.members.filter((m) => m !== deviceId);
        this.notifyLink(old);
      }
    }
    if (!g.members.includes(deviceId)) g.members.push(deviceId);
    d.groupId = groupId;
    if (g.linked) {
      if (g.replica) {
        d.replica = cloneReplica(g.replica);
        this.hooks.persist({ type: "device", id: d.id });
      } else if (d.replica) {
        g.replica = cloneReplica(d.replica);
        this.hooks.persist({ type: "group", id: g.id });
      }
    }
    this.notifyLink(g);
  }

  renameDevice(id: string, name: string): void {
    const d = this.devices.get(id);
    if (!d || d.name === name) return;
    d.name = name;
    if (d.groupId !== null) {
      const g = this.groups.get(d.groupId);
      if (g) this.notifyLink(g);
    }
  }

  renameGroup(id: number, name: string): void {
    const g = this.groups.get(id);
    if (!g || g.name === name) return;
    g.name = name;
    this.notifyLink(g);
  }

  // ------------------------------------------------------------------ queries

  getDevice(id: string): DeviceNode | undefined {
    return this.devices.get(id);
  }

  getGroup(id: number): GroupNode | undefined {
    return this.groups.get(id);
  }

  listGroups(): GroupNode[] {
    return [...this.groups.values()].sort((a, b) => a.id - b.id);
  }

  isOnline(id: string): boolean {
    return this.devices.get(id)?.online ?? false;
  }

  linkedGroupOf(deviceId: string): GroupNode | null {
    const d = this.devices.get(deviceId);
    if (!d || d.groupId === null) return null;
    const g = this.groups.get(d.groupId);
    return g && g.linked ? g : null;
  }

  onlineMembers(g: GroupNode): DeviceNode[] {
    const out: DeviceNode[] = [];
    for (const id of g.members) {
      const d = this.devices.get(id);
      if (d?.online) out.push(d);
    }
    return out;
  }

  /** `welcome.link` / `link` for a lamp; null when it's in no group. */
  linkFor(deviceId: string): Link | null {
    const d = this.devices.get(deviceId);
    if (!d || d.groupId === null) return null;
    const g = this.groups.get(d.groupId);
    if (!g) return null;
    return {
      group_id: g.id,
      name: g.name,
      linked: g.linked,
      peers: g.members.filter((m) => m !== deviceId).map((m) => ({ id: m, name: this.devices.get(m)?.name ?? m })),
    };
  }

  /** What a target currently shows: the group state while linked, else the lamp's own state. */
  stateOf(target: Target): LampState | null {
    if ("device" in target) {
      const d = this.devices.get(target.device);
      if (!d) return null;
      const g = this.linkedGroupOf(d.id);
      const r = g?.replica ?? d.replica;
      return r ? cloneState(r.state) : null;
    }
    const g = this.groups.get(target.group);
    if (!g) return null;
    if (g.linked) return g.replica ? cloneState(g.replica.state) : null;
    for (const id of g.members) {
      const r = this.devices.get(id)?.replica;
      if (r) return cloneState(r.state);
    }
    return null;
  }

  recordDelay(deviceId: string, oneWayMs: number): boolean {
    return this.devices.get(deviceId)?.delays.add(oneWayMs) ?? false;
  }

  // ------------------------------------------------------------------ commands

  /**
   * A command from a browser, scene or schedule.
   * - Device target: fails with `offline` if the lamp isn't connected (nothing is queued); goes to the group
   *   if the lamp is in a linked group.
   * - Linked group: updates the group replica even if a member is offline (it catches up on reconnect).
   * - Unlinked group: applied to each online member separately.
   */
  command(target: Target, patch: StatePatch, opts: CommandOptions): CommandResult {
    if ("device" in target) {
      const d = this.devices.get(target.device);
      if (!d) return fail("not_found", "no such lamp");
      if (!d.online) return fail("offline", `${d.name} is offline`);
      const g = this.linkedGroupOf(d.id);
      const bad = this.checkEffect(g ? g.members : [d.id], patch);
      if (bad) return bad;
      return g ? this.applyGroup(g, patch, opts, "command", target, null) : this.applyDevice(d, patch, opts, "command", null);
    }
    const g = this.groups.get(target.group);
    if (!g) return fail("not_found", "no such group");
    const online = this.onlineMembers(g);
    if (online.length === 0) {
      return fail("offline", g.members.length ? "no lamp in this group is online" : "this group has no lamps");
    }
    if (g.linked) {
      const bad = this.checkEffect(g.members, patch);
      if (bad) return bad;
      return this.applyGroup(g, patch, opts, "command", target, null);
    }
    const bad = this.checkEffect(
      online.map((d) => d.id),
      patch,
    );
    if (bad) return bad;
    let first: { state: LampState } | null = null;
    const changed = new Set<FieldName>();
    for (const d of online) {
      const r = this.applyDevice(d, patch, opts, "command", null);
      if (!r.ok) return r;
      first ??= r;
      for (const f of r.changed) changed.add(f);
    }
    return { ok: true, state: first!.state, changed: FIELD_NAMES.filter((f) => changed.has(f)) };
  }

  /**
   * A `state.report` from a lamp: handled like a command, and echoed to every member, including the
   * lamp that reported (05 §4). That echo makes concurrent edits converge.
   */
  report(deviceId: string, patch: StatePatch, origin: string): CommandResult {
    const d = this.devices.get(deviceId);
    if (!d) return fail("not_found", "no such lamp");
    const g = this.linkedGroupOf(d.id);
    const opts: CommandOptions = { origin, transitionMs: TRANSITION.tapMs };
    return g
      ? this.applyGroup(g, patch, opts, "lamp", { device: deviceId }, deviceId)
      : this.applyDevice(d, patch, opts, "lamp", deviceId);
  }

  private checkEffect(memberIds: readonly string[], patch: StatePatch): EngineError | null {
    const id = patch.effect?.id;
    if (id === undefined) return null;
    for (const m of memberIds) {
      const d = this.devices.get(m);
      if (d && d.effects.length > 0 && !d.effects.includes(id)) {
        return fail("unknown_effect", `${d.name} doesn't support the effect "${id}"`, "patch.effect.id");
      }
    }
    return null;
  }

  /** Applies a patch to a replica; returns the fields that changed (and stamps their timestamps). */
  private applyToReplica(
    r: Replica,
    patch: StatePatch,
    now: number,
    applyAt: number | undefined,
    opts: CommandOptions,
    policy: EpochPolicy,
  ): FieldName[] {
    const prev = r.state;
    let p = patch;
    if (policy === "lamp" && p.effect && p.effect.epoch === undefined) {
      const idChanged = p.effect.id !== undefined && p.effect.id !== prev.effect.id;
      p = { ...p, effect: { ...p.effect, epoch: idChanged ? now : prev.effect.epoch } };
    }
    const next = applyPatch(prev, p, { newSeed: this.newSeed }).state;
    const explicitEpoch = p.effect?.epoch !== undefined;
    // A new effect (or an explicit restart, e.g. a scheduled sunrise) starts at apply_at so linked lamps
    // begin in phase. Speed/intensity/color tweaks keep the epoch: both lamps still share it, and dragging
    // a slider doesn't restart the animation on every step.
    if (!explicitEpoch && (opts.restartEffect || next.effect.id !== prev.effect.id)) {
      next.effect.epoch = applyAt ?? now;
    }
    const changed = FIELD_NAMES.filter((f) => !fieldEquals(prev, next, f));
    if (changed.length === 0) return changed;
    r.state = next;
    for (const f of changed) r.fieldTs[f] = now;
    r.rev += 1;
    return changed;
  }

  private applyGroup(
    g: GroupNode,
    patch: StatePatch,
    opts: CommandOptions,
    policy: EpochPolicy,
    target: Target,
    reporter: string | null,
  ): CommandResult {
    const now = this.clock();
    if (!g.replica) g.replica = makeReplica(DEFAULT_STATE);
    const online = this.onlineMembers(g);
    const applyAt = computeApplyAt(
      now,
      online.map((d) => d.delays.p90()),
    );
    const changed = this.applyToReplica(g.replica, patch, now, applyAt, opts, policy);
    if (changed.length === 0) return { ok: true, state: cloneState(g.replica.state), changed };
    this.syncMembersFromGroup(g);
    const state = g.replica.state;
    const transition = clampTransition(opts.transitionMs);
    for (const d of online) {
      this.hooks.sendState(d.id, withApplyAt({ state: cloneState(state), transition_ms: transition, origin: opts.origin }, applyAt));
    }
    this.emitGroup(g, opts.origin, opts.by, applyAt);
    if (!opts.quiet) {
      this.hooks.activity({
        target,
        deviceId: reporter ?? ("device" in target ? target.device : null),
        patch: pickFields(state, changed),
        origin: opts.origin,
        by: opts.by,
        extra: { group_id: g.id },
      });
    }
    return withApplyAtResult({ ok: true, state: cloneState(state), changed }, applyAt);
  }

  private applyDevice(
    d: DeviceNode,
    patch: StatePatch,
    opts: CommandOptions,
    policy: EpochPolicy,
    reporter: string | null,
  ): CommandResult {
    const now = this.clock();
    if (!d.replica) d.replica = makeReplica(DEFAULT_STATE);
    const changed = this.applyToReplica(d.replica, patch, now, undefined, opts, policy);
    if (changed.length === 0) return { ok: true, state: cloneState(d.replica.state), changed };
    const state = d.replica.state;
    this.hooks.persist({ type: "device", id: d.id });
    if (d.online) {
      this.hooks.sendState(d.id, { state: cloneState(state), transition_ms: clampTransition(opts.transitionMs), origin: opts.origin });
    }
    this.hooks.stateChanged({ kind: "device", id: d.id, state: cloneState(state), origin: opts.origin, by: opts.by });
    if (!opts.quiet) {
      this.hooks.activity({
        target: { device: d.id },
        deviceId: reporter ?? d.id,
        patch: pickFields(state, changed),
        origin: opts.origin,
        by: opts.by,
      });
    }
    return { ok: true, state: cloneState(state), changed };
  }

  /** While linked, every group change is copied into each member's own replica. */
  private syncMembersFromGroup(g: GroupNode): void {
    if (!g.replica) return;
    for (const id of g.members) {
      const d = this.devices.get(id);
      if (!d) continue;
      d.replica = cloneReplica(g.replica);
      this.hooks.persist({ type: "device", id });
    }
    this.hooks.persist({ type: "group", id: g.id });
  }

  /** group.state plus device.state for each member (the web app renders tiles from device.state). */
  private emitGroup(g: GroupNode, origin: string, by: string | undefined, applyAt: number | undefined): void {
    if (!g.replica) return;
    const state = g.replica.state;
    this.hooks.stateChanged({ kind: "group", id: g.id, state: cloneState(state), origin, by, applyAt });
    for (const id of g.members) {
      if (this.devices.has(id)) this.hooks.stateChanged({ kind: "device", id, state: cloneState(state), origin, by, applyAt });
    }
  }

  // ------------------------------------------------------------------ connections

  /** A lamp's `hello`: marks it online and runs the reconnect merge (04 §6). */
  connect(deviceId: string, hello: { state: LampState; dirty?: Dirty; effects?: string[] }): ConnectResult {
    const d = this.devices.get(deviceId);
    if (!d) throw new Error(`connect: unknown device ${deviceId}`);
    d.online = true;
    d.delays.clear();
    if (hello.effects && hello.effects.length > 0) d.effects = [...hello.effects];
    const now = this.clock();
    const g = this.linkedGroupOf(d.id);

    if (!g) {
      const m = mergeHello(d.replica, hello, now);
      d.replica = m.replica;
      if (m.lampWon.length) this.hooks.persist({ type: "device", id: d.id });
      if (m.changed.length) {
        this.hooks.stateChanged({ kind: "device", id: d.id, state: cloneState(d.replica.state), origin: "local" });
        if (!m.adopted) {
          this.hooks.activity({
            target: { device: d.id },
            deviceId: d.id,
            patch: pickFields(d.replica.state, m.changed),
            origin: "local",
            extra: { offline_edit: true },
          });
        }
      }
      return { desired: m.desired, link: this.linkFor(d.id), lampWon: m.lampWon, adopted: m.adopted };
    }

    const m = mergeHello(g.replica, hello, now);
    g.replica = m.replica;
    this.syncMembersFromGroup(g);
    if (m.changed.length) {
      // The lamp's offline edit won: spread it to the other members at a shared apply_at.
      const online = this.onlineMembers(g);
      const applyAt = computeApplyAt(
        now,
        online.map((x) => x.delays.p90()),
      );
      for (const o of online) {
        if (o.id === d.id) continue;
        this.hooks.sendState(
          o.id,
          withApplyAt({ state: cloneState(g.replica.state), transition_ms: TRANSITION.tapMs, origin: "local" }, applyAt),
        );
      }
      this.emitGroup(g, "local", undefined, applyAt);
      if (!m.adopted) {
        this.hooks.activity({
          target: { device: d.id },
          deviceId: d.id,
          patch: pickFields(g.replica.state, m.changed),
          origin: "local",
          extra: { offline_edit: true, group_id: g.id },
        });
      }
    }
    return { desired: m.desired, link: this.linkFor(d.id), lampWon: m.lampWon, adopted: m.adopted };
  }

  disconnect(deviceId: string): void {
    const d = this.devices.get(deviceId);
    if (!d) return;
    d.online = false;
    d.delays.clear();
  }

  // ------------------------------------------------------------------ link / unlink

  /**
   * Linking starts the group replica from `matchFrom` or the most recently changed member, then pushes it to
   * every member at a shared apply_at. Unlinking copies the group state into each member's own replica.
   */
  setLinked(groupId: number, linked: boolean, matchFrom?: string): LinkResult {
    const g = this.groups.get(groupId);
    if (!g) return fail("not_found", "no such group");
    if (matchFrom !== undefined && !g.members.includes(matchFrom)) {
      return fail("invalid", "match_from must be a lamp in this group", "match_from");
    }
    if (linked === g.linked) return { ok: true, changed: false };
    const now = this.clock();

    if (!linked) {
      g.linked = false;
      if (g.replica) this.syncMembersFromGroup(g);
      this.hooks.persist({ type: "group", id: g.id });
      this.notifyLink(g);
      return { ok: true, changed: true };
    }

    const sourceId = pickLinkSource(
      g.members.map((id) => ({ id, replica: this.devices.get(id)?.replica ?? null })),
      matchFrom,
    );
    const source = sourceId ? this.devices.get(sourceId) : undefined;
    g.linked = true;
    let applyAt: number | undefined;
    if (source?.replica) {
      // The link itself is the newest change to every field: an offline member's older edits lose to it.
      g.replica = { state: cloneState(source.replica.state), fieldTs: uniformFieldTs(now), rev: (g.replica?.rev ?? 0) + 1 };
      this.syncMembersFromGroup(g);
      const online = this.onlineMembers(g);
      applyAt = computeApplyAt(
        now,
        online.map((x) => x.delays.p90()),
      );
      for (const o of online) {
        this.hooks.sendState(
          o.id,
          withApplyAt({ state: cloneState(g.replica.state), transition_ms: LINK_TRANSITION_MS, origin: "link" }, applyAt),
        );
      }
      this.emitGroup(g, "link", undefined, applyAt);
    } else {
      g.replica = null;
    }
    this.hooks.persist({ type: "group", id: g.id });
    this.notifyLink(g);
    return { ok: true, changed: true, applyAt, sourceId: sourceId ?? null };
  }

  private notifyLink(g: GroupNode): void {
    for (const id of g.members) {
      if (this.devices.get(id)?.online) this.hooks.sendLink(id, this.linkFor(id));
    }
  }
}

function withApplyAt(msg: StateSetOut, applyAt: number | undefined): StateSetOut {
  return applyAt === undefined ? msg : { ...msg, apply_at: applyAt };
}

function withApplyAtResult<T extends { ok: true }>(r: T, applyAt: number | undefined): T & { applyAt?: number } {
  return applyAt === undefined ? r : { ...r, applyAt };
}
