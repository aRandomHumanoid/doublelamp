// Local WebSocket /api/v1/ws (04 §3.1): state + info pushes, cmd in. At most 3 clients.
#include <cstdio>
#include <cstdlib>
#include <cstring>

#include "api_internal.hpp"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "lamp/lamp.hpp"
#include "lamp/settings.hpp"
#include "lamp/status.hpp"
#include "lamp_core/codec.hpp"
#include "local_api/local_api.hpp"

#if !CONFIG_HTTPD_WS_PRE_HANDSHAKE_CB_SUPPORT || !CONFIG_HTTPD_WS_POST_HANDSHAKE_CB_SUPPORT
#error "The local WebSocket needs the httpd handshake callbacks from sdkconfig.defaults: run .\lamp.ps1 fullclean"
#endif

static const char* TAG = "ws";

namespace local_api {

namespace {

constexpr int kMaxClients = 3;
int s_fds[kMaxClients] = {-1, -1, -1};
uint8_t s_fails[kMaxClients] = {0, 0, 0};
portMUX_TYPE s_mux = portMUX_INITIALIZER_UNLOCKED;

int count_clients() {
    int n = 0;
    portENTER_CRITICAL(&s_mux);
    for (int fd : s_fds) n += fd >= 0;
    portEXIT_CRITICAL(&s_mux);
    return n;
}

bool add_client(int fd) {
    bool ok = false;
    portENTER_CRITICAL(&s_mux);
    for (int i = 0; i < kMaxClients && !ok; i++)
        if (s_fds[i] < 0 || s_fds[i] == fd) s_fds[i] = fd, s_fails[i] = 0, ok = true;
    portEXIT_CRITICAL(&s_mux);
    return ok;
}

char* envelope(const char* type, cJSON* data, const char* ref = nullptr) {
    cJSON* env = cJSON_CreateObject();
    cJSON_AddStringToObject(env, "type", type);
    if (ref) cJSON_AddStringToObject(env, "ref", ref);
    cJSON_AddItemToObject(env, "data", data);
    char* text = cJSON_PrintUnformatted(env);
    cJSON_Delete(env);
    return text;
}

char* state_message(const lc::LampState& st, uint32_t rev, lc::Origin origin) {
    cJSON* d = cJSON_CreateObject();
    cJSON_AddNumberToObject(d, "rev", rev);
    cJSON_AddItemToObject(d, "state", lc::state_to_json(st));
    cJSON_AddStringToObject(d, "origin", lc::origin_name(origin));
    return envelope("state", d);
}

struct Job {
    char* text;
};

/** Runs in the httpd task (httpd_queue_work): send one text to every client. */
void broadcast_work(void* arg) {
    Job* job = (Job*)arg;
    httpd_ws_frame_t f = {};
    f.type = HTTPD_WS_TYPE_TEXT;
    f.payload = (uint8_t*)job->text;
    f.len = std::strlen(job->text);
    for (int i = 0; i < kMaxClients; i++) {
        int fd = s_fds[i];
        if (fd < 0) continue;
        if (httpd_ws_get_fd_info(g_server, fd) != HTTPD_WS_CLIENT_WEBSOCKET) {
            s_fds[i] = -1;
            continue;
        }
        if (httpd_ws_send_frame_async(g_server, fd, &f) != ESP_OK) {
            if (++s_fails[i] >= 2) {  // drop a client whose sends fail twice (03 §9)
                ESP_LOGW(TAG, "dropping client %d", fd);
                httpd_sess_trigger_close(g_server, fd);
                s_fds[i] = -1;
            }
        } else {
            s_fails[i] = 0;
        }
    }
    cJSON_free(job->text);
    std::free(job);
}

void broadcast(char* text) {
    if (!text) return;
    if (!g_server || count_clients() == 0) {
        cJSON_free(text);
        return;
    }
    Job* job = (Job*)std::malloc(sizeof(Job));
    if (!job) {
        cJSON_free(text);
        return;
    }
    job->text = text;
    if (httpd_queue_work(g_server, broadcast_work, job) != ESP_OK) {
        cJSON_free(text);
        std::free(job);
    }
}

void on_state(const lamp::StateEvent& ev, void*) { broadcast(state_message(ev.state, ev.rev, ev.origin)); }

void on_info(void*) { broadcast(envelope("info", lamp::status::info_json())); }
void on_settings(uint32_t topics, void*) {
    if (topics & (lamp::settings::TOPIC_NAME | lamp::settings::TOPIC_LED | lamp::settings::TOPIC_CLOUD)) on_info(nullptr);
}

esp_err_t send_text(httpd_req_t* req, char* text) {
    if (!text) return ESP_FAIL;
    httpd_ws_frame_t f = {};
    f.type = HTTPD_WS_TYPE_TEXT;
    f.payload = (uint8_t*)text;
    f.len = std::strlen(text);
    esp_err_t e = httpd_ws_send_frame(req, &f);
    cJSON_free(text);
    return e;
}

esp_err_t send_ws_error(httpd_req_t* req, const char* ref, const char* code, const char* msg) {
    cJSON* d = cJSON_CreateObject();
    cJSON_AddStringToObject(d, "code", code);
    cJSON_AddStringToObject(d, "message", msg);
    return send_text(req, envelope("error", d, ref));
}

// httpd answers the handshake itself and never calls the URI handler for it, so the upgrade checks
// and the first messages live in its pre/post-handshake callbacks.

/** Before the 101: refuse a foreign Host (DNS rebinding) or a page from another origin (07 §4). */
esp_err_t ws_pre_handshake(httpd_req_t* req) {
    if (!host_ok(req)) return ESP_FAIL;
    char origin[96] = "";
    if (httpd_req_get_hdr_value_str(req, "Origin", origin, sizeof origin) == ESP_OK) {
        const char* host = std::strstr(origin, "://");
        char hdr[96];
        std::snprintf(hdr, sizeof hdr, "%s", host ? host + 3 : origin);
        char own[72] = "";
        httpd_req_get_hdr_value_str(req, "Host", own, sizeof own);
        if (std::strcmp(hdr, own) != 0) {
            ESP_LOGW(TAG, "refusing WebSocket from origin %s", origin);
            send_error(req, 403, "forbidden", "foreign origin");
            return ESP_FAIL;
        }
    }
    return ESP_OK;
}

/** After the 101: turn a 4th client away with 1013, otherwise register it and send state + info. */
esp_err_t ws_post_handshake(httpd_req_t* req) {
    int fd = httpd_req_to_sockfd(req);
    if (count_clients() >= kMaxClients || !add_client(fd)) {
        uint8_t code[2] = {0x03, 0xF5};  // 1013 try again later
        httpd_ws_frame_t f = {};
        f.type = HTTPD_WS_TYPE_CLOSE;
        f.payload = code;
        f.len = 2;
        httpd_ws_send_frame(req, &f);
        return ESP_OK;
    }
    uint32_t rev;
    lc::LampState st = lamp::get_state(&rev);
    send_text(req, state_message(st, rev, lc::Origin::Local));
    send_text(req, envelope("info", lamp::status::info_json()));
    return ESP_OK;
}

esp_err_t ws_handler(httpd_req_t* req) {
    httpd_ws_frame_t f = {};
    if (httpd_ws_recv_frame(req, &f, 0) != ESP_OK) return ESP_FAIL;
    if (f.type != HTTPD_WS_TYPE_TEXT || f.len == 0) return ESP_OK;
    if (f.len > 4096) return send_ws_error(req, nullptr, "too_large", "message too large");
    uint8_t* buf = (uint8_t*)std::malloc(f.len + 1);
    if (!buf) return ESP_ERR_NO_MEM;
    f.payload = buf;
    if (httpd_ws_recv_frame(req, &f, f.len) != ESP_OK) {
        std::free(buf);
        return ESP_FAIL;
    }
    buf[f.len] = '\0';
    cJSON* env = cJSON_Parse((char*)buf);
    std::free(buf);
    if (!env) return send_ws_error(req, nullptr, "invalid", "malformed JSON");
    const char* type = lc::json_str(env, "type");
    const char* id = lc::json_str(env, "id");
    char ref[41] = "";
    if (id) std::snprintf(ref, sizeof ref, "%s", id);
    esp_err_t r = ESP_OK;
    if (type && std::strcmp(type, "cmd") == 0) {
        const cJSON* d = cJSON_GetObjectItemCaseSensitive(env, "data");
        lc::Patch p;
        lc::JsonError err;
        if (!lc::patch_from_json(cJSON_GetObjectItemCaseSensitive(d, "patch"), &p, &err)) {
            r = send_ws_error(req, ref[0] ? ref : nullptr, err.code, err.message);
        } else {
            double tr;
            bool present;
            if (!lc::json_int(d, "transition_ms", 0, 10000, &tr, &present) || !present) tr = 400;
            if (!lamp::submit(p, (uint16_t)tr, 0, lc::Origin::Local, 100))
                r = send_ws_error(req, ref[0] ? ref : nullptr, "busy", "lamp busy");
        }
    } else {
        r = send_ws_error(req, ref[0] ? ref : nullptr, "unsupported", "unknown message type");
    }
    cJSON_Delete(env);
    return r;
}

}  // namespace

void register_ws(httpd_handle_t server) {
    httpd_uri_t u = {};
    u.uri = "/api/v1/ws";
    u.method = HTTP_GET;
    u.handler = ws_handler;
    u.is_websocket = true;
    u.ws_pre_handshake_cb = ws_pre_handshake;
    u.ws_post_handshake_cb = ws_post_handshake;
    httpd_register_uri_handler(server, &u);
}

void ws_on_close(int fd) {
    portENTER_CRITICAL(&s_mux);
    for (int& f : s_fds)
        if (f == fd) f = -1;
    portEXIT_CRITICAL(&s_mux);
}

void ws_start_broadcasts() {
    lamp::subscribe(on_state, nullptr);
    lamp::status::subscribe(on_info, nullptr);
    lamp::settings::subscribe(on_settings, nullptr);
}

void close_ws_clients() {
    for (int i = 0; i < kMaxClients; i++) {
        int fd = s_fds[i];
        if (fd >= 0 && g_server) httpd_sess_trigger_close(g_server, fd);
        s_fds[i] = -1;
    }
}

}  // namespace local_api
