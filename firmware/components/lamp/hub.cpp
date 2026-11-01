// State task (03 §4): an actor that owns LampState. Every input becomes a Command on one queue.
#include <cstdio>
#include <cstring>

#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "lamp/clock.hpp"
#include "lamp/identity.hpp"
#include "lamp/lamp.hpp"
#include "lamp/settings.hpp"
#include "lamp/status.hpp"
#include "storage/storage.hpp"

static const char* TAG = "lamp";

namespace lamp {

namespace {

constexpr uint8_t kStateSchema = 1;
constexpr uint8_t kPresetSchema = 1;
constexpr int kMaxListeners = 8;
constexpr uint32_t kPersistDelayMs = 5000;

enum class CmdType : uint8_t { Patch, Toggle, Preset, NextPreset, Welcome, CloudConn };

struct Cmd {
    CmdType type;
    Origin origin;
    uint16_t transition_ms;
    int8_t slot;
    bool flag;
    int64_t apply_at;
    Patch patch;
};

QueueHandle_t s_queue;
SemaphoreHandle_t s_mutex;  // guards s_state, s_rev, dirty data and presets
TaskHandle_t s_persist_task;

LampState s_state;
uint32_t s_rev = 0;
bool s_cloud_connected = false;
bool s_dirty[lc::kFieldCount] = {};
int64_t s_changed_at[lc::kFieldCount] = {};  // mono ms
Preset s_presets[lc::kPresetSlots];
int s_last_preset = -1;
volatile uint32_t s_presets_rev = 0;

struct Sub {
    StateListener cb;
    void* ctx;
};
Sub s_subs[kMaxListeners];
int s_nsubs = 0;

struct Lock {
    Lock() { xSemaphoreTake(s_mutex, portMAX_DELAY); }
    ~Lock() { xSemaphoreGive(s_mutex); }
};

void preset_key(int slot, char key[4]) { std::snprintf(key, 4, "p%d", slot); }

void save_state_now() {
    LampState copy;
    {
        Lock l;
        copy = s_state;
    }
    storage::save_blob("state", "last", kStateSchema, &copy, sizeof copy);
}

void schedule_persist() {
    if (s_persist_task) xTaskNotifyGive(s_persist_task);
}

void persist_task(void*) {
    for (;;) {
        ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
        // Debounce: write 5 s after the last change.
        while (ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(kPersistDelayMs)) > 0) {
        }
        save_state_now();
    }
}

void publish(FieldMask changed, Origin origin, uint16_t transition_ms, int64_t apply_at) {
    StateEvent ev;
    {
        Lock l;
        ev.rev = s_rev;
        ev.state = s_state;
    }
    ev.fields = changed;
    ev.origin = origin;
    ev.transition_ms = transition_ms;
    ev.apply_at = apply_at;
    for (int i = 0; i < s_nsubs; i++) s_subs[i].cb(ev, s_subs[i].ctx);
}

void apply(const Patch& p, Origin origin, uint16_t transition_ms, int64_t apply_at) {
    FieldMask changed;
    {
        Lock l;
        changed = lc::apply_patch(s_state, p, clock::sync_now_ms(), identity::random32);
        if (changed) {
            s_rev++;
            int64_t now = clock::mono_ms();
            for (int i = 0; i < lc::kFieldCount; i++) {
                if (!(changed & (1u << i))) continue;
                s_changed_at[i] = now;
                if (!s_cloud_connected && origin != Origin::Cloud) s_dirty[i] = true;
            }
        }
    }
    if (!changed) return;
    publish(changed, origin, transition_ms, apply_at);
    schedule_persist();
}

Patch preset_patch(const LampState& st) {
    Patch p = lc::full_patch(st);
    p.effect_fields &= (uint8_t)~lc::EF_EPOCH;  // a preset restarts its effect now
    p.values.effect.epoch_ms = clock::sync_now_ms();
    p.effect_fields |= lc::EF_EPOCH;
    return p;
}

void handle(const Cmd& c) {
    switch (c.type) {
        case CmdType::Patch:
            apply(c.patch, c.origin, c.transition_ms, c.apply_at);
            break;
        case CmdType::Toggle: {
            Patch p;
            p.fields = lc::F_ON;
            {
                Lock l;
                p.values.on = !s_state.on;
            }
            apply(p, c.origin, c.transition_ms, 0);
            break;
        }
        case CmdType::Preset:
        case CmdType::NextPreset: {
            int slot = c.slot;
            Preset pr{};
            {
                Lock l;
                if (c.type == CmdType::NextPreset) {
                    slot = -1;
                    for (int k = 1; k <= lc::kPresetSlots; k++) {
                        int idx = (s_last_preset + k) % lc::kPresetSlots;
                        if (idx >= 0 && s_presets[idx].used) {
                            slot = idx;
                            break;
                        }
                    }
                }
                if (slot >= 0 && slot < lc::kPresetSlots) pr = s_presets[slot];
            }
            if (slot < 0 || !pr.used) break;
            s_last_preset = slot;
            Patch p = preset_patch(pr.state);
            p.values.on = true;  // applying a preset turns the lamp on
            apply(p, c.origin, c.transition_ms, 0);
            break;
        }
        case CmdType::Welcome:
            if (c.flag) apply(c.patch, Origin::Cloud, 400, 0);
            {
                Lock l;
                for (bool& d : s_dirty) d = false;
            }
            break;
        case CmdType::CloudConn: {
            Lock l;
            s_cloud_connected = c.flag;
            break;
        }
    }
}

void state_task(void*) {
    Cmd c;
    for (;;) {
        if (xQueueReceive(s_queue, &c, portMAX_DELAY) == pdTRUE) handle(c);
    }
}

bool send(const Cmd& c, uint32_t wait_ms) {
    if (!s_queue) return false;
    if (xQueueSend(s_queue, &c, pdMS_TO_TICKS(wait_ms)) != pdTRUE) {
        ESP_LOGW(TAG, "command queue full");
        return false;
    }
    return true;
}

}  // namespace

