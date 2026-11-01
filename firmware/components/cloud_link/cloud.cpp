// Cloud link task (03 §10): connect → hello → welcome → state reports / state.set / time sync.
#include <cstdio>
#include <cstdlib>
#include <cstring>

#include "cJSON.h"
#include "cloud_link/cloud_link.hpp"
#include "driver/temperature_sensor.h"
#include "effects/effects.hpp"
#include "esp_crt_bundle.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_random.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "esp_websocket_client.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "lamp/clock.hpp"
#include "lamp/identity.hpp"
#include "lamp/lamp.hpp"
#include "lamp/log_ring.hpp"
#include "lamp/settings.hpp"
#include "lamp/status.hpp"
#include "lamp_core/codec.hpp"
#include "lamp_core/misc.hpp"
#include "led_output/led_output.hpp"
#include "net/net.hpp"
#include "ota/ota.hpp"
#include "sdkconfig.h"

static const char* TAG = "cloud";

namespace cloud {

namespace {

constexpr size_t kMaxMsg = 4096;  // 04 §1 size limit

enum class Ev : uint8_t { WsConnected, WsDisconnected, WsData, WsClosed, State, Info, Log, Button, OtaProgress, Creds };

struct Event {
    Ev type;
    int code;          // close code / ota pct / job id
    lc::FieldMask fields;
    char* text;        // malloc'd (WsData, Log)
    char small[48];    // button gesture / ota phase
    char small2[64];   // ota error
    int extra;
};

enum class Conn : uint8_t { Idle, Connecting, Connected, Welcomed };

QueueHandle_t s_q;
esp_websocket_client_handle_t s_ws = nullptr;
volatile Conn s_conn = Conn::Idle;
int64_t s_next_attempt = 0;
uint32_t s_backoff_ms = 2000;
int64_t s_connected_at = 0;
int64_t s_welcomed_at = 0;
int64_t s_last_rx = 0;
int64_t s_last_ping = 0;
int64_t s_last_telemetry = 0;
int64_t s_online_since = 0;
int s_reconnects = 0;
bool s_bad_token = false;
int64_t s_proto_retry_at = 0;
lc::FieldMask s_pending_fields = 0;
lc::Origin s_pending_origin = lc::Origin::Local;
bool s_info_dirty = false;
int s_msg_id = 0;
lc::TimeSyncFilter s_filter;
// time.ping carries t0 on the sync clock (04 §5) so the server's t1 − t0 is a real one-way delay;
// we remember the monotonic time each ping left at, and compute offsets against that.
struct PingRec {
    int64_t sync_t0;
    int64_t mono_t0;
};
PingRec s_pings[4] = {};
int s_ping_idx = 0;
temperature_sensor_handle_t s_tsens = nullptr;

// Reassembly buffer for fragmented frames (websocket task only)
char* s_rx = nullptr;
int s_rx_len = 0;

void post(const Event& e) {
    if (xQueueSend(s_q, &e, 0) != pdTRUE && e.text) std::free(e.text);
}

void post_simple(Ev t, int code = 0) {
    Event e{};
    e.type = t;
    e.code = code;
    post(e);
}

void set_status(const char* state, const char* problem = nullptr) {
    lamp::status::Cloud c = lamp::status::cloud();
    std::snprintf(c.state, sizeof c.state, "%s", state);
    if (problem) std::snprintf(c.problem, sizeof c.problem, "%s", problem);
    if (std::strcmp(state, "online") == 0) c.problem[0] = '\0';
    if (std::strcmp(state, "off") == 0) c.linked = false, c.group_name[0] = '\0', c.peers[0][0] = c.peers[1][0] = '\0';
    lamp::status::set_cloud(c);
}

// ---------------------------------------------------------------- websocket callbacks (ws task)

void ws_handler(void*, esp_event_base_t, int32_t id, void* data) {
    auto* d = (esp_websocket_event_data_t*)data;
    switch (id) {
        case WEBSOCKET_EVENT_CONNECTED:
            post_simple(Ev::WsConnected);
            break;
        case WEBSOCKET_EVENT_DISCONNECTED:
        case WEBSOCKET_EVENT_ERROR: {
            int status = d ? d->error_handle.esp_ws_handshake_status_code : 0;
            post_simple(Ev::WsDisconnected, status);
            break;
        }
        case WEBSOCKET_EVENT_CLOSED:
            post_simple(Ev::WsDisconnected, 0);
            break;
        case WEBSOCKET_EVENT_DATA: {
            if (!d) break;
            if (d->op_code == 0x08) {  // close frame: 2-byte big-endian code
                int code = d->close_status_code;
                if (!code && d->data_len >= 2)
                    code = ((uint8_t)d->data_ptr[0] << 8) | (uint8_t)d->data_ptr[1];
                post_simple(Ev::WsClosed, code);
                break;
            }
            if (d->op_code != 0x01 && d->op_code != 0x00) break;  // text and continuation only
            if (d->payload_len <= 0 || d->payload_len > (int)kMaxMsg) break;
            if (d->payload_offset == 0) {
                std::free(s_rx);
                s_rx = (char*)std::malloc(d->payload_len + 1);
                s_rx_len = d->payload_len;
            }
            if (!s_rx || d->payload_offset + d->data_len > s_rx_len) break;
            std::memcpy(s_rx + d->payload_offset, d->data_ptr, d->data_len);
            if (d->payload_offset + d->data_len == s_rx_len) {
                s_rx[s_rx_len] = '\0';
                Event e{};
                e.type = Ev::WsData;
                e.text = s_rx;
                s_rx = nullptr;
                post(e);
            }
            break;
        }
        default:
            break;
    }
}

// ---------------------------------------------------------------- sending

bool send_json(const char* type, cJSON* data, const char* ref = nullptr) {
    if (!s_ws || !esp_websocket_client_is_connected(s_ws)) {
        cJSON_Delete(data);
        return false;
    }
    cJSON* env = cJSON_CreateObject();
    cJSON_AddStringToObject(env, "type", type);
    char id[16];
    std::snprintf(id, sizeof id, "l-%d", ++s_msg_id);
    cJSON_AddStringToObject(env, "id", id);
    if (ref) cJSON_AddStringToObject(env, "ref", ref);
    cJSON_AddItemToObject(env, "data", data ? data : cJSON_CreateObject());
    char* text = cJSON_PrintUnformatted(env);
    cJSON_Delete(env);
    if (!text) return false;
    int len = (int)std::strlen(text);
    int sent = len <= (int)kMaxMsg ? esp_websocket_client_send_text(s_ws, text, len, pdMS_TO_TICKS(3000)) : -1;
    if (sent < 0) ESP_LOGW(TAG, "send %s failed", type);
    cJSON_free(text);
    return sent >= 0;
}

void send_error(const char* ref, const char* code, const char* msg) {
    cJSON* d = cJSON_CreateObject();
    cJSON_AddStringToObject(d, "code", code);
    cJSON_AddStringToObject(d, "message", msg);
    send_json("error", d, ref);
}

const char* boot_reason() {
    switch (esp_reset_reason()) {
        case ESP_RST_POWERON: return "poweron";
        case ESP_RST_SW: return "sw";
        case ESP_RST_PANIC: return "panic";
        case ESP_RST_INT_WDT:
        case ESP_RST_TASK_WDT:
        case ESP_RST_WDT: return "watchdog";
        case ESP_RST_BROWNOUT: return "brownout";
        case ESP_RST_DEEPSLEEP: return "deepsleep";
        case ESP_RST_EXT: return "external";
        default: return "unknown";
    }
}

void send_hello() {
    lamp::LampState st = lamp::get_state();
    lamp::Dirty dirty = lamp::get_dirty();
    lc::LedConfig led = lamp::settings::led();
    lamp::status::Net n = lamp::status::net();

    cJSON* d = cJSON_CreateObject();
    cJSON_AddStringToObject(d, "device_id", lamp::identity::device_id());
    cJSON_AddNumberToObject(d, "proto", 1);
    cJSON_AddStringToObject(d, "fw", lamp::identity::fw_version());
    cJSON_AddStringToObject(d, "build", lamp::identity::build_id());
    cJSON* hw = cJSON_AddObjectToObject(d, "hw");
    cJSON_AddStringToObject(hw, "chip", "esp32c3");
    cJSON_AddNumberToObject(hw, "pixels", led.pixel_count);
    cJSON_AddNumberToObject(hw, "channels", led.channels);
    cJSON_AddStringToObject(hw, "color_order", led.color_order);
    cJSON_AddItemToObject(d, "state", lc::state_to_json(st));
    cJSON* dj = cJSON_AddObjectToObject(d, "dirty");
    for (int i = 0; i < lc::kFieldCount; i++) {
        if (!dirty.dirty[i]) continue;
        cJSON* f = cJSON_AddObjectToObject(dj, lc::field_name(i));
        cJSON_AddNumberToObject(f, "age_ms", (double)dirty.age_ms[i]);
    }
    cJSON_AddStringToObject(d, "boot_reason", boot_reason());
    cJSON_AddBoolToObject(d, "rollback", ota::rolled_back());
    cJSON_AddBoolToObject(d, "pending_verify", ota::pending_verify());
    cJSON_AddNumberToObject(d, "uptime_s", (double)(esp_timer_get_time() / 1000000));
    cJSON_AddStringToObject(d, "ip", n.ip);
    cJSON_AddNumberToObject(d, "rssi", net::rssi());
    cJSON* eff = cJSON_AddArrayToObject(d, "effects");
    for (size_t i = 0; i < fx::effect_count(); i++) cJSON_AddItemToArray(eff, cJSON_CreateString(fx::effect_at(i).id));
    cJSON_AddItemToObject(d, "info", lamp::status::info_json());
    cJSON_AddItemToObject(d, "config", lc::led_config_to_json(led));
    send_json("hello", d);
}

void send_ping() {
    int64_t mono = lamp::clock::mono_ms();
    int64_t t0 = lamp::clock::sync_now_ms();
    s_pings[s_ping_idx] = {t0, mono};
    s_ping_idx = (s_ping_idx + 1) % 4;
    cJSON* d = cJSON_CreateObject();
    cJSON_AddNumberToObject(d, "t0", (double)t0);
    send_json("time.ping", d);
    s_last_ping = mono;
}

void send_state_report() {
    if (!s_pending_fields) return;
    uint32_t rev;
    lamp::LampState st = lamp::get_state(&rev);
    cJSON* d = cJSON_CreateObject();
    cJSON_AddNumberToObject(d, "rev", rev);
    cJSON_AddItemToObject(d, "patch", lc::fields_to_json(st, s_pending_fields));
    lc::Origin o = s_pending_origin;
    const char* origin = o == lc::Origin::HomeKit ? "homekit" : o == lc::Origin::Button ? "button"
                       : o == lc::Origin::Timer   ? "timer"   : "local";
    cJSON_AddStringToObject(d, "origin", origin);
    if (send_json("state.report", d)) s_pending_fields = 0;
}

void send_info() {
    cJSON* d = cJSON_CreateObject();
    cJSON_AddItemToObject(d, "info", lamp::status::info_json());
    cJSON_AddItemToObject(d, "config", lc::led_config_to_json(lamp::settings::led()));
    send_json("info", d);
    s_info_dirty = false;
}

void send_telemetry() {
    float temp = 0;
    if (s_tsens) temperature_sensor_get_celsius(s_tsens, &temp);
    cJSON* d = cJSON_CreateObject();
    cJSON_AddNumberToObject(d, "rssi", net::rssi());
    cJSON_AddNumberToObject(d, "heap_free", (double)esp_get_free_heap_size());
    cJSON_AddNumberToObject(d, "heap_min", (double)esp_get_minimum_free_heap_size());
    cJSON_AddNumberToObject(d, "uptime_s", (double)(esp_timer_get_time() / 1000000));
    cJSON_AddNumberToObject(d, "fps", (double)(int)(led_output::fps() * 10) / 10.0);
    cJSON_AddNumberToObject(d, "reconnects", s_reconnects);
    cJSON_AddNumberToObject(d, "temp_c", (double)(int)(temp * 10) / 10.0);
    send_json("telemetry", d);
}

void send_ota_progress(int job_id, const char* phase, int pct, const char* error) {
    cJSON* d = cJSON_CreateObject();
    cJSON_AddNumberToObject(d, "job_id", job_id);
    cJSON_AddStringToObject(d, "phase", phase);
    cJSON_AddNumberToObject(d, "pct", pct);
    if (error && *error) cJSON_AddStringToObject(d, "error", error);
    send_json("ota.progress", d);
}

// ---------------------------------------------------------------- connection management

void destroy_client() {
    if (s_ws) {
        esp_websocket_client_stop(s_ws);
        esp_websocket_client_destroy(s_ws);
        s_ws = nullptr;
    }
}

void schedule_retry() {
    // Full jitter: random in [0, backoff], then double up to 60 s (03 §10)
    uint32_t delay = esp_random() % (s_backoff_ms + 1);
    if (delay < 500) delay = 500;
    s_next_attempt = lamp::clock::mono_ms() + delay;
    s_backoff_ms = s_backoff_ms * 2 > 60000 ? 60000 : s_backoff_ms * 2;
}

void drop_connection(const char* why) {
    if (s_conn != Conn::Idle) ESP_LOGW(TAG, "connection closed: %s", why);
    bool was_welcomed = s_conn == Conn::Welcomed;
    destroy_client();
    s_conn = Conn::Idle;
    if (was_welcomed) lamp::set_cloud_connected(false);
    if (lamp::settings::claimed() && !s_bad_token) set_status("connecting");
    schedule_retry();
}

bool should_run(int64_t now) {
    if (!lamp::settings::claimed() || s_bad_token) return false;
    if (!net::online()) return false;
    if (s_proto_retry_at && now < s_proto_retry_at) return false;
    // TLS likes a plausible clock: wait for SNTP or 10 s after going online (03 §10)
    return net::sntp_synced() || (s_online_since && now - s_online_since > 10000);
}

void connect() {
    lamp::settings::Cloud c;
    lamp::settings::cloud(&c);
    if (!url_allowed(c.ws_url)) {
        ESP_LOGE(TAG, "server URL %s not allowed in this build", c.ws_url);
        set_status("off", "server URL needs https");
        s_bad_token = true;
        return;
    }
    static char headers[128];
    std::snprintf(headers, sizeof headers, "Authorization: Bearer %s\r\n", c.token);
    static char ua[40];
    std::snprintf(ua, sizeof ua, "DoubleLamp/%s", lamp::identity::fw_version());
    static char uri[161];
    std::snprintf(uri, sizeof uri, "%s", c.ws_url);

    esp_websocket_client_config_t cfg = {};
    cfg.uri = uri;
    cfg.headers = headers;
    cfg.user_agent = ua;
    cfg.crt_bundle_attach = esp_crt_bundle_attach;
    cfg.disable_auto_reconnect = true;
    cfg.network_timeout_ms = 10000;
    cfg.ping_interval_sec = 20;
    cfg.pingpong_timeout_sec = 60;
    cfg.disable_pingpong_discon = true;  // liveness is our own 45 s silence rule
    cfg.buffer_size = 2048;
    cfg.task_prio = 5;  // below render, so the TLS handshake doesn't stutter animations
    cfg.task_stack = 7168;
    s_ws = esp_websocket_client_init(&cfg);
    if (!s_ws) {
        schedule_retry();
        return;
    }
    esp_websocket_register_events(s_ws, WEBSOCKET_EVENT_ANY, ws_handler, nullptr);
    s_conn = Conn::Connecting;
    s_connected_at = lamp::clock::mono_ms();
    set_status("connecting");
    ESP_LOGI(TAG, "connecting to %s", uri);
    if (esp_websocket_client_start(s_ws) != ESP_OK) drop_connection("start failed");
}

// ---------------------------------------------------------------- inbound messages

/** Fills linked / group name / partner names from a link object (04 §4.4). */
void apply_link(const cJSON* link, lamp::status::Cloud* c) {
    c->linked = cJSON_IsObject(link) && cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(link, "linked"));
    const char* gname = cJSON_IsObject(link) ? lc::json_str(link, "name") : nullptr;
    std::snprintf(c->group_name, sizeof c->group_name, "%s", gname ? gname : "");
    c->peers[0][0] = c->peers[1][0] = '\0';
    const cJSON* peers = cJSON_IsObject(link) ? cJSON_GetObjectItemCaseSensitive(link, "peers") : nullptr;
    int n = 0;
    const cJSON* p;
    cJSON_ArrayForEach(p, peers) {
        const char* id = lc::json_str(p, "id");
        const char* name = lc::json_str(p, "name");
        if (!name || (id && std::strcmp(id, lamp::identity::device_id()) == 0) || n >= 2) continue;
        std::snprintf(c->peers[n], sizeof c->peers[n], "%s", name);
        n++;
    }
}

void handle_welcome(const cJSON* d) {
    // Coarse clock from server_time until the first time.pong refines it, so an early
    // state.set's apply_at isn't compared against a boot-relative clock.
    double st_ms;
    bool st_present;
    if (!lamp::clock::synced_to_server() && lc::json_int(d, "server_time", 0, 9e15, &st_ms, &st_present) && st_present)
        lamp::clock::set_server_offset((int64_t)st_ms - lamp::clock::mono_ms());
    const cJSON* desired = cJSON_GetObjectItemCaseSensitive(d, "desired");
    lamp::set_cloud_connected(true);
    if (cJSON_IsObject(desired)) {
        lc::LampState st;
        lc::JsonError err;
        if (lc::state_from_json(desired, &st, &err)) lamp::cloud_welcome(&st);
        else {
            ESP_LOGW(TAG, "welcome.desired invalid: %s", err.message);
            lamp::cloud_welcome(nullptr);
        }
    } else {
        lamp::cloud_welcome(nullptr);  // the server adopts our state
    }
    lamp::status::Cloud c = lamp::status::cloud();
    apply_link(cJSON_GetObjectItemCaseSensitive(d, "link"), &c);
    std::snprintf(c.state, sizeof c.state, "online");
    c.problem[0] = '\0';
    lamp::status::set_cloud(c);
    s_conn = Conn::Welcomed;
    s_welcomed_at = lamp::clock::mono_ms();
    s_filter.reset();
    send_ping();
    int failed = ota::job_to_report_failed();
    if (failed >= 0) send_ota_progress(failed, "failed", 0, "rolled back to the previous firmware");
    if (failed >= 0) ota::clear_reported();
    ESP_LOGI(TAG, "welcome (linked=%d)", c.linked);
}

void handle_link(const cJSON* d) {
    lamp::status::Cloud c = lamp::status::cloud();
    apply_link(d, &c);
    lamp::status::set_cloud(c);
}

void handle_state_set(const cJSON* d, const char* id) {
    lc::LampState st;
    lc::JsonError err;
    if (!lc::state_from_json(cJSON_GetObjectItemCaseSensitive(d, "state"), &st, &err)) {
        send_error(id, err.code, err.message);
        return;
    }
    double v;
    bool present;
    int64_t apply_at = 0;
    uint16_t transition = 400;
    if (lc::json_int(d, "apply_at", -9007199254740991.0, 9007199254740991.0, &v, &present) && present)
        apply_at = (int64_t)v;
    if (lc::json_int(d, "transition_ms", 0, 10000, &v, &present) && present) transition = (uint16_t)v;
    lamp::submit(lc::full_patch(st), transition, apply_at, lc::Origin::Cloud, 200);
}

void handle_presets(const cJSON* d) {
    const cJSON* arr = cJSON_GetObjectItemCaseSensitive(d, "presets");
    if (!cJSON_IsArray(arr)) return;
    static lamp::Preset presets[lc::kPresetSlots];
    std::memset(presets, 0, sizeof presets);
    const cJSON* it;
    cJSON_ArrayForEach(it, arr) {
        double slot;
        bool present;
        if (!lc::json_int(it, "slot", 0, lc::kPresetSlots - 1, &slot, &present) || !present) continue;
        lc::JsonError err;
        lamp::Preset& p = presets[(int)slot];
        const char* name = lc::json_str(it, "name");
        if (!lc::state_from_json(cJSON_GetObjectItemCaseSensitive(it, "state"), &p.state, &err)) continue;
        std::snprintf(p.name, sizeof p.name, "%s", name ? name : "Scene");
        p.used = true;
    }
    lamp::replace_presets(presets, lc::kPresetSlots);
    ESP_LOGI(TAG, "presets synced from the server");
}

void on_ota_progress(int job_id, const char* phase, int pct, const char* error, void*) {
    Event e{};
    e.type = Ev::OtaProgress;
    e.code = job_id;
    e.extra = pct;
    std::snprintf(e.small, sizeof e.small, "%s", phase);
    std::snprintf(e.small2, sizeof e.small2, "%s", error ? error : "");
    post(e);
}

void handle_message(char* text) {
    cJSON* env = cJSON_Parse(text);
    if (!env) {
        ESP_LOGW(TAG, "malformed message");
        return;
    }
    const char* type = lc::json_str(env, "type");
    const char* id = lc::json_str(env, "id");
    const cJSON* d = cJSON_GetObjectItemCaseSensitive(env, "data");
    if (!type) type = "";
    bool known = true;
    if (std::strcmp(type, "welcome") == 0) handle_welcome(d);
    else if (std::strcmp(type, "state.set") == 0) handle_state_set(d, id);
    else if (std::strcmp(type, "time.pong") == 0) {
        double t0, t1, t2;
        bool p0, p1, p2;
        int64_t t3 = lamp::clock::mono_ms();
        if (lc::json_int(d, "t0", -9e15, 9e15, &t0, &p0) && lc::json_int(d, "t1", -9e15, 9e15, &t1, &p1) &&
            lc::json_int(d, "t2", -9e15, 9e15, &t2, &p2) && p0 && p1 && p2) {
            int64_t mono_t0 = -1;
            for (const PingRec& p : s_pings)
                if (p.sync_t0 == (int64_t)t0 && p.mono_t0) mono_t0 = p.mono_t0;
            int64_t best, delay;
            if (mono_t0 >= 0 && s_filter.add(mono_t0, (int64_t)t1, (int64_t)t2, t3, &best, &delay))
                lamp::clock::set_server_offset(best);  // server − mono
        }
    } else if (std::strcmp(type, "link") == 0) handle_link(d);
    else if (std::strcmp(type, "config.set") == 0) {
        lc::LedConfig cfg = lamp::settings::led();
        lc::JsonError err;
        if (lc::led_config_merge_json(d, &cfg, &err)) {
            lamp::settings::set_led(cfg);
            send_json("ack", cJSON_CreateObject(), id);
        } else {
            send_error(id, err.code, err.message);
        }
    } else if (std::strcmp(type, "presets.sync") == 0) handle_presets(d);
    else if (std::strcmp(type, "identify") == 0) {
        double ms;
        bool present;
        if (!lc::json_int(d, "duration_ms", 0, 60000, &ms, &present) || !present) ms = 3000;
        led_output::identify((uint32_t)ms);
    } else if (std::strcmp(type, "nudge") == 0) {
        fx::RGB8 c{255, 180, 107};
        const char* hex = lc::json_str(d, "color");
        if (hex) fx::parse_hex(hex, &c);
        double count;
        bool present;
        if (!lc::json_int(d, "count", 1, 10, &count, &present) || !present) count = 3;
        led_output::nudge(c, (uint8_t)count);
    } else if (std::strcmp(type, "ota.start") == 0) {
        double job, size;
        bool p1, p2;
        const char* url = lc::json_str(d, "url");
        const char* sha = lc::json_str(d, "sha256");
        const char* ver = lc::json_str(d, "version");
        bool allow = cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(d, "allow_downgrade"));
        if (!lc::json_int(d, "job_id", 0, 2147483647.0, &job, &p1) || !p1 || !url ||
            !lc::json_int(d, "size", 1, 4194304.0, &size, &p2) || !p2) {
            send_error(id, "invalid", "bad ota.start");
        } else if (!ota::start_job((int)job, url, sha, (size_t)size, ver, allow, on_ota_progress, nullptr)) {
            send_ota_progress((int)job, "failed", 0, ota::busy() ? "another update is running" : "could not start");
        }
    } else if (std::strcmp(type, "reboot") == 0) {
        lamp::flush();
        vTaskDelay(pdMS_TO_TICKS(300));
        esp_restart();
    } else if (std::strcmp(type, "unclaim") == 0) {
        ESP_LOGW(TAG, "unclaimed by the server");
        lamp::settings::clear_cloud();
    } else if (std::strcmp(type, "name.set") == 0) {
        const char* name = lc::json_str(d, "name");
        if (name) lamp::settings::set_name(name);
    } else if (std::strcmp(type, "error") == 0) {
        const char* msg = d ? lc::json_str(d, "message") : nullptr;
        ESP_LOGW(TAG, "server error: %s", msg ? msg : "?");
    } else if (std::strcmp(type, "ack") == 0) {
    } else {
        known = false;
    }
    if (!known && id) send_error(id, "unsupported", "unknown message type");
    cJSON_Delete(env);
}

