// WiFi state machine (03 §7):
//   Boot → Setup (no credentials / requested) | Connecting → Online; Connecting → Fallback after 2 min.
#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <cstring>

#include "esp_event.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_random.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "lamp/identity.hpp"
#include "lamp/settings.hpp"
#include "lamp/status.hpp"
#include "led_output/led_output.hpp"
#include "net/net.hpp"
#include "net_internal.hpp"

static const char* TAG = "wifi";

namespace net {

namespace {

constexpr int64_t kFallbackAfterMs = 120000;
constexpr uint32_t kSetupTimeoutMs = 30000;

esp_netif_t* s_sta = nullptr;
esp_netif_t* s_ap = nullptr;
portMUX_TYPE s_mux = portMUX_INITIALIZER_UNLOCKED;
volatile Mode s_mode = Mode::Connecting;
bool s_setup = false;
bool s_ap_up = false;
bool s_ap_open = false;
uint8_t s_ap_channel = 1;
volatile bool s_want_sta = false;
int s_retry = 0;
int64_t s_connecting_since = 0;
esp_timer_handle_t s_retry_timer, s_fallback_timer, s_setup_timer, s_finish_timer, s_rssi_timer;
SetupStatus s_setup_status = {"idle", "", ""};
int s_setup_attempts = 0;

constexpr int kMaxListeners = 6;
struct Sub {
    Listener cb;
    void* ctx;
};
Sub s_subs[kMaxListeners];
int s_nsubs = 0;

void publish_status() {
    lamp::status::Net n = lamp::status::net();
    std::snprintf(n.mode, sizeof n.mode, "%s", s_ap_up ? (s_mode == Mode::Online || s_want_sta ? "apsta" : "ap") : "sta");
    wifi_config_t conf{};
    if (esp_wifi_get_config(WIFI_IF_STA, &conf) == ESP_OK)
        std::snprintf(n.ssid, sizeof n.ssid, "%s", (const char*)conf.sta.ssid);
    n.online = s_mode == Mode::Online;
    n.setup_mode = s_setup;
    if (n.online) {
        esp_netif_ip_info_t ip;
        if (esp_netif_get_ip_info(s_sta, &ip) == ESP_OK) std::snprintf(n.ip, sizeof n.ip, IPSTR, IP2STR(&ip.ip));
        int r = rssi();
        if (n.rssi == 0 || std::abs(r - n.rssi) >= 5) n.rssi = r;  // hysteresis: telemetry has the live value
    } else {
        std::snprintf(n.ip, sizeof n.ip, "%s", s_ap_up ? "192.168.4.1" : "");
        n.rssi = 0;
    }
    lamp::status::set_net(n);
}

void set_mode(Mode m) {
    bool changed = s_mode != m;
    s_mode = m;
    publish_status();
    if (!changed) return;
    static const char* names[] = {"setup", "connecting", "online", "fallback"};
    ESP_LOGI(TAG, "mode → %s", names[(int)m]);
    for (int i = 0; i < s_nsubs; i++) s_subs[i].cb(m, s_subs[i].ctx);
}

void configure_ap(bool open) {
    wifi_config_t ap{};
    const char* ssid = lamp::identity::ap_ssid();
    std::snprintf((char*)ap.ap.ssid, sizeof ap.ap.ssid, "%s", ssid);
    ap.ap.ssid_len = (uint8_t)std::strlen(ssid);
    ap.ap.channel = s_ap_channel;
    ap.ap.max_connection = 4;
    char psk[65];
    lamp::settings::ap_password(psk);
    if (open || std::strlen(psk) < 8) {
        ap.ap.authmode = WIFI_AUTH_OPEN;
        open = true;
    } else {
        size_t n = strnlen(psk, sizeof ap.ap.password - 1);  // WPA2 passphrases are at most 63 chars
        std::memcpy(ap.ap.password, psk, n);
        ap.ap.password[n] = '\0';
        ap.ap.authmode = WIFI_AUTH_WPA2_PSK;
    }
    ap.ap.pmf_cfg.required = false;
    esp_wifi_set_config(WIFI_IF_AP, &ap);
    s_ap_open = open;
}

void set_ap(bool up, bool open) {
    if (up == s_ap_up && (!up || open == s_ap_open)) return;
    if (up) {
        esp_wifi_set_mode(WIFI_MODE_APSTA);
        configure_ap(open);
    } else {
        esp_wifi_set_mode(WIFI_MODE_STA);
    }
    s_ap_up = up;
    ESP_LOGI(TAG, "access point %s%s", up ? "up" : "down", up ? (s_ap_open ? " (open)" : " (WPA2)") : "");
    publish_status();
}

void connect_now() {
    if (!s_want_sta) return;
    esp_err_t err = esp_wifi_connect();
    if (err != ESP_OK && err != ESP_ERR_WIFI_CONN) ESP_LOGW(TAG, "connect: %s", esp_err_to_name(err));
}

void schedule_retry() {
    if (!s_want_sta) return;
    // 1 s → 30 s with ±20 % jitter (03 §7)
    uint64_t base = 1000ull << std::min(s_retry, 5);
    if (base > 30000) base = 30000;
    uint64_t jitter = base / 5;
    uint64_t delay = base - jitter + (esp_random() % (2 * jitter + 1));
    s_retry++;
    esp_timer_stop(s_retry_timer);
    esp_timer_start_once(s_retry_timer, delay * 1000);
}

const char* reason_to_setup_error(uint8_t reason) {
    switch (reason) {
        case WIFI_REASON_AUTH_FAIL:
        case WIFI_REASON_4WAY_HANDSHAKE_TIMEOUT:
        case WIFI_REASON_HANDSHAKE_TIMEOUT:
        case WIFI_REASON_MIC_FAILURE:
            return "wrong_password";
        case WIFI_REASON_NO_AP_FOUND:
        case WIFI_REASON_NO_AP_FOUND_W_COMPATIBLE_SECURITY:
        case WIFI_REASON_NO_AP_FOUND_IN_AUTHMODE_THRESHOLD:
            return "no_network";
        default:
            return nullptr;
    }
}

void setup_fail(const char* reason) {
    portENTER_CRITICAL(&s_mux);
    std::snprintf(s_setup_status.state, sizeof s_setup_status.state, "failed");
    std::snprintf(s_setup_status.reason, sizeof s_setup_status.reason, "%s", reason);
    portEXIT_CRITICAL(&s_mux);
    esp_timer_stop(s_setup_timer);
    s_want_sta = false;
    esp_wifi_disconnect();
    ESP_LOGW(TAG, "setup connect failed: %s", reason);
}

void on_wifi(void*, esp_event_base_t, int32_t id, void* data) {
    switch (id) {
        case WIFI_EVENT_STA_START:
            connect_now();
            break;
        case WIFI_EVENT_STA_CONNECTED:
            ESP_LOGI(TAG, "associated");
            break;
        case WIFI_EVENT_STA_DISCONNECTED: {
            auto* ev = (wifi_event_sta_disconnected_t*)data;
            ESP_LOGW(TAG, "disconnected, reason %u", ev->reason);
            bool in_setup_connect = s_setup && std::strcmp(s_setup_status.state, "connecting") == 0;
            if (in_setup_connect) {
                const char* r = reason_to_setup_error(ev->reason);
                s_setup_attempts++;
                if (r && (std::strcmp(r, "wrong_password") == 0 || s_setup_attempts >= 3)) {
                    setup_fail(r);
                    break;
                }
            }
            if (s_mode == Mode::Online) {
                s_connecting_since = esp_timer_get_time() / 1000;
                set_mode(Mode::Connecting);
                esp_timer_stop(s_fallback_timer);
                esp_timer_start_once(s_fallback_timer, kFallbackAfterMs * 1000);
            }
            schedule_retry();
            break;
        }
        case WIFI_EVENT_AP_STACONNECTED:
            ESP_LOGI(TAG, "a phone joined the lamp's access point");
            break;
        default:
            break;
    }
}

void on_ip(void*, esp_event_base_t, int32_t id, void* data) {
    if (id == IP_EVENT_STA_GOT_IP) {
        auto* ev = (ip_event_got_ip_t*)data;
        ESP_LOGI(TAG, "online, IP " IPSTR, IP2STR(&ev->ip_info.ip));
        s_retry = 0;
        esp_timer_stop(s_fallback_timer);
        esp_timer_stop(s_retry_timer);
        if (s_setup && std::strcmp(s_setup_status.state, "connecting") == 0) {
            portENTER_CRITICAL(&s_mux);
            std::snprintf(s_setup_status.state, sizeof s_setup_status.state, "online");
            std::snprintf(s_setup_status.ip, sizeof s_setup_status.ip, IPSTR, IP2STR(&ev->ip_info.ip));
            s_setup_status.reason[0] = '\0';
            portEXIT_CRITICAL(&s_mux);
            esp_timer_stop(s_setup_timer);
        }
        if (!s_setup && s_mode == Mode::Fallback && !lamp::settings::ap_always_on()) set_ap(false, false);
        set_mode(Mode::Online);
        internal_on_online();
    } else if (id == IP_EVENT_STA_LOST_IP) {
        ESP_LOGW(TAG, "lost IP");
    }
}

void retry_cb(void*) { connect_now(); }

void fallback_cb(void*) {
    if (s_mode == Mode::Online || s_setup) return;
    char psk[65];
    lamp::settings::ap_password(psk);
    if (std::strlen(psk) < 8) return;  // no direct-mode password yet: stay station-only
    ESP_LOGW(TAG, "not online after 2 min: starting the fallback access point");
    set_ap(true, false);
    set_mode(Mode::Fallback);
}

void setup_timeout_cb(void*) {
    if (std::strcmp(s_setup_status.state, "connecting") == 0) setup_fail("timeout");
}

void finish_cb(void*) {
    s_setup = false;
    captive_dns_stop();
    led_output::set_setup_mode(false);
    if (!lamp::settings::ap_always_on()) set_ap(false, false);
    else set_ap(true, false);
    publish_status();
    ESP_LOGI(TAG, "setup finished: access point closed");
}

void rssi_cb(void*) {
    if (s_mode == Mode::Online) publish_status();
}

void make_timer(esp_timer_cb_t cb, const char* name, esp_timer_handle_t* out) {
    esp_timer_create_args_t a = {};
    a.callback = cb;
    a.name = name;
    esp_timer_create(&a, out);
}

}  // namespace

void init() {
    ESP_ERROR_CHECK(esp_netif_init());
    esp_err_t err = esp_event_loop_create_default();
    if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) ESP_ERROR_CHECK(err);
    s_sta = esp_netif_create_default_wifi_sta();
    s_ap = esp_netif_create_default_wifi_ap();
    esp_netif_set_hostname(s_sta, lamp::identity::hostname());
    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&cfg));
    ESP_ERROR_CHECK(esp_wifi_set_storage(WIFI_STORAGE_FLASH));
    ESP_ERROR_CHECK(esp_event_handler_instance_register(WIFI_EVENT, ESP_EVENT_ANY_ID, on_wifi, nullptr, nullptr));
    ESP_ERROR_CHECK(esp_event_handler_instance_register(IP_EVENT, ESP_EVENT_ANY_ID, on_ip, nullptr, nullptr));
    make_timer(retry_cb, "wifi_retry", &s_retry_timer);
    make_timer(fallback_cb, "wifi_fallback", &s_fallback_timer);
    make_timer(setup_timeout_cb, "wifi_setup", &s_setup_timer);
    make_timer(finish_cb, "wifi_finish", &s_finish_timer);
    make_timer(rssi_cb, "wifi_rssi", &s_rssi_timer);
}

