#include "storage/storage.hpp"

#include <cstdlib>
#include <cstring>

#include "esp_log.h"
#include "lamp_core/misc.hpp"
#include "nvs.h"
#include "nvs_flash.h"

static const char* TAG = "storage";

namespace storage {

esp_err_t init() {
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_LOGW(TAG, "NVS needs erase (%s)", esp_err_to_name(err));
        ESP_ERROR_CHECK(nvs_flash_erase());
        err = nvs_flash_init();
    }
    return err;
}

static bool open(const char* ns, nvs_open_mode_t mode, nvs_handle_t* h) {
    esp_err_t err = nvs_open(ns, mode, h);
    if (err != ESP_OK && !(mode == NVS_READONLY && err == ESP_ERR_NVS_NOT_FOUND))
        ESP_LOGW(TAG, "open %s: %s", ns, esp_err_to_name(err));
    return err == ESP_OK;
}

bool load_blob(const char* ns, const char* key, uint8_t schema, void* data, size_t len) {
    nvs_handle_t h;
    if (!open(ns, NVS_READONLY, &h)) return false;
    size_t total = 3 + len + 2;
    uint8_t* buf = (uint8_t*)std::malloc(total);
    bool ok = false;
    if (buf) {
        size_t got = total;
        if (nvs_get_blob(h, key, buf, &got) == ESP_OK && got == total) {
            uint16_t stored_len = (uint16_t)(buf[1] | (buf[2] << 8));
            uint16_t crc = (uint16_t)(buf[3 + len] | (buf[4 + len] << 8));
            if (buf[0] == schema && stored_len == len && crc == lc::crc16(buf, 3 + len)) {
                std::memcpy(data, buf + 3, len);
                ok = true;
            } else {
                ESP_LOGW(TAG, "%s/%s: stale or corrupt blob, using defaults", ns, key);
            }
        }
        std::free(buf);
    }
    nvs_close(h);
    return ok;
}

bool save_blob(const char* ns, const char* key, uint8_t schema, const void* data, size_t len) {
    nvs_handle_t h;
    if (!open(ns, NVS_READWRITE, &h)) return false;
    size_t total = 3 + len + 2;
    uint8_t* buf = (uint8_t*)std::malloc(total);
    bool ok = false;
    if (buf) {
        buf[0] = schema;
        buf[1] = (uint8_t)(len & 0xFF);
        buf[2] = (uint8_t)(len >> 8);
        std::memcpy(buf + 3, data, len);
        uint16_t crc = lc::crc16(buf, 3 + len);
        buf[3 + len] = (uint8_t)(crc & 0xFF);
        buf[4 + len] = (uint8_t)(crc >> 8);
        ok = nvs_set_blob(h, key, buf, total) == ESP_OK && nvs_commit(h) == ESP_OK;
        std::free(buf);
    }
    nvs_close(h);
    if (!ok) ESP_LOGE(TAG, "save %s/%s failed", ns, key);
    return ok;
}

bool load_str(const char* ns, const char* key, char* out, size_t cap) {
    nvs_handle_t h;
    if (!open(ns, NVS_READONLY, &h)) return false;
    size_t len = cap;
    bool ok = nvs_get_str(h, key, out, &len) == ESP_OK;
    nvs_close(h);
    return ok;
}

bool save_str(const char* ns, const char* key, const char* value) {
    nvs_handle_t h;
    if (!open(ns, NVS_READWRITE, &h)) return false;
    bool ok = nvs_set_str(h, key, value) == ESP_OK && nvs_commit(h) == ESP_OK;
    nvs_close(h);
    return ok;
}

bool load_u32(const char* ns, const char* key, uint32_t* out) {
    nvs_handle_t h;
    if (!open(ns, NVS_READONLY, &h)) return false;
    bool ok = nvs_get_u32(h, key, out) == ESP_OK;
    nvs_close(h);
    return ok;
}

bool save_u32(const char* ns, const char* key, uint32_t value) {
    nvs_handle_t h;
    if (!open(ns, NVS_READWRITE, &h)) return false;
    bool ok = nvs_set_u32(h, key, value) == ESP_OK && nvs_commit(h) == ESP_OK;
    nvs_close(h);
    return ok;
}

bool erase_key(const char* ns, const char* key) {
    nvs_handle_t h;
    if (!open(ns, NVS_READWRITE, &h)) return false;
    esp_err_t err = nvs_erase_key(h, key);
    bool ok = (err == ESP_OK || err == ESP_ERR_NVS_NOT_FOUND) && nvs_commit(h) == ESP_OK;
    nvs_close(h);
    return ok;
}

bool erase_namespace(const char* ns) {
    nvs_handle_t h;
    if (!open(ns, NVS_READWRITE, &h)) return false;
    bool ok = nvs_erase_all(h) == ESP_OK && nvs_commit(h) == ESP_OK;
    nvs_close(h);
    return ok;
}

void erase_all() {
    nvs_flash_deinit();
    nvs_flash_erase();
    nvs_flash_init();
}

}  // namespace storage
