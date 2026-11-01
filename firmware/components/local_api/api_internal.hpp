#pragma once

#include "cJSON.h"
#include "esp_http_server.h"

namespace local_api {

extern httpd_handle_t g_server;

// Responses
esp_err_t send_json(httpd_req_t* req, int status, cJSON* obj);  // takes ownership
esp_err_t send_error(httpd_req_t* req, int status, const char* code, const char* msg, const char* field = nullptr);
esp_err_t send_status(httpd_req_t* req, int status);  // empty body
const char* status_line(int status);

// Request guards (07 §4)
bool host_ok(httpd_req_t* req);
/** Reads a JSON body (≤ 4 KB, Content-Type application/json). Sends the error itself on failure. */
cJSON* read_json(httpd_req_t* req, bool allow_empty = false);
bool is_admin(httpd_req_t* req);
/** True if authorized; otherwise sends 401 and returns false. `setup_ok`: allowed without auth in setup mode. */
bool require_admin(httpd_req_t* req, bool setup_ok = false);
/** Setup-only routes answer 403 outside setup mode. */
bool require_setup(httpd_req_t* req);

// Sessions
bool login(const char* password, char token_out[33], int* status_out);
void logout(httpd_req_t* req);
void drop_sessions_except(httpd_req_t* req);

// Route groups
void register_routes(httpd_handle_t server);
void register_ws(httpd_handle_t server);
void ws_on_close(int fd);
void ws_start_broadcasts();
void setup_register(httpd_handle_t server);

}  // namespace local_api
