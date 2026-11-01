// Command-line parsing for the virtual lamp CLI.
import type { ReportOrigin, VirtualLampOptions } from "./lamp";

export interface CliOptions extends VirtualLampOptions {
  exitAfterMs?: number;
  quiet: boolean;
  help: boolean;
}

export const USAGE = `Usage: npm run virtual-lamp -- --server <url> [options]

  --server <url>          Server base URL, e.g. http://localhost:8080 (required)
  --code <XXXX-XXXX>      Pairing code (needed on the first run; later runs reuse the stored token)
  --name <name>           Lamp name (default "Virtual lamp")
  --id <dl-xxxxxx>        Device id (default: derived from the name)
  --pixels <n>            Strip length in pixels (default 10)
  --fw <version>          Firmware version to report (default 1.0.0)
  --state-dir <dir>       Where credentials and state are kept (default: <os temp>/doublelamp-virtual-lamps)
  --latency <ms>          Simulated one-way network delay
  --jitter <ms>           ± random delay on top of --latency
  --drop <p>              Probability of losing each message, e.g. 0.05
  --offline-after <dur>   Go offline after this long (e.g. 30s, 2m)
  --offline-for <dur>     ...and come back after this long (default: stay offline; press x)
  --crash-on-ota          A received update "crashes": come back on the old firmware with rollback: true
  --report-origin <o>     Origin of local changes: local | homekit | button (default local)
  --exit-after <dur>      Quit after this long
  --quiet                 No status line or event log
`;

/** "30s", "2m", "1h", "500ms"; a bare number uses `bareUnit`. */
export function parseDuration(raw: string, bareUnit: "ms" | "s" = "s"): number {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(raw.trim());
  if (!m) throw new Error(`bad duration "${raw}" (try 30s, 2m, 500ms)`);
  const n = Number(m[1]);
  const unit = m[2] ?? bareUnit;
  return Math.round(n * { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[unit]!);
}

function num(raw: string, name: string, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`--${name} must be a number from ${min} to ${max}`);
  return n;
}

export function parseArgs(argv: readonly string[]): CliOptions {
  const out: CliOptions = { server: "", quiet: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const [flag, inline] = arg.startsWith("--") && arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined];
    const value = (): string => {
      if (inline !== undefined) return inline;
      const v = argv[++i];
      if (v === undefined) throw new Error(`${flag} needs a value`);
      return v;
    };
    switch (flag) {
      case "--server":
        out.server = value();
        break;
      case "--code":
        out.code = value();
        break;
      case "--name":
        out.name = value();
        break;
      case "--id":
        out.id = value();
        break;
      case "--pixels":
        out.pixels = num(value(), "pixels", 1, 1024);
        break;
      case "--fw":
        out.fw = value();
        break;
      case "--state-dir":
        out.stateDir = value();
        break;
      case "--latency":
        out.latencyMs = parseDuration(value(), "ms");
        break;
      case "--jitter":
        out.jitterMs = parseDuration(value(), "ms");
        break;
      case "--drop":
        out.drop = num(value(), "drop", 0, 1);
        break;
      case "--offline-after":
        out.offlineAfterMs = parseDuration(value());
        break;
      case "--offline-for":
        out.offlineForMs = parseDuration(value());
        break;
      case "--crash-on-ota":
        out.crashOnOta = true;
        break;
      case "--report-origin": {
        const o = value();
        if (o !== "local" && o !== "homekit" && o !== "button") throw new Error("--report-origin must be local, homekit or button");
        out.reportOrigin = o as ReportOrigin;
        break;
      }
      case "--exit-after":
        out.exitAfterMs = parseDuration(value());
        break;
      case "--quiet":
        out.quiet = true;
        break;
      case "-h":
      case "--help":
        out.help = true;
        break;
      default:
        throw new Error(`unknown option ${arg}`);
    }
  }
  if (!out.help) {
    if (!out.server) throw new Error("--server is required");
    try {
      const u = new URL(out.server);
      if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error();
    } catch {
      throw new Error(`--server must be an http(s) URL, got "${out.server}"`);
    }
  }
  return out;
}
