#include "lamp/clock.hpp"

#include <sys/time.h>

#include <cstdlib>

#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"

static const char* TAG = "clock";

namespace lamp::clock {

static portMUX_TYPE s_mux = portMUX_INITIALIZER_UNLOCKED;
static int64_t s_offset = 0;     // applied offset (sync − mono)
static int64_t s_target = 0;     // where the offset is slewing to
static int64_t s_slew_mark = 0;  // mono ms up to which slew has been applied
static bool s_server = false;

int64_t mono_ms() { return esp_timer_get_time() / 1000; }

int64_t sync_now_ms() {
    int64_t now = mono_ms();
    portENTER_CRITICAL(&s_mux);
    if (s_offset == s_target) {
        s_slew_mark = now;
    } else {
        int64_t allowed = (now - s_slew_mark) / 100;  // 1 ms per 100 ms
        if (allowed > 0) {
            int64_t diff = s_target - s_offset;
            int64_t step = std::llabs(diff) < allowed ? std::llabs(diff) : allowed;
            s_offset += diff > 0 ? step : -step;
            s_slew_mark += allowed * 100;
        }
    }
    int64_t r = now + s_offset;
    portEXIT_CRITICAL(&s_mux);
    return r;
}

void set_server_offset(int64_t offset_ms) {
    bool stepped;
    int64_t jump;
    portENTER_CRITICAL(&s_mux);
    jump = offset_ms - s_offset;
    stepped = !s_server || std::llabs(jump) >= 250;
    if (stepped) s_offset = offset_ms;
    s_target = offset_ms;
    s_slew_mark = mono_ms();
    s_server = true;
    portEXIT_CRITICAL(&s_mux);
    if (stepped && std::llabs(jump) >= 250) ESP_LOGI(TAG, "sync clock stepped by %lld ms", (long long)jump);
}

void set_from_wall_clock() {
    struct timeval tv;
    gettimeofday(&tv, nullptr);
    int64_t wall = (int64_t)tv.tv_sec * 1000 + tv.tv_usec / 1000;
    int64_t off = wall - mono_ms();
    portENTER_CRITICAL(&s_mux);
    if (!s_server) {
        s_offset = off;
        s_target = off;
    }
    portEXIT_CRITICAL(&s_mux);
}

bool synced_to_server() { return s_server; }

}  // namespace lamp::clock