bool has_credentials() {
    wifi_config_t conf{};
    return esp_wifi_get_config(WIFI_IF_STA, &conf) == ESP_OK && conf.sta.ssid[0] != 0;
}

void start(bool setup_mode) {
    s_setup = setup_mode;
    if (setup_mode) {
        s_want_sta = false;
        // Start the AP on the strongest nearby network's channel: when the station later joins
        // that network the AP doesn't have to change channel, which drops phones (03 §8).
        esp_wifi_set_mode(WIFI_MODE_STA);
        ESP_ERROR_CHECK(esp_wifi_start());
        esp_wifi_set_ps(WIFI_PS_NONE);
        wifi_scan_config_t sc = {};
        if (esp_wifi_scan_start(&sc, true) == ESP_OK) {
            uint16_t n = 16;
            wifi_ap_record_t* recs = (wifi_ap_record_t*)calloc(n, sizeof(wifi_ap_record_t));
            if (recs && esp_wifi_scan_get_ap_records(&n, recs) == ESP_OK) {
                int best = -1;
                for (int i = 0; i < n; i++)
                    if (recs[i].primary >= 1 && recs[i].primary <= 13 && (best < 0 || recs[i].rssi > recs[best].rssi))
                        best = i;
                if (best >= 0) s_ap_channel = recs[best].primary;
            }
            free(recs);
            esp_wifi_clear_ap_list();
        }
        ESP_LOGI(TAG, "setup mode: open access point %s on channel %u", lamp::identity::ap_ssid(), s_ap_channel);
        esp_wifi_set_mode(WIFI_MODE_APSTA);
        configure_ap(true);
        s_ap_up = true;
        // DHCP option 114 (RFC 8910) points phones straight at the setup page
        static const char portal[] = "http://192.168.4.1";
        esp_netif_dhcps_stop(s_ap);
        esp_netif_dhcps_option(s_ap, ESP_NETIF_OP_SET, ESP_NETIF_CAPTIVEPORTAL_URI, (void*)portal, sizeof portal - 1);
        esp_netif_dhcps_start(s_ap);
        captive_dns_start();
        led_output::set_setup_mode(true);
        set_mode(Mode::Setup);
    } else {
        bool ap = lamp::settings::ap_always_on();
        esp_wifi_set_mode(ap ? WIFI_MODE_APSTA : WIFI_MODE_STA);
        if (ap) configure_ap(false);
        s_ap_up = ap;
        s_want_sta = true;
        s_connecting_since = esp_timer_get_time() / 1000;
        ESP_ERROR_CHECK(esp_wifi_start());
        esp_wifi_set_ps(WIFI_PS_NONE);  // mains powered; modem sleep adds latency (03 §7)
        set_mode(Mode::Connecting);
        esp_timer_start_once(s_fallback_timer, kFallbackAfterMs * 1000);
    }
    esp_timer_start_periodic(s_rssi_timer, 30ull * 1000 * 1000);
}

