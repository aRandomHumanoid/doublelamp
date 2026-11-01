#include "effects/math8.hpp"

namespace fx {

// round(32767 · sin(k · π / 128)), k = 0..64
static const int16_t kQuarterSine[65] = {
    0,     804,   1608,  2410,  3212,  4011,  4808,  5602,  6393,  7179,  7962,  8739,  9512,
    10278, 11039, 11793, 12539, 13279, 14010, 14732, 15446, 16151, 16846, 17530, 18204, 18868,
    19519, 20159, 20787, 21403, 22005, 22594, 23170, 23731, 24279, 24811, 25329, 25832, 26319,
    26790, 27245, 27683, 28105, 28510, 28898, 29268, 29621, 29956, 30273, 30571, 30852, 31113,
    31356, 31580, 31785, 31971, 32137, 32285, 32412, 32521, 32609, 32678, 32728, 32757, 32767,
};

int16_t sin16(uint16_t theta) {
    uint32_t quadrant = theta >> 14;
    uint32_t p = theta & 0x3FFFu;
    if (quadrant & 1u) p = 16384u - p;  // mirror: 1..16384
    uint32_t idx = p >> 8;              // 0..64
    uint32_t frac = p & 0xFFu;
    int32_t v;
    if (idx >= 64u) {
        v = kQuarterSine[64];
    } else {
        int32_t a = kQuarterSine[idx];
        int32_t d = kQuarterSine[idx + 1] - a;  // >= 0: the quarter wave rises
        v = a + (int32_t)(((uint32_t)d * frac) >> 8);
    }
    return (int16_t)(quadrant >= 2u ? -v : v);
}

RGB8 hsv16(uint16_t h, uint8_t s, uint8_t v) {
    uint32_t h6 = (uint32_t)h * 6u;
    uint32_t region = h6 >> 16;
    uint32_t rem = (h6 >> 8) & 0xFFu;
    uint32_t vv = v, ss = s;
    uint8_t p = (uint8_t)((vv * (255u - ss) + 127u) / 255u);
    uint8_t q = (uint8_t)((vv * (255u - (ss * rem + 127u) / 255u) + 127u) / 255u);
    uint8_t t = (uint8_t)((vv * (255u - (ss * (255u - rem) + 127u) / 255u) + 127u) / 255u);
    switch (region) {
        case 0: return {v, t, p};
        case 1: return {q, v, p};
        case 2: return {p, v, t};
        case 3: return {p, q, v};
        case 4: return {t, p, v};
        default: return {v, p, q};
    }
}

static inline uint32_t mix32(uint32_t x) {
    x ^= x >> 16;
    x *= 0x7FEB352Du;
    x ^= x >> 15;
    x *= 0x846CA68Bu;
    x ^= x >> 16;
    return x;
}

uint32_t hash32(uint32_t seed, uint32_t a, uint32_t b) {
    uint32_t h = mix32(seed ^ 0x9E3779B9u);
    h = mix32(h ^ a);
    h = mix32(h ^ b);
    return h;
}

static int hexval(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

bool parse_hex(const char* s, RGB8* out) {
    if (!s) return false;
    if (*s == '#') s++;
    uint8_t v[3];
    for (int i = 0; i < 3; i++) {
        int hi = hexval(s[2 * i]);
        if (hi < 0) return false;
        int lo = hexval(s[2 * i + 1]);
        if (lo < 0) return false;
        v[i] = (uint8_t)(hi * 16 + lo);
    }
    if (s[6] != '\0') return false;
    *out = {v[0], v[1], v[2]};
    return true;
}

void format_hex(RGB8 c, char out[8]) {
    static const char* digits = "0123456789ABCDEF";
    out[0] = '#';
    const uint8_t v[3] = {c.r, c.g, c.b};
    for (int i = 0; i < 3; i++) {
        out[1 + 2 * i] = digits[v[i] >> 4];
        out[2 + 2 * i] = digits[v[i] & 0xF];
    }
    out[7] = '\0';
}

}  // namespace fx
