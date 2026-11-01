#include "lamp/settings.hpp"

#include <cstdio>
#include <cstring>

#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "lamp/identity.hpp"
#include "mbedtls/md.h"
#include "mbedtls/pkcs5.h"
#include "sdkconfig.h"
#include "storage/storage.hpp"

static const char* TAG = "settings";

namespace lamp::settings {

namespace {

constexpr uint8_t kLedSchema = 1;
constexpr uint8_t kAdminSchema = 1;
constexpr uint32_t kPbkdf2Iterations = 10000;

struct AdminBlob {
    uint8_t salt[16];
    uint8_t hash[32];
    uint32_t iters;
};

SemaphoreHandle_t s_mutex;
lc::LedConfig s_led;
char s_name[lc::kNameLen + 1];
bool s_have_admin = false;
AdminBlob s_admin;
char s_ap_psk[65];
bool s_ap_always_on = false;
Cloud s_cloud;
bool s_claimed = false;

constexpr int kMaxListeners = 6;
struct Sub {
    Listener cb;
    void* ctx;
};
Sub s_subs[kMaxListeners];
int s_nsubs = 0;

struct Lock {
    Lock() { xSemaphoreTake(s_mutex, portMAX_DELAY); }
    ~Lock() { xSemaphoreGive(s_mutex); }
};

void notify(uint32_t topics) {
    for (int i = 0; i < s_nsubs; i++) s_subs[i].cb(topics, s_subs[i].ctx);
}

void pbkdf2(const char* password, const uint8_t salt[16], uint32_t iters, uint8_t out[32]) {
    mbedtls_pkcs5_pbkdf2_hmac_ext(MBEDTLS_MD_SHA256, (const unsigned char*)password, std::strlen(password), salt, 16,
                                  iters, 32, out);
}

}  // namespace

void init() {
    s_mutex = xSemaphoreCreateMutex();
    uint16_t px = CONFIG_LAMP_DEFAULT_PIXEL_COUNT;
    if (!storage::load_blob("led", "cfg", kLedSchema, &s_led, sizeof s_led) ||
        !lc::valid_color_order(s_led.color_order) || s_led.pixel_count < 1 ||
        s_led.pixel_count > CONFIG_LAMP_MAX_PIXELS) {
        s_led = lc::default_led_config(px, CONFIG_LAMP_DEFAULT_MA_PER_PIXEL);
    }
    if (!storage::load_str("dev", "name", s_name, sizeof s_name)) {
        // "Lamp 3FA2C1" until setup names it
        std::snprintf(s_name, sizeof s_name, "Lamp %s", identity::ap_ssid() + 11);
    }
    s_have_admin = storage::load_blob("dev", "admin", kAdminSchema, &s_admin, sizeof s_admin);
    if (!storage::load_str("dev", "ap_psk", s_ap_psk, sizeof s_ap_psk)) s_ap_psk[0] = '\0';
    uint32_t v = 0;
    s_ap_always_on = storage::load_u32("net", "ap_always", &v) && v;
    std::memset(&s_cloud, 0, sizeof s_cloud);
    s_claimed = storage::load_str("cloud", "url", s_cloud.url, sizeof s_cloud.url) &&
                storage::load_str("cloud", "ws", s_cloud.ws_url, sizeof s_cloud.ws_url) &&
                storage::load_str("cloud", "token", s_cloud.token, sizeof s_cloud.token) && s_cloud.token[0];
    ESP_LOGI(TAG, "name '%s', %u px, %s, claimed=%d", s_name, s_led.pixel_count, s_led.color_order, s_claimed);
}

void subscribe(Listener cb, void* ctx) {
    if (s_nsubs < kMaxListeners) s_subs[s_nsubs++] = {cb, ctx};
}

lc::LedConfig led() {
    Lock l;
    return s_led;
}

bool set_led(const lc::LedConfig& cfg) {
    {
        Lock l;
        s_led = cfg;
    }
    bool ok = storage::save_blob("led", "cfg", kLedSchema, &cfg, sizeof cfg);
    notify(TOPIC_LED);
    return ok;
}

void name(char out[lc::kNameLen + 1]) {
    Lock l;
    std::memcpy(out, s_name, sizeof s_name);
}

bool set_name(const char* n) {
    if (!n || !*n || std::strlen(n) > lc::kNameLen) return false;
    {
        Lock l;
        std::snprintf(s_name, sizeof s_name, "%s", n);
    }
    bool ok = storage::save_str("dev", "name", n);
    notify(TOPIC_NAME);
    return ok;
}

bool has_admin_password() { return s_have_admin; }

bool check_admin_password(const char* password) {
    if (!s_have_admin || !password) return false;
    AdminBlob a;
    {
        Lock l;
        a = s_admin;
    }
    uint8_t h[32];
    pbkdf2(password, a.salt, a.iters, h);
    uint8_t diff = 0;
    for (int i = 0; i < 32; i++) diff |= (uint8_t)(h[i] ^ a.hash[i]);
    return diff == 0;
}

bool set_admin_password(const char* password) {
    if (!password || std::strlen(password) < 8) return false;
    AdminBlob a;
    for (int i = 0; i < 16; i += 4) {
        uint32_t r = identity::random32();
        std::memcpy(a.salt + i, &r, 4);
    }
    a.iters = kPbkdf2Iterations;
    pbkdf2(password, a.salt, a.iters, a.hash);
    {
        Lock l;
        s_admin = a;
        s_have_admin = true;
    }
    bool ok = storage::save_blob("dev", "admin", kAdminSchema, &a, sizeof a);
    notify(TOPIC_SECURITY);
    return ok;
}

void ap_password(char out[65]) {
    Lock l;
    std::memcpy(out, s_ap_psk, sizeof s_ap_psk);
}

bool set_ap_password(const char* password) {
    if (!password || std::strlen(password) < 8 || std::strlen(password) > 63) return false;
    {
        Lock l;
        std::snprintf(s_ap_psk, sizeof s_ap_psk, "%s", password);
    }
    bool ok = storage::save_str("dev", "ap_psk", password);
    notify(TOPIC_NETWORK);
    return ok;
}

bool ap_always_on() { return s_ap_always_on; }

void set_ap_always_on(bool on) {
    s_ap_always_on = on;
    storage::save_u32("net", "ap_always", on ? 1 : 0);
    notify(TOPIC_NETWORK);
}

bool cloud(Cloud* out) {
    Lock l;
    *out = s_cloud;
    return s_claimed;
}

bool claimed() { return s_claimed; }

bool set_cloud(const Cloud& c) {
    bool ok = storage::save_str("cloud", "url", c.url) && storage::save_str("cloud", "ws", c.ws_url) &&
              storage::save_str("cloud", "token", c.token);
    {
        Lock l;
        s_cloud = c;
        s_claimed = ok && c.token[0];
    }
    notify(TOPIC_CLOUD);
    return ok;
}

void clear_cloud() {
    storage::erase_namespace("cloud");
    {
        Lock l;
        std::memset(&s_cloud, 0, sizeof s_cloud);
        s_claimed = false;
    }
    notify(TOPIC_CLOUD);
}

bool setup_requested() {
    uint32_t v = 0;
    return storage::load_u32("sys", "setup", &v) && v;
}

void set_setup_requested(bool requested) { storage::save_u32("sys", "setup", requested ? 1 : 0); }

}  // namespace lamp::settings