Mode mode() { return s_mode; }
bool online() { return s_mode == Mode::Online; }
bool in_setup() { return s_setup; }

void subscribe(Listener cb, void* ctx) {
    if (s_nsubs < kMaxListeners) s_subs[s_nsubs++] = {cb, ctx};
}

bool setup_connect(const char* ssid, const char* password) {
    if (!ssid || !*ssid || std::strlen(ssid) > 32 || (password && std::strlen(password) > 64)) return false;
    wifi_config_t conf{};
    std::snprintf((char*)conf.sta.ssid, sizeof conf.sta.ssid, "%s", ssid);
    if (password) std::memcpy(conf.sta.password, password, std::min(std::strlen(password), sizeof conf.sta.password));
    conf.sta.scan_method = WIFI_ALL_CHANNEL_SCAN;
    conf.sta.sort_method = WIFI_CONNECT_AP_BY_SIGNAL;
    conf.sta.threshold.authmode = (password && *password) ? WIFI_AUTH_WEP : WIFI_AUTH_OPEN;
    conf.sta.pmf_cfg.capable = true;
    esp_wifi_disconnect();
    if (esp_wifi_set_config(WIFI_IF_STA, &conf) != ESP_OK) return false;
    portENTER_CRITICAL(&s_mux);
    std::snprintf(s_setup_status.state, sizeof s_setup_status.state, "connecting");
    s_setup_status.reason[0] = '\0';
    s_setup_status.ip[0] = '\0';
    portEXIT_CRITICAL(&s_mux);
    s_setup_attempts = 0;
    s_retry = 0;
    s_want_sta = true;
    esp_timer_stop(s_setup_timer);
    esp_timer_start_once(s_setup_timer, (uint64_t)kSetupTimeoutMs * 1000);
    connect_now();
    return true;
}