void handle_close_code(int code) {
    switch (code) {
        case 4001:
            ESP_LOGE(TAG, "server rejected the device token: re-pair needed");
            s_bad_token = true;
            set_status("off", "re-pair needed");
            break;
        case 4002:
            s_backoff_ms = 2000;  // replaced by a newer connection: reconnect normally
            break;
        case 4003:
            ESP_LOGW(TAG, "device was unclaimed");
            lamp::settings::clear_cloud();
            break;
        case 4004:
            s_proto_retry_at = lamp::clock::mono_ms() + 3600000;
            set_status("off", "firmware update needed");
            break;
        default:
            break;
    }
}

// ---------------------------------------------------------------- task

void tick(int64_t now) {
    if (s_conn == Conn::Idle) {
        if (should_run(now) && now >= s_next_attempt) {
            if (s_ws) destroy_client();
            s_reconnects++;
            connect();
        } else if (!lamp::settings::claimed()) {
            set_status("off");
        }
        return;
    }
    if (!lamp::settings::claimed() || !net::online()) {
        drop_connection(!net::online() ? "WiFi down" : "unpaired");
        if (!lamp::settings::claimed()) set_status("off");
        return;
    }
    if (s_conn == Conn::Connecting && now - s_connected_at > 20000) {
        drop_connection("connect timeout");
        return;
    }
    if (s_conn == Conn::Connected && now - s_connected_at > 10000) {
        drop_connection("no welcome within 10 s");
        return;
    }
    if (s_conn != Conn::Welcomed) return;
    if (now - s_last_rx > 45000) {
        drop_connection("45 s of silence");
        return;
    }
    // time.ping every 5 s for the first 30 s, then every 20 s; doubles as the heartbeat (04 §4.1)
    int64_t interval = (now - s_welcomed_at) < 30000 ? 5000 : 20000;
    if (now - s_last_ping >= interval) send_ping();
    if (now - s_last_telemetry >= 60000) {
        s_last_telemetry = now;
        send_telemetry();
    }
    if (now - s_welcomed_at > 60000) s_backoff_ms = 2000;  // stable: reset the backoff
    if (s_pending_fields) send_state_report();
    if (s_info_dirty) send_info();
    int done = ota::job_to_report_done();
    if (done >= 0) {
        send_ota_progress(done, "done", 100, nullptr);
        ota::clear_reported();
    }
}

