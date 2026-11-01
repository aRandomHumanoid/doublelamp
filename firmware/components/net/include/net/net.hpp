// WiFi, setup AP + captive DNS, fallback AP, mDNS and SNTP (03 §7, §8).
#pragma once

#include <cstdint>

namespace net {

enum class Mode : uint8_t { Setup, Connecting, Online, Fallback };

void init();
/** Starts WiFi: setup mode (open AP + captive portal) or connecting with the stored credentials. */
void start(bool setup_mode);
bool has_credentials();
Mode mode();
bool online();
bool in_setup();

using Listener = void (*)(Mode mode, void* ctx);
/** Called from the event task on every mode change. */
void subscribe(Listener cb, void* ctx);

// ---------------------------------------------------------------- setup (03 §8)

struct SetupStatus {
    char state[12];   // "idle" | "connecting" | "online" | "failed"
    char reason[20];  // "wrong_password" | "no_network" | "no_ip" | "timeout"
    char ip[16];
};
/** Connects the station with new credentials while the setup AP stays up (AP+STA). */
bool setup_connect(const char* ssid, const char* password);
SetupStatus setup_status();
/** After a successful setup: close the setup AP after `delay_ms`, stop captive DNS. */
void finish_setup(uint32_t delay_ms);

// ---------------------------------------------------------------- station

struct Network {
    char ssid[33];
    int8_t rssi;
    const char* auth;  // "open" | "wep" | "wpa" | "wpa2" | "wpa3" | "wpa2-enterprise"
};
/** Blocking scan (~2 s). Returns how many networks were written, strongest first, deduplicated. */
int scan(Network* out, int max);
/** PUT /wifi: save new credentials and reconnect. */
bool set_credentials(const char* ssid, const char* password);
int8_t rssi();
/** Applies "direct mode always on" / a changed direct-mode password. */
void refresh_ap();

// ---------------------------------------------------------------- services

/** mDNS: hostname, instance name, _http._tcp and _doublelamp._tcp. Safe to call again. */
void mdns_start();
/** Re-asserts our hostname (the HomeKit SDK sets its own when it starts). */
void mdns_refresh();
bool sntp_synced();

}  // namespace net
