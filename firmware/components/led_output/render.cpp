// Render pipeline (03 §5):
//   snapshot → transition planner → effect → crossfade → brightness (CIE L*) → sRGB→linear +
//   color correction → current limiter → dither 16→8 → color order → led_strip (SPI + DMA)
#include <cmath>
#include <cstdlib>
#include <cstring>

#include "effects/effects.hpp"
#include "esp_log.h"
#include "esp_task_wdt.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "lamp/clock.hpp"
#include "lamp/lamp.hpp"
#include "lamp/settings.hpp"
#include "led_output/led_output.hpp"
#include "led_strip.h"
#include "sdkconfig.h"

static const char* TAG = "render";

namespace led_output {

using fx::RGB8;
using lc::LampState;

namespace {

struct Snapshot {
    LampState state;
    uint16_t transition_ms;
    int64_t apply_at;
};

enum class Ov : uint8_t { Identify, Nudge, Setup, SetupDone, Reset, Ota, Rollback, Test };

struct OvMsg {
    Ov type;
    int32_t a;  // duration / pct / on
    uint8_t b;  // count / test kind
    RGB8 color;
};

QueueHandle_t s_snap_q;
QueueHandle_t s_ov_q;
volatile bool s_config_dirty = true;
volatile float s_fps = 0;
volatile int64_t s_last_frame_us = 0;

led_strip_handle_t s_strip = nullptr;
lc::LedConfig s_cfg;
uint8_t s_order[4] = {0, 1, 2, 3};
uint8_t s_order_n = 3;

uint16_t s_gamma[256];  // sRGB 8-bit → linear 16-bit
uint16_t s_cie[256];    // perceptual brightness → linear 16-bit

// Pixel buffers, sized for CONFIG_LAMP_MAX_PIXELS at first use
RGB8* s_out = nullptr;
RGB8* s_from = nullptr;
RGB8* s_last = nullptr;
int16_t* s_err = nullptr;  // dither error, 3 per pixel
uint16_t* s_lin = nullptr; // linear 16-bit working frame, 3 per pixel
uint16_t s_alloc = 0;

// Transition planner
LampState s_cur;
bool s_have_cur = false;
bool s_pending = false;
LampState s_next;
int64_t s_next_start = 0;
uint16_t s_next_dur = 0;
bool s_xf = false;
int64_t s_xf_start = 0;
uint16_t s_xf_dur = 0;
uint16_t s_lvl_from = 0, s_lvl_to = 0;
int64_t s_lvl_start = 0;
uint16_t s_lvl_dur = 0;
uint32_t s_limit_k = 65536;  // current limiter scale, Q16
int64_t s_limit_t = 0;

// Overlays
struct {
    bool setup = false;
    int reset_pct = -1;
    int ota_pct = -1;
    Ov timed = Ov::Identify;
    bool timed_active = false;
    int64_t timed_start = 0;
    uint32_t timed_dur = 0;
    uint8_t count = 0;
    RGB8 color{255, 255, 255};
    bool test_active = false;
    uint8_t test_kind = 0;
    int64_t test_end = 0;
} s_ov;

uint8_t smooth8(int64_t elapsed, uint32_t dur) {
    if (dur == 0 || elapsed >= (int64_t)dur) return 255;
    if (elapsed <= 0) return 0;
    uint32_t x = (uint32_t)((elapsed * 65536) / dur);  // Q16
    uint64_t s = ((uint64_t)x * x >> 16) * (3u * 65536u - 2u * x) >> 16;  // smoothstep
    uint32_t v = (uint32_t)((s * 255u) >> 16);
    return v > 255 ? 255 : (uint8_t)v;
}

uint16_t level_for(const LampState& s) { return s.on ? s_cie[s.brightness] : 0; }

uint16_t current_level(int64_t t) {
    uint8_t f = smooth8(t - s_lvl_start, s_lvl_dur);
    return (uint16_t)(s_lvl_from + (((int32_t)s_lvl_to - (int32_t)s_lvl_from) * f) / 255);
}

void build_tables() {
    for (int i = 0; i < 256; i++) {
        float v = i / 255.0f;
        s_gamma[i] = (uint16_t)std::lround(65535.0f * std::pow(v, 2.2f));
        float l = v * 100.0f;
        float y = l > 8.0f ? std::pow((l + 16.0f) / 116.0f, 3.0f) : l / 903.3f;
        s_cie[i] = (uint16_t)std::lround(65535.0f * y);
    }
}

bool ensure_buffers(uint16_t n) {
    if (n <= s_alloc) return true;
    std::free(s_out), std::free(s_from), std::free(s_last), std::free(s_err), std::free(s_lin);
    s_out = (RGB8*)std::calloc(n, sizeof(RGB8));
    s_from = (RGB8*)std::calloc(n, sizeof(RGB8));
    s_last = (RGB8*)std::calloc(n, sizeof(RGB8));
    s_err = (int16_t*)std::calloc((size_t)n * 3, sizeof(int16_t));
    s_lin = (uint16_t*)std::calloc((size_t)n * 3, sizeof(uint16_t));
    s_alloc = (s_out && s_from && s_last && s_err && s_lin) ? n : 0;
    return s_alloc != 0;
}

void apply_config() {
    lc::LedConfig cfg = lamp::settings::led();
    if (cfg.pixel_count > CONFIG_LAMP_MAX_PIXELS) cfg.pixel_count = CONFIG_LAMP_MAX_PIXELS;
    bool rebuild = !s_strip || cfg.pixel_count != s_cfg.pixel_count || cfg.channels != s_cfg.channels;
    s_cfg = cfg;
    if (!lc::color_order_map(cfg.color_order, s_order, &s_order_n)) {
        s_order[0] = 0, s_order[1] = 1, s_order[2] = 2, s_order_n = 3;
    }
    if (!ensure_buffers(cfg.pixel_count)) {
        ESP_LOGE(TAG, "no memory for %u pixels", cfg.pixel_count);
        return;
    }
    if (!rebuild) return;
    if (s_strip) {
        led_strip_clear(s_strip);
        led_strip_del(s_strip);
        s_strip = nullptr;
    }
    led_strip_config_t sc = {};
    sc.strip_gpio_num = CONFIG_LAMP_LED_GPIO;
    sc.max_leds = cfg.pixel_count;
    sc.led_model = cfg.channels == 4 ? LED_MODEL_SK6812 : LED_MODEL_WS2811;
    sc.color_component_format = cfg.channels == 4 ? LED_STRIP_COLOR_COMPONENT_FMT_RGBW : LED_STRIP_COLOR_COMPONENT_FMT_RGB;
    sc.flags.invert_out = false;
    esp_err_t err;
#if CONFIG_LAMP_LED_BACKEND_RMT
    led_strip_rmt_config_t rc = {};
    rc.clk_src = RMT_CLK_SRC_DEFAULT;
    rc.resolution_hz = 10 * 1000 * 1000;
    rc.mem_block_symbols = 0;
    rc.flags.with_dma = false;  // the C3's RMT has no DMA
    err = led_strip_new_rmt_device(&sc, &rc, &s_strip);
#else
    led_strip_spi_config_t spi = {};
    spi.clk_src = SPI_CLK_SRC_DEFAULT;
    spi.spi_bus = SPI2_HOST;
    spi.flags.with_dma = true;
    err = led_strip_new_spi_device(&sc, &spi, &s_strip);
#endif
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "led_strip init failed: %s", esp_err_to_name(err));
        s_strip = nullptr;
        return;
    }
    led_strip_clear(s_strip);
    ESP_LOGI(TAG, "strip: %u px on GPIO%d, order %s", cfg.pixel_count, CONFIG_LAMP_LED_GPIO, cfg.color_order);
}

