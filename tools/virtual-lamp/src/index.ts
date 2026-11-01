// Library entry: the server's integration tests drive VirtualLamp directly.
export {
  VirtualLamp,
  DEFAULT_TIMINGS,
  compareVersions,
  defaultStateDir,
  deviceIdForName,
  type AppliedState,
  type LampStatus,
  type LampTimings,
  type ReportOrigin,
  type VirtualLampOptions,
} from "./lamp";
export { parseArgs, parseDuration, USAGE, type CliOptions } from "./args";
export { statusLine, stripPixels } from "./render";
