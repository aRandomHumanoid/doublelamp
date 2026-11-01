// Effect functions (03 §6). Pure: output depends only on (params, t, i, n). No IDF headers.
#pragma once

#include <cstddef>
#include <cstdint>

#include "effects/math8.hpp"

namespace fx {

enum Uses : uint16_t {
    USES_COLORS1 = 1 << 0,
    USES_COLORS2 = 1 << 1,
    USES_COLORS3 = 1 << 2,
    USES_SPEED = 1 << 3,
    USES_INTENSITY = 1 << 4,
    USES_DURATION = 1 << 5,
};

struct EffectParams {
    uint8_t speed;
    uint8_t intensity;
    const RGB8* colors;  // at least one
    uint8_t ncolors;     // 1–3
    uint32_t seed;
    uint32_t duration_ms;
};

/** Renders n pixels at t_ms after the effect's epoch. */
using RenderFn = void (*)(const EffectParams& p, uint64_t t_ms, uint16_t n, RGB8* out);

struct EffectDesc {
    const char* id;
    const char* name;
    uint16_t uses;
    bool oneshot;
    uint8_t default_speed;
    uint8_t default_intensity;
    uint32_t default_duration_ms;
    RenderFn render;
};

size_t effect_count();
const EffectDesc& effect_at(size_t index);
/** nullptr when the id is unknown. */
const EffectDesc* find_effect(const char* id);
/** Index into the table, or -1. */
int effect_index(const char* id);
/** True when a color change is visible in this effect (otherwise a new color switches to solid, 03 §11). */
bool effect_uses_colors(const char* id);

}  // namespace fx
