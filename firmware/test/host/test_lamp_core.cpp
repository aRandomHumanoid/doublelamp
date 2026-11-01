// Host unit tests for lamp_core and effects (08 §1.1). Build with test/host/CMakeLists.txt
// or directly with g++ (see run_host_tests.sh).
#include <cmath>
#include <cstdio>
#include <cstring>

#include "cJSON.h"
#include "effects/effects.hpp"
#include "lamp_core/codec.hpp"
#include "lamp_core/homekit_map.hpp"
#include "lamp_core/misc.hpp"
#include "lamp_core/state.hpp"

static int g_failures = 0, g_checks = 0;
#define CHECK(cond)                                                          \
    do {                                                                     \
        g_checks++;                                                          \
        if (!(cond)) {                                                       \
            g_failures++;                                                    \
            std::printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond);     \
        }                                                                    \
    } while (0)

using namespace lc;

static uint32_t fixed_rand() { return 4242u; }
static uint32_t counter_rand() {
    static uint32_t x = 1;
    x = x * 1664525u + 1013904223u;
    return x;
}

static Patch parse_patch(const char* json, JsonError* err, bool* ok) {
    cJSON* o = cJSON_Parse(json);
    Patch p;
    *ok = patch_from_json(o, &p, err);
    cJSON_Delete(o);
    return p;
}

static void test_apply_patch() {
    LampState s = default_state();
    Patch p;
    p.fields = F_ON | F_BRIGHTNESS;
    p.values.on = true;
    p.values.brightness = 128;  // unchanged
    FieldMask ch = apply_patch(s, p, 1000, fixed_rand);
    CHECK(ch == F_ON);
    CHECK(s.on);
    CHECK(apply_patch(s, p, 1000, fixed_rand) == 0);  // idempotent

    Patch e;
    e.fields = F_EFFECT;
    e.effect_fields = EF_ID;
    std::strcpy(e.values.effect.id, "candle");
    ch = apply_patch(s, e, 5555, fixed_rand);
    CHECK(ch == F_EFFECT);
    CHECK(std::strcmp(s.effect.id, "candle") == 0);
    CHECK(s.effect.epoch_ms == 5555);
    CHECK(s.effect.seed == 4242u);

    Patch sp;
    sp.fields = F_EFFECT;
    sp.effect_fields = EF_SPEED;
    sp.values.effect.speed = 10;
    ch = apply_patch(s, sp, 9999, fixed_rand);
    CHECK(ch == F_EFFECT);
    CHECK(s.effect.epoch_ms == 5555);  // speed change keeps the phase origin
    CHECK(s.effect.speed == 10);
}