SetupStatus setup_status() {
    portENTER_CRITICAL(&s_mux);
    SetupStatus s = s_setup_status;
    portEXIT_CRITICAL(&s_mux);
    return s;
}

void finish_setup(uint32_t delay_ms) {
    esp_timer_stop(s_finish_timer);
    esp_timer_start_once(s_finish_timer, (uint64_t)delay_ms * 1000);
}

static const char* auth_name(wifi_auth_mode_t m) {
    switch (m) {
        case WIFI_AUTH_OPEN: return "open";
        case WIFI_AUTH_WEP: return "wep";
        case WIFI_AUTH_WPA_PSK: return "wpa";
        case WIFI_AUTH_WPA3_PSK: return "wpa3";
        case WIFI_AUTH_WPA2_ENTERPRISE: return "wpa2-enterprise";
        default: return "wpa2";
    }
}

int scan(Network* out, int max) {
    wifi_scan_config_t sc = {};
    sc.show_hidden = false;
    if (esp_wifi_scan_start(&sc, true) != ESP_OK) return 0;
    uint16_t count = 0;
    esp_wifi_scan_get_ap_num(&count);
    if (count > 24) count = 24;
    wifi_ap_record_t* recs = (wifi_ap_record_t*)calloc(count ? count : 1, sizeof(wifi_ap_record_t));
    if (!recs) return 0;
    esp_wifi_scan_get_ap_records(&count, recs);
    std::sort(recs, recs + count, [](const wifi_ap_record_t& a, const wifi_ap_record_t& b) { return a.rssi > b.rssi; });
    int n = 0;
    for (int i = 0; i < count && n < max; i++) {
        const char* ssid = (const char*)recs[i].ssid;
        if (!ssid[0]) continue;
        bool dup = false;
        for (int k = 0; k < n; k++) dup |= std::strcmp(out[k].ssid, ssid) == 0;
        if (dup) continue;  // sorted strongest first, so the first copy wins
        std::snprintf(out[n].ssid, sizeof out[n].ssid, "%s", ssid);
        out[n].rssi = recs[i].rssi;
        out[n].auth = auth_name(recs[i].authmode);
        n++;
    }
    free(recs);
    return n;
}

