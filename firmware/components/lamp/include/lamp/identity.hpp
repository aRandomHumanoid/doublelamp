// Device identity (01 §8): device_id = "dl-" + last 3 MAC bytes, mDNS host, AP SSID, firmware.
#pragma once

#include <cstdint>

namespace lamp::identity {

void init();
const char* device_id();  // "dl-3fa2c1"
const char* hostname();   // "doublelamp-3fa2c1"
const char* ap_ssid();    // "DoubleLamp-3FA2C1"
const char* fw_version(); // "1.0.0"
const char* build_id();   // first 8 hex chars of the app ELF SHA-256
/** Random uint32 from the hardware RNG. */
uint32_t random32();

}  // namespace lamp::identity
