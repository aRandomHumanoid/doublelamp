// Apple Home accessory (03 §11): one Lightbulb service with On, Brightness, Hue, Saturation.
#include "homekit/homekit.hpp"

#include <cstdio>
#include <cstring>

#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "hap.h"
#include "hap_apple_chars.h"
#include "hap_apple_servs.h"
#include "homekit_internal.hpp"
#include "lamp/identity.hpp"
#include "lamp/lamp.hpp"
#include "lamp/settings.hpp"
#include "lamp/status.hpp"
#include "lamp_core/homekit_map.hpp"
#include "led_output/led_output.hpp"
#include "net/net.hpp"
#include "sdkconfig.h"

static const char* TAG = "homekit";

namespace homekit {

namespace {

bool s_started = false;
hap_char_t* s_on = nullptr;
hap_char_t* s_bri = nullptr;
hap_char_t* s_hue = nullptr;
hap_char_t* s_sat = nullptr;
lc::HkValues s_pushed{};
bool s_have_pushed = false;

// HAP keeps these pointers: they must stay valid.
char s_name[lc::kNameLen + 1];
char s_model[] = "DoubleLamp C3";
char s_manufacturer[] = "DoubleLamp";
char s_serial[12];
char s_fw[33];
char s_hw[] = "1.0";
char s_pv[] = "1.1.0";

void publish_status() {
    lamp::status::Homekit h;
    int n = s_started ? hap_get_paired_controller_count() : 0;
    std::snprintf(h.state, sizeof h.state, "%s", !s_started ? "off" : (n > 0 ? "paired" : "unpaired"));
    h.controllers = n;
    lamp::status::set_homekit(h);
}

int on_identify(hap_acc_t*) {
    led_output::identify(1200);
    return HAP_SUCCESS;
}

int on_write(hap_write_data_t write_data[], int count, void*, void*) {
    lc::HkWrite w;
    for (int i = 0; i < count; i++) {
        hap_write_data_t* wd = &write_data[i];
        const char* uuid = hap_char_get_type_uuid(wd->hc);
        *(wd->status) = HAP_STATUS_SUCCESS;
        if (!std::strcmp(uuid, HAP_CHAR_UUID_ON)) {
            w.has_on = true;
            w.on = wd->val.b;
        } else if (!std::strcmp(uuid, HAP_CHAR_UUID_BRIGHTNESS)) {
            w.has_brightness = true;
            w.brightness_pct = wd->val.i;
        } else if (!std::strcmp(uuid, HAP_CHAR_UUID_HUE)) {
            w.has_hue = true;
            w.hue = wd->val.f;
        } else if (!std::strcmp(uuid, HAP_CHAR_UUID_SATURATION)) {
            w.has_saturation = true;
            w.saturation = wd->val.f;
        } else {
            *(wd->status) = HAP_STATUS_RES_ABSENT;
            continue;
        }
        hap_char_update_val(wd->hc, &(wd->val));  // so reads return the new value
    }
    lc::Patch p;
    if (lc::hk_to_patch(w, lamp::get_state(), &p)) {
        // One patch per HAP request; never wait on the state task here.
        lamp::submit(p, 400, 0, lc::Origin::HomeKit, 20);
    }
    return HAP_SUCCESS;
}

/** Push state changes from every other source so the Home app stays current. */
void on_state(const lamp::StateEvent& ev, void*) {
    if (!s_started || ev.origin == lc::Origin::HomeKit) return;
    lc::HkValues v = lc::hk_from_state(ev.state);
    hap_val_t val;
    if (!s_have_pushed || v.on != s_pushed.on) {
        val.b = v.on;
        hap_char_update_val(s_on, &val);
    }
    if (!s_have_pushed || v.brightness_pct != s_pushed.brightness_pct) {
        val.i = v.brightness_pct;
        hap_char_update_val(s_bri, &val);
    }
    if (!s_have_pushed || v.hue != s_pushed.hue) {
        val.f = v.hue;
        hap_char_update_val(s_hue, &val);
    }
    if (!s_have_pushed || v.saturation != s_pushed.saturation) {
        val.f = v.saturation;
        hap_char_update_val(s_sat, &val);
    }
    s_pushed = v;
    s_have_pushed = true;
}

void on_hap_event(hap_event_t event, void*) {
    switch (event) {
        case HAP_EVENT_CTRL_PAIRED:
            ESP_LOGI(TAG, "an iPhone paired");
            break;
        case HAP_EVENT_CTRL_UNPAIRED:
            ESP_LOGI(TAG, "a pairing was removed");
            break;
        case HAP_EVENT_PAIRING_STARTED:
            ESP_LOGI(TAG, "pairing started");
            break;
        default:
            break;
    }
    publish_status();
}

}  // namespace

void init() {
    load_or_create_code();
    lamp::subscribe(on_state, nullptr);
}

bool available() {
#if CONFIG_LAMP_HOMEKIT
    return true;
#else
    return false;
#endif
}

void start() {
#if CONFIG_LAMP_HOMEKIT
    if (s_started) return;
    hap_cfg_t cfg;
    hap_get_config(&cfg);
    cfg.unique_param = UNIQUE_NONE;  // we name the accessory after the lamp
    hap_set_config(&cfg);
    if (hap_init(HAP_TRANSPORT_WIFI) != HAP_SUCCESS) {
        ESP_LOGE(TAG, "hap_init failed");
        return;
    }
    lamp::settings::name(s_name);
    std::snprintf(s_serial, sizeof s_serial, "%s", lamp::identity::device_id());
    std::snprintf(s_fw, sizeof s_fw, "%s", lamp::identity::fw_version());
    hap_acc_cfg_t acc_cfg = {};
    acc_cfg.name = s_name;
    acc_cfg.model = s_model;
    acc_cfg.manufacturer = s_manufacturer;
    acc_cfg.serial_num = s_serial;
    acc_cfg.fw_rev = s_fw;
    acc_cfg.hw_rev = s_hw;
    acc_cfg.pv = s_pv;
    acc_cfg.cid = HAP_CID_LIGHTING;
    acc_cfg.identify_routine = on_identify;
    hap_acc_t* acc = hap_acc_create(&acc_cfg);
    if (!acc) {
        ESP_LOGE(TAG, "hap_acc_create failed");
        return;
    }
    static uint8_t product_data[] = {'D', 'B', 'L', 'L', 'A', 'M', 'P', '1'};
    hap_acc_add_product_data(acc, product_data, sizeof product_data);
    hap_acc_add_wifi_transport_service(acc, 0);

    lc::HkValues v = lc::hk_from_state(lamp::get_state());
    hap_serv_t* svc = hap_serv_lightbulb_create(v.on);
    hap_serv_add_char(svc, hap_char_name_create(s_name));
    hap_serv_add_char(svc, hap_char_brightness_create(v.brightness_pct));
    hap_serv_add_char(svc, hap_char_hue_create(v.hue));
    hap_serv_add_char(svc, hap_char_saturation_create(v.saturation));
    hap_serv_set_write_cb(svc, on_write);
    hap_acc_add_serv(acc, svc);
    s_on = hap_serv_get_char_by_uuid(svc, HAP_CHAR_UUID_ON);
    s_bri = hap_serv_get_char_by_uuid(svc, HAP_CHAR_UUID_BRIGHTNESS);
    s_hue = hap_serv_get_char_by_uuid(svc, HAP_CHAR_UUID_HUE);
    s_sat = hap_serv_get_char_by_uuid(svc, HAP_CHAR_UUID_SATURATION);
    s_pushed = v;
    s_have_pushed = true;
    hap_add_accessory(acc);

    hap_set_setup_code(g_code);
    hap_set_setup_id(g_setup_id);
    hap_register_event_handler(on_hap_event);
    if (hap_start() != HAP_SUCCESS) {
        ESP_LOGE(TAG, "hap_start failed");
        return;
    }
    s_started = true;
    net::mdns_refresh();  // the SDK sets its own mDNS hostname; put ours back
    publish_status();
    ESP_LOGI(TAG, "Apple Home accessory started on port %d (%d paired)", CONFIG_HAP_HTTP_SERVER_PORT,
             hap_get_paired_controller_count());
#endif
}

Info info() {
    Info i{};
    int n = s_started ? hap_get_paired_controller_count() : 0;
    i.state = !s_started ? "off" : (n > 0 ? "paired" : "unpaired");
    i.controllers = n;
    std::memcpy(i.setup_code, g_code, sizeof i.setup_code);
    std::memcpy(i.setup_id, g_setup_id, sizeof i.setup_id);
    return i;
}

void reset_pairings() {
    if (!s_started) return;
    ESP_LOGW(TAG, "removing all Apple Home pairings (the lamp restarts)");
    lamp::flush();
    hap_reset_pairings();
}

}  // namespace homekit
