// Built when esp-homekit-sdk isn't checked out: no Apple Home, everything else unchanged.
#include <cstring>

#include "esp_log.h"
#include "homekit/homekit.hpp"
#include "homekit_internal.hpp"

namespace homekit {

void init() {
    load_or_create_code();
    ESP_LOGW("homekit", "built without esp-homekit-sdk: Apple Home is off");
}
void start() {}
bool available() { return false; }

Info info() {
    Info i{};
    i.state = "off";
    i.controllers = 0;
    std::memcpy(i.setup_code, g_code, sizeof i.setup_code);
    std::memcpy(i.setup_id, g_setup_id, sizeof i.setup_id);
    return i;
}

void reset_pairings() {}

}  // namespace homekit
