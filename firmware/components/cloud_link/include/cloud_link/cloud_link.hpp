// Lamp ↔ server link (03 §10, 04 §4): one WSS connection, outbound only.
#pragma once

#include <cstddef>

namespace cloud {

void init();
void start();

struct ClaimResult {
    bool ok;
    char code[24];  // "invalid_code" | "code_expired" | "rate_limited" | "unreachable" | "invalid" | "claim_failed"
    char error[96];
};
/** Pairs with a server (04 §4.5). Blocking HTTP call, up to ~15 s. */
ClaimResult claim(const char* server_url, const char* code);
/** Forget the server (DELETE /cloud): erase the token and close the socket. */
void unpair();

bool connected();
bool welcomed();
/** Reports a button gesture to the server as an event. */
void report_button(const char* gesture);

/** True if the URL is acceptable for this build (https, or private ws/http on dev builds). */
bool url_allowed(const char* url);

}  // namespace cloud
