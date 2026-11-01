// Small pure helpers: Apple Home setup codes, time-sync filtering, CRC (03 §11–§13).
#pragma once

#include <cstddef>
#include <cstdint>

namespace lc {

/** Writes a random setup code "XXX-XX-XXX" (11 bytes incl. NUL), rejecting codes the HAP spec forbids. */
void generate_setup_code(uint32_t (*rand32)(), char out[11]);
/** True for codes the HAP spec forbids: all-same digits, 12345678 and 87654321. Accepts "XXX-XX-XXX". */
bool is_forbidden_setup_code(const char* code);
/** Writes a random 4-character setup ID from [0-9A-Z] (5 bytes incl. NUL). */
void generate_setup_id(uint32_t (*rand32)(), char out[5]);

/**
 * NTP-style offset filter (03 §12): keep the last 8 samples, trust the one with the smallest
 * delay, drop delay > 1000 ms.
 */
class TimeSyncFilter {
public:
    /** Returns true and the new best offset if the sample was accepted. */
    bool add(int64_t t0, int64_t t1, int64_t t2, int64_t t3, int64_t* best_offset, int64_t* delay);
    int count() const { return n_; }
    void reset() { n_ = 0, head_ = 0; }

private:
    struct Sample {
        int64_t offset, delay;
    };
    Sample s_[8]{};
    int n_ = 0, head_ = 0;
};

uint16_t crc16(const uint8_t* data, size_t len);

}  // namespace lc
