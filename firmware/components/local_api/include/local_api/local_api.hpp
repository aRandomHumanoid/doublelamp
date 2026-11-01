// Local HTTP API + WebSocket on port 80 (03 §9, 04 §3) and the embedded device UI.
#pragma once

namespace local_api {

void init();
void start();
/** True while the server is running (used by the OTA health check). */
bool healthy();
/** Low-memory handling (03 §16): drop local WebSocket clients. */
void close_ws_clients();

}  // namespace local_api
