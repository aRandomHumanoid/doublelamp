// v1 effects (03 §6). Rules: pure functions, repeatable randomness via hash32, normalized
// positions, integer math only, 64-bit time reduced with % before narrowing.
// Any change here must be mirrored in packages/effects/src/effects.ts and the golden vectors
// regenerated (firmware/test/host: gen_vectors).
#include "effects/effects.hpp"

#include <cstring>

namespace fx {

static void fill(RGB8* out, uint16_t n, RGB8 c) {
    for (uint16_t i = 0; i < n; i++) out[i] = c;
}

static void fx_solid(const EffectParams& p, uint64_t, uint16_t n, RGB8* out) { fill(out, n, p.colors[0]); }

static void fx_breathe(const EffectParams& p, uint64_t t, uint16_t n, RGB8* out) {
    uint32_t per = period_ms(p.speed, 20000, 2000);
    uint16_t ph = phase16(t, per);
    int32_t s = sin16((uint16_t)(ph + 49152u));  // sin(phase − 90°): starts at the dim end
    uint32_t level = (uint32_t)(s + 32768) >> 8;  // 0..255
    uint8_t scale = (uint8_t)(255u - ((uint32_t)p.intensity * (255u - level)) / 255u);
    fill(out, n, scale_rgb(p.colors[0], scale));
}

static void fx_gradient(const EffectParams& p, uint64_t t, uint16_t n, RGB8* out) {
    if (p.ncolors <= 1) {
        fill(out, n, p.colors[0]);
        return;
    }
    uint32_t off = p.speed ? (uint32_t)(((t * p.speed) >> 4) & 0xFFFFu) : 0u;
    uint32_t seg = (uint32_t)p.ncolors - 1u;
    for (uint16_t i = 0; i < n; i++) {
        uint32_t x = pos_q16(i, n);
        uint32_t u;
        if (!p.speed) {
            u = x;
        } else {
            uint32_t w = ((x >> 1) + off) & 0xFFFFu;  // half a ping-pong cycle across the lamp
            u = w < 32768u ? w * 2u : (65535u - w) * 2u;
        }
        uint32_t sc = u * seg;
        uint32_t idx = sc >> 16;
        uint8_t f = (uint8_t)((sc >> 8) & 0xFFu);
        out[i] = lerp_rgb(p.colors[idx], p.colors[idx + 1], f);
    }
}

static void fx_cycle(const EffectParams& p, uint64_t t, uint16_t n, RGB8* out) {
    uint32_t per = period_ms(p.speed, 60000, 2000);
    fill(out, n, hsv16(phase16(t, per), p.intensity, 255));
}

static void fx_rainbow(const EffectParams& p, uint64_t t, uint16_t n, RGB8* out) {
    uint32_t per = period_ms(p.speed, 30000, 2000);
    uint16_t base = phase16(t, per);
    for (uint16_t i = 0; i < n; i++) {
        uint16_t h = (uint16_t)(base + (((uint32_t)pos_q16(i, n) * p.intensity) >> 8));
        out[i] = hsv16(h, 255, 255);
    }
}

static void fx_candle(const EffectParams& p, uint64_t t, uint16_t n, RGB8* out) {
    uint32_t step = 40u + ((uint32_t)(255u - p.speed) * 160u) / 255u;  // 40..200 ms
    uint64_t k = t / step;
    uint8_t fr = (uint8_t)(((t % step) * 256u) / step);
    uint32_t gstep = step * 4u;
    uint64_t gk = t / gstep;
    uint8_t gfr = (uint8_t)(((t % gstep) * 256u) / gstep);
    uint8_t g = lerp8((uint8_t)(hash32(p.seed, 0xFFFFFFFFu, (uint32_t)gk) & 0xFFu),
                      (uint8_t)(hash32(p.seed, 0xFFFFFFFFu, (uint32_t)(gk + 1u)) & 0xFFu), gfr);
    uint32_t gdip = ((uint32_t)g * g) >> 8;
    for (uint16_t i = 0; i < n; i++) {
        uint8_t v = lerp8((uint8_t)(hash32(p.seed, i, (uint32_t)k) & 0xFFu),
                          (uint8_t)(hash32(p.seed, i, (uint32_t)(k + 1u)) & 0xFFu), fr);
        uint32_t dip = ((((uint32_t)v * v) >> 8) + gdip) >> 1;
        uint8_t scale = (uint8_t)(255u - ((uint32_t)p.intensity * dip) / 255u);
        out[i] = scale_rgb(p.colors[0], scale);
    }
}

static void fx_twinkle(const EffectParams& p, uint64_t t, uint16_t n, RGB8* out) {
    uint32_t len = 2600u - ((uint32_t)p.speed * 2200u) / 255u;  // 2600..400 ms per twinkle
    for (uint16_t i = 0; i < n; i++) {
        uint32_t offset = hash32(p.seed, i, 0x7A11u) % len;
        uint64_t tt = t + offset;
        uint64_t k = tt / len;
        uint32_t pos = (uint32_t)(tt % len);
        uint32_t h = hash32(p.seed, i, (uint32_t)k);
        if ((h & 0xFFu) >= p.intensity) {
            out[i] = {0, 0, 0};
            continue;
        }
        uint32_t level = (2u * pos < len) ? (pos * 510u) / len : ((len - pos) * 510u) / len;
        if (level > 255u) level = 255u;
        const RGB8& c = p.colors[(h >> 8) % p.ncolors];
        out[i] = scale_rgb(c, (uint8_t)level);
    }
}

static void fx_sunrise(const EffectParams& p, uint64_t t, uint16_t n, RGB8* out) {
    struct Stop {
        uint32_t pos;
        RGB8 c;
    };
    static const Stop stops[5] = {
        {0u, {0x00, 0x00, 0x00}},
        {13107u, {0x40, 0x00, 0x00}},  // deep red
        {32768u, {0xFF, 0x30, 0x00}},
        {49152u, {0xFF, 0x8C, 0x20}},  // amber
        {65535u, {0xFF, 0xD8, 0xA8}},  // warm white
    };
    uint32_t dur = p.duration_ms ? p.duration_ms : 1800000u;
    uint32_t pr = t >= dur ? 65535u : (uint32_t)((t * 65535u) / dur);
    int j = 0;
    while (j < 3 && pr > stops[j + 1].pos) j++;
    uint32_t span = stops[j + 1].pos - stops[j].pos;
    uint8_t f = (uint8_t)(((pr - stops[j].pos) * 255u) / span);
    fill(out, n, lerp_rgb(stops[j].c, stops[j + 1].c, f));
}

static void fx_sync_test(const EffectParams&, uint64_t t, uint16_t n, RGB8* out) {
    fill(out, n, (t % 1000u) < 20u ? RGB8{255, 255, 255} : RGB8{0, 0, 0});
}

static const EffectDesc kEffects[] = {
    {"solid", "Solid", USES_COLORS1, false, 128, 128, 0, fx_solid},
    {"breathe", "Breathe", USES_COLORS1 | USES_SPEED | USES_INTENSITY, false, 96, 160, 0, fx_breathe},
    {"gradient", "Gradient", USES_COLORS1 | USES_COLORS2 | USES_COLORS3 | USES_SPEED, false, 0, 128, 0, fx_gradient},
    {"cycle", "Color cycle", USES_SPEED | USES_INTENSITY, false, 64, 255, 0, fx_cycle},
    {"rainbow", "Rainbow", USES_SPEED | USES_INTENSITY, false, 64, 96, 0, fx_rainbow},
    {"candle", "Candle", USES_COLORS1 | USES_SPEED | USES_INTENSITY, false, 128, 140, 0, fx_candle},
    {"twinkle", "Twinkle", USES_COLORS1 | USES_COLORS2 | USES_COLORS3 | USES_SPEED | USES_INTENSITY, false, 96, 64, 0,
     fx_twinkle},
    {"sunrise", "Sunrise", USES_DURATION, true, 128, 128, 30u * 60000u, fx_sunrise},
    {"sync_test", "Sync test", 0, false, 128, 128, 0, fx_sync_test},
};

size_t effect_count() { return sizeof(kEffects) / sizeof(kEffects[0]); }

const EffectDesc& effect_at(size_t index) { return kEffects[index < effect_count() ? index : 0]; }

int effect_index(const char* id) {
    if (!id) return -1;
    for (size_t i = 0; i < effect_count(); i++) {
        if (std::strcmp(kEffects[i].id, id) == 0) return (int)i;
    }
    return -1;
}

const EffectDesc* find_effect(const char* id) {
    int i = effect_index(id);
    return i < 0 ? nullptr : &kEffects[i];
}

bool effect_uses_colors(const char* id) {
    const EffectDesc* d = find_effect(id);
    return d ? (d->uses & USES_COLORS1) != 0 : true;
}

}  // namespace fx
