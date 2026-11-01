// OTA updates (03 §15): one streaming writer for server-pushed and locally uploaded images,
// plus the post-boot health check that confirms a new image or rolls it back.
#pragma once

#include <cstddef>
#include <cstdint>

#include "esp_err.h"
#include "esp_ota_ops.h"
#include "mbedtls/sha256.h"

namespace ota {

/**
 * Checks, in order: the app descriptor (project "doublelamp", no downgrade unless allowed), the
 * SHA-256 of the whole file (when known), and on finish the image itself — esp_ota_end verifies
 * the signature against the running app's key (CONFIG_SECURE_SIGNED_ON_UPDATE_NO_SECURE_BOOT).
 */
class Writer {
public:
    esp_err_t begin(size_t expected_size, const char* expected_sha256_hex, bool allow_downgrade);
    esp_err_t write(const void* data, size_t len);
    /** Verifies and switches the boot slot. */
    esp_err_t finish();
    void abort();
    const char* error() const { return err_; }
    size_t written() const { return written_; }
    const char* new_version() const { return version_; }

private:
    esp_err_t fail(const char* msg, esp_err_t code = ESP_FAIL);
    esp_ota_handle_t handle_ = 0;
    const esp_partition_t* part_ = nullptr;
    mbedtls_sha256_context sha_{};
    uint8_t head_[288]{};
    size_t written_ = 0, expected_ = 0;
    bool checked_desc_ = false, allow_downgrade_ = false, active_ = false;
    char want_sha_[65] = {0};
    char version_[33] = {0};
    char err_[64] = {0};
};

using ProgressFn = void (*)(int job_id, const char* phase, int pct, const char* error, void* ctx);

/** Downloads and installs in the "ota" task (priority 4). Reboots on success. */
bool start_job(int job_id, const char* url, const char* sha256_hex, size_t size, const char* version,
               bool allow_downgrade, ProgressFn progress, void* ctx);
bool busy();

/** Records what's being installed so the next boot can tell success from a rollback. */
void remember_pending(int job_id, const char* version);

// ---------------------------------------------------------------- after boot

void boot_check();
bool pending_verify();
/** The previous boot attempted an update that was rolled back. */
bool rolled_back();
/** Job id to report as done once verified (-1 = none), and one to report as failed. */
int job_to_report_done();
int job_to_report_failed();
void clear_reported();
/** Call once a second (03 §15 health rules). */
void health_tick(bool render_ok, bool httpd_ok, bool internet_ok, bool claimed, bool got_welcome);

}  // namespace ota
