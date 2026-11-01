#include "lamp/log_ring.hpp"

#include <cstdarg>
#include <cstdio>
#include <cstring>

#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"

namespace lamp::log_ring {

static constexpr size_t kSize = 4096;
static char s_buf[kSize];
static size_t s_head = 0;  // next write position
static bool s_wrapped = false;
static portMUX_TYPE s_mux = portMUX_INITIALIZER_UNLOCKED;
static vprintf_like_t s_orig = nullptr;
static WarnHook s_hook = nullptr;
static int64_t s_last_hook_us = 0;

static void append(const char* s, size_t n) {
    portENTER_CRITICAL(&s_mux);
    for (size_t i = 0; i < n; i++) {
        s_buf[s_head] = s[i];
        s_head = (s_head + 1) % kSize;
        if (s_head == 0) s_wrapped = true;
    }
    portEXIT_CRITICAL(&s_mux);
}

/** First log-level letter after any ANSI color prefix. */
static char level_of(const char* line) {
    const char* p = line;
    if (*p == '\033') {
        while (*p && *p != 'm') p++;
        if (*p) p++;
    }
    return *p;
}

static int hook_vprintf(const char* fmt, va_list args) {
    char line[160];
    va_list copy;
    va_copy(copy, args);
    int n = vsnprintf(line, sizeof line, fmt, copy);
    va_end(copy);
    if (n > 0) {
        size_t len = (size_t)n < sizeof line ? (size_t)n : sizeof line - 1;
        append(line, len);
        char lvl = level_of(line);
        if (s_hook && (lvl == 'W' || lvl == 'E')) {
            int64_t now = esp_timer_get_time();
            if (now - s_last_hook_us >= 1000000) {
                s_last_hook_us = now;
                s_hook(lvl, line);
            }
        }
    }
    return s_orig ? s_orig(fmt, args) : vprintf(fmt, args);
}

void init() { s_orig = esp_log_set_vprintf(hook_vprintf); }

size_t read(char* out, size_t cap) {
    portENTER_CRITICAL(&s_mux);
    size_t len = s_wrapped ? kSize : s_head;
    size_t start = s_wrapped ? s_head : 0;
    if (len > cap) {
        start = (start + (len - cap)) % kSize;
        len = cap;
    }
    for (size_t i = 0; i < len; i++) out[i] = s_buf[(start + i) % kSize];
    portEXIT_CRITICAL(&s_mux);
    return len;
}

void set_warn_hook(WarnHook hook) { s_hook = hook; }

}  // namespace lamp::log_ring
