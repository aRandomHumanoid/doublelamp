// JSON encode/decode for the protocol objects (04 §2), using cJSON. Unknown fields are ignored;
// values out of range are rejected and nothing is partly applied.
#pragma once

#include "cJSON.h"
#include "lamp_core/state.hpp"

namespace lc {

struct JsonError {
    const char* code = "invalid";  // "invalid" | "unknown_effect"
    char field[32] = {0};
    char message[80] = {0};
};

/** "#RRGGBB" */
void color_hex(RGB8 c, char out[8]);

cJSON* state_to_json(const LampState& s);
/** A patch object holding the given fields of `s` (the effect is always written whole). */
cJSON* fields_to_json(const LampState& s, FieldMask fields);
bool patch_from_json(const cJSON* obj, Patch* out, JsonError* err);
/** Requires every field. */
bool state_from_json(const cJSON* obj, LampState* out, JsonError* err);

cJSON* led_config_to_json(const LedConfig& c);
/** Applies the fields present in `obj` onto `inout` (partial update). */
bool led_config_merge_json(const cJSON* obj, LedConfig* inout, JsonError* err);

/** The effect catalog as EffectDesc[] (04 §2). */
cJSON* effects_to_json();

/** Reads an integer field; false if present but not an integer in [lo, hi]. */
bool json_int(const cJSON* obj, const char* key, double lo, double hi, double* out, bool* present);
/** Returns the string value of obj[key] or nullptr. */
const char* json_str(const cJSON* obj, const char* key);

/** Prints compactly into a newly malloc'd string. Caller frees with cJSON_free. */
char* json_print(const cJSON* obj);

}  // namespace lc
