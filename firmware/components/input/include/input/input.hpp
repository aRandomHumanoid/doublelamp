// Buttons (03 §14): the BOOT button (GPIO9) and an optional external one (GPIO3) behave the same.
#pragma once

#include <cstdint>

namespace input {

enum class Gesture : uint8_t {
    Single,      // toggle on/off
    Double,      // next preset
    HoldSetup,   // held 3 s and released: setup mode
    HoldReset,   // held 10 s: factory reset
};

using Handler = void (*)(Gesture g);
/** Called with 0–100 while a hold passes 3 s on its way to 10 s, and -1 when it ends. */
using ProgressHandler = void (*)(int pct);

void start(Handler on_gesture, ProgressHandler on_progress);

}  // namespace input
