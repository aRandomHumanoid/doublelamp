cmake_minimum_required(VERSION 3.16)

# Firmware version (SemVer). OTA compares it to refuse downgrades (03 §15).
set(PROJECT_VER "1.0.0")

# Apple Home: Espressif's open-source esp-homekit-sdk (non-MFi), checked out at
# third_party/esp-homekit-sdk (see docs/09-bring-up.md). Without it the firmware builds
# without Apple Home and says so in the build log.
set(HOMEKIT_SDK_PATH "${CMAKE_CURRENT_LIST_DIR}/third_party/esp-homekit-sdk" CACHE PATH "esp-homekit-sdk checkout")
if(EXISTS "${HOMEKIT_SDK_PATH}/components/homekit/esp_hap_core")
    set(EXTRA_COMPONENT_DIRS "${HOMEKIT_SDK_PATH}/components/homekit")
    set(LAMP_HAVE_HOMEKIT_SDK 1)
    message(STATUS "DoubleLamp: building with Apple Home (${HOMEKIT_SDK_PATH})")
else()
    set(LAMP_HAVE_HOMEKIT_SDK 0)
    message(WARNING "DoubleLamp: esp-homekit-sdk not found at ${HOMEKIT_SDK_PATH}; building WITHOUT Apple Home. "
                    "Run: git submodule add https://github.com/espressif/esp-homekit-sdk.git firmware/third_party/esp-homekit-sdk")
endif()

include($ENV{IDF_PATH}/tools/cmake/project.cmake)
idf_build_set_property(LAMP_HAVE_HOMEKIT_SDK ${LAMP_HAVE_HOMEKIT_SDK})
project(doublelamp)
