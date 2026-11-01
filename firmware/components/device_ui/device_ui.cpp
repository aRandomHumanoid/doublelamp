#include "device_ui/device_ui.hpp"

extern const uint8_t index_html_gz_start[] asm("_binary_index_html_gz_start");
extern const uint8_t index_html_gz_end[] asm("_binary_index_html_gz_end");

namespace device_ui {

const uint8_t* index_gz(size_t* len) {
    *len = (size_t)(index_html_gz_end - index_html_gz_start);
    return index_html_gz_start;
}

}  // namespace device_ui
