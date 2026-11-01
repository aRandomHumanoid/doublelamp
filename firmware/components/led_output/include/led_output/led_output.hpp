// Render task and LED pipeline (03 §5) plus overlays and status patterns (03 §6, §14).
#pragma once

#include <cstdint>

#include "effects/math8.hpp"

namespace led_output {

/** Creates the strip driver from the LED config and subscribes to state and config changes. */
void init();
/** Starts the render task (priority 15). */
void start();

void identify(uint32_t duration_ms = 1200);
void nudge(fx::RGB8 color, uint8_t count);
void set_setup_mode(bool on);   // slow blue breathing
void setup_success();           // two green blinks
void reset_progress(int pct);   // red bar while the button is held; -1 hides it
void ota_progress(int pct);     // dim violet bar while the lamp is off; -1 hides it
void rollback_blinks();         // three amber blinks after a rollback
/** "color_order" | "last_pixel" | "white_25"; duration 0 stops a running pattern. */
bool test_pattern(const char* name, uint32_t duration_ms);

float fps();
/** True if a frame went out in the last second (used by the OTA health check). */
bool healthy();

}  // namespace led_output