bool set_credentials(const char* ssid, const char* password) {
    if (!ssid || !*ssid || std::strlen(ssid) > 32 || (password && std::strlen(password) > 64)) return false;
    wifi_config_t conf{};
    std::snprintf((char*)conf.sta.ssid, sizeof conf.sta.ssid, "%s", ssid);
    if (password) std::memcpy(conf.sta.password, password, std::min(std::strlen(password), sizeof conf.sta.password));
    conf.sta.scan_method = WIFI_ALL_CHANNEL_SCAN;
    conf.sta.sort_method = WIFI_CONNECT_AP_BY_SIGNAL;
    conf.sta.pmf_cfg.capable = true;
    esp_wifi_disconnect();
    if (esp_wifi_set_config(WIFI_IF_STA, &conf) != ESP_OK) return false;
    s_want_sta = true;
    s_retry = 0;
    connect_now();
    return true;
}

int8_t rssi() {
    wifi_ap_record_t ap;
    return esp_wifi_sta_get_ap_info(&ap) == ESP_OK ? ap.rssi : 0;
}

void refresh_ap() {
    if (s_setup) return;
    bool want = lamp::settings::ap_always_on() || s_mode == Mode::Fallback;
    if (want && s_ap_up) configure_ap(false);  // password may have changed
    set_ap(want, false);
}

}  // namespace net
