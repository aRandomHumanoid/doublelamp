// 4 KB RAM copy of the log for GET /api/v1/logs (01 §8), plus a hook that forwards warnings
// and errors to the server.
#pragma once

#include <cstddef>

namespace lamp::log_ring {

void init();
/** Copies the buffered log (oldest first) into out; returns bytes written (no NUL). */
size_t read(char* out, size_t cap);

using WarnHook = void (*)(char level, const char* line);
/** Called for W/E lines, at most once per second; must not log. */
void set_warn_hook(WarnHook hook);

}  // namespace lamp::log_ring
