// NVS wrapper (03 §13). Every blob is stored as {u8 schema, u16 len} + data + CRC-16, and a
// load falls back to the caller's defaults if the schema, length or CRC doesn't match.
#pragma once

#include <cstddef>
#include <cstdint>

#include "esp_err.h"

namespace storage {

esp_err_t init();

bool load_blob(const char* ns, const char* key, uint8_t schema, void* data, size_t len);
bool save_blob(const char* ns, const char* key, uint8_t schema, const void* data, size_t len);

bool load_str(const char* ns, const char* key, char* out, size_t cap);
bool save_str(const char* ns, const char* key, const char* value);

bool load_u32(const char* ns, const char* key, uint32_t* out);
bool save_u32(const char* ns, const char* key, uint32_t value);

bool erase_key(const char* ns, const char* key);
bool erase_namespace(const char* ns);

/** Factory reset: erases the whole NVS partition (WiFi, settings, Apple Home pairings). */
void erase_all();

}  // namespace storage
