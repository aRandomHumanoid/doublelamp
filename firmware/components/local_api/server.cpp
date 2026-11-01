// HTTP server, guards, sessions, the embedded UI and captive-portal redirects.
#include <sys/socket.h>
#include <unistd.h>

#include <cctype>
#include <cstdio>
#include <cstdlib>
#include <cstring>

#include "api_internal.hpp"
#include "device_ui/device_ui.hpp"
#include "esp_log.h"
#include "esp_timer.h"
#include "lamp/identity.hpp"
#include "lamp/settings.hpp"
#include "lamp/status.hpp"
#include "local_api/local_api.hpp"
#include "net/net.hpp"

static const char* TAG = "api";

namespace local_api {

httpd_handle_t g_server = nullptr;

namespace {

constexpr size_t kMaxBody = 4096;
constexpr int kMaxSessions = 4;
constexpr int64_t kSessionMs = 30LL * 24 * 3600 * 1000;

struct Session {
    char token[33];
    int64_t expires;
};
Session s_sessions[kMaxSessions];
int64_t s_fail_times[5];
int s_fail_idx = 0;
portMUX_TYPE s_mux = portMUX_INITIALIZER_UNLOCKED;

int64_t now_ms() { return esp_timer_get_time() / 1000; }

void new_token(char out[33]) {
    static const char* hex = "0123456789abcdef";
    for (int i = 0; i < 32; i += 8) {
        uint32_t r = lamp::identity::random32();
        for (int k = 0; k < 8; k++) out[i + k] = hex[(r >> (4 * k)) & 15];
    }
    out[32] = '\0';
}

bool bearer(httpd_req_t* req, char out[64]) {
    char h[64];
    if (httpd_req_get_hdr_value_str(req, "Authorization", h, sizeof h) != ESP_OK) return false;
    if (std::strncmp(h, "Bearer ", 7) != 0) return false;
    std::snprintf(out, 64, "%s", h + 7);
    return true;
}

}  // namespace

const char* status_line(int s) {
    switch (s) {
        case 200: return "200 OK";
        case 201: return "201 Created";
        case 202: return "202 Accepted";
        case 204: return "204 No Content";
        case 302: return "302 Found";
        case 304: return "304 Not Modified";
        case 400: return "400 Bad Request";
        case 401: return "401 Unauthorized";
        case 403: return "403 Forbidden";
        case 404: return "404 Not Found";
        case 409: return "409 Conflict";
        case 413: return "413 Payload Too Large";
        case 415: return "415 Unsupported Media Type";
        case 421: return "421 Misdirected Request";
        case 429: return "429 Too Many Requests";
        case 502: return "502 Bad Gateway";
        case 503: return "503 Service Unavailable";
        default: return "500 Internal Server Error";
    }
}

esp_err_t send_json(httpd_req_t* req, int status, cJSON* obj) {
    char* text = obj ? cJSON_PrintUnformatted(obj) : nullptr;
    cJSON_Delete(obj);
    httpd_resp_set_status(req, status_line(status));
    httpd_resp_set_type(req, "application/json");
    httpd_resp_set_hdr(req, "Cache-Control", "no-store");
    esp_err_t e = httpd_resp_send(req, text ? text : "{}", HTTPD_RESP_USE_STRLEN);
    if (text) cJSON_free(text);
    return e;
}

esp_err_t send_error(httpd_req_t* req, int status, const char* code, const char* msg, const char* field) {
    cJSON* o = cJSON_CreateObject();
    cJSON* e = cJSON_AddObjectToObject(o, "error");
    cJSON_AddStringToObject(e, "code", code);
    cJSON_AddStringToObject(e, "message", msg ? msg : "");
    if (field && *field) cJSON_AddStringToObject(e, "field", field);
    return send_json(req, status, o);
}

esp_err_t send_status(httpd_req_t* req, int status) {
    httpd_resp_set_status(req, status_line(status));
    httpd_resp_set_hdr(req, "Cache-Control", "no-store");
    return httpd_resp_send(req, nullptr, 0);
}

bool host_ok(httpd_req_t* req) {
    char host[72];
    if (httpd_req_get_hdr_value_str(req, "Host", host, sizeof host) != ESP_OK) {
        send_error(req, 421, "forbidden", "missing Host header");
        return false;
    }
    char* colon = std::strchr(host, ':');
    if (colon) *colon = '\0';
    for (char* p = host; *p; p++) *p = (char)std::tolower((unsigned char)*p);
    char mdns[40];
    std::snprintf(mdns, sizeof mdns, "%s.local", lamp::identity::hostname());
    lamp::status::Net n = lamp::status::net();
    if (std::strcmp(host, mdns) == 0 || std::strcmp(host, lamp::identity::hostname()) == 0 ||
        std::strcmp(host, "192.168.4.1") == 0 || (n.ip[0] && std::strcmp(host, n.ip) == 0))
        return true;
    // DNS rebinding defense: a foreign name pointing at our IP is refused (07 §4)
    send_error(req, 421, "forbidden", "unexpected Host");
    return false;
}

cJSON* read_json(httpd_req_t* req, bool allow_empty) {
    char ct[64] = "";
    httpd_req_get_hdr_value_str(req, "Content-Type", ct, sizeof ct);
    if (std::strncmp(ct, "application/json", 16) != 0) {
        send_error(req, 415, "invalid", "Content-Type must be application/json");
        return nullptr;
    }
    if (req->content_len > kMaxBody) {
        send_error(req, 413, "too_large", "body too large");
        return nullptr;
    }
    if (req->content_len == 0) {
        if (allow_empty) return cJSON_CreateObject();
        send_error(req, 400, "invalid", "empty body");
        return nullptr;
    }
    char* buf = (char*)std::malloc(req->content_len + 1);
    if (!buf) {
        send_error(req, 503, "busy", "out of memory");
        return nullptr;
    }
    size_t got = 0;
    while (got < req->content_len) {
        int r = httpd_req_recv(req, buf + got, req->content_len - got);
        if (r == HTTPD_SOCK_ERR_TIMEOUT) continue;
        if (r <= 0) {
            std::free(buf);
            return nullptr;
        }
        got += (size_t)r;
    }
    buf[got] = '\0';
    cJSON* j = cJSON_Parse(buf);
    std::free(buf);
    if (!j) send_error(req, 400, "invalid", "malformed JSON");
    return j;
}

bool is_admin(httpd_req_t* req) {
    char tok[64];
    if (!bearer(req, tok)) return false;
    int64_t now = now_ms();
    bool ok = false;
    portENTER_CRITICAL(&s_mux);
    for (auto& s : s_sessions)
        if (s.token[0] && s.expires > now && std::strcmp(s.token, tok) == 0) ok = true;
    portEXIT_CRITICAL(&s_mux);
    return ok;
}

bool require_admin(httpd_req_t* req, bool setup_ok) {
    if (setup_ok && net::in_setup()) return true;
    if (is_admin(req)) return true;
    send_error(req, 401, "auth_required", "log in with the lamp's admin password");
    return false;
}

bool require_setup(httpd_req_t* req) {
    if (net::in_setup()) return true;
    send_error(req, 403, "forbidden", "only available in setup mode");
    return false;
}

bool login(const char* password, char token_out[33], int* status_out) {
    int64_t now = now_ms();
    // At most 5 failed attempts per minute (07 §4)
    int recent = 0;
    for (int64_t t : s_fail_times) recent += (t && now - t < 60000) ? 1 : 0;
    if (recent >= 5) {
        *status_out = 429;
        return false;
    }
    if (!lamp::settings::check_admin_password(password)) {
        s_fail_times[s_fail_idx] = now;
        s_fail_idx = (s_fail_idx + 1) % 5;
        *status_out = 401;
        return false;
    }
    new_token(token_out);
    portENTER_CRITICAL(&s_mux);
    int slot = 0;
    for (int i = 0; i < kMaxSessions; i++) {
        if (!s_sessions[i].token[0] || s_sessions[i].expires < now) {
            slot = i;
            break;
        }
        if (s_sessions[i].expires < s_sessions[slot].expires) slot = i;  // evict the oldest
    }
    std::memcpy(s_sessions[slot].token, token_out, 33);
    s_sessions[slot].expires = now + kSessionMs;
    portEXIT_CRITICAL(&s_mux);
    *status_out = 200;
    return true;
}

void logout(httpd_req_t* req) {
    char tok[64];
    if (!bearer(req, tok)) return;
    portENTER_CRITICAL(&s_mux);
    for (auto& s : s_sessions)
        if (std::strcmp(s.token, tok) == 0) s.token[0] = '\0';
    portEXIT_CRITICAL(&s_mux);
}

void drop_sessions_except(httpd_req_t* req) {
    char tok[64] = "";
    bearer(req, tok);
    portENTER_CRITICAL(&s_mux);
    for (auto& s : s_sessions)
        if (std::strcmp(s.token, tok) != 0) s.token[0] = '\0';
    portEXIT_CRITICAL(&s_mux);
}

// ---------------------------------------------------------------- UI and captive portal

namespace {

esp_err_t serve_index(httpd_req_t* req) {
    size_t len = 0;
    const uint8_t* gz = device_ui::index_gz(&len);
    char etag[24];
    std::snprintf(etag, sizeof etag, "\"%s\"", lamp::identity::build_id());
    char inm[32];
    if (httpd_req_get_hdr_value_str(req, "If-None-Match", inm, sizeof inm) == ESP_OK && std::strcmp(inm, etag) == 0)
        return send_status(req, 304);
    httpd_resp_set_type(req, "text/html; charset=utf-8");
    httpd_resp_set_hdr(req, "Content-Encoding", "gzip");
    httpd_resp_set_hdr(req, "Cache-Control", "no-cache");
    httpd_resp_set_hdr(req, "ETag", etag);
    httpd_resp_set_hdr(req, "X-Content-Type-Options", "nosniff");
    httpd_resp_set_hdr(req, "Referrer-Policy", "no-referrer");
    return httpd_resp_send(req, (const char*)gz, (ssize_t)len);
}

esp_err_t redirect_to_portal(httpd_req_t* req) {
    httpd_resp_set_status(req, "302 Found");
    httpd_resp_set_hdr(req, "Location", "http://192.168.4.1/");
    httpd_resp_set_hdr(req, "Cache-Control", "no-store");
    return httpd_resp_send(req, nullptr, 0);
}

/** "/" and every unknown GET: the UI, or a captive-portal redirect in setup mode (03 §8). */
esp_err_t catch_all(httpd_req_t* req) {
    const char* uri = req->uri;
    if (std::strncmp(uri, "/api/", 5) == 0) return send_error(req, 404, "not_found", "no such route");
    if (net::in_setup()) {
        char host[72] = "";
        httpd_req_get_hdr_value_str(req, "Host", host, sizeof host);
        bool ours = std::strncmp(host, "192.168.4.1", 11) == 0;
        // Probes (/generate_204, /hotspot-detect.html, /connecttest.txt, /ncsi.txt) and foreign hosts
        if (!ours || std::strcmp(uri, "/") != 0) return redirect_to_portal(req);
    }
    return serve_index(req);
}

void on_close(httpd_handle_t, int fd) {
    ws_on_close(fd);
    close(fd);
}

}  // namespace

void init() { ws_start_broadcasts(); }  // subscribe before lamp::start()

void start() {
    httpd_config_t cfg = HTTPD_DEFAULT_CONFIG();
    cfg.server_port = 80;
    cfg.max_open_sockets = 5;  // leaves room for the HomeKit server (03 §17)
    cfg.lru_purge_enable = true;
    cfg.max_uri_handlers = 40;
    cfg.stack_size = 8192;
    cfg.task_priority = 5;
    cfg.recv_wait_timeout = 15;
    cfg.send_wait_timeout = 10;
    cfg.uri_match_fn = httpd_uri_match_wildcard;
    cfg.close_fn = on_close;
    if (httpd_start(&g_server, &cfg) != ESP_OK) {
        ESP_LOGE(TAG, "httpd_start failed");
        return;
    }
    register_routes(g_server);
    setup_register(g_server);
    register_ws(g_server);
    // Catch-all last: wildcard handlers match in registration order
    httpd_uri_t all = {};
    all.uri = "/*";
    all.method = HTTP_GET;
    all.handler = catch_all;
    httpd_register_uri_handler(g_server, &all);
    ESP_LOGI(TAG, "local API on :80");
}

bool healthy() { return g_server != nullptr; }

}  // namespace local_api