void on_state(const lamp::StateEvent& ev, void*) {
    Snapshot s{ev.state, ev.transition_ms, ev.apply_at};
    xQueueOverwrite(s_snap_q, &s);
}

void on_settings(uint32_t topics, void*) {
    if (topics & lamp::settings::TOPIC_LED) s_config_dirty = true;
}

bool visual_differs(const LampState& a, const LampState& b) {
    return !lc::field_equal(a, b, 2) || !lc::field_equal(a, b, 3);
}

void plan(const Snapshot& snap, int64_t now) {
    if (!s_have_cur) {
        s_cur = snap.state;
        s_have_cur = true;
        s_lvl_from = 0;
        s_lvl_to = level_for(s_cur);
        s_lvl_start = now;
        s_lvl_dur = snap.transition_ms;
        return;
    }
    s_next = snap.state;
    // apply_at more than 5 s ahead means the clocks disagree: apply now rather than freeze.
    s_next_start = (snap.apply_at > now && snap.apply_at - now < 5000) ? snap.apply_at : now;
    s_next_dur = snap.transition_ms;
    s_pending = true;
}

void begin_pending(int64_t now, uint16_t n) {
    if (visual_differs(s_cur, s_next)) {
        std::memcpy(s_from, s_last, n * sizeof(RGB8));
        s_xf = s_next_dur > 0;
        s_xf_start = now;
        s_xf_dur = s_next_dur;
    }
    uint16_t target = level_for(s_next);
    uint16_t cur = current_level(now);
    if (target != s_lvl_to || cur != target) {
        s_lvl_from = cur;
        s_lvl_to = target;
        s_lvl_start = now;
        s_lvl_dur = s_next_dur;
    }
    s_cur = s_next;
    s_pending = false;
}

