#include "lamp_core/homekit_map.hpp"

#include <cmath>
#include <cstring>

#include "effects/effects.hpp"

namespace lc {

int brightness_to_pct(uint8_t b) { return (int)((b * 100u + 127u) / 255u); }

uint8_t pct_to_brightness(int pct) {
    if (pct <= 0) return 0;
    if (pct >= 100) return 255;
    return (uint8_t)((pct * 255 + 50) / 100);
}

RGB8 hue_sat_to_rgb(float hue, float sat) {
    float h = std::fmod(hue, 360.0f);
    if (h < 0) h += 360.0f;
    float s = sat < 0 ? 0 : (sat > 100 ? 1.0f : sat / 100.0f);
    float c = s;  // chroma at V = 1
    float hp = h / 60.0f;
    float x = c * (1.0f - std::fabs(std::fmod(hp, 2.0f) - 1.0f));
    float r = 0, g = 0, b = 0;
    if (hp < 1) r = c, g = x;
    else if (hp < 2) r = x, g = c;
    else if (hp < 3) g = c, b = x;
    else if (hp < 4) g = x, b = c;
    else if (hp < 5) r = x, b = c;
    else r = c, b = x;
    float m = 1.0f - c;
    auto to8 = [](float v) { return (uint8_t)std::lround(v * 255.0f); };
    return {to8(r + m), to8(g + m), to8(b + m)};
}

void rgb_to_hue_sat(RGB8 c, float* hue, float* sat) {
    float r = c.r / 255.0f, g = c.g / 255.0f, b = c.b / 255.0f;
    float mx = std::fmax(r, std::fmax(g, b));
    float mn = std::fmin(r, std::fmin(g, b));
    float d = mx - mn;
    float h = 0;
    if (d > 0) {
        if (mx == r) h = 60.0f * std::fmod((g - b) / d, 6.0f);
        else if (mx == g) h = 60.0f * ((b - r) / d + 2.0f);
        else h = 60.0f * ((r - g) / d + 4.0f);
        if (h < 0) h += 360.0f;
    }
    float s = mx > 0 ? d / mx : 0;
    // Report to one decimal place so repeated round trips don't drift.
    *hue = std::round(h * 10.0f) / 10.0f;
    *sat = std::round(s * 1000.0f) / 10.0f;
}

HkValues hk_from_state(const LampState& s) {
    HkValues v{};
    v.on = s.on;
    v.brightness_pct = brightness_to_pct(s.brightness);
    rgb_to_hue_sat(s.colors[0], &v.hue, &v.saturation);
    return v;
}

bool hk_to_patch(const HkWrite& w, const LampState& current, Patch* out) {
    Patch p;
    if (w.has_on) {
        p.fields |= F_ON;
        p.values.on = w.on;
    }
    if (w.has_brightness) {
        if (w.brightness_pct <= 0) {
            p.fields |= F_ON;  // 0 % means off; keep the old brightness
            p.values.on = false;
        } else {
            p.fields |= F_BRIGHTNESS;
            p.values.brightness = pct_to_brightness(w.brightness_pct);
        }
    }
    if (w.has_hue || w.has_saturation) {
        float hue, sat;
        rgb_to_hue_sat(current.colors[0], &hue, &sat);
        if (w.has_hue) hue = w.hue;
        if (w.has_saturation) sat = w.saturation;
        RGB8 c = hue_sat_to_rgb(hue, sat);
        p.fields |= F_COLORS;
        p.values.ncolors = current.ncolors ? current.ncolors : 1;
        for (int i = 0; i < kMaxColors; i++) p.values.colors[i] = current.colors[i];
        p.values.colors[0] = c;
        if (!fx::effect_uses_colors(current.effect.id)) {
            p.fields |= F_EFFECT;
            p.effect_fields |= EF_ID;
            std::strncpy(p.values.effect.id, "solid", kEffectIdLen - 1);
            p.values.effect.id[kEffectIdLen - 1] = '\0';
        }
    }
    *out = p;
    return p.fields != 0;
}

}  // namespace lc
