#include "lamp/identity.hpp"

#include <cstdio>
#include <cstring>

#include "esp_app_desc.h"
#include "esp_mac.h"
#include "esp_random.h"

namespace lamp::identity {

static char s_id[12] = "dl-000000";
static char s_host[24] = "doublelamp-000000";
static char s_ssid[24] = "DoubleLamp-000000";
static char s_build[12] = "";

void init() {
    uint8_t mac[6] = {0};
    esp_read_mac(mac, ESP_MAC_WIFI_STA);
    std::snprintf(s_id, sizeof s_id, "dl-%02x%02x%02x", mac[3], mac[4], mac[5]);
    std::snprintf(s_host, sizeof s_host, "doublelamp-%02x%02x%02x", mac[3], mac[4], mac[5]);
    std::snprintf(s_ssid, sizeof s_ssid, "DoubleLamp-%02X%02X%02X", mac[3], mac[4], mac[5]);
    char sha[65] = {0};
    esp_app_get_elf_sha256(sha, sizeof sha);
    std::snprintf(s_build, sizeof s_build, "%.8s", sha);
}

const char* device_id() { return s_id; }
const char* hostname() { return s_host; }
const char* ap_ssid() { return s_ssid; }
const char* fw_version() { return esp_app_get_description()->version; }
const char* build_id() { return s_build; }
uint32_t random32() { return esp_random(); }

}  // namespace lamp::identity
