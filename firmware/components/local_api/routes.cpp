// Local API routes (04 §3).
#include <cstdio>
#include <cstdlib>
#include <cstring>

#include "api_internal.hpp"
#include "cloud_link/cloud_link.hpp"
#include "esp_log.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "homekit/homekit.hpp"
#include "lamp/lamp.hpp"
#include "lamp/log_ring.hpp"
#include "lamp/settings.hpp"
#include "lamp/status.hpp"
#include "lamp_core/codec.hpp"
#include "led_output/led_output.hpp"
#include "net/net.hpp"
#include "ota/ota.hpp"
#include "storage/storage.hpp"

static const char* TAG = "api";

namespace local_api {

namespace {

using lc::JsonError;

void restart_soon(uint32_t ms, bool factory) {
    static esp_timer_handle_t t = nullptr;
    static bool wipe = false;
    wipe = factory;
    if (!t) {
        esp_timer_create_args_t a = {};
        a.callback = [](void*) {
            if (wipe) storage::erase_all();
            esp_restart();
        };
        a.name = "restart";
        esp_timer_create(&a, &t);
    }
    lamp::flush();
    esp_timer_start_once(t, (uint64_t)ms * 1000);
}

uint16_t transition_of(const cJSON* obj, uint16_t dflt) {
    double v;
    bool present;
    if (lc::json_int(obj, "transition_ms", 0, 10000, &v, &present) && present) return (uint16_t)v;
    return dflt;
}

/** Slot from "/api/v1/presets/<n>[/apply]". */
int preset_slot(const char* uri) {
    const char* p = uri + std::strlen("/api/v1/presets/");
    if (*p < '0' || *p > '7' || (p[1] != '\0' && p[1] != '/' && p[1] != '?')) return -1;
    return *p - '0';
}

cJSON* preset_json(int slot, const lamp::Preset& p) {
    cJSON* o = cJSON_CreateObject();
    cJSON_AddNumberToObject(o, "slot", slot);
    cJSON_AddStringToObject(o, "name", p.name);
    cJSON_AddItemToObject(o, "state", lc::state_to_json(p.state));
    return o;
}

// ---------------------------------------------------------------- state

esp_err_t get_info(httpd_req_t* req) {
    if (!host_ok(req)) return ESP_OK;
    return send_json(req, 200, lamp::status::info_json());
}

/** Sends the state with its revision in X-Rev, so polled answers can be ordered. */
esp_err_t send_state(httpd_req_t* req) {
    uint32_t rev;
    lc::LampState st = lamp::get_state(&rev);
    char hdr[12];
    std::snprintf(hdr, sizeof hdr, "%u", (unsigned)rev);
    httpd_resp_set_hdr(req, "X-Rev", hdr);
    return send_json(req, 200, lc::state_to_json(st));
}

esp_err_t get_state(httpd_req_t* req) {
    if (!host_ok(req)) return ESP_OK;
    return send_state(req);
}

esp_err_t patch_state(httpd_req_t* req) {
    if (!host_ok(req)) return ESP_OK;
    cJSON* body = read_json(req);
    if (!body) return ESP_OK;
    lc::Patch p;
    JsonError err;
    const cJSON* patch = cJSON_GetObjectItemCaseSensitive(body, "patch");
    if (!lc::patch_from_json(patch, &p, &err)) {
        cJSON_Delete(body);
        return send_error(req, 400, err.code, err.message, err.field);
    }
    uint16_t tr = transition_of(body, 400);
    cJSON_Delete(body);
    // The state task outranks httpd, so the change is applied when submit returns.
    if (!lamp::submit(p, tr, 0, lc::Origin::Local, 200)) return send_error(req, 503, "busy", "lamp busy");
    return send_state(req);
}

esp_err_t get_effects(httpd_req_t* req) {
    if (!host_ok(req)) return ESP_OK;
    return send_json(req, 200, lc::effects_to_json());
}

esp_err_t get_presets(httpd_req_t* req) {
    if (!host_ok(req)) return ESP_OK;
    cJSON* arr = cJSON_CreateArray();
    for (int i = 0; i < lc::kPresetSlots; i++) {
        lamp::Preset p = lamp::get_preset(i);
        if (p.used) cJSON_AddItemToArray(arr, preset_json(i, p));
    }
    return send_json(req, 200, arr);
}

esp_err_t post_preset(httpd_req_t* req) {  // POST /presets/{slot}/apply
    if (!host_ok(req)) return ESP_OK;
    int slot = preset_slot(req->uri);
    if (slot < 0 || !std::strstr(req->uri, "/apply")) return send_error(req, 404, "not_found", "no such route");
    cJSON* body = read_json(req, true);
    if (!body) return ESP_OK;
    uint16_t tr = transition_of(body, 400);
    cJSON_Delete(body);
    if (!lamp::get_preset(slot).used) return send_error(req, 404, "not_found", "empty preset slot");
    lamp::apply_preset(slot, tr, lc::Origin::Local);
    return send_json(req, 200, lc::state_to_json(lamp::get_state()));
}

esp_err_t put_preset(httpd_req_t* req) {
    if (!host_ok(req) || !require_admin(req)) return ESP_OK;
    int slot = preset_slot(req->uri);
    if (slot < 0) return send_error(req, 404, "not_found", "slot must be 0-7");
    if (lamp::settings::claimed())
        return send_error(req, 409, "managed_by_server", "presets come from the server's scenes while paired");
    cJSON* body = read_json(req);
    if (!body) return ESP_OK;
    const char* name = lc::json_str(body, "name");
    if (!name || !*name || std::strlen(name) > lc::kNameLen) {
        cJSON_Delete(body);
        return send_error(req, 400, "invalid", "name must be 1-32 characters", "name");
    }
    lc::LampState st = lamp::get_state();
    const cJSON* sj = cJSON_GetObjectItemCaseSensitive(body, "state");
    JsonError err;
    if (sj && !lc::state_from_json(sj, &st, &err)) {
        cJSON_Delete(body);
        return send_error(req, 400, err.code, err.message, err.field);
    }
    char nm[lc::kNameLen + 1];
    std::snprintf(nm, sizeof nm, "%s", name);
    cJSON_Delete(body);
    lamp::save_preset(slot, nm, st);
    return send_json(req, 200, preset_json(slot, lamp::get_preset(slot)));
}

esp_err_t delete_preset(httpd_req_t* req) {
    if (!host_ok(req) || !require_admin(req)) return ESP_OK;
    int slot = preset_slot(req->uri);
    if (slot < 0) return send_error(req, 404, "not_found", "slot must be 0-7");
    if (lamp::settings::claimed())
        return send_error(req, 409, "managed_by_server", "presets come from the server's scenes while paired");
    lamp::delete_preset(slot);
    return send_status(req, 204);
}

esp_err_t put_name(httpd_req_t* req) {
    if (!host_ok(req) || !require_admin(req)) return ESP_OK;
    cJSON* body = read_json(req);
    if (!body) return ESP_OK;
    const char* name = lc::json_str(body, "name");
    bool ok = name && *name && std::strlen(name) <= lc::kNameLen && lamp::settings::set_name(name);
    cJSON_Delete(body);
    if (!ok) return send_error(req, 400, "invalid", "name must be 1-32 characters", "name");
    char nm[lc::kNameLen + 1];
    lamp::settings::name(nm);
    cJSON* o = cJSON_CreateObject();
    cJSON_AddStringToObject(o, "name", nm);
    return send_json(req, 200, o);
}

esp_err_t post_identify(httpd_req_t* req) {
    if (!host_ok(req)) return ESP_OK;
    cJSON* body = read_json(req, true);
    if (!body) return ESP_OK;
    double ms;
    bool present;
    if (!lc::json_int(body, "duration_ms", 0, 60000, &ms, &present) || !present) ms = 1200;
    cJSON_Delete(body);
    led_output::identify((uint32_t)ms);
    return send_status(req, 204);
}

// ---------------------------------------------------------------- auth

esp_err_t post_login(httpd_req_t* req) {
    if (!host_ok(req)) return ESP_OK;
    cJSON* body = read_json(req);
    if (!body) return ESP_OK;
    const char* pw = lc::json_str(body, "password");
    char token[33];
    int status = 401;
    bool ok = pw && lamp::settings::has_admin_password() && login(pw, token, &status);
    cJSON_Delete(body);
    if (!ok) {
        if (status == 429) return send_error(req, 429, "rate_limited", "too many attempts: wait a minute");
        if (!lamp::settings::has_admin_password())
            return send_error(req, 401, "auth_required", "no admin password set yet: finish setup first");
        return send_error(req, 401, "auth_required", "wrong password");
    }
    cJSON* o = cJSON_CreateObject();
    cJSON_AddStringToObject(o, "token", token);
    cJSON_AddNumberToObject(o, "expires_in", 30 * 24 * 3600);
    return send_json(req, 200, o);
}

esp_err_t post_logout(httpd_req_t* req) {
    if (!host_ok(req) || !require_admin(req)) return ESP_OK;
    logout(req);
    return send_status(req, 204);
}

esp_err_t put_security(httpd_req_t* req) {
    if (!host_ok(req) || !require_admin(req)) return ESP_OK;
    cJSON* body = read_json(req);
    if (!body) return ESP_OK;
    const char* cur = lc::json_str(body, "current_password");
    const char* admin = lc::json_str(body, "admin_password");
    const char* ap = lc::json_str(body, "ap_password");
    esp_err_t r;
    if (!cur || !lamp::settings::check_admin_password(cur)) {
        r = send_error(req, 401, "auth_required", "current password is wrong", "current_password");
    } else if ((admin && std::strlen(admin) < 8) || (ap && (std::strlen(ap) < 8 || std::strlen(ap) > 63))) {
        r = send_error(req, 400, "invalid", "passwords must be at least 8 characters");
    } else {
        if (admin) {
            lamp::settings::set_admin_password(admin);
            drop_sessions_except(req);
        }
        if (ap) {
            lamp::settings::set_ap_password(ap);
            net::refresh_ap();
        }
        r = send_status(req, 204);
    }
    cJSON_Delete(body);
    return r;
}

// ---------------------------------------------------------------- config

esp_err_t get_config(httpd_req_t* req) {
    if (!host_ok(req) || !require_admin(req)) return ESP_OK;
    return send_json(req, 200, lc::led_config_to_json(lamp::settings::led()));
}

esp_err_t put_config(httpd_req_t* req) {
    if (!host_ok(req) || !require_admin(req)) return ESP_OK;
    cJSON* body = read_json(req);
    if (!body) return ESP_OK;
    lc::LedConfig cfg = lamp::settings::led();
    JsonError err;
    bool ok = lc::led_config_merge_json(body, &cfg, &err);
    cJSON_Delete(body);
    if (!ok) return send_error(req, 400, err.code, err.message, err.field);
    lamp::settings::set_led(cfg);
    return send_json(req, 200, lc::led_config_to_json(cfg));
}

esp_err_t post_test_pattern(httpd_req_t* req) {
    if (!host_ok(req) || !require_admin(req, true)) return ESP_OK;
    cJSON* body = read_json(req);
    if (!body) return ESP_OK;
    const char* pattern = lc::json_str(body, "pattern");
    double ms;
    bool present;
    if (!lc::json_int(body, "duration_ms", 0, 120000, &ms, &present) || !present) ms = 10000;
    bool ok = pattern && led_output::test_pattern(pattern, (uint32_t)ms);
    cJSON_Delete(body);
    if (!ok) return send_error(req, 400, "invalid", "pattern must be color_order, last_pixel or white_25", "pattern");
    return send_status(req, 204);
}

// ---------------------------------------------------------------- network

esp_err_t get_scan(httpd_req_t* req) {
    if (!host_ok(req) || !require_admin(req, true)) return ESP_OK;
    static net::Network nets[20];
    int n = net::scan(nets, 20);
    cJSON* arr = cJSON_CreateArray();
    for (int i = 0; i < n; i++) {
        cJSON* o = cJSON_CreateObject();
        cJSON_AddStringToObject(o, "ssid", nets[i].ssid);
        cJSON_AddNumberToObject(o, "rssi", nets[i].rssi);
        cJSON_AddStringToObject(o, "auth", nets[i].auth);
        cJSON_AddItemToArray(arr, o);
    }
    return send_json(req, 200, arr);
}

esp_err_t put_wifi(httpd_req_t* req) {
    if (!host_ok(req) || !require_admin(req)) return ESP_OK;
    cJSON* body = read_json(req);
    if (!body) return ESP_OK;
    const char* ssid = lc::json_str(body, "ssid");
    const char* pw = lc::json_str(body, "password");
    bool ok = ssid && net::set_credentials(ssid, pw ? pw : "");
    cJSON_Delete(body);
    if (!ok) return send_error(req, 400, "invalid", "ssid must be 1-32 characters", "ssid");
    return send_status(req, 202);
}

cJSON* network_json() {
    cJSON* o = cJSON_CreateObject();
    cJSON_AddBoolToObject(o, "ap_always_on", lamp::settings::ap_always_on());
    return o;
}

esp_err_t get_network(httpd_req_t* req) {
    if (!host_ok(req) || !require_admin(req)) return ESP_OK;
    return send_json(req, 200, network_json());
}

esp_err_t put_network(httpd_req_t* req) {
    if (!host_ok(req) || !require_admin(req)) return ESP_OK;
    cJSON* body = read_json(req);
    if (!body) return ESP_OK;
    const cJSON* on = cJSON_GetObjectItemCaseSensitive(body, "ap_always_on");
    if (on && !cJSON_IsBool(on)) {
        cJSON_Delete(body);
        return send_error(req, 400, "invalid", "ap_always_on must be true or false", "ap_always_on");
    }
    if (on) {
        lamp::settings::set_ap_always_on(cJSON_IsTrue(on));
        net::refresh_ap();
    }
    cJSON_Delete(body);
    return send_json(req, 200, network_json());
}

// ---------------------------------------------------------------- Apple Home

esp_err_t get_homekit(httpd_req_t* req) {
    if (!host_ok(req) || !require_admin(req)) return ESP_OK;
    homekit::Info i = homekit::info();
    cJSON* o = cJSON_CreateObject();
    cJSON_AddStringToObject(o, "state", i.state);
    cJSON_AddNumberToObject(o, "controllers", i.controllers);
    cJSON_AddStringToObject(o, "setup_code", i.setup_code);
    cJSON_AddStringToObject(o, "setup_id", i.setup_id);
    return send_json(req, 200, o);
}

esp_err_t post_homekit_reset(httpd_req_t* req) {
    if (!host_ok(req) || !require_admin(req)) return ESP_OK;
    if (!homekit::available()) return send_error(req, 409, "conflict", "Apple Home is not built into this firmware");
    send_status(req, 202);
    homekit::reset_pairings();  // the SDK reboots the lamp
    return ESP_OK;
}

// ---------------------------------------------------------------- server pairing

esp_err_t post_claim(httpd_req_t* req) {
    if (!host_ok(req) || !require_admin(req, true)) return ESP_OK;
    cJSON* body = read_json(req);
    if (!body) return ESP_OK;
    char url[129] = "", code[16] = "";
    const char* u = lc::json_str(body, "server_url");
    const char* c = lc::json_str(body, "code");
    if (u) std::snprintf(url, sizeof url, "%s", u);
    if (c) std::snprintf(code, sizeof code, "%s", c);
    cJSON_Delete(body);
    if (!net::online()) return send_error(req, 409, "offline", "the lamp is not connected to WiFi");
    cloud::ClaimResult r = cloud::claim(url, code);
    if (!r.ok) {
        int st = (!std::strcmp(r.code, "invalid_code") || !std::strcmp(r.code, "invalid")) ? 400
                 : !std::strcmp(r.code, "code_expired")                                    ? 410
                 : !std::strcmp(r.code, "rate_limited")                                    ? 429
                                                                                           : 502;
        return send_error(req, st, r.code, r.error);
    }
    cJSON* o = cJSON_CreateObject();
    cJSON_AddStringToObject(o, "state", "online");
    return send_json(req, 200, o);
}

esp_err_t delete_cloud(httpd_req_t* req) {
    if (!host_ok(req) || !require_admin(req)) return ESP_OK;
    cloud::unpair();
    return send_status(req, 204);
}

// ---------------------------------------------------------------- firmware and system

esp_err_t post_ota(httpd_req_t* req) {
    if (!host_ok(req) || !require_admin(req)) return ESP_OK;
    char ct[48] = "";
    httpd_req_get_hdr_value_str(req, "Content-Type", ct, sizeof ct);
    if (std::strncmp(ct, "application/octet-stream", 24) != 0)
        return send_error(req, 415, "invalid", "upload the .bin as application/octet-stream");
    if (req->content_len == 0) return send_error(req, 400, "invalid", "empty upload");
    if (ota::busy()) return send_error(req, 409, "conflict", "an update is already running");
    char q[48] = "", v[8] = "";
    bool allow_downgrade = httpd_req_get_url_query_str(req, q, sizeof q) == ESP_OK &&
                           httpd_query_key_value(q, "allow_downgrade", v, sizeof v) == ESP_OK && v[0] == '1';
    ota::Writer w;
    if (w.begin(req->content_len, nullptr, allow_downgrade) != ESP_OK) return send_error(req, 400, "invalid", w.error());
    char* buf = (char*)std::malloc(2048);
    if (!buf) {
        w.abort();
        return send_error(req, 503, "busy", "out of memory");
    }
    size_t left = req->content_len;
    int last_pct = -1;
    while (left > 0) {
        int r = httpd_req_recv(req, buf, left < 2048 ? left : 2048);
        if (r == HTTPD_SOCK_ERR_TIMEOUT) continue;
        if (r <= 0) {
            std::free(buf);
            w.abort();
            led_output::ota_progress(-1);
            return ESP_FAIL;
        }
        if (w.write(buf, r) != ESP_OK) {
            std::free(buf);
            led_output::ota_progress(-1);
            return send_error(req, 400, "invalid", w.error());
        }
        left -= (size_t)r;
        int pct = (int)(((req->content_len - left) * 100) / req->content_len);
        if (pct / 10 != last_pct / 10) led_output::ota_progress(last_pct = pct);
    }
    std::free(buf);
    led_output::ota_progress(-1);
    if (w.finish() != ESP_OK) return send_error(req, 400, "invalid", w.error());
    ota::remember_pending(-1, w.new_version());
    send_status(req, 202);
    ESP_LOGW(TAG, "local firmware upload installed (%s); restarting", w.new_version());
    restart_soon(800, false);
    return ESP_OK;
}

esp_err_t get_logs(httpd_req_t* req) {
    if (!host_ok(req) || !require_admin(req)) return ESP_OK;
    char* buf = (char*)std::malloc(4096);
    if (!buf) return send_error(req, 503, "busy", "out of memory");
    size_t n = lamp::log_ring::read(buf, 4096);
    httpd_resp_set_type(req, "text/plain; charset=utf-8");
    httpd_resp_set_hdr(req, "Cache-Control", "no-store");
    esp_err_t e = httpd_resp_send(req, buf, (ssize_t)n);
    std::free(buf);
    return e;
}

esp_err_t post_reboot(httpd_req_t* req) {
    if (!host_ok(req) || !require_admin(req)) return ESP_OK;
    cJSON* body = read_json(req, true);
    if (!body) return ESP_OK;
    cJSON_Delete(body);
    send_status(req, 202);
    restart_soon(500, false);
    return ESP_OK;
}

esp_err_t post_factory_reset(httpd_req_t* req) {
    if (!host_ok(req) || !require_admin(req)) return ESP_OK;
    cJSON* body = read_json(req, true);
    if (!body) return ESP_OK;
    cJSON_Delete(body);
    send_status(req, 202);
    ESP_LOGW(TAG, "factory reset requested");
    restart_soon(500, true);
    return ESP_OK;
}

void add(httpd_handle_t s, const char* uri, httpd_method_t m, esp_err_t (*h)(httpd_req_t*)) {
    httpd_uri_t u = {};
    u.uri = uri;
    u.method = m;
    u.handler = h;
    if (httpd_register_uri_handler(s, &u) != ESP_OK) ESP_LOGE(TAG, "could not register %s", uri);
}

}  // namespace

void register_routes(httpd_handle_t s) {
    add(s, "/api/v1/info", HTTP_GET, get_info);
    add(s, "/api/v1/state", HTTP_GET, get_state);
    add(s, "/api/v1/state", HTTP_PATCH, patch_state);
    add(s, "/api/v1/effects", HTTP_GET, get_effects);
    add(s, "/api/v1/presets", HTTP_GET, get_presets);
    add(s, "/api/v1/presets/*", HTTP_POST, post_preset);
    add(s, "/api/v1/presets/*", HTTP_PUT, put_preset);
    add(s, "/api/v1/presets/*", HTTP_DELETE, delete_preset);
    add(s, "/api/v1/identify", HTTP_POST, post_identify);
    add(s, "/api/v1/name", HTTP_PUT, put_name);
    add(s, "/api/v1/auth/login", HTTP_POST, post_login);
    add(s, "/api/v1/auth/logout", HTTP_POST, post_logout);
    add(s, "/api/v1/config", HTTP_GET, get_config);
    add(s, "/api/v1/config", HTTP_PUT, put_config);
    add(s, "/api/v1/test-pattern", HTTP_POST, post_test_pattern);
    add(s, "/api/v1/wifi/scan", HTTP_GET, get_scan);
    add(s, "/api/v1/wifi", HTTP_PUT, put_wifi);
    add(s, "/api/v1/network", HTTP_GET, get_network);
    add(s, "/api/v1/network", HTTP_PUT, put_network);
    add(s, "/api/v1/security", HTTP_PUT, put_security);
    add(s, "/api/v1/homekit", HTTP_GET, get_homekit);
    add(s, "/api/v1/homekit/reset", HTTP_POST, post_homekit_reset);
    add(s, "/api/v1/cloud/claim", HTTP_POST, post_claim);
    add(s, "/api/v1/cloud", HTTP_DELETE, delete_cloud);
    add(s, "/api/v1/ota", HTTP_POST, post_ota);
    add(s, "/api/v1/logs", HTTP_GET, get_logs);
    add(s, "/api/v1/reboot", HTTP_POST, post_reboot);
    add(s, "/api/v1/factory-reset", HTTP_POST, post_factory_reset);
}

}  // namespace local_api
