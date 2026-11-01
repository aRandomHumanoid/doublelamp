// Button gestures, polled every 10 ms with 30 ms debounce.
#include <cstdint>

#include "driver/gpio.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "input/input.hpp"
#include "sdkconfig.h"

static const char* TAG = "input";

namespace input {

namespace {

Handler s_handler = nullptr;
ProgressHandler s_progress = nullptr;

void setup_pin(int gpio) {
    if (gpio < 0) return;
    gpio_config_t c = {};
    c.pin_bit_mask = 1ULL << gpio;
    c.mode = GPIO_MODE_INPUT;
    c.pull_up_en = GPIO_PULLUP_ENABLE;
    c.pull_down_en = GPIO_PULLDOWN_DISABLE;
    c.intr_type = GPIO_INTR_DISABLE;
    gpio_config(&c);
}

bool raw_pressed() {
    bool p = gpio_get_level((gpio_num_t)CONFIG_LAMP_BUTTON_GPIO) == 0;
#if CONFIG_LAMP_EXT_BUTTON_GPIO >= 0
    p = p || gpio_get_level((gpio_num_t)CONFIG_LAMP_EXT_BUTTON_GPIO) == 0;
#endif
    return p;
}

void emit(Gesture g) {
    static const char* names[] = {"single", "double", "hold_setup", "hold_reset"};
    ESP_LOGI(TAG, "gesture: %s", names[(int)g]);
    if (s_handler) s_handler(g);
}

void task(void*) {
    bool stable = false, last_raw = false;
    int64_t raw_since = 0, press_start = 0, last_release = 0;
    bool waiting_second = false, reset_fired = false, showing = false;
    for (;;) {
        vTaskDelay(pdMS_TO_TICKS(10));
        int64_t now = esp_timer_get_time() / 1000;
        bool raw = raw_pressed();
        if (raw != last_raw) {
            last_raw = raw;
            raw_since = now;
        }
        if (raw != stable && now - raw_since >= 30) {  // debounced edge
            stable = raw;
            if (stable) {
                press_start = now;
                reset_fired = false;
            } else {
                int64_t held = now - press_start;
                if (showing) {
                    s_progress(-1);
                    showing = false;
                }
                if (reset_fired) {
                    // already handled
                } else if (held >= 3000) {
                    waiting_second = false;
                    emit(Gesture::HoldSetup);
                } else if (waiting_second && now - last_release < 450) {
                    waiting_second = false;
                    emit(Gesture::Double);
                } else {
                    waiting_second = true;
                    last_release = now;
                }
            }
        }
        if (stable && !reset_fired) {
            int64_t held = now - press_start;
            if (held >= 3000 && s_progress) {
                int pct = (int)((held - 3000) * 100 / 7000);
                s_progress(pct > 100 ? 100 : pct);
                showing = true;
            }
            if (held >= 10000) {
                reset_fired = true;
                waiting_second = false;
                emit(Gesture::HoldReset);
            }
        }
        if (waiting_second && !stable && now - last_release >= 450) {
            waiting_second = false;
            emit(Gesture::Single);
        }
    }
}

}  // namespace

void start(Handler on_gesture, ProgressHandler on_progress) {
    s_handler = on_gesture;
    s_progress = on_progress;
    setup_pin(CONFIG_LAMP_BUTTON_GPIO);
#if CONFIG_LAMP_EXT_BUTTON_GPIO >= 0
    setup_pin(CONFIG_LAMP_EXT_BUTTON_GPIO);
#endif
    xTaskCreate(task, "input", 3072, nullptr, 7, nullptr);
}

}  // namespace input
