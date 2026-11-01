// The cases in packages/protocol/test-vectors/merge/ are the specification for the reconnect merge (05 §4).
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { dirtySchema, lampStateSchema, type LampState } from "@doublelamp/protocol";
import { SyncEngine } from "../../src/engine/engine";
import { makeReplica, mergeHello, type FieldTs } from "../../src/engine/state";
import { Recorder } from "./engine-helpers";

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/protocol/test-vectors/merge");

interface VectorCase {
  name: string;
  now: number;
  server: { state: unknown; field_ts: FieldTs } | null;
  hello: { state: unknown; dirty: unknown };
  expected: { adopted: boolean; lamp_won: string[]; desired: LampState | null; state?: LampState; field_ts: FieldTs };
}

const files = readdirSync(DIR).filter((f) => f.endsWith(".json"));

describe("merge test vectors", () => {
  it("exist", () => {
    expect(files.length).toBeGreaterThanOrEqual(2);
  });

  for (const file of files) {
    const doc = JSON.parse(readFileSync(path.join(DIR, file), "utf8")) as { cases: VectorCase[] };
    describe(file, () => {
      for (const c of doc.cases) {
        const hello = { state: lampStateSchema.parse(c.hello.state) as LampState, dirty: dirtySchema.parse(c.hello.dirty) };
        const server = c.server ? makeReplica(lampStateSchema.parse(c.server.state) as LampState, c.server.field_ts, 3) : null;
        const expectedState = c.expected.state ?? c.expected.desired!;

        it(c.name, () => {
          const m = mergeHello(server, hello, c.now);
          expect(m.adopted).toBe(c.expected.adopted);
          expect(m.lampWon).toEqual(c.expected.lamp_won);
          expect(m.desired).toEqual(c.expected.desired);
          expect(m.replica.state).toEqual(expectedState);
          expect(m.replica.fieldTs).toEqual(c.expected.field_ts);
        });

        for (const linked of [false, true]) {
          it(`${c.name} (through the engine, ${linked ? "linked group" : "single lamp"})`, () => {
            const rec = new Recorder();
            const engine = new SyncEngine({ clock: () => c.now, hooks: rec });
            engine.addDevice({ id: "dl-00000a", name: "A", replica: linked ? null : server });
            engine.addDevice({ id: "dl-00000b", name: "B" });
            engine.addGroup({ id: 1, name: "G", linked, members: ["dl-00000a", "dl-00000b"], replica: linked ? server : null });
            const res = engine.connect("dl-00000a", hello);
            expect(res.desired).toEqual(c.expected.desired);
            const r = linked ? engine.getGroup(1)!.replica! : engine.getDevice("dl-00000a")!.replica!;
            expect(r.state).toEqual(expectedState);
            expect(r.fieldTs).toEqual(c.expected.field_ts);
            expect(engine.getDevice("dl-00000a")!.replica!.state).toEqual(expectedState);
          });
        }
      }
    });
  }
});
