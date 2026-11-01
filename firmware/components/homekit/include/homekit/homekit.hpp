// Apple Home accessory (03 §11, ADR-0004): HAP over IP via esp-homekit-sdk.
#pragma once

namespace homekit {

/** Loads or generates the setup code. Safe without the SDK. */
void init();
/** Starts the HAP server once the lamp has WiFi credentials (not in setup mode). Idempotent. */
void start();
/** Built with the SDK and enabled in menuconfig. */
bool available();

struct Info {
    const char* state;  // "off" | "unpaired" | "paired"
    int controllers;
    char setup_code[11];  // "XXX-XX-XXX"
    char setup_id[5];
};
Info info();

/** Removes every pairing. The SDK reboots the lamp afterwards. */
void reset_pairings();

}  // namespace homekit
