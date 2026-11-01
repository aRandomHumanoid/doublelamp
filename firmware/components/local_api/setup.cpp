// First-time setup (03 §8): POST /setup connects the station while the setup AP stays up,
// then saves everything, optionally pairs with the server, and closes the AP after 60 s.
#include <cmath>
#include <cstdio>
#include <cstring>

#include "api_internal.hpp"
#include "cloud_link/cloud_link.hpp"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "homekit/homekit.hpp"
#include "lamp/identity.hpp"
#include "lamp/settings.hpp"
#include "lamp_core/codec.hpp"
#include "lamp/lamp.hpp"
#include "led_output/led_output.hpp"
#include "net/net.hpp"
#include "sdkconfig.h"

static const char* TAG = "setup";

namespace local_api {

namespace {

struct Pending {
    char ssid[33];
    char password[65];
    char name[lc::kNameLen + 1];
    char admin[65];
    uint16_t pixels;
    uint16_t max_ma;
    char server_url[129];
    char code[16];
};

Pending s_p;
volatile bool s_running = false;
volatile bool s_done = false;
char s_cloud[12] = "";
char s_cloud_err[96] = "";
portMUX_TYPE s_mux = portMUX_INITIALIZER_UNLOCKED;

void set_cloud(const char* state, const char* err = "") {
    portENTER_CRITICAL(&s_mux);
    std::snprintf(s_cloud, sizeof s_cloud, "%s", state);
    std::snprintf(s_cloud_err, sizeof s_cloud_err, "%s", err);
    portEXIT_CRITICAL(&s_mux);
}

void setup_task(void*) {
    for (int i = 0; i < 200; i++) {  // up to ~50 s; net times out at 30 s
        vTaskDelay(pdMS_TO_TICKS(250));
        net::SetupStatus st = net::setup_status();
        if (std::strcmp(st.state, "failed") == 0) break;
        if (std::strcmp(st.state, "online") != 0) continue;

        ESP_LOGI(TAG, "WiFi OK (%s): saving settings", st.ip);
        lamp::settings::set_name(s_p.name);
        lamp::settings::set_admin_password(s_p.admin);
        lamp::settings::set_ap_password(s_p.admin);  // default direct-mode password (03 §8)
        lc::LedConfig cfg = lamp::settings::led();
        cfg.pixel_count = s_p.pixels;
        cfg.max_current_ma = s_p.max_ma;
        lamp::settings::set_led(cfg);
        lamp::settings::set_setup_requested(false);
        led_output::setup_success();
        if (!lamp::get_state().on) {  // show that it worked: warm white at about half brightness
            lc::Patch on;
            on.fields = lc::F_ON;
            on.values.on = true;
            lamp::submit(on, 1200, 0, lc::Origin::Local, 100);
        }
        s_done = true;

        if (s_p.server_url[0] && s_p.code[0]) {
            set_cloud("claiming");
            cloud::ClaimResult r = cloud::claim(s_p.server_url, s_p.code);
            set_cloud(r.ok ? "online" : "failed", r.ok ? "" : r.error);
        } else {
            set_cloud("skipped");
        }
        std::memset(s_p.admin, 0, sizeof s_p.admin);
        std::memset(s_p.password, 0, sizeof s_p.password);
        net::finish_setup(60000);  // keep the AP 60 s so the phone can show the new address
        homekit::start();
        net::mdns_start();
        break;
    }
    s_running = false;
    vTaskDelete(nullptr);
}

bool copy_str(const cJSON* body, const char* key, char* out, size_t cap, size_t min_len) {
    const char* v = lc::json_str(body, key);
    if (!v) return min_len == 0;
    size_t n = std::strlen(v);
    if (n < min_len || n >= cap) return false;
    std::memcpy(out, v, n + 1);
    return true;
}

esp_err_t post_setup(httpd_req_t* req) {
    if (!host_ok(req) || !require_setup(req)) return ESP_OK;
    if (s_done) return send_error(req, 409, "conflict", "setup already finished");
    if (s_running) return send_error(req, 409, "busy", "setup is already connecting");
    cJSON* body = read_json(req);
    if (!body) return ESP_OK;
    Pending p{};
    const char* bad = nullptr;
    if (!copy_str(body, "ssid", p.ssid, sizeof p.ssid, 1)) bad = "ssid";
    else if (!copy_str(body, "password", p.password, sizeof p.password, 0)) bad = "password";
    else if (!copy_str(body, "name", p.name, sizeof p.name, 1)) bad = "name";
    else if (!copy_str(body, "admin_password", p.admin, sizeof p.admin, 8)) bad = "admin_password";
    const cJSON* strip = cJSON_GetObjectItemCaseSensitive(body, "strip_m");
    double strip_m = cJSON_IsNumber(strip) ? strip->valuedouble : 0.625;
    if (!bad && (strip_m < 0.0625 || strip_m > 64)) bad = "strip_m";
    long px = std::lround(strip_m * CONFIG_LAMP_DEFAULT_PIXELS_PER_M);
    if (px < 1) px = 1;
    if (px > CONFIG_LAMP_MAX_PIXELS) px = CONFIG_LAMP_MAX_PIXELS;
    p.pixels = (uint16_t)px;
    p.max_ma = 600;
    const cJSON* power = cJSON_GetObjectItemCaseSensitive(body, "power");
    if (!bad && cJSON_IsObject(power)) {
        const char* preset = lc::json_str(power, "preset");
        double ma;
        bool present;
        if (preset) {
            if (!std::strcmp(preset, "12v1a")) p.max_ma = 600;
            else if (!std::strcmp(preset, "12v2a")) p.max_ma = 1400;
            else if (!std::strcmp(preset, "12v3a")) p.max_ma = 2200;
            else if (!std::strcmp(preset, "12v5a")) p.max_ma = 3800;
            else bad = "power";
        } else if (lc::json_int(power, "max_current_ma", 100, 20000, &ma, &present) && present) {
            p.max_ma = (uint16_t)ma;
        } else {
            bad = "power";
        }
    }
    if (!bad) copy_str(body, "server_url", p.server_url, sizeof p.server_url, 0);
    if (!bad) copy_str(body, "pairing_code", p.code, sizeof p.code, 0);
    if (!bad && p.server_url[0] && !p.code[0]) bad = "pairing_code";
    if (!bad && p.server_url[0] && !cloud::url_allowed(p.server_url)) bad = "server_url";
    cJSON_Delete(body);
    if (bad) {
        char msg[64];
        std::snprintf(msg, sizeof msg, "%s is missing or invalid", bad);
        return send_error(req, 400, "invalid", msg, bad);
    }
    s_p = p;
    set_cloud(p.server_url[0] ? "claiming" : "skipped");
    if (!net::setup_connect(p.ssid, p.password)) return send_error(req, 400, "invalid", "could not use that network", "ssid");
    s_running = true;
    if (xTaskCreate(setup_task, "setup", 6144, nullptr, 5, nullptr) != pdPASS) {
        s_running = false;
        return send_error(req, 503, "busy", "out of memory");
    }
    ESP_LOGI(TAG, "connecting to '%s'", p.ssid);
    return send_status(req, 202);
}

esp_err_t get_setup_status(httpd_req_t* req) {
    if (!host_ok(req) || !require_setup(req)) return ESP_OK;
    net::SetupStatus st = net::setup_status();
    cJSON* o = cJSON_CreateObject();
    // Report "online" only once the settings are saved, so the UI's next steps work.
    const char* state = st.state;
    if (std::strcmp(state, "online") == 0 && !s_done) state = "connecting";
    cJSON_AddStringToObject(o, "state", state);
    if (st.reason[0]) cJSON_AddStringToObject(o, "reason", st.reason);
    if (st.ip[0] && s_done) {
        cJSON_AddStringToObject(o, "ip", st.ip);
        char host[40];
        std::snprintf(host, sizeof host, "%s.local", lamp::identity::hostname());
        cJSON_AddStringToObject(o, "host", host);
    }
    portENTER_CRITICAL(&s_mux);
    char cloud[12], err[96];
    std::memcpy(cloud, s_cloud, sizeof cloud);
    std::memcpy(err, s_cloud_err, sizeof err);
    portEXIT_CRITICAL(&s_mux);
    if (cloud[0] && std::strcmp(st.state, "idle") != 0) cJSON_AddStringToObject(o, "cloud", cloud);
    if (err[0]) cJSON_AddStringToObject(o, "cloud_error", err);
    return send_json(req, 200, o);
}

}  // namespace

void setup_register(httpd_handle_t s) {
    httpd_uri_t a = {};
    a.uri = "/api/v1/setup";
    a.method = HTTP_POST;
    a.handler = post_setup;
    httpd_register_uri_handler(s, &a);
    httpd_uri_t b = {};
    b.uri = "/api/v1/setup/status";
    b.method = HTTP_GET;
    b.handler = get_setup_status;
    httpd_register_uri_handler(s, &b);
}

}  // namespace local_api
