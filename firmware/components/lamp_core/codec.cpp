#include "lamp_core/codec.hpp"

#include <cmath>
#include <cstdio>
#include <cstring>

#include "effects/effects.hpp"

namespace lc {

static void set_err(JsonError* err, const char* field, const char* msg, const char* code = "invalid") {
    if (!err) return;
    err->code = code;
    std::snprintf(err->field, sizeof err->field, "%s", field);
    std::snprintf(err->message, sizeof err->message, "%s", msg);
}

void color_hex(RGB8 c, char out[8]) { fx::format_hex(c, out); }

const char* json_str(const cJSON* obj, const char* key) {
    const cJSON* it = cJSON_GetObjectItemCaseSensitive(obj, key);
    return cJSON_IsString(it) ? it->valuestring : nullptr;
}

bool json_int(const cJSON* obj, const char* key, double lo, double hi, double* out, bool* present) {
    const cJSON* it = cJSON_GetObjectItemCaseSensitive(obj, key);
    *present = it != nullptr && !cJSON_IsNull(it);
    if (!*present) return true;
    if (!cJSON_IsNumber(it)) return false;
    double v = it->valuedouble;
    if (std::floor(v) != v || v < lo || v > hi) return false;
    *out = v;
    return true;
}

char* json_print(const cJSON* obj) { return cJSON_PrintUnformatted(obj); }

static cJSON* effect_to_json(const Effect& e) {
    cJSON* o = cJSON_CreateObject();
    cJSON_AddStringToObject(o, "id", e.id);
    cJSON_AddNumberToObject(o, "speed", e.speed);
    cJSON_AddNumberToObject(o, "intensity", e.intensity);
    cJSON_AddNumberToObject(o, "seed", (double)e.seed);
    cJSON_AddNumberToObject(o, "epoch", (double)e.epoch_ms);
    cJSON_AddNumberToObject(o, "duration_ms", (double)e.duration_ms);
    return o;
}

static cJSON* colors_to_json(const LampState& s) {
    cJSON* a = cJSON_CreateArray();
    char hex[8];
    for (int i = 0; i < s.ncolors; i++) {
        color_hex(s.colors[i], hex);
        cJSON_AddItemToArray(a, cJSON_CreateString(hex));
    }
    return a;
}

cJSON* fields_to_json(const LampState& s, FieldMask fields) {
    cJSON* o = cJSON_CreateObject();
    if (fields & F_ON) cJSON_AddBoolToObject(o, "on", s.on);
    if (fields & F_BRIGHTNESS) cJSON_AddNumberToObject(o, "brightness", s.brightness);
    if (fields & F_COLORS) cJSON_AddItemToObject(o, "colors", colors_to_json(s));
    if (fields & F_EFFECT) cJSON_AddItemToObject(o, "effect", effect_to_json(s.effect));
    return o;
}

cJSON* state_to_json(const LampState& s) { return fields_to_json(s, F_ALL); }

bool patch_from_json(const cJSON* obj, Patch* out, JsonError* err) {
    if (!cJSON_IsObject(obj)) {
        set_err(err, "", "expected an object");
        return false;
    }
    Patch p;
    const cJSON* on = cJSON_GetObjectItemCaseSensitive(obj, "on");
    if (on && !cJSON_IsNull(on)) {
        if (!cJSON_IsBool(on)) return set_err(err, "on", "on must be true or false"), false;
        p.fields |= F_ON;
        p.values.on = cJSON_IsTrue(on);
    }
    double v;
    bool present;
    if (!json_int(obj, "brightness", 0, 255, &v, &present))
        return set_err(err, "brightness", "brightness must be 0-255"), false;
    if (present) {
        p.fields |= F_BRIGHTNESS;
        p.values.brightness = (uint8_t)v;
    }
    const cJSON* colors = cJSON_GetObjectItemCaseSensitive(obj, "colors");
    if (colors && !cJSON_IsNull(colors)) {
        int n = cJSON_IsArray(colors) ? cJSON_GetArraySize(colors) : -1;
        if (n < 1 || n > kMaxColors) return set_err(err, "colors", "colors must hold 1-3 #RRGGBB values"), false;
        for (int i = 0; i < n; i++) {
            const cJSON* c = cJSON_GetArrayItem(colors, i);
            if (!cJSON_IsString(c) || !fx::parse_hex(c->valuestring, &p.values.colors[i]))
                return set_err(err, "colors", "colors must be #RRGGBB"), false;
        }
        p.values.ncolors = (uint8_t)n;
        p.fields |= F_COLORS;
    }
    const cJSON* eff = cJSON_GetObjectItemCaseSensitive(obj, "effect");
    if (eff && !cJSON_IsNull(eff)) {
        if (!cJSON_IsObject(eff)) return set_err(err, "effect", "effect must be an object"), false;
        Effect& e = p.values.effect;
        const char* id = json_str(eff, "id");
        if (cJSON_GetObjectItemCaseSensitive(eff, "id")) {
            if (!id) return set_err(err, "effect.id", "effect.id must be a string"), false;
            if (!fx::find_effect(id)) return set_err(err, "effect.id", "unknown effect", "unknown_effect"), false;
            std::snprintf(e.id, sizeof e.id, "%s", id);
            p.effect_fields |= EF_ID;
        }
        if (!json_int(eff, "speed", 0, 255, &v, &present))
            return set_err(err, "effect.speed", "speed must be 0-255"), false;
        if (present) e.speed = (uint8_t)v, p.effect_fields |= EF_SPEED;
        if (!json_int(eff, "intensity", 0, 255, &v, &present))
            return set_err(err, "effect.intensity", "intensity must be 0-255"), false;
        if (present) e.intensity = (uint8_t)v, p.effect_fields |= EF_INTENSITY;
        if (!json_int(eff, "seed", 0, 4294967295.0, &v, &present))
            return set_err(err, "effect.seed", "seed must be a uint32"), false;
        if (present) e.seed = (uint32_t)v, p.effect_fields |= EF_SEED;
        if (!json_int(eff, "epoch", -9007199254740991.0, 9007199254740991.0, &v, &present))
            return set_err(err, "effect.epoch", "epoch must be an integer"), false;
        if (present) e.epoch_ms = (int64_t)v, p.effect_fields |= EF_EPOCH;
        if (!json_int(eff, "duration_ms", 0, 4294967295.0, &v, &present))
            return set_err(err, "effect.duration_ms", "duration_ms must be a uint32"), false;
        if (present) e.duration_ms = (uint32_t)v, p.effect_fields |= EF_DURATION;
        if (p.effect_fields) p.fields |= F_EFFECT;
    }
    *out = p;
    return true;
}

bool state_from_json(const cJSON* obj, LampState* out, JsonError* err) {
    Patch p;
    if (!patch_from_json(obj, &p, err)) return false;
    if (p.fields != F_ALL || p.effect_fields != EF_ALL) {
        set_err(err, "state", "state is missing fields");
        return false;
    }
    *out = p.values;
    return true;
}

cJSON* led_config_to_json(const LedConfig& c) {
    cJSON* o = cJSON_CreateObject();
    cJSON_AddNumberToObject(o, "pixel_count", c.pixel_count);
    cJSON_AddNumberToObject(o, "channels", c.channels);
    cJSON_AddStringToObject(o, "color_order", c.color_order);
    cJSON_AddNumberToObject(o, "max_current_ma", c.max_current_ma);
    cJSON_AddNumberToObject(o, "ma_per_pixel_white", c.ma_per_pixel_white);
    cJSON* cc = cJSON_CreateArray();
    for (int i = 0; i < 3; i++) cJSON_AddItemToArray(cc, cJSON_CreateNumber(c.color_correction[i]));
    cJSON_AddItemToObject(o, "color_correction", cc);
    cJSON_AddNumberToObject(o, "fps", c.fps);
    cJSON_AddBoolToObject(o, "dither", c.dither);
    cJSON_AddStringToObject(o, "power_on", power_on_name(c.power_on));
    return o;
}

bool led_config_merge_json(const cJSON* obj, LedConfig* inout, JsonError* err) {
    if (!cJSON_IsObject(obj)) return set_err(err, "", "expected an object"), false;
    LedConfig c = *inout;
    double v;
    bool present;
    if (!json_int(obj, "pixel_count", 1, 1024, &v, &present))
        return set_err(err, "pixel_count", "pixel_count must be 1-1024"), false;
    if (present) c.pixel_count = (uint16_t)v;
    if (!json_int(obj, "channels", 3, 4, &v, &present)) return set_err(err, "channels", "channels must be 3 or 4"), false;
    if (present) c.channels = (uint8_t)v;
    if (const cJSON* co = cJSON_GetObjectItemCaseSensitive(obj, "color_order")) {
        if (!cJSON_IsString(co) || !valid_color_order(co->valuestring) || std::strlen(co->valuestring) > 4)
            return set_err(err, "color_order", "color_order must be like RGB, GRB, BRG or GRBW"), false;
        std::snprintf(c.color_order, sizeof c.color_order, "%s", co->valuestring);
    }
    if (!json_int(obj, "max_current_ma", 100, 20000, &v, &present))
        return set_err(err, "max_current_ma", "max_current_ma must be 100-20000"), false;
    if (present) c.max_current_ma = (uint16_t)v;
    if (!json_int(obj, "ma_per_pixel_white", 1, 200, &v, &present))
        return set_err(err, "ma_per_pixel_white", "ma_per_pixel_white must be 1-200"), false;
    if (present) c.ma_per_pixel_white = (uint8_t)v;
    if (const cJSON* cc = cJSON_GetObjectItemCaseSensitive(obj, "color_correction")) {
        if (!cJSON_IsArray(cc) || cJSON_GetArraySize(cc) != 3)
            return set_err(err, "color_correction", "color_correction must be [r, g, b]"), false;
        for (int i = 0; i < 3; i++) {
            const cJSON* it = cJSON_GetArrayItem(cc, i);
            if (!cJSON_IsNumber(it) || it->valuedouble < 0 || it->valuedouble > 255)
                return set_err(err, "color_correction", "color_correction values must be 0-255"), false;
            c.color_correction[i] = (uint8_t)it->valuedouble;
        }
    }
    if (!json_int(obj, "fps", 10, 100, &v, &present)) return set_err(err, "fps", "fps must be 10-100"), false;
    if (present) c.fps = (uint8_t)v;
    if (const cJSON* d = cJSON_GetObjectItemCaseSensitive(obj, "dither")) {
        if (!cJSON_IsBool(d)) return set_err(err, "dither", "dither must be true or false"), false;
        c.dither = cJSON_IsTrue(d);
    }
    if (const char* po = json_str(obj, "power_on")) {
        if (!parse_power_on(po, &c.power_on))
            return set_err(err, "power_on", "power_on must be restore, on or off"), false;
    } else if (cJSON_GetObjectItemCaseSensitive(obj, "power_on")) {
        return set_err(err, "power_on", "power_on must be restore, on or off"), false;
    }
    uint8_t map[4], nbytes;
    color_order_map(c.color_order, map, &nbytes);
    if (nbytes != c.channels) return set_err(err, "color_order", "color_order must match channels"), false;
    *inout = c;
    return true;
}

cJSON* effects_to_json() {
    static const struct {
        uint16_t bit;
        const char* name;
    } uses[] = {
        {fx::USES_COLORS1, "colors1"}, {fx::USES_COLORS2, "colors2"},     {fx::USES_COLORS3, "colors3"},
        {fx::USES_SPEED, "speed"},     {fx::USES_INTENSITY, "intensity"}, {fx::USES_DURATION, "duration"},
    };
    cJSON* arr = cJSON_CreateArray();
    for (size_t i = 0; i < fx::effect_count(); i++) {
        const fx::EffectDesc& d = fx::effect_at(i);
        cJSON* o = cJSON_CreateObject();
        cJSON_AddStringToObject(o, "id", d.id);
        cJSON_AddStringToObject(o, "name", d.name);
        cJSON* u = cJSON_CreateArray();
        for (const auto& x : uses)
            if (d.uses & x.bit) cJSON_AddItemToArray(u, cJSON_CreateString(x.name));
        cJSON_AddItemToObject(o, "uses", u);
        cJSON_AddBoolToObject(o, "oneshot", d.oneshot);
        cJSON* def = cJSON_CreateObject();
        cJSON_AddNumberToObject(def, "speed", d.default_speed);
        cJSON_AddNumberToObject(def, "intensity", d.default_intensity);
        if (d.default_duration_ms) cJSON_AddNumberToObject(def, "duration_ms", (double)d.default_duration_ms);
        cJSON_AddItemToObject(o, "defaults", def);
        cJSON_AddItemToArray(arr, o);
    }
    return arr;
}

}  // namespace lc
