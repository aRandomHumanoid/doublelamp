// Apple Home ↔ LampState mapping (03 §11). Pure, host-tested.
#pragma once

#include "lamp_core/state.hpp"

namespace lc {

struct HkValues {
    bool on;
    int brightness_pct;  // 0–100
    float hue;           // 0–360
    float saturation;    // 0–100
};

/** What the Home app should show for a state. Hue/saturation come from colors[0] at V = 100 %. */
HkValues hk_from_state(const LampState& s);

/** One HAP write request (the Home app sends hue and saturation together). */
struct HkWrite {
    bool has_on = false, has_brightness = false, has_hue = false, has_saturation = false;
    bool on = false;
    int brightness_pct = 0;
    float hue = 0, saturation = 0;
};

/**
 * Turns a write into one patch. `current` supplies the missing half of hue/saturation.
 * Brightness 0 % turns the lamp off and keeps the previous brightness. A color written while
 * the effect doesn't use colors switches the effect to solid. Returns false if nothing to do.
 */
bool hk_to_patch(const HkWrite& w, const LampState& current, Patch* out);

/** Perceptual brightness 0–255 ↔ HomeKit percent. */
int brightness_to_pct(uint8_t b);
uint8_t pct_to_brightness(int pct);

/** HSV (h 0–360, s 0–100, v = 100 %) ↔ RGB8. */
RGB8 hue_sat_to_rgb(float hue, float sat);
void rgb_to_hue_sat(RGB8 c, float* hue, float* sat);

}  // namespace lc
