#include "lamp_core/state.hpp"

#include <cstring>

#include "effects/effects.hpp"

namespace lc {

const char* origin_name(Origin o) {
    switch (o) {
        case Origin::Local: return "local";
        case Origin::Cloud: return "cloud";
        case Origin::HomeKit: return "homekit";
        case Origin::Button: return "button";
        case Origin::Timer: return "timer";
        case Origin::Boot: return "boot";
    }
    return "local";
}

const char* field_name(int index) {
    static const char* names[kFieldCount] = {"on", "brightness", "colors", "effect"};
    return (index >= 0 && index < kFieldCount) ? names[index] : "";
}

LampState default_state() {
    LampState s{};
    s.on = false;
    s.brightness = 128;
    s.colors[0] = {0xFF, 0xB4, 0x6B};  // warm white
    s.ncolors = 1;
    std::strncpy(s.effect.id, "solid", kEffectIdLen - 1);
    s.effect.speed = 128;
    s.effect.intensity = 128;
    s.effect.seed = 0;
    s.effect.epoch_ms = 0;
    s.effect.duration_ms = 0;
    return s;
}

static bool effects_equal(const Effect& a, const Effect& b) {
    return std::strncmp(a.id, b.id, kEffectIdLen) == 0 && a.speed == b.speed && a.intensity == b.intensity &&
           a.seed == b.seed && a.epoch_ms == b.epoch_ms && a.duration_ms == b.duration_ms;
}

bool field_equal(const LampState& a, const LampState& b, int i) {
    switch (i) {
        case 0: return a.on == b.on;
        case 1: return a.brightness == b.brightness;
        case 2:
            if (a.ncolors != b.ncolors) return false;
            for (int k = 0; k < a.ncolors; k++)
                if (a.colors[k] != b.colors[k]) return false;
            return true;
        case 3: return effects_equal(a.effect, b.effect);
    }
    return true;
}

bool states_equal(const LampState& a, const LampState& b) {
    for (int i = 0; i < kFieldCount; i++)
        if (!field_equal(a, b, i)) return false;
    return true;
}

Patch full_patch(const LampState& s) {
    Patch p;
    p.fields = F_ALL;
    p.effect_fields = EF_ALL;
    p.values = s;
    return p;
}

FieldMask apply_patch(LampState& s, const Patch& p, int64_t now_ms, Rand32 rand32) {
    const LampState before = s;
    if (p.fields & F_ON) s.on = p.values.on;
    if (p.fields & F_BRIGHTNESS) s.brightness = p.values.brightness;
    if ((p.fields & F_COLORS) && p.values.ncolors >= 1 && p.values.ncolors <= kMaxColors) {
        s.ncolors = p.values.ncolors;
        for (int k = 0; k < kMaxColors; k++) s.colors[k] = k < s.ncolors ? p.values.colors[k] : RGB8{0, 0, 0};
    }
    if (p.fields & F_EFFECT) {
        const Effect& e = p.values.effect;
        bool id_changed = false;
        if (p.effect_fields & EF_ID) {
            id_changed = std::strncmp(s.effect.id, e.id, kEffectIdLen) != 0;
            std::memcpy(s.effect.id, e.id, kEffectIdLen);
            s.effect.id[kEffectIdLen - 1] = '\0';
        }
        if (p.effect_fields & EF_SPEED) s.effect.speed = e.speed;
        if (p.effect_fields & EF_INTENSITY) s.effect.intensity = e.intensity;
        if (p.effect_fields & EF_SEED) s.effect.seed = e.seed;
        if (p.effect_fields & EF_EPOCH) s.effect.epoch_ms = e.epoch_ms;
        if (p.effect_fields & EF_DURATION) s.effect.duration_ms = e.duration_ms;
        if (id_changed && !(p.effect_fields & EF_EPOCH)) s.effect.epoch_ms = now_ms;
        if (id_changed && !(p.effect_fields & EF_SEED) && rand32) s.effect.seed = rand32();
    }
    FieldMask changed = 0;
    for (int i = 0; i < kFieldCount; i++)
        if (!field_equal(before, s, i)) changed |= (FieldMask)(1u << i);
    return changed;
}

LedConfig default_led_config(uint16_t pixel_count, uint8_t ma_per_pixel) {
    LedConfig c{};
    c.pixel_count = pixel_count;
    c.channels = 3;
    std::strncpy(c.color_order, "RGB", sizeof c.color_order);
    c.max_current_ma = 600;
    c.ma_per_pixel_white = ma_per_pixel;
    c.color_correction[0] = c.color_correction[1] = c.color_correction[2] = 255;
    c.fps = 100;
    c.dither = true;
    c.power_on = PowerOn::Restore;
    return c;
}

bool color_order_map(const char* s, uint8_t out[4], uint8_t* nbytes) {
    if (!s) return false;
    size_t len = std::strlen(s);
    if (len != 3 && len != 4) return false;
    bool seen[4] = {false, false, false, false};
    for (size_t i = 0; i < len; i++) {
        int idx;
        switch (s[i]) {
            case 'R': idx = 0; break;
            case 'G': idx = 1; break;
            case 'B': idx = 2; break;
            case 'W': idx = 3; break;
            default: return false;
        }
        if (seen[idx]) return false;
        if (idx == 3 && len != 4) return false;
        seen[idx] = true;
        out[i] = (uint8_t)idx;
    }
    if (len == 4 && !seen[3]) return false;
    *nbytes = (uint8_t)len;
    return true;
}

bool valid_color_order(const char* s) {
    uint8_t m[4], n;
    return color_order_map(s, m, &n);
}

const char* power_on_name(PowerOn p) {
    switch (p) {
        case PowerOn::On: return "on";
        case PowerOn::Off: return "off";
        default: return "restore";
    }
}

bool parse_power_on(const char* s, PowerOn* out) {
    if (!s) return false;
    if (std::strcmp(s, "restore") == 0) *out = PowerOn::Restore;
    else if (std::strcmp(s, "on") == 0) *out = PowerOn::On;
    else if (std::strcmp(s, "off") == 0) *out = PowerOn::Off;
    else return false;
    return true;
}

}  // namespace lc
