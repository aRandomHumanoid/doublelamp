#!/usr/bin/env node
// Virtual lamp CLI (08 §1.3). Keyboard controls act as local changes on the lamp when stdin is a TTY.
import { EFFECT_IDS, findEffect, type LampState } from "@doublelamp/protocol";
import { USAGE, parseArgs, type CliOptions } from "./args";
import { VirtualLamp, type AppliedState } from "./lamp";
import { statusLine } from "./render";

const PALETTE = ["#FFB46B", "#FF4000", "#FF0000", "#FF00AA", "#7A2BFF", "#0040FF", "#00C8FF", "#00FF60", "#FFFFFF"];

function describe(s: LampState): string {
  return `on=${s.on} bri=${s.brightness} colors=${s.colors.join(",")} effect=${s.effect.id}(speed ${s.effect.speed}, epoch ${s.effect.epoch})`;
}

async function main(): Promise<void> {
  let opts: CliOptions;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n\n${USAGE}`);
    process.exit(2);
  }
  if (opts.help) {
    process.stdout.write(USAGE);
    return;
  }

  const lamp = new VirtualLamp(opts);
  const tty = process.stdout.isTTY === true && !opts.quiet;
  const interactive = tty && process.stdin.isTTY === true;
  let statusShown = false;

  const clearStatus = () => {
    if (statusShown) process.stdout.write("\r\x1b[2K");
    statusShown = false;
  };
  const print = (line: string) => {
    if (opts.quiet) return;
    clearStatus();
    const time = new Date().toISOString().slice(11, 23);
    process.stdout.write(`${time} [${lamp.name}] ${line}\n`);
  };

  lamp.on("log", print);
  lamp.on("applied", (a: AppliedState) =>
    print(`applied ${describe(a.state)} origin=${a.origin}${a.apply_at !== undefined ? ` apply_at=${a.apply_at} (Δ ${Math.round(a.appliedAt - a.apply_at)} ms)` : ""}`),
  );
  lamp.on("local", (e: { origin: string }) => print(`local change (${e.origin}): ${describe(lamp.state)}`));
  lamp.on("link", () => print(lamp.link ? `link: ${lamp.link.linked ? "linked" : "not linked"} in "${lamp.link.name}" with ${lamp.link.peers.map((p) => p.name).join(", ") || "nobody"}` : "link: none"));
  lamp.on("presets", () => print(`presets: ${lamp.presets.map((p) => `${p.slot}:${p.name}`).join(" ") || "(none)"}`));
  lamp.on("identify", () => print("identify"));
  lamp.on("nudge", (n: { from_name: string; color: string }) => print(`nudge from ${n.from_name} (${n.color})`));
  lamp.on("ota", (o: { phase: string; pct?: number; error?: string }) => print(`ota ${o.phase}${o.pct !== undefined ? ` ${o.pct}%` : ""}${o.error ? `: ${o.error}` : ""}`));

  let quitting = false;
  const quit = async (code = 0) => {
    if (quitting) return;
    quitting = true;
    clearStatus();
    if (interactive) process.stdin.setRawMode(false);
    await lamp.stop();
    print("stopped");
    process.exit(code);
  };
  process.once("SIGINT", () => void quit(0));
  process.once("SIGTERM", () => void quit(0));

  try {
    await lamp.start();
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    process.exit(1);
  }
  print(`device ${lamp.id}, fw ${lamp.firmware}, ${lamp.pixels} px → ${opts.server}`);
  if (opts.exitAfterMs !== undefined) setTimeout(() => void quit(0), opts.exitAfterMs).unref();

  if (interactive) {
    process.stdin.setRawMode(true);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (key: string) => {
      const s = lamp.state;
      switch (key) {
        case "o":
          lamp.localChange({ on: !s.on });
          break;
        case "+":
        case "=":
          lamp.localChange({ on: true, brightness: Math.min(255, s.brightness + 16) });
          break;
        case "-":
        case "_":
          lamp.localChange({ brightness: Math.max(1, s.brightness - 16) });
          break;
        case "c": {
          const i = PALETTE.indexOf(s.colors[0] ?? "");
          lamp.localChange({ colors: [PALETTE[(i + 1) % PALETTE.length]!] });
          break;
        }
        case "e": {
          const ids = EFFECT_IDS.filter((id) => id !== "sync_test");
          const next = ids[(ids.indexOf(s.effect.id) + 1) % ids.length]!;
          const d = findEffect(next)?.defaults;
          lamp.localChange({ effect: { id: next, ...(d ? { speed: d.speed, intensity: d.intensity, duration_ms: d.duration_ms ?? 0 } : {}) } });
          break;
        }
        case "x":
          lamp.setOffline(!lamp.isForcedOffline);
          break;
        case "q":
        case "\u0003":
          void quit(0);
          break;
      }
    });
    setInterval(() => {
      process.stdout.write(`\r\x1b[2K${statusLine(lamp, true)}`);
      statusShown = true;
    }, 66);
  }
}

void main();
