// LampState, patches and LED config (04 §2). Pure C++: no IDF headers, host-testable.
#pragma once

#include <cstddef>
#include <cstdint>

#include "effects/math8.hpp"

namespace lc {

using fx::RGB8;

constexpr int kMaxColors = 3;
constexpr int kPresetSlots = 8;
constexpr int kEffectIdLen = 16;
constexpr int kNameLen = 32;

enum class Origin : uint8_t { Local, Cloud, HomeKit, Button, Timer, Boot };
const char* origin_name(Origin o);

struct Effect {
    char id[kEffectIdLen];
    uint8_t speed;
    uint8_t intensity;
    uint32_t seed;
    int64_t epoch_ms;  // sync-clock ms when the effect started
    uint32_t duration_ms;
};

struct LampState {
    bool on;
    uint8_t brightness;  // 0–255, perceptual
    RGB8 colors[kMaxColors];
    uint8_t ncolors;     // 1–3
    Effect effect;
};

enum Field : uint8_t {
    F_ON = 1 << 0,
    F_BRIGHTNESS = 1 << 1,
    F_COLORS = 1 << 2,
    F_EFFECT = 1 << 3,
    F_ALL = 0x0F,
};
using FieldMask = uint8_t;
constexpr int kFieldCount = 4;
/** "on", "brightness", "colors", "effect" — index i is the field 1 << i. */
const char* field_name(int index);

enum EffectField : uint8_t {
    EF_ID = 1 << 0,
    EF_SPEED = 1 << 1,
    EF_INTENSITY = 1 << 2,
    EF_SEED = 1 << 3,
    EF_EPOCH = 1 << 4,
    EF_DURATION = 1 << 5,
    EF_ALL = 0x3F,
};

/** Any subset of the state. `effect_fields` says which effect subfields the patch sets. */
struct Patch {
    FieldMask fields = 0;
    uint8_t effect_fields = 0;
    LampState values{};
};

LampState default_state();
bool field_equal(const LampState& a, const LampState& b, int field_index);
bool states_equal(const LampState& a, const LampState& b);
/** A patch that sets every field of `s`. */
Patch full_patch(const LampState& s);

using Rand32 = uint32_t (*)();

/**
 * Applies a patch. When the effect id changes and the patch has no epoch, epoch = now_ms;
 * with no seed, a fresh random seed. Returns the mask of fields that actually changed.
 */
FieldMask apply_patch(LampState& s, const Patch& p, int64_t now_ms, Rand32 rand32);

// ---------------------------------------------------------------- LED config

enum class PowerOn : uint8_t { Restore, On, Off };

struct LedConfig {
    uint16_t pixel_count;
    uint8_t channels;        // 3 or 4
    char color_order[5];     // "RGB", "GRB", …, "GRBW"
    uint16_t max_current_ma; // 100–20000
    uint8_t ma_per_pixel_white;
    uint8_t color_correction[3];
    uint8_t fps;             // 10–100
    bool dither;
    PowerOn power_on;
};

LedConfig default_led_config(uint16_t pixel_count, uint8_t ma_per_pixel);
bool valid_color_order(const char* s);
/** Index of each wire byte into {r, g, b, w}: "BRG" → {2, 0, 1}. Returns false if invalid. */
bool color_order_map(const char* s, uint8_t out[4], uint8_t* nbytes);
const char* power_on_name(PowerOn p);
bool parse_power_on(const char* s, PowerOn* out);

}  // namespace lc