void handle_overlay(const OvMsg& m, int64_t now) {
    switch (m.type) {
        case Ov::Setup: s_ov.setup = m.a != 0; break;
        case Ov::Reset: s_ov.reset_pct = m.a; break;
        case Ov::Ota: s_ov.ota_pct = m.a; break;
        case Ov::Test:
            s_ov.test_active = m.a > 0;
            s_ov.test_kind = m.b;
            s_ov.test_end = now + m.a;
            break;
        default:
            s_ov.timed = m.type;
            s_ov.timed_active = true;
            s_ov.timed_start = now;
            s_ov.count = m.b;
            s_ov.color = m.color;
            switch (m.type) {
                case Ov::Identify: s_ov.timed_dur = (uint32_t)m.a; break;
                case Ov::Nudge: s_ov.timed_dur = 1000u * m.b; break;
                case Ov::SetupDone: s_ov.timed_dur = 1200; break;
                case Ov::Rollback: s_ov.timed_dur = 1800; break;
                default: s_ov.timed_dur = 1000; break;
            }
            break;
    }
}

/** Fills s_out with an overlay frame and returns true, or false if no overlay is showing. */
bool overlay_frame(int64_t now, uint16_t n, uint16_t* level, bool* raw_order) {
    const uint16_t cap = s_cie[64];  // status patterns stay dim at night
    uint16_t lamp_level = current_level(now);
    uint16_t lvl = lamp_level > cap ? lamp_level : cap;
    auto fill = [&](RGB8 c) {
        for (uint16_t i = 0; i < n; i++) s_out[i] = c;
    };
    if (s_ov.test_active) {
        if (now >= s_ov.test_end) {
            s_ov.test_active = false;
        } else {
            fill({0, 0, 0});
            if (s_ov.test_kind == 0) {
                // color_order: wire byte 1, then 2, then 3 on the first pixel, 1 s each, ignoring the
                // configured order, so the colors you see spell the strip's order (e.g. G, R, B = "GRB").
                static const RGB8 seq[3] = {{255, 0, 0}, {0, 255, 0}, {0, 0, 255}};
                s_out[0] = seq[(now / 1000) % 3];
                *level = 32768;
                *raw_order = true;
            } else if (s_ov.test_kind == 1) {  // last_pixel
                s_out[n - 1] = {255, 255, 255};
                *level = 32768;
            } else {  // white_25: 25 % of full white, for current calibration (02 §5)
                fill({255, 255, 255});
                *level = 16384;
            }
            return true;
        }
    }
    if (s_ov.reset_pct >= 0) {  // red bar fills the strip
        uint32_t lit = ((uint32_t)n * (uint32_t)s_ov.reset_pct + 99) / 100;
        for (uint16_t i = 0; i < n; i++) s_out[i] = i < lit ? RGB8{255, 0, 0} : RGB8{0, 0, 0};
        *level = cap;
        return true;
    }
    if (s_ov.timed_active) {
        int64_t el = now - s_ov.timed_start;
        if (el >= (int64_t)s_ov.timed_dur) {
            s_ov.timed_active = false;
        } else {
            bool on = false;
            RGB8 c = s_ov.color;
            uint8_t scale = 255;
            switch (s_ov.timed) {
                case Ov::Identify: on = (el / 200) % 2 == 0; c = {255, 255, 255}; break;
                case Ov::SetupDone: on = (el / 300) % 2 == 0; c = {0, 255, 40}; break;
                case Ov::Rollback: on = (el / 300) % 2 == 0; c = {255, 140, 0}; break;
                case Ov::Nudge: {
                    uint16_t ph = (uint16_t)((el % 1000) * 65536 / 1000);
                    scale = (uint8_t)((fx::sin16((uint16_t)(ph + 49152u)) + 32768) >> 8);
                    on = true;
                    break;
                }
                default: break;
            }
            fill(on ? fx::scale_rgb(c, scale) : RGB8{0, 0, 0});
            *level = lvl;
            return true;
        }
    }
    if (s_ov.ota_pct >= 0 && !s_cur.on) {  // dim violet progress bar, only while off
        uint32_t lit = ((uint32_t)n * (uint32_t)s_ov.ota_pct + 99) / 100;
        for (uint16_t i = 0; i < n; i++) s_out[i] = i < lit ? RGB8{120, 0, 255} : RGB8{0, 0, 0};
        *level = cap;
        return true;
    }
    if (s_ov.setup && !s_cur.on) {  // slow blue breathing
        uint16_t ph = (uint16_t)((now % 4000) * 65536 / 4000);
        uint8_t b = (uint8_t)(64 + (((fx::sin16(ph) + 32768) >> 8) * 191) / 255);
        fill(fx::scale_rgb({0, 64, 255}, b));
        *level = cap;
        return true;
    }
    return false;
}

