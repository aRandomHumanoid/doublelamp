// mDNS and SNTP (03 §7).
#include <cstdio>
#include <cstring>

#include "esp_log.h"
#include "esp_sntp.h"
#include "lamp/clock.hpp"
#include "lamp/identity.hpp"
#include "lamp/settings.hpp"
#include "mdns.h"
#include "net/net.hpp"
#include "net_internal.hpp"

static const char* TAG = "net";

namespace net {

static bool s_mdns_services = false;
static bool s_sntp_started = false;
static volatile bool s_sntp_synced = false;

static void on_time_sync(struct timeval*) {
    s_sntp_synced = true;
    lamp::clock::set_from_wall_clock();
    ESP_LOGI(TAG, "SNTP time set");
}

static void on_name_change(uint32_t topics, void*) {
    if (!(topics & lamp::settings::TOPIC_NAME) || !s_mdns_services) return;
    char name[lc::kNameLen + 1];
    lamp::settings::name(name);
    mdns_instance_name_set(name);
    mdns_service_txt_item_set("_doublelamp", "_tcp", "name", name);
}

void mdns_refresh() {
    mdns_hostname_set(lamp::identity::hostname());
    char name[lc::kNameLen + 1];
    lamp::settings::name(name);
    mdns_instance_name_set(name);
}

void mdns_start() {
    esp_err_t err = mdns_init();  // ESP_OK if already initialized (e.g. by the HomeKit SDK)
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "mdns_init: %s", esp_err_to_name(err));
        return;
    }
    mdns_refresh();
    if (s_mdns_services) return;
    char name[lc::kNameLen + 1];
    lamp::settings::name(name);
    mdns_txt_item_t txt[4] = {
        {"id", lamp::identity::device_id()},
        {"name", name},
        {"fw", lamp::identity::fw_version()},
        {"proto", "1"},
    };
    mdns_service_add(nullptr, "_http", "_tcp", 80, nullptr, 0);
    mdns_service_add(nullptr, "_doublelamp", "_tcp", 80, txt, 4);
    s_mdns_services = true;
    static bool subscribed = false;
    if (!subscribed) {
        subscribed = true;
        lamp::settings::subscribe(on_name_change, nullptr);
    }
    ESP_LOGI(TAG, "mDNS: %s.local", lamp::identity::hostname());
}

void internal_on_online() {
    if (!s_sntp_started) {
        s_sntp_started = true;
        esp_sntp_setoperatingmode(ESP_SNTP_OPMODE_POLL);
        esp_sntp_setservername(0, "pool.ntp.org");
        sntp_set_time_sync_notification_cb(on_time_sync);
        esp_sntp_init();
    }
}

bool sntp_synced() { return s_sntp_synced; }

}  // namespace net
