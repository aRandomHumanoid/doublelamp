// Integer-only math for effects (03 §6). No FPU on the ESP32-C3, and every function here is
// ported 1:1 to packages/effects so the web preview matches the lamps bit for bit.
#pragma once

#include <cstddef>
#include <cstdint>

namespace fx {

struct RGB8 {
    uint8_t r, g, b;
};

inline bool operator==(const RGB8& a, const RGB8& b) { return a.r == b.r && a.g == b.g && a.b == b.b; }
inline bool operator!=(const RGB8& a, const RGB8& b) { return !(a == b); }

/** sin(theta · 2π / 65536) × 32767, from a quarter-wave table with linear interpolation. */
int16_t sin16(uint16_t theta);

/** a + (b − a) · f / 255, rounded. */
inline uint8_t lerp8(uint8_t a, uint8_t b, uint8_t f) {
    return (uint8_t)(((uint32_t)a * (255u - f) + (uint32_t)b * f + 127u) / 255u);
}

/** c · s / 255, rounded. */
inline uint8_t scale8(uint8_t c, uint8_t s) { return (uint8_t)(((uint32_t)c * s + 127u) / 255u); }

inline RGB8 lerp_rgb(RGB8 a, RGB8 b, uint8_t f) { return {lerp8(a.r, b.r, f), lerp8(a.g, b.g, f), lerp8(a.b, b.b, f)}; }
inline RGB8 scale_rgb(RGB8 c, uint8_t s) { return {scale8(c.r, s), scale8(c.g, s), scale8(c.b, s)}; }

/** Integer HSV: h 0–65535 is one turn of the hue wheel, s and v 0–255. */
RGB8 hsv16(uint16_t h, uint8_t s, uint8_t v);

/** Counter-based hash: the same (seed, a, b) gives the same value on every lamp. */
uint32_t hash32(uint32_t seed, uint32_t a, uint32_t b);

/** Normalized pixel position in Q16: x = (2i + 1) · 65536 / (2n). */
inline uint16_t pos_q16(uint16_t i, uint16_t n) {
    return (uint16_t)(((uint32_t)(2u * i + 1u) * 65536u) / (2u * (uint32_t)n));
}

/** Maps speed 0–255 linearly from slow_ms down to fast_ms. */
inline uint32_t period_ms(uint8_t speed, uint32_t slow_ms, uint32_t fast_ms) {
    return slow_ms - ((uint32_t)speed * (slow_ms - fast_ms)) / 255u;
}

/** Position within a period as Q16. `t % period` is taken in 64 bits before narrowing. */
inline uint16_t phase16(uint64_t t, uint32_t period) {
    return (uint16_t)(((t % period) * 65536u) / period);
}

/** Parses "#RRGGBB" or "RRGGBB". */
bool parse_hex(const char* s, RGB8* out);
/** Writes "#RRGGBB" plus a terminating NUL (8 bytes). */
void format_hex(RGB8 c, char out[8]);

}  // namespace fx
