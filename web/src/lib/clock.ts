// The browser's estimate of the server's sync clock (04 §5, 06 A.4). Same filtering as the lamps.
import { SyncClock } from "@doublelamp/protocol";

/** Local monotonic-ish ms. `time.ping.t0` and the pong's receive time both use this base. */
export const localNow = (): number => performance.timeOrigin + performance.now();

export const clock = new SyncClock(localNow);
