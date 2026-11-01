// Live status published by the net, cloud and Apple Home modules, and the DeviceInfo object
// built from it (04 §2) for GET /info, the local WebSocket and the server.
#pragma once

#include <cstdint>

#include "cJSON.h"

namespace lamp::status {

struct Net {
    char mode[6] = "sta";  // "sta" | "ap" | "apsta"
    char ssid[33] = "";
    char ip[16] = "";
    int rssi = 0;
    bool online = false;
    bool setup_mode = false;
};

struct Cloud {
    char state[12] = "off";  // "off" | "connecting" | "online"
    bool linked = false;
    char group_name[33] = "";
    char problem[32] = "";   // e.g. "re-pair needed", "firmware update needed"
    char peers[2][33] = {"", ""};  // names of the other lamps in the link group
};

struct Homekit {
    char state[10] = "off";  // "off" | "unpaired" | "paired"
    int controllers = 0;
};

Net net();
void set_net(const Net& n);
Cloud cloud();
void set_cloud(const Cloud& c);
Homekit homekit();
void set_homekit(const Homekit& h);

using Listener = void (*)(void* ctx);
/** Called after any status change (from the setter's task). Keep it short. */
void subscribe(Listener cb, void* ctx);
/** Notify listeners without a status change (e.g. after a rename). */
void notify();

/** DeviceInfo (caller deletes). */
cJSON* info_json();

}  // namespace lamp::status