void init() {
    s_mutex = xSemaphoreCreateMutex();
    s_queue = xQueueCreate(16, sizeof(Cmd));

    LampState saved;
    bool have = storage::load_blob("state", "last", kStateSchema, &saved, sizeof saved) &&
                saved.ncolors >= 1 && saved.ncolors <= lc::kMaxColors;
    s_state = have ? saved : lc::default_state();
    // Restart the effect phase on the local clock; the server realigns it when linked.
    s_state.effect.epoch_ms = clock::sync_now_ms();
    s_state.effect.id[lc::kEffectIdLen - 1] = '\0';

    for (int i = 0; i < lc::kPresetSlots; i++) {
        char key[4];
        preset_key(i, key);
        if (!storage::load_blob("preset", key, kPresetSchema, &s_presets[i], sizeof s_presets[i]))
            s_presets[i].used = false;
    }

    switch (settings::led().power_on) {
        case lc::PowerOn::Off:
            s_state.on = false;
            break;
        case lc::PowerOn::On:
            if (s_presets[0].used) {
                s_state = s_presets[0].state;
                s_state.effect.epoch_ms = clock::sync_now_ms();
            }
            s_state.on = true;
            break;
        case lc::PowerOn::Restore:
            break;
    }
    ESP_LOGI(TAG, "restored state: %s, brightness %u, effect %s", s_state.on ? "on" : "off", s_state.brightness,
             s_state.effect.id);
}

void start() {
    xTaskCreate(state_task, "state", 4096, nullptr, 12, nullptr);
    xTaskCreate(persist_task, "persist", 3072, nullptr, 3, &s_persist_task);
    // Tell subscribers (render first) what to show at boot.
    StateEvent ev;
    ev.rev = s_rev;
    ev.state = s_state;
    ev.fields = lc::F_ALL;
    ev.origin = Origin::Boot;
    ev.transition_ms = 400;  // fade in to limit inrush (03 §16)
    ev.apply_at = 0;
    for (int i = 0; i < s_nsubs; i++) s_subs[i].cb(ev, s_subs[i].ctx);
}

