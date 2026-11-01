// Pairing with a server (04 §4.5): POST {server}/api/v1/devices/claim with a one-time code.
#include <cctype>
#include <cstdio>
#include <cstdlib>
#include <cstring>

#include "cJSON.h"
#include "cloud_link/cloud_link.hpp"
#include "esp_crt_bundle.h"
#include "esp_http_client.h"
#include "esp_log.h"
#include "lamp/identity.hpp"
#include "lamp/settings.hpp"
#include "lamp_core/codec.hpp"
#include "sdkconfig.h"

static const char* TAG = "claim";

namespace cloud {

namespace {

/** Host part of "scheme://host[:port]/…" into out. */
void url_host(const char* url, char* out, size_t cap) {
    const char* p = std::strstr(url, "://");
    p = p ? p + 3 : url;
    size_t n = 0;
    while (p[n] && p[n] != ':' && p[n] != '/' && n + 1 < cap) {
        out[n] = (char)std::tolower((unsigned char)p[n]);
        n++;
    }
    out[n] = '\0';
}

bool private_host(const char* host) {
    unsigned a, b, c, d;
    if (std::sscanf(host, "%u.%u.%u.%u", &a, &b, &c, &d) == 4) {
        return a == 10 || a == 127 || (a == 192 && b == 168) || (a == 172 && b >= 16 && b <= 31) ||
               (a == 169 && b == 254);
    }
    size_t n = std::strlen(host);
    return std::strcmp(host, "localhost") == 0 || (n > 6 && std::strcmp(host + n - 6, ".local") == 0);
}

struct Buf {
    char data[768];
    int len;
};

esp_err_t on_http(esp_http_client_event_t* evt) {
    if (evt->event_id == HTTP_EVENT_ON_DATA && evt->user_data) {
        Buf* b = (Buf*)evt->user_data;
        int room = (int)sizeof b->data - 1 - b->len;
        int n = evt->data_len < room ? evt->data_len : room;
        if (n > 0) {
            std::memcpy(b->data + b->len, evt->data, n);
            b->len += n;
            b->data[b->len] = '\0';
        }
    }
    return ESP_OK;
}

}  // namespace

bool url_allowed(const char* url) {
    if (!url) return false;
    if (std::strncmp(url, "https://", 8) == 0 || std::strncmp(url, "wss://", 6) == 0) return true;
#if CONFIG_LAMP_ALLOW_INSECURE_SERVER
    if (std::strncmp(url, "http://", 7) == 0 || std::strncmp(url, "ws://", 5) == 0) {
        char host[96];
        url_host(url, host, sizeof host);
        return private_host(host);
    }
#endif
    return false;
}

ClaimResult claim(const char* server_url, const char* code_in) {
    ClaimResult r{};
    std::snprintf(r.code, sizeof r.code, "invalid");
    char base[129];
    std::snprintf(base, sizeof base, "%s", server_url ? server_url : "");
    size_t bl = std::strlen(base);
    while (bl && (base[bl - 1] == '/' || base[bl - 1] == ' ')) base[--bl] = '\0';
    if (!bl || !url_allowed(base)) {
#if CONFIG_LAMP_ALLOW_INSECURE_SERVER
        std::snprintf(r.error, sizeof r.error, "server URL must start with https:// (or http:// on your own network)");
#else
        std::snprintf(r.error, sizeof r.error, "server URL must start with https://");
#endif
        return r;
    }
    // Normalize the pairing code to XXXX-XXXX
    char digits[9];
    int n = 0;
    for (const char* p = code_in ? code_in : ""; *p && n < 8; p++)
        if (std::isalnum((unsigned char)*p)) digits[n++] = (char)std::toupper((unsigned char)*p);
    if (n != 8) {
        std::snprintf(r.error, sizeof r.error, "pairing code must be 8 characters (XXXX-XXXX)");
        return r;
    }
    char code[10];
    std::snprintf(code, sizeof code, "%.4s-%.4s", digits, digits + 4);

    lc::LedConfig led = lamp::settings::led();
    char name[lc::kNameLen + 1];
    lamp::settings::name(name);
    cJSON* body = cJSON_CreateObject();
    cJSON_AddStringToObject(body, "code", code);
    cJSON_AddStringToObject(body, "device_id", lamp::identity::device_id());
    cJSON_AddStringToObject(body, "name", name);
    cJSON_AddStringToObject(body, "fw", lamp::identity::fw_version());
    cJSON* hw = cJSON_AddObjectToObject(body, "hw");
    cJSON_AddStringToObject(hw, "chip", "esp32c3");
    cJSON_AddNumberToObject(hw, "pixels", led.pixel_count);
    cJSON_AddNumberToObject(hw, "channels", led.channels);
    char* text = cJSON_PrintUnformatted(body);
    cJSON_Delete(body);

    char url[192];
    std::snprintf(url, sizeof url, "%s/api/v1/devices/claim", base);
    Buf* resp = (Buf*)std::calloc(1, sizeof(Buf));
    esp_http_client_config_t cfg = {};
    cfg.url = url;
    cfg.method = HTTP_METHOD_POST;
    cfg.timeout_ms = 15000;
    cfg.crt_bundle_attach = esp_crt_bundle_attach;
    cfg.event_handler = on_http;
    cfg.user_data = resp;
    esp_http_client_handle_t c = esp_http_client_init(&cfg);
    if (!c || !resp || !text) {
        std::snprintf(r.error, sizeof r.error, "out of memory");
    } else {
        char ua[40];
        std::snprintf(ua, sizeof ua, "DoubleLamp/%s", lamp::identity::fw_version());
        esp_http_client_set_header(c, "Content-Type", "application/json");
        esp_http_client_set_header(c, "User-Agent", ua);
        esp_http_client_set_post_field(c, text, (int)std::strlen(text));
        esp_err_t err = esp_http_client_perform(c);
        int status = esp_http_client_get_status_code(c);
        if (err != ESP_OK) {
            std::snprintf(r.code, sizeof r.code, "unreachable");
            std::snprintf(r.error, sizeof r.error, "could not reach the server (%s)", esp_err_to_name(err));
        } else if (status != 200) {
            cJSON* j = cJSON_Parse(resp->data);
            const cJSON* e = j ? cJSON_GetObjectItemCaseSensitive(j, "error") : nullptr;
            const char* msg = e ? lc::json_str(e, "message") : nullptr;
            const char* ecode = e ? lc::json_str(e, "code") : nullptr;
            if (status == 410 || (ecode && std::strcmp(ecode, "code_expired") == 0)) {
                std::snprintf(r.code, sizeof r.code, "code_expired");
                std::snprintf(r.error, sizeof r.error, "pairing code expired: create a new one");
            } else if (status == 429) {
                std::snprintf(r.code, sizeof r.code, "rate_limited");
                std::snprintf(r.error, sizeof r.error, "too many attempts: wait a minute");
            } else if (ecode && std::strcmp(ecode, "invalid_code") == 0) {
                std::snprintf(r.code, sizeof r.code, "invalid_code");
                std::snprintf(r.error, sizeof r.error, "that pairing code isn't valid: check it or create a new one");
            } else {
                std::snprintf(r.code, sizeof r.code, "claim_failed");
                std::snprintf(r.error, sizeof r.error, "server said %d%s%s", status, msg ? ": " : "", msg ? msg : "");
            }
            cJSON_Delete(j);
        } else {
            cJSON* j = cJSON_Parse(resp->data);
            const char* token = j ? lc::json_str(j, "device_token") : nullptr;
            const char* ws_url = j ? lc::json_str(j, "ws_url") : nullptr;
            if (!token || !ws_url || std::strlen(token) > 64 || std::strlen(ws_url) > 160) {
                std::snprintf(r.code, sizeof r.code, "claim_failed");
                std::snprintf(r.error, sizeof r.error, "unexpected reply from the server");
            } else if (!url_allowed(ws_url)) {
                std::snprintf(r.error, sizeof r.error, "server gave a non-secure ws_url (%.40s)", ws_url);
            } else {
                lamp::settings::Cloud creds{};
                std::snprintf(creds.url, sizeof creds.url, "%s", base);
                std::snprintf(creds.ws_url, sizeof creds.ws_url, "%s", ws_url);
                std::snprintf(creds.token, sizeof creds.token, "%s", token);
                r.ok = lamp::settings::set_cloud(creds);
                if (!r.ok) std::snprintf(r.error, sizeof r.error, "could not save the server credentials");
                else ESP_LOGI(TAG, "paired with %s", base);
            }
            cJSON_Delete(j);
        }
    }
    if (c) esp_http_client_cleanup(c);
    std::free(resp);
    if (text) cJSON_free(text);
    if (!r.ok) ESP_LOGW(TAG, "claim failed: %s", r.error);
    return r;
}

}  // namespace cloud