void task(void*) {
    Event e;
    int64_t last_tick = 0;
    for (;;) {
        if (xQueueReceive(s_q, &e, pdMS_TO_TICKS(250)) == pdTRUE) {
            int64_t now = lamp::clock::mono_ms();
            switch (e.type) {
                case Ev::WsConnected:
                    // Offline changes travel in hello.dirty; the server's merge decides (04 §6).
                    s_pending_fields = 0;
                    s_conn = Conn::Connected;
                    s_connected_at = now;
                    s_last_rx = now;
                    ESP_LOGI(TAG, "connected; sending hello");
                    send_hello();
                    break;
                case Ev::WsDisconnected:
                    if (e.code == 401) {
                        ESP_LOGE(TAG, "server refused the token (401): re-pair needed");
                        s_bad_token = true;
                        set_status("off", "re-pair needed");
                    }
                    if (s_conn != Conn::Idle) drop_connection("disconnected");
                    break;
                case Ev::WsClosed:
                    handle_close_code(e.code);
                    drop_connection("closed by server");
                    break;
                case Ev::WsData:
                    s_last_rx = now;
                    handle_message(e.text);
                    std::free(e.text);
                    break;
                case Ev::State:
                    if (s_conn != Conn::Connected && s_conn != Conn::Welcomed) break;  // dirty tracking covers it
                    s_pending_fields |= e.fields;
                    s_pending_origin = (lc::Origin)e.code;
                    if (s_conn == Conn::Welcomed) send_state_report();
                    break;
                case Ev::Info:
                    s_info_dirty = true;
                    break;
                case Ev::Log:
                    if (s_conn == Conn::Welcomed && e.text) {
                        cJSON* d = cJSON_CreateObject();
                        cJSON_AddStringToObject(d, "kind", "log");
                        char lvl[2] = {(char)e.code, 0};
                        cJSON_AddStringToObject(d, "level", lvl[0] == 'E' ? "error" : "warn");
                        cJSON_AddStringToObject(d, "msg", e.text);
                        send_json("event", d);
                    }
                    std::free(e.text);
                    break;
                case Ev::Button:
                    if (s_conn == Conn::Welcomed) {
                        cJSON* d = cJSON_CreateObject();
                        cJSON_AddStringToObject(d, "kind", "button");
                        cJSON_AddStringToObject(d, "gesture", e.small);
                        send_json("event", d);
                    }
                    break;
                case Ev::OtaProgress:
                    if (s_conn == Conn::Welcomed) send_ota_progress(e.code, e.small, e.extra, e.small2);
                    break;
                case Ev::Creds:
                    s_bad_token = false;
                    s_backoff_ms = 2000;
                    s_next_attempt = 0;
                    if (s_conn != Conn::Idle) drop_connection("credentials changed");
                    s_next_attempt = 0;
                    if (!lamp::settings::claimed()) set_status("off");
                    break;
            }
        }
        int64_t now = lamp::clock::mono_ms();
        if (now - last_tick >= 1000) {
            last_tick = now;
            tick(now);
        }
    }
}

