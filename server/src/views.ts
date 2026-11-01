// REST/WS views of lamps and groups (rest.ts DeviceView / GroupView).
import { cloneState, type DeviceView, type GroupView } from "@doublelamp/protocol";
import type { DeviceRecord, DeviceRegistry } from "./devices";
import type { GroupNode, SyncEngine } from "./engine/engine";
import type { SceneStore } from "./scenes";

export class Views {
  constructor(
    private readonly engine: SyncEngine,
    private readonly devices: DeviceRegistry,
    private readonly scenes: SceneStore,
    private readonly clock: () => number,
  ) {}

  deviceFrom(rec: DeviceRecord): DeviceView {
    const node = this.engine.getDevice(rec.id);
    const replica = node?.replica ?? null;
    return {
      id: rec.id,
      name: rec.name,
      online: node?.online ?? false,
      last_seen_at: rec.lastSeenAt,
      fw: rec.fw,
      info: rec.info,
      config: rec.config,
      state: replica ? cloneState(replica.state) : null,
      telemetry: rec.telemetry,
      effects: [...rec.effects],
      group_id: node?.groupId ?? null,
      pending_verify: rec.pendingVerify,
    };
  }

  device(id: string): DeviceView | null {
    const rec = this.devices.get(id);
    return rec ? this.deviceFrom(rec) : null;
  }

  devicesAll(): DeviceView[] {
    return this.devices.all().map((r) => this.deviceFrom(r));
  }

  groupFrom(g: GroupNode): GroupView {
    return {
      id: g.id,
      name: g.name,
      linked: g.linked,
      members: [...g.members],
      state: g.replica ? cloneState(g.replica.state) : null,
    };
  }

  group(id: number): GroupView | null {
    const g = this.engine.getGroup(id);
    return g ? this.groupFrom(g) : null;
  }

  groupsAll(): GroupView[] {
    return this.engine.listGroups().map((g) => this.groupFrom(g));
  }

  snapshot() {
    return {
      devices: this.devicesAll(),
      groups: this.groupsAll(),
      scenes: this.scenes.list(),
      server_time: this.clock(),
    };
  }
}
