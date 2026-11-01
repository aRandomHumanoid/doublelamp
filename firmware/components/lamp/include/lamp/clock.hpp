// The sync clock (03 §12): monotonic time plus an offset that tracks the server's clock.
// Steps of 250 ms or more apply at once; smaller corrections slew at most 1 ms per 100 ms.
#pragma once

#include <cstdint>

namespace lamp::clock {

int64_t mono_ms();
int64_t sync_now_ms();
/** New best offset estimate from the server (server − mono). */
void set_server_offset(int64_t offset_ms);
/** Before the first server sync: offset from SNTP wall time. */
void set_from_wall_clock();
bool synced_to_server();

}  // namespace lamp::clock
