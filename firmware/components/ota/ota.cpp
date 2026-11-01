#include "ota/ota.hpp"

#include <cstdio>
#include <cstdlib>
#include <cstring>

#include "esp_app_desc.h"
#include "esp_app_format.h"
#include "esp_crt_bundle.h"
#include "esp_http_client.h"
#include "esp_log.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "lamp/identity.hpp"
#include "lamp/lamp.hpp"
#include "led_output/led_output.hpp"
#include "sdkconfig.h"
#include "storage/storage.hpp"

static const char* TAG = "ota";

namespace ota {

namespace {

constexpr uint8_t kPendSchema = 1;
struct Pending {
    int32_t job_id;
    char version[33];
};

volatile bool s_busy = false;
bool s_pending_verify = false;
bool s_rolled_back = false;
int s_done_job = -1;
int s_failed_job = -1;
bool s_marked = false;

/** -1, 0, 1 for a < b, a == b, a > b on "major.minor.patch[-…]". */
int semver_cmp(const char* a, const char* b) {
    unsigned va[3] = {0, 0, 0}, vb[3] = {0, 0, 0};
    std::sscanf(a, "%u.%u.%u", &va[0], &va[1], &va[2]);
    std::sscanf(b, "%u.%u.%u", &vb[0], &vb[1], &vb[2]);
    for (int i = 0; i < 3; i++) {
        if (va[i] < vb[i]) return -1;
        if (va[i] > vb[i]) return 1;
    }
    return 0;
}

void hex(const uint8_t* in, size_t n, char* out) {
    static const char* d = "0123456789abcdef";
    for (size_t i = 0; i < n; i++) out[2 * i] = d[in[i] >> 4], out[2 * i + 1] = d[in[i] & 15];
    out[2 * n] = '\0';
}

}  // namespace

esp_err_t Writer::fail(const char* msg, esp_err_t code) {
    std::snprintf(err_, sizeof err_, "%s", msg);
    ESP_LOGE(TAG, "%s", msg);
    abort();
    return code;
}

esp_err_t Writer::begin(size_t expected_size, const char* expected_sha256_hex, bool allow_downgrade) {
    if (active_) abort();
    err_[0] = '\0';
    written_ = 0;
    expected_ = expected_size;
    checked_desc_ = false;
    allow_downgrade_ = allow_downgrade;
    want_sha_[0] = '\0';
    if (expected_sha256_hex) std::snprintf(want_sha_, sizeof want_sha_, "%s", expected_sha256_hex);
    part_ = esp_ota_get_next_update_partition(nullptr);
    if (!part_) return fail("no OTA partition");
    if (expected_size && expected_size > part_->size) return fail("image too large for the OTA slot");
    esp_err_t e = esp_ota_begin(part_, OTA_WITH_SEQUENTIAL_WRITES, &handle_);
    if (e != ESP_OK) return fail("esp_ota_begin failed", e);
    mbedtls_sha256_init(&sha_);
    mbedtls_sha256_starts(&sha_, 0);
    active_ = true;
    ESP_LOGI(TAG, "writing to %s (%u bytes expected)", part_->label, (unsigned)expected_size);
    return ESP_OK;
}

esp_err_t Writer::write(const void* data, size_t len) {
    if (!active_) return ESP_ERR_INVALID_STATE;
    const uint8_t* p = (const uint8_t*)data;
    if (!checked_desc_) {
        size_t need = sizeof head_ - written_;
        size_t take = len < need ? len : need;
        std::memcpy(head_ + written_, p, take);
        if (written_ + take >= sizeof head_) {
            const size_t off = sizeof(esp_image_header_t) + sizeof(esp_image_segment_header_t);
            esp_app_desc_t desc;
            std::memcpy(&desc, head_ + off, sizeof desc);
            if (desc.magic_word != ESP_APP_DESC_MAGIC_WORD) return fail("not an ESP32 app image");
            if (std::strncmp(desc.project_name, "doublelamp", sizeof desc.project_name) != 0)
                return fail("image is not DoubleLamp firmware");
            std::snprintf(version_, sizeof version_, "%s", desc.version);
            if (!allow_downgrade_ && semver_cmp(desc.version, lamp::identity::fw_version()) < 0)
                return fail("downgrade refused");
            checked_desc_ = true;
            ESP_LOGI(TAG, "image: %s %s (IDF %s)", desc.project_name, desc.version, desc.idf_ver);
        }
    }
    mbedtls_sha256_update(&sha_, p, len);
    esp_err_t e = esp_ota_write(handle_, p, len);
    if (e != ESP_OK) return fail("flash write failed", e);
    written_ += len;
    return ESP_OK;
}

esp_err_t Writer::finish() {
    if (!active_) return ESP_ERR_INVALID_STATE;
    if (!checked_desc_) return fail("image too short");
    if (expected_ && written_ != expected_) return fail("size mismatch");
    uint8_t sum[32];
    mbedtls_sha256_finish(&sha_, sum);
    mbedtls_sha256_free(&sha_);
    char got[65];
    hex(sum, 32, got);
    if (want_sha_[0] && std::strcmp(got, want_sha_) != 0) return fail("sha256 mismatch");
    esp_err_t e = esp_ota_end(handle_);  // validates the image and its signature
    active_ = false;
    handle_ = 0;
    if (e != ESP_OK) {
        std::snprintf(err_, sizeof err_, "%s", e == ESP_ERR_OTA_VALIDATE_FAILED ? "image validation or signature failed"
                                                                               : "esp_ota_end failed");
        ESP_LOGE(TAG, "%s (%s)", err_, esp_err_to_name(e));
        return e;
    }
    e = esp_ota_set_boot_partition(part_);
    if (e != ESP_OK) {
        std::snprintf(err_, sizeof err_, "set boot partition failed");
        return e;
    }
    ESP_LOGI(TAG, "update verified (%u bytes, sha256 %.12s…)", (unsigned)written_, got);
    return ESP_OK;
}

void Writer::abort() {
    if (active_) {
        esp_ota_abort(handle_);
        mbedtls_sha256_free(&sha_);
    }
    active_ = false;
    handle_ = 0;
}

// ---------------------------------------------------------------- download job

namespace {

struct Job {
    int id;
    char url[384];
    char sha[65];
    size_t size;
    char version[33];
    bool allow_downgrade;
    ProgressFn progress;
    void* ctx;
};

void report(const Job& j, const char* phase, int pct, const char* err) {
    if (j.progress) j.progress(j.id, phase, pct, err, j.ctx);
}

void job_task(void* arg) {
    Job* j = (Job*)arg;
    Writer w;
    char* buf = (char*)std::malloc(2048);
    esp_http_client_config_t cfg = {};
    cfg.url = j->url;
    cfg.timeout_ms = 15000;
    cfg.buffer_size = 2048;
    cfg.keep_alive_enable = true;
    cfg.crt_bundle_attach = esp_crt_bundle_attach;
    esp_http_client_handle_t c = esp_http_client_init(&cfg);
    const char* err = nullptr;
    int last_pct = -1;
    report(*j, "download", 0, nullptr);
    led_output::ota_progress(0);
    if (!buf || !c) {
        err = "out of memory";
    } else if (esp_http_client_open(c, 0) != ESP_OK) {
        err = "download failed to start";
    } else {
        int64_t len = esp_http_client_fetch_headers(c);
        int status = esp_http_client_get_status_code(c);
        if (status != 200) {
            err = status == 403 || status == 401 ? "download link expired" : "download HTTP error";
        } else if (w.begin(j->size ? j->size : (len > 0 ? (size_t)len : 0), j->sha, j->allow_downgrade) != ESP_OK) {
            err = w.error();
        } else {
            for (;;) {
                int r = esp_http_client_read(c, buf, 2048);
                if (r < 0) {
                    err = "download interrupted";
                    break;
                }
                if (r == 0) {
                    if (esp_http_client_is_complete_data_received(c)) break;
                    err = "download interrupted";
                    break;
                }
                if (w.write(buf, r) != ESP_OK) {
                    err = w.error();
                    break;
                }
                if (j->size) {
                    int pct = (int)((w.written() * 100) / j->size);
                    if (pct / 10 != last_pct / 10) {
                        last_pct = pct;
                        report(*j, "download", pct > 99 ? 99 : pct, nullptr);
                        led_output::ota_progress(pct);
                    }
                }
            }
            if (!err) {
                report(*j, "verify", 100, nullptr);
                if (w.finish() != ESP_OK) err = w.error();
            } else {
                w.abort();
            }
        }
    }
    if (c) {
        esp_http_client_close(c);
        esp_http_client_cleanup(c);
    }
    std::free(buf);
    led_output::ota_progress(-1);
    if (err) {
        ESP_LOGE(TAG, "job %d failed: %s", j->id, err);
        report(*j, "failed", 0, err);
        std::free(j);
        s_busy = false;
        vTaskDelete(nullptr);
        return;
    }
    remember_pending(j->id, w.new_version());
    report(*j, "reboot", 100, nullptr);
    lamp::flush();
    std::free(j);
    vTaskDelay(pdMS_TO_TICKS(800));  // let the progress message go out
    esp_restart();
}

}  // namespace

bool start_job(int job_id, const char* url, const char* sha256_hex, size_t size, const char* version,
               bool allow_downgrade, ProgressFn progress, void* ctx) {
    if (s_busy) return false;
#if !CONFIG_LAMP_ALLOW_INSECURE_SERVER
    if (std::strncmp(url, "https://", 8) != 0) {
        ESP_LOGE(TAG, "refusing non-HTTPS download");
        if (progress) progress(job_id, "failed", 0, "download must use https", ctx);
        return false;
    }
#endif
    Job* j = (Job*)std::calloc(1, sizeof(Job));
    if (!j) return false;
    j->id = job_id;
    std::snprintf(j->url, sizeof j->url, "%s", url);
    std::snprintf(j->sha, sizeof j->sha, "%s", sha256_hex ? sha256_hex : "");
    j->size = size;
    std::snprintf(j->version, sizeof j->version, "%s", version ? version : "");
    j->allow_downgrade = allow_downgrade;
    j->progress = progress;
    j->ctx = ctx;
    s_busy = true;
    if (xTaskCreate(job_task, "ota", 8192, j, 4, nullptr) != pdPASS) {
        std::free(j);
        s_busy = false;
        return false;
    }
    return true;
}

bool busy() { return s_busy; }

void remember_pending(int job_id, const char* version) {
    Pending p{};
    p.job_id = job_id;
    std::snprintf(p.version, sizeof p.version, "%s", version ? version : "");
    storage::save_blob("ota", "pend", kPendSchema, &p, sizeof p);
}

// ---------------------------------------------------------------- after boot

void boot_check() {
    const esp_partition_t* running = esp_ota_get_running_partition();
    esp_ota_img_states_t st;
    if (esp_ota_get_state_partition(running, &st) == ESP_OK) s_pending_verify = st == ESP_OTA_IMG_PENDING_VERIFY;
    Pending p{};
    if (storage::load_blob("ota", "pend", kPendSchema, &p, sizeof p)) {
        if (std::strcmp(p.version, lamp::identity::fw_version()) == 0) {
            s_done_job = p.job_id;  // reported once the new image is verified
        } else {
            s_rolled_back = true;   // we're running the old image again
            s_failed_job = p.job_id;
        }
        if (!s_pending_verify || s_rolled_back) storage::erase_key("ota", "pend");
    }
    if (s_pending_verify) ESP_LOGW(TAG, "new firmware %s is pending verification", lamp::identity::fw_version());
    if (s_rolled_back) ESP_LOGW(TAG, "booted after a rollback");
}

bool pending_verify() { return s_pending_verify && !s_marked; }
bool rolled_back() { return s_rolled_back; }
int job_to_report_done() { return pending_verify() ? -1 : s_done_job; }
int job_to_report_failed() { return s_failed_job; }

void clear_reported() {
    if (!pending_verify()) {
        s_done_job = -1;
        storage::erase_key("ota", "pend");
    }
    s_failed_job = -1;
}

void health_tick(bool render_ok, bool httpd_ok, bool internet_ok, bool claimed, bool got_welcome) {
    if (!s_pending_verify || s_marked) return;
    int64_t up_s = esp_timer_get_time() / 1000000;
    if (!render_ok || !httpd_ok) return;
    if (up_s < 60) return;
    bool need_server = internet_ok && claimed;
    if (need_server && !got_welcome) {
        if (up_s > 60 + 300) {
            ESP_LOGE(TAG, "no welcome from the server within 5 min: rolling back");
            esp_ota_mark_app_invalid_rollback_and_reboot();
        }
        return;
    }
    if (esp_ota_mark_app_valid_cancel_rollback() == ESP_OK) {
        s_marked = true;
        storage::erase_key("ota", "pend");
        ESP_LOGI(TAG, "firmware %s marked valid", lamp::identity::fw_version());
    }
}

}  // namespace ota
