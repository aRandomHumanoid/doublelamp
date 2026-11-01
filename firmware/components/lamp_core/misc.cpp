#include "lamp_core/misc.hpp"

#include <cstdio>
#include <cstring>

namespace lc {

bool is_forbidden_setup_code(const char* code) {
    char digits[9];
    int n = 0;
    for (const char* p = code; *p && n < 9; p++)
        if (*p >= '0' && *p <= '9') digits[n++] = *p;
    if (n != 8) return true;
    digits[8] = '\0';
    bool all_same = true;
    for (int i = 1; i < 8; i++) all_same &= digits[i] == digits[0];
    return all_same || std::strcmp(digits, "12345678") == 0 || std::strcmp(digits, "87654321") == 0;
}

void generate_setup_code(uint32_t (*rand32)(), char out[11]) {
    do {
        uint32_t v = rand32() % 100000000u;
        std::snprintf(out, 11, "%03u-%02u-%03u", (unsigned)(v / 100000u), (unsigned)((v / 1000u) % 100u),
                      (unsigned)(v % 1000u));
    } while (is_forbidden_setup_code(out));
}

void generate_setup_id(uint32_t (*rand32)(), char out[5]) {
    static const char* alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    for (int i = 0; i < 4; i++) out[i] = alphabet[rand32() % 36u];
    out[4] = '\0';
}

bool TimeSyncFilter::add(int64_t t0, int64_t t1, int64_t t2, int64_t t3, int64_t* best_offset, int64_t* delay) {
    int64_t d = (t3 - t0) - (t2 - t1);
    if (d < 0 || d > 1000) return false;
    // ((t1 − t0) + (t2 − t3)) / 2, rounded toward negative infinity consistently
    int64_t sum = (t1 - t0) + (t2 - t3);
    int64_t off = sum >= 0 ? sum / 2 : -((-sum + 1) / 2);
    s_[head_] = {off, d};
    head_ = (head_ + 1) % 8;
    if (n_ < 8) n_++;
    const Sample* best = &s_[0];
    for (int i = 0; i < n_; i++)
        if (s_[i].delay < best->delay) best = &s_[i];
    *best_offset = best->offset;
    *delay = d;
    return true;
}

uint16_t crc16(const uint8_t* data, size_t len) {
    // CRC-16/CCITT-FALSE
    uint16_t crc = 0xFFFF;
    for (size_t i = 0; i < len; i++) {
        crc ^= (uint16_t)data[i] << 8;
        for (int b = 0; b < 8; b++) crc = (crc & 0x8000) ? (uint16_t)((crc << 1) ^ 0x1021) : (uint16_t)(crc << 1);
    }
    return crc;
}

}  // namespace lc
