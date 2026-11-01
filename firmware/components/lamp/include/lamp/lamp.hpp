// The lamp's state store (03 §4): one FreeRTOS task applies every command in order and is the
// only writer of LampState. Inputs (local API, cloud link, Apple Home, button, timers) submit
// commands; subscribers (render, local API, cloud link, Apple Home, persist) get StateEvents.
#pragma once

#include <cstdint>

#include "lamp_core/state.hpp"

namespace lamp {

using lc::FieldMask;
using lc::LampState;
using lc::Origin;
using lc::Patch;

struct StateEvent {
    uint32_t rev;
    LampState state;
    FieldMask fields;   // which fields changed
    Origin origin;
    uint16_t transition_ms;
    int64_t apply_at;   // sync-clock ms; 0 = now
};

using StateListener = void (*)(const StateEvent& ev, void* ctx);

/** Loads the saved state and presets (03 §13 power-on behavior). Call after settings::init(). */
void init();
/** Starts the state task and the persist task. */
void start();
/** Subscribers are called from the state task: they must not block. Register before start(). */
void subscribe(StateListener cb, void* ctx);

bool submit(const Patch& p, uint16_t transition_ms, int64_t apply_at, Origin origin, uint32_t wait_ms = 50);
bool toggle(Origin origin);
bool apply_preset(int slot, uint16_t transition_ms, Origin origin);
bool next_preset(Origin origin);
/** welcome from the server: applies `desired` (if any) and clears the dirty flags. */
void cloud_welcome(const LampState* desired);
/** Changes made while disconnected are tracked as dirty (04 §6). */
void set_cloud_connected(bool connected);

/** Thread-safe copy of the current logical state. */
LampState get_state(uint32_t* rev = nullptr);

struct Dirty {
    bool dirty[lc::kFieldCount];
    int64_t age_ms[lc::kFieldCount];
};
Dirty get_dirty();

/** Writes the state to NVS now (before a planned reboot or OTA). */
void flush();

// ---------------------------------------------------------------- presets (8 slots)

struct Preset {
    bool used;
    char name[lc::kNameLen + 1];
    LampState state;
};

Preset get_preset(int slot);
bool save_preset(int slot, const char* name, const LampState& state);
bool delete_preset(int slot);
/** presets.sync from the server: replaces every slot. */
void replace_presets(const Preset* presets, int count);
/** Bumped whenever a preset changes; DeviceInfo carries it so open pages can refetch. */
uint32_t presets_rev();

}  // namespace lamp
