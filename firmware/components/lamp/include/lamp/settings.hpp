// Persistent device settings (03 §13): name, admin password, direct-mode password, LED config,
// network options and the server credentials.
#pragma once

#include <cstddef>
#include <cstdint>

#include "lamp_core/state.hpp"

namespace lamp::settings {

void init();

enum Topic : uint32_t {
    TOPIC_LED = 1 << 0,
    TOPIC_NAME = 1 << 1,
    TOPIC_NETWORK = 1 << 2,
    TOPIC_CLOUD = 1 << 3,
    TOPIC_SECURITY = 1 << 4,
};
using Listener = void (*)(uint32_t topics, void* ctx);
void subscribe(Listener cb, void* ctx);

lc::LedConfig led();
bool set_led(const lc::LedConfig& cfg);

void name(char out[lc::kNameLen + 1]);
bool set_name(const char* name);

bool has_admin_password();
/** Constant-time PBKDF2-SHA256 check (~0.3 s). */
bool check_admin_password(const char* password);
bool set_admin_password(const char* password);

/** WPA2 password of the fallback / direct-mode AP (plaintext, the WiFi driver needs it). */
void ap_password(char out[65]);
bool set_ap_password(const char* password);
bool ap_always_on();
void set_ap_always_on(bool on);

struct Cloud {
    char url[129];     // server base URL, e.g. https://lamps.example.com
    char ws_url[161];  // wss://…/ws/device from the claim response
    char token[65];
};
bool cloud(Cloud* out);
bool claimed();
bool set_cloud(const Cloud& c);
void clear_cloud();

/** "Enter setup mode on next boot" (button hold or 5 quick power cycles). */
bool setup_requested();
void set_setup_requested(bool requested);

}  // namespace lamp::settings
