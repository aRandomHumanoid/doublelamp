// The lamp's built-in UI: one gzipped HTML file built from /device-ui and embedded in the image.
#pragma once

#include <cstddef>
#include <cstdint>

namespace device_ui {

const uint8_t* index_gz(size_t* len);

}  // namespace device_ui
