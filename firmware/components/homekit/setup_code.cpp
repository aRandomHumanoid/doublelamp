// Setup code storage, shared by the real accessory and the stub.
#include <cstdio>
#include <cstring>

#include "esp_log.h"
#include "homekit_internal.hpp"
#include "lamp/identity.hpp"
#include "lamp_core/misc.hpp"
#include "storage/storage.hpp"

static const char* TAG = "homekit";

namespace homekit {

char g_code[11] = "";
char g_setup_id[5] = "";

void load_or_create_code() {
    if (!storage::load_str("hk", "code", g_code, sizeof g_code) || lc::is_forbidden_setup_code(g_code)) {
        lc::generate_setup_code(lamp::identity::random32, g_code);
        storage::save_str("hk", "code", g_code);
        ESP_LOGI(TAG, "new Apple Home setup code generated");
    }
    if (!storage::load_str("hk", "id", g_setup_id, sizeof g_setup_id) || std::strlen(g_setup_id) != 4) {
        lc::generate_setup_id(lamp::identity::random32, g_setup_id);
        storage::save_str("hk", "id", g_setup_id);
    }
}

}  // namespace homekit