void on_state(const lamp::StateEvent& ev, void*) {
    if (ev.origin == lc::Origin::Cloud || ev.origin == lc::Origin::Boot) return;  // don't echo the server
    Event e{};
    e.type = Ev::State;
    e.fields = ev.fields;
    e.code = (int)ev.origin;
    post(e);
}

void on_status(void*) { post_simple(Ev::Info); }

void on_settings(uint32_t topics, void*) {
    if (topics & lamp::settings::TOPIC_CLOUD) post_simple(Ev::Creds);
    if (topics & (lamp::settings::TOPIC_LED | lamp::settings::TOPIC_NAME)) post_simple(Ev::Info);
}

void on_net(net::Mode m, void*) {
    if (m == net::Mode::Online) s_online_since = lamp::clock::mono_ms();
}

void on_warn(char level, const char* line) {
    if (s_conn != Conn::Welcomed) return;
    Event e{};
    e.type = Ev::Log;
    e.code = level;
    size_t n = std::strlen(line);
    while (n && (line[n - 1] == '\n' || line[n - 1] == '\r')) n--;
    e.text = (char*)std::malloc(n + 1);
    if (!e.text) return;
    std::memcpy(e.text, line, n);
    e.text[n] = '\0';
    post(e);
}

}  // namespace

void init() {
    s_q = xQueueCreate(24, sizeof(Event));
    lamp::subscribe(on_state, nullptr);
    lamp::status::subscribe(on_status, nullptr);
    lamp::settings::subscribe(on_settings, nullptr);
    net::subscribe(on_net, nullptr);
    lamp::log_ring::set_warn_hook(on_warn);
    temperature_sensor_config_t tc = TEMPERATURE_SENSOR_CONFIG_DEFAULT(-10, 80);
    if (temperature_sensor_install(&tc, &s_tsens) == ESP_OK) temperature_sensor_enable(s_tsens);
    else s_tsens = nullptr;
    set_status(lamp::settings::claimed() ? "connecting" : "off");
}

void start() { xTaskCreate(task, "cloud", 6144, nullptr, 6, nullptr); }

bool connected() { return s_conn != Conn::Idle && s_conn != Conn::Connecting; }
bool welcomed() { return s_conn == Conn::Welcomed; }

void report_button(const char* gesture) {
    Event e{};
    e.type = Ev::Button;
    std::snprintf(e.small, sizeof e.small, "%s", gesture);
    post(e);
}

void unpair() { lamp::settings::clear_cloud(); }

}  // namespace cloud
