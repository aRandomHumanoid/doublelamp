#include "lamp/status.hpp"

#include <cstdio>
#include <cstring>

#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "lamp/identity.hpp"
#include "lamp/lamp.hpp"
#include "lamp/settings.hpp"
#include "sdkconfig.h"

namespace lamp::status {

static portMUX_TYPE s_mux = portMUX_INITIALIZER_UNLOCKED;
static Net s_net;
static Cloud s_cloud;
static Homekit s_hk;

constexpr int kMaxListeners = 6;
static struct {
    Listener cb;
    void* ctx;
} s_subs[kMaxListeners];
static int s_nsubs = 0;

void notify() {
    for (int i = 0; i < s_nsubs; i++) s_subs[i].cb(s_subs[i].ctx);
}

void subscribe(Listener cb, void* ctx) {
    if (s_nsubs < kMaxListeners) s_subs[s_nsubs++] = {cb, ctx};
}

template <typename T>
static T get(const T& v) {
    portENTER_CRITICAL(&s_mux);
    T copy = v;
    portEXIT_CRITICAL(&s_mux);
    return copy;
}

template <typename T>
static void put(T& dst, const T& v) {
    portENTER_CRITICAL(&s_mux);
    bool changed = std::memcmp(&dst, &v, sizeof v) != 0;
    dst = v;
    portEXIT_CRITICAL(&s_mux);
    if (changed) notify();
}

Net net() { return get(s_net); }
void set_net(const Net& n) { put(s_net, n); }
Cloud cloud() { return get(s_cloud); }
void set_cloud(const Cloud& c) { put(s_cloud, c); }
Homekit homekit() { return get(s_hk); }
void set_homekit(const Homekit& h) { put(s_hk, h); }

cJSON* info_json() {
    Net n = net();
    Cloud c = cloud();
    Homekit h = homekit();
    lc::LedConfig led = settings::led();
    settings::Cloud creds;
    settings::cloud(&creds);
    char name[lc::kNameLen + 1];
    settings::name(name);
    char host[40];
    std::snprintf(host, sizeof host, "%s.local", identity::hostname());

    cJSON* o = cJSON_CreateObject();
    cJSON_AddStringToObject(o, "id", identity::device_id());
    cJSON_AddStringToObject(o, "name", name);
    cJSON_AddStringToObject(o, "fw", identity::fw_version());
    cJSON_AddNumberToObject(o, "proto", 1);
    cJSON_AddStringToObject(o, "build", identity::build_id());
    cJSON_AddStringToObject(o, "host", host);

    cJSON* hw = cJSON_AddObjectToObject(o, "hw");
    cJSON_AddStringToObject(hw, "chip", "esp32c3");
    cJSON_AddNumberToObject(hw, "pixels", led.pixel_count);
    cJSON_AddNumberToObject(hw, "channels", led.channels);
    cJSON_AddStringToObject(hw, "color_order", led.color_order);

    cJSON* jn = cJSON_AddObjectToObject(o, "net");
    cJSON_AddStringToObject(jn, "mode", n.mode);
    cJSON_AddStringToObject(jn, "ssid", n.ssid);
    cJSON_AddStringToObject(jn, "ip", n.ip);
    cJSON_AddNumberToObject(jn, "rssi", n.rssi);

    cJSON* jc = cJSON_AddObjectToObject(o, "cloud");
    cJSON_AddStringToObject(jc, "state", c.state);
    cJSON_AddStringToObject(jc, "url", creds.url);
    cJSON_AddBoolToObject(jc, "linked", c.linked);
    cJSON_AddStringToObject(jc, "group_name", c.group_name);
    if (c.problem[0]) cJSON_AddStringToObject(jc, "problem", c.problem);
    cJSON* peers = cJSON_AddArrayToObject(jc, "peers");
    for (const auto& p : c.peers)
        if (p[0]) cJSON_AddItemToArray(peers, cJSON_CreateString(p));

    cJSON* jh = cJSON_AddObjectToObject(o, "homekit");
    cJSON_AddStringToObject(jh, "state", h.state);
    cJSON_AddNumberToObject(jh, "controllers", h.controllers);

#if CONFIG_LAMP_ALLOW_INSECURE_SERVER
    cJSON_AddBoolToObject(o, "insecure_server_allowed", true);
#else
    cJSON_AddBoolToObject(o, "insecure_server_allowed", false);
#endif
    cJSON_AddBoolToObject(o, "setup_mode", n.setup_mode);
    cJSON_AddNumberToObject(o, "presets_rev", lamp::presets_rev());
    cJSON_AddNumberToObject(o, "uptime_s", (double)(esp_timer_get_time() / 1000000));
    return o;
}

}  // namespace lamp::status