void subscribe(StateListener cb, void* ctx) {
    if (s_nsubs < kMaxListeners) s_subs[s_nsubs++] = {cb, ctx};
}

bool submit(const Patch& p, uint16_t transition_ms, int64_t apply_at, Origin origin, uint32_t wait_ms) {
    Cmd c{};
    c.type = CmdType::Patch;
    c.origin = origin;
    c.transition_ms = transition_ms;
    c.apply_at = apply_at;
    c.patch = p;
    return send(c, wait_ms);
}

bool toggle(Origin origin) {
    Cmd c{};
    c.type = CmdType::Toggle;
    c.origin = origin;
    c.transition_ms = 400;
    return send(c, 50);
}

bool apply_preset(int slot, uint16_t transition_ms, Origin origin) {
    if (slot < 0 || slot >= lc::kPresetSlots) return false;
    Cmd c{};
    c.type = CmdType::Preset;
    c.origin = origin;
    c.slot = (int8_t)slot;
    c.transition_ms = transition_ms;
    return send(c, 50);
}

bool next_preset(Origin origin) {
    Cmd c{};
    c.type = CmdType::NextPreset;
    c.origin = origin;
    c.transition_ms = 400;
    return send(c, 50);
}

void cloud_welcome(const LampState* desired) {
    Cmd c{};
    c.type = CmdType::Welcome;
    c.flag = desired != nullptr;
    if (desired) c.patch = lc::full_patch(*desired);
    send(c, 200);
}

void set_cloud_connected(bool connected) {
    Cmd c{};
    c.type = CmdType::CloudConn;
    c.flag = connected;
    send(c, 200);
}

LampState get_state(uint32_t* rev) {
    Lock l;
    if (rev) *rev = s_rev;
    return s_state;
}

Dirty get_dirty() {
    Dirty d{};
    int64_t now = clock::mono_ms();
    Lock l;
    for (int i = 0; i < lc::kFieldCount; i++) {
        d.dirty[i] = s_dirty[i];
        d.age_ms[i] = s_dirty[i] ? now - s_changed_at[i] : 0;
    }
    return d;
}

void flush() { save_state_now(); }

Preset get_preset(int slot) {
    Preset p{};
    if (slot < 0 || slot >= lc::kPresetSlots) return p;
    Lock l;
    return s_presets[slot];
}

bool save_preset(int slot, const char* name, const LampState& state) {
    if (slot < 0 || slot >= lc::kPresetSlots || !name) return false;
    Preset p{};
    p.used = true;
    std::snprintf(p.name, sizeof p.name, "%s", name);
    p.state = state;
    {
        Lock l;
        s_presets[slot] = p;
    }
    char key[4];
    preset_key(slot, key);
    bool ok = storage::save_blob("preset", key, kPresetSchema, &p, sizeof p);
    s_presets_rev = s_presets_rev + 1;
    status::notify();
    return ok;
}

bool delete_preset(int slot) {
    if (slot < 0 || slot >= lc::kPresetSlots) return false;
    {
        Lock l;
        s_presets[slot].used = false;
    }
    char key[4];
    preset_key(slot, key);
    bool ok = storage::erase_key("preset", key);
    s_presets_rev = s_presets_rev + 1;
    status::notify();
    return ok;
}

uint32_t presets_rev() { return s_presets_rev; }

void replace_presets(const Preset* presets, int count) {
    for (int i = 0; i < lc::kPresetSlots; i++) {
        if (i < count && presets[i].used) {
            Preset cur = get_preset(i);
            if (cur.used && std::strcmp(cur.name, presets[i].name) == 0 && lc::states_equal(cur.state, presets[i].state))
                continue;  // unchanged: spare the flash
            save_preset(i, presets[i].name, presets[i].state);
        } else {
            Preset cur = get_preset(i);
            if (cur.used) delete_preset(i);
        }
    }
}

}  // namespace lamp
