// DoubleLamp firmware entry point: wires the components together (01 §6, 03).
// Order matters: the light comes back first (≤ 500 ms), networking after.
#include <cstring>

#include "cloud_link/cloud_link.hpp"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "homekit/homekit.hpp"
#include "input/input.hpp"
#include "lamp/clock.hpp"
#include "lamp/identity.hpp"
#include "lamp/lamp.hpp"
#include "lamp/log_ring.hpp"
#include "lamp/settings.hpp"
#include "led_output/led_output.hpp"
#include "local_api/local_api.hpp"
#include "net/net.hpp"
#include "ota/ota.hpp"
#include "storage/storage.hpp"

static const char* TAG = "main";

namespace {

constexpr uint32_t kRapidCyclesForSetup = 5;

/** 5 power cycles, each shorter than 5 s, enter setup mode without the button (03 §14). */
bool count_rapid_power_cycles() {
    uint32_t boots = 0;
    storage::load_u32("sys", "boots", &boots);
    boots++;
    storage::save_u32("sys", "boots", boots);
    if (boots >= kRapidCyclesForSetup) {
        storage::save_u32("sys", "boots", 0);
        ESP_LOGW(TAG, "%u quick power cycles: entering setup mode", (unsigned)boots);
        return true;
    }
    return false;
}

void reboot_into_setup() {
    lamp::settings::set_setup_requested(true);
    lamp::flush();
    vTaskDelay(pdMS_TO_TICKS(200));
    esp_restart();
}

void on_gesture(input::Gesture g) {
    switch (g) {
        case input::Gesture::Single:
            lamp::toggle(lc::Origin::Button);
            cloud::report_button("single");
            break;
        case input::Gesture::Double:
            lamp::next_preset(lc::Origin::Button);
            cloud::report_button("double");
            break;
        case input::Gesture::HoldSetup:
            ESP_LOGW(TAG, "button held 3 s: entering setup mode");
            reboot_into_setup();
            break;
        case input::Gesture::HoldReset:
            ESP_LOGW(TAG, "button held 10 s: factory reset");
            led_output::reset_progress(-1);
            storage::erase_all();
            vTaskDelay(pdMS_TO_TICKS(200));
            esp_restart();
            break;
    }
}

void on_hold_progress(int pct) { led_output::reset_progress(pct); }

}  // namespace

extern "C" void app_main() {
    lamp::log_ring::init();
    ESP_ERROR_CHECK(storage::init());
    lamp::identity::init();
    ESP_LOGI(TAG, "DoubleLamp %s (%s) %s", lamp::identity::fw_version(), lamp::identity::build_id(),
             lamp::identity::device_id());
    lamp::settings::init();
    ota::boot_check();
    bool rapid_setup = count_rapid_power_cycles();

    // 1. Light first: restore the state and start rendering.
    lamp::init();
    led_output::init();
    // Everything that subscribes to state changes does so before the state task starts.
    homekit::init();
    cloud::init();
    local_api::init();
    lamp::start();
    led_output::start();
    if (ota::rolled_back()) led_output::rollback_blinks();
    input::start(on_gesture, on_hold_progress);

    // 2. Networking.
    net::init();
    bool setup_mode = rapid_setup || lamp::settings::setup_requested() || !net::has_credentials();
    net::start(setup_mode);
    local_api::start();
    if (!setup_mode) {
        homekit::start();  // before mdns_start, which re-asserts our hostname afterwards
        net::mdns_start();
    }
    cloud::start();

    // 3. Supervision: OTA health check, rapid-cycle window, low-memory and setup-mode timeouts.
    int64_t low_heap_since = 0;
    bool boots_cleared = false;
    for (;;) {
        vTaskDelay(pdMS_TO_TICKS(1000));
        int64_t up_ms = esp_timer_get_time() / 1000;
        if (!boots_cleared && up_ms > 5000) {
            storage::save_u32("sys", "boots", 0);
            boots_cleared = true;
        }
        if (up_ms / 1000 == 15 || (up_ms / 1000) % 300 == 0)
            ESP_LOGI(TAG, "heap: %u free, %u lowest", (unsigned)esp_get_free_heap_size(),
                     (unsigned)esp_get_minimum_free_heap_size());
        ota::health_tick(led_output::healthy(), local_api::healthy(), net::online() && net::sntp_synced(),
                         lamp::settings::claimed(), cloud::welcomed());

        // Setup requested by the button but nobody set it up for 10 min: go back to normal.
        if (net::in_setup() && net::has_credentials() && up_ms > 600000 &&
            std::strcmp(net::setup_status().state, "idle") == 0) {
            ESP_LOGW(TAG, "setup mode unused for 10 min: restarting normally");
            lamp::settings::set_setup_requested(false);
            esp_restart();
        }

        // Low memory (03 §16): close local WS clients, then reboot cleanly.
        size_t free_heap = esp_get_free_heap_size();
        if (free_heap < 20 * 1024) {
            if (!low_heap_since) low_heap_since = up_ms;
            if (up_ms - low_heap_since > 30000) {
                ESP_LOGE(TAG, "free heap %u for 30 s: restarting", (unsigned)free_heap);
                lamp::flush();
                esp_restart();
            } else if (up_ms - low_heap_since > 10000) {
                local_api::close_ws_clients();
            }
        } else {
            low_heap_since = 0;
        }
    }
}