static void test_codec() {
    JsonError err;
    bool ok;
    Patch p = parse_patch(R"({"brightness":90,"colors":["#ff8a3d","7A2BFF"],"extra":1})", &err, &ok);
    CHECK(ok);
    CHECK(p.fields == (F_BRIGHTNESS | F_COLORS));
    CHECK(p.values.ncolors == 2);
    CHECK(p.values.colors[0] == (RGB8{0xFF, 0x8A, 0x3D}));

    parse_patch(R"({"brightness":256})", &err, &ok);
    CHECK(!ok);
    CHECK(std::strcmp(err.field, "brightness") == 0);
    parse_patch(R"({"brightness":1.5})", &err, &ok);
    CHECK(!ok);
    parse_patch(R"({"colors":[]})", &err, &ok);
    CHECK(!ok);
    parse_patch(R"({"colors":["#12345"]})", &err, &ok);
    CHECK(!ok);
    parse_patch(R"({"effect":{"id":"disco"}})", &err, &ok);
    CHECK(!ok);
    CHECK(std::strcmp(err.code, "unknown_effect") == 0);

    p = parse_patch(R"({"effect":{"id":"rainbow","speed":40,"epoch":1761650000123}})", &err, &ok);
    CHECK(ok);
    CHECK(p.effect_fields == (EF_ID | EF_SPEED | EF_EPOCH));
    CHECK(p.values.effect.epoch_ms == 1761650000123LL);

    // Round trip a full state
    LampState s = default_state();
    s.on = true;
    s.ncolors = 3;
    s.colors[1] = {1, 2, 3};
    s.colors[2] = {250, 251, 252};
    s.effect.seed = 4294967295u;
    s.effect.epoch_ms = 1793000000000LL;
    cJSON* j = state_to_json(s);
    char* text = json_print(j);
    cJSON* back = cJSON_Parse(text);
    LampState t;
    CHECK(state_from_json(back, &t, &err));
    CHECK(states_equal(s, t));
    cJSON_free(text);
    cJSON_Delete(j);
    cJSON_Delete(back);

    // A partial object is not a full state
    cJSON* part = cJSON_Parse(R"({"on":true})");
    CHECK(!state_from_json(part, &t, &err));
    cJSON_Delete(part);
}

static void test_led_config() {
    LedConfig c = default_led_config(10, 42);
    JsonError err;
    cJSON* o = cJSON_Parse(R"({"pixel_count":32,"color_order":"BRG","fps":60})");
    CHECK(led_config_merge_json(o, &c, &err));
    CHECK(c.pixel_count == 32 && c.fps == 60 && std::strcmp(c.color_order, "BRG") == 0);
    cJSON_Delete(o);
    o = cJSON_Parse(R"({"color_order":"RRB"})");
    CHECK(!led_config_merge_json(o, &c, &err));
    cJSON_Delete(o);
    o = cJSON_Parse(R"({"color_order":"GRBW"})");  // 4 bytes but channels = 3
    CHECK(!led_config_merge_json(o, &c, &err));
    cJSON_Delete(o);
    o = cJSON_Parse(R"({"color_order":"GRBW","channels":4})");
    CHECK(led_config_merge_json(o, &c, &err));
    cJSON_Delete(o);
    uint8_t map[4], n;
    CHECK(color_order_map("BRG", map, &n) && n == 3 && map[0] == 2 && map[1] == 0 && map[2] == 1);
}

static void test_homekit_map() {
    CHECK(brightness_to_pct(255) == 100);
    CHECK(brightness_to_pct(0) == 0);
    CHECK(pct_to_brightness(100) == 255);
    CHECK(pct_to_brightness(50) == 128);
    for (int p = 1; p <= 100; p++) CHECK(brightness_to_pct(pct_to_brightness(p)) == p);

    RGB8 red = hue_sat_to_rgb(0, 100);
    CHECK(red == (RGB8{255, 0, 0}));
    float h, s;
    rgb_to_hue_sat({0, 0, 255}, &h, &s);
    CHECK(std::fabs(h - 240.0f) < 0.11f && std::fabs(s - 100.0f) < 0.11f);
    rgb_to_hue_sat({0xFF, 0xB4, 0x6B}, &h, &s);  // warm white
    RGB8 back = hue_sat_to_rgb(h, s);
    CHECK(std::abs(back.r - 0xFF) <= 1 && std::abs(back.g - 0xB4) <= 1 && std::abs(back.b - 0x6B) <= 1);

    LampState st = default_state();
    std::strcpy(st.effect.id, "rainbow");
    HkWrite w;
    w.has_hue = w.has_saturation = true;
    w.hue = 120;
    w.saturation = 100;
    Patch p;
    CHECK(hk_to_patch(w, st, &p));
    CHECK((p.fields & F_COLORS) && (p.fields & F_EFFECT));
    CHECK(std::strcmp(p.values.effect.id, "solid") == 0);
    CHECK(p.values.colors[0] == (RGB8{0, 255, 0}));

    std::strcpy(st.effect.id, "breathe");
    CHECK(hk_to_patch(w, st, &p));
    CHECK((p.fields & F_COLORS) && !(p.fields & F_EFFECT));

    HkWrite z;
    z.has_brightness = true;
    z.brightness_pct = 0;
    CHECK(hk_to_patch(z, st, &p));
    CHECK(p.fields == F_ON && !p.values.on);

    HkWrite only_hue;
    only_hue.has_hue = true;
    only_hue.hue = 240;
    st.colors[0] = {255, 255, 255};  // saturation 0 stays 0
    CHECK(hk_to_patch(only_hue, st, &p));
    CHECK(p.values.colors[0] == (RGB8{255, 255, 255}));
}

static void test_misc() {
    CHECK(is_forbidden_setup_code("111-11-111"));
    CHECK(is_forbidden_setup_code("123-45-678"));
    CHECK(is_forbidden_setup_code("876-54-321"));
    CHECK(!is_forbidden_setup_code("031-45-154"));
    char code[11];
    for (int i = 0; i < 200; i++) {
        generate_setup_code(counter_rand, code);
        CHECK(std::strlen(code) == 10 && code[3] == '-' && code[6] == '-');
        CHECK(!is_forbidden_setup_code(code));
    }
    char id[5];
    generate_setup_id(counter_rand, id);
    CHECK(std::strlen(id) == 4);

    TimeSyncFilter f;
    int64_t off, d;
    CHECK(f.add(1000, 6020, 6021, 1041, &off, &d));  // offset 5000, delay 40
    CHECK(off == 5000 && d == 40);
    CHECK(f.add(2000, 7030, 7031, 2061, &off, &d));  // delay 60: best stays the first
    CHECK(off == 5000);
    CHECK(!f.add(3000, 8000, 8000, 5000, &off, &d));  // delay 2000 rejected

    const char* s = "123456789";
    CHECK(crc16((const uint8_t*)s, 9) == 0x29B1);
}

static void test_effects_registry() {
    CHECK(fx::effect_count() == 9);
    CHECK(fx::find_effect("sunrise") && fx::find_effect("sunrise")->oneshot);
    CHECK(!fx::effect_uses_colors("rainbow"));
    CHECK(fx::effect_uses_colors("candle"));
    CHECK(fx::sin16(0) == 0 && fx::sin16(16384) == 32767 && fx::sin16(49152) == -32767);
    cJSON* effects = effects_to_json();
    CHECK(cJSON_GetArraySize(effects) == 9);
    cJSON_Delete(effects);
}

int main() {
    test_apply_patch();
    test_codec();
    test_led_config();
    test_homekit_map();
    test_misc();
    test_effects_registry();
    std::printf("%d checks, %d failures\n", g_checks, g_failures);
    return g_failures ? 1 : 0;
}
