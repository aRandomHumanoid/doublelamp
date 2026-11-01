import { describe, expect, it } from "vitest";
import type { EventRecord } from "@doublelamp/protocol";
import { formatEvent, type ActivityContext } from "../src/lib/activity";
import { describeWhen } from "../src/lib/schedule";

const ctx: ActivityContext = {
  deviceName: (id) => ({ "dl-aaaaaa": "Lamp A", "dl-bbbbbb": "Lamp B" })[id] ?? id,
  groupName: () => "Both lamps",
};

const ev = (over: Partial<EventRecord>): EventRecord => ({
  id: 1,
  ts: 0,
  kind: "state",
  device_id: null,
  by_label: null,
  data: null,
  ...over,
});

describe("activity lines (06 A.1)", () => {
  it("Lamp B → Candle · web, Kitchen iPad", () => {
    const line = formatEvent(
      ev({ device_id: "dl-bbbbbb", by_label: "Kitchen iPad", data: { origin: "web", patch: { effect: { id: "candle" } } } }),
      ctx,
    );
    expect(line).toMatchObject({ text: "Lamp B → Candle", source: "web, Kitchen iPad", tone: "state" });
  });

  it("Lamp A → off · Apple Home", () => {
    const line = formatEvent(ev({ device_id: "dl-aaaaaa", data: { origin: "homekit", patch: { on: false } } }), ctx);
    expect(line).toMatchObject({ text: "Lamp A → off", source: "Apple Home" });
  });

  it("names group targets, colors and brightness", () => {
    const line = formatEvent(ev({ data: { target: { group: 1 }, origin: "schedule", patch: { colors: ["#FF0000"], brightness: 255 } } }), ctx);
    expect(line.text).toBe("Both lamps → Red, 100 %");
    expect(line.source).toBe("schedule");
  });

  it("formats presence, OTA and failed logins, and falls back for unknown kinds", () => {
    expect(formatEvent(ev({ kind: "disconnect", device_id: "dl-aaaaaa" }), ctx).text).toBe("Lamp A disconnected");
    expect(formatEvent(ev({ kind: "ota", device_id: "dl-bbbbbb", data: { version: "1.3.0", status: "done" } }), ctx).text).toBe(
      "Lamp B firmware 1.3.0 installed",
    );
    expect(formatEvent(ev({ kind: "login_failed", data: { ip: "203.0.113.9" } }), ctx)).toMatchObject({
      text: "Failed sign-in attempt from 203.0.113.9",
      tone: "error",
    });
    expect(formatEvent(ev({ kind: "something_new", device_id: "dl-aaaaaa" }), ctx).text).toBe("Something new · Lamp A");
  });
});

describe("schedule text", () => {
  it("describes daily and cron schedules", () => {
    expect(describeWhen({ type: "daily", time: "07:00", days: ["mon", "tue", "wed", "thu", "fri"], tz: "UTC" })).toBe("Weekdays at 07:00");
    expect(describeWhen({ type: "daily", time: "22:30", days: ["sat", "mon"], tz: "UTC" })).toBe("Mon, Sat at 22:30");
    expect(describeWhen({ type: "cron", expr: "0 7 * * 1-5", tz: "UTC" })).toBe("Cron 0 7 * * 1-5");
  });
});