void frame(int64_t now) {
    const uint16_t n = s_cfg.pixel_count;
    if (!s_strip || n == 0 || s_alloc < n) return;
    if (s_pending && now >= s_next_start) begin_pending(now, n);

    // Effect
    const fx::EffectDesc* d = fx::find_effect(s_cur.effect.id);
    if (!d) d = &fx::effect_at(0);
    fx::EffectParams p{s_cur.effect.speed, s_cur.effect.intensity, s_cur.colors,
                       s_cur.ncolors ? s_cur.ncolors : (uint8_t)1, s_cur.effect.seed, s_cur.effect.duration_ms};
    int64_t trel = now - s_cur.effect.epoch_ms;
    d->render(p, trel > 0 ? (uint64_t)trel : 0, n, s_out);

    // Crossfade from the frozen last frame
    if (s_xf) {
        uint8_t f = smooth8(now - s_xf_start, s_xf_dur);
        for (uint16_t i = 0; i < n; i++) s_out[i] = fx::lerp_rgb(s_from[i], s_out[i], f);
        if (f == 255) s_xf = false;
    }
    std::memcpy(s_last, s_out, n * sizeof(RGB8));

    uint16_t level = current_level(now);
    bool raw_order = false;
    overlay_frame(now, n, &level, &raw_order);
    static const uint8_t kIdentity[4] = {0, 1, 2, 3};
    const uint8_t* order = raw_order ? kIdentity : s_order;

    // Linearize, scale, current limit
    const uint32_t corr[3] = {s_cfg.color_correction[0], s_cfg.color_correction[1], s_cfg.color_correction[2]};
    uint32_t sum = 0;
    uint16_t* lin = s_lin;
    for (uint16_t i = 0; i < n; i++) {
        const uint8_t c8[3] = {s_out[i].r, s_out[i].g, s_out[i].b};
        for (int c = 0; c < 3; c++) {
            uint32_t v = ((uint32_t)s_gamma[c8[c]] * level) >> 16;
            v = (v * corr[c]) / 255u;
            lin[3 * i + c] = (uint16_t)v;
            sum += v;
        }
    }
    uint32_t est_ma = (uint32_t)(((uint64_t)sum * s_cfg.ma_per_pixel_white) / (3u * 65535u));
    uint32_t k_target = est_ma > s_cfg.max_current_ma ? (uint32_t)(((uint64_t)s_cfg.max_current_ma << 16) / est_ma) : 65536u;
    int64_t dt = now - s_limit_t;
    s_limit_t = now;
    if (k_target < s_limit_k) {
        s_limit_k = k_target;  // react at once when the estimate goes over the limit
    } else if (dt > 0) {
        uint32_t step = (uint32_t)(((uint64_t)(k_target - s_limit_k) * (uint64_t)(dt > 200 ? 200 : dt)) / 200u);
        s_limit_k += step ? step : (k_target > s_limit_k ? 1 : 0);
    }

    // Dither 16 → 8 bits, reorder, send
    bool dither = s_cfg.dither && s_fps >= 60.0f;
    for (uint16_t i = 0; i < n; i++) {
        uint8_t ch[4] = {0, 0, 0, 0};
        for (int c = 0; c < 3; c++) {
            uint32_t v = ((uint32_t)lin[3 * i + c] * s_limit_k) >> 16;
            if (dither) {
                // 255 << 8 already shows as 255. Carrying the excess as error would grow it every
                // frame until the int16 wraps and a frame drops to half brightness.
                if (v > 0xFF00) v = 0xFF00;
                int32_t acc = (int32_t)v + s_err[3 * i + c];
                int32_t o = acc >> 8;
                if (o > 255) o = 255;
                if (o < 0) o = 0;
                s_err[3 * i + c] = (int16_t)(acc - (o << 8));
                ch[c] = (uint8_t)o;
            } else {
                uint32_t o = (v + 128) >> 8;
                ch[c] = (uint8_t)(o > 255 ? 255 : o);
            }
        }
        if (s_order_n == 4) {  // RGBW: pull the common white out of r, g, b
            uint8_t w = ch[0] < ch[1] ? (ch[0] < ch[2] ? ch[0] : ch[2]) : (ch[1] < ch[2] ? ch[1] : ch[2]);
            ch[0] -= w, ch[1] -= w, ch[2] -= w, ch[3] = w;
            led_strip_set_pixel_rgbw(s_strip, i, ch[order[0]], ch[order[1]], ch[order[2]], ch[order[3]]);
        } else {
            led_strip_set_pixel(s_strip, i, ch[order[0]], ch[order[1]], ch[order[2]]);
        }
    }
    led_strip_refresh(s_strip);
}

void render_task(void*) {
    esp_task_wdt_add(nullptr);
    TickType_t last_wake = xTaskGetTickCount();
    int frames = 0;
    int64_t fps_mark = esp_timer_get_time();
    for (;;) {
        if (s_config_dirty) {
            s_config_dirty = false;
            apply_config();
        }
        int64_t now = lamp::clock::sync_now_ms();
        Snapshot snap;
        if (xQueueReceive(s_snap_q, &snap, 0) == pdTRUE) plan(snap, now);
        OvMsg m;
        while (xQueueReceive(s_ov_q, &m, 0) == pdTRUE) handle_overlay(m, now);
        frame(now);

        int64_t us = esp_timer_get_time();
        s_last_frame_us = us;
        frames++;
        if (us - fps_mark >= 1000000) {
            s_fps = frames * 1e6f / (float)(us - fps_mark);
            frames = 0;
            fps_mark = us;
        }
        esp_task_wdt_reset();
        uint32_t fps = s_cfg.fps ? s_cfg.fps : 50;
        TickType_t period = pdMS_TO_TICKS(1000 / fps);
        if (period < 1) period = 1;
        // xTaskDelayUntil returns pdFALSE if we fell behind; resync instead of bursting.
        if (xTaskDelayUntil(&last_wake, period) == pdFALSE) last_wake = xTaskGetTickCount();
    }
}

void post(const OvMsg& m) {
    if (s_ov_q) xQueueSend(s_ov_q, &m, 0);
}

}  // namespace

void init() {
    build_tables();
    s_snap_q = xQueueCreate(1, sizeof(Snapshot));
    s_ov_q = xQueueCreate(6, sizeof(OvMsg));
    lamp::subscribe(on_state, nullptr);
    lamp::settings::subscribe(on_settings, nullptr);
    apply_config();
    s_config_dirty = false;
}

void start() { xTaskCreate(render_task, "render", 4096, nullptr, 15, nullptr); }

void identify(uint32_t duration_ms) { post({Ov::Identify, (int32_t)(duration_ms ? duration_ms : 1200), 3, {255, 255, 255}}); }
void nudge(RGB8 color, uint8_t count) { post({Ov::Nudge, 0, (uint8_t)(count ? count : 3), color}); }
void set_setup_mode(bool on) { post({Ov::Setup, on ? 1 : 0, 0, {}}); }
void setup_success() { post({Ov::SetupDone, 0, 2, {}}); }
void reset_progress(int pct) { post({Ov::Reset, pct, 0, {}}); }
void ota_progress(int pct) { post({Ov::Ota, pct, 0, {}}); }
void rollback_blinks() { post({Ov::Rollback, 0, 3, {}}); }

bool test_pattern(const char* name, uint32_t duration_ms) {
    uint8_t kind;
    if (std::strcmp(name, "color_order") == 0) kind = 0;
    else if (std::strcmp(name, "last_pixel") == 0) kind = 1;
    else if (std::strcmp(name, "white_25") == 0) kind = 2;
    else return false;
    if (duration_ms > 120000) duration_ms = 120000;  // 0 stops a running pattern
    post({Ov::Test, (int32_t)duration_ms, kind, {}});
    return true;
}

float fps() { return s_fps; }
bool healthy() { return esp_timer_get_time() - s_last_frame_us < 1000000; }

}  // namespace led_output
