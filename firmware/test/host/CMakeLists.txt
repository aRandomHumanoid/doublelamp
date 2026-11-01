# Host unit tests for the pure C++ parts (08 §1.1): lamp_core + effects, plus the golden
# vector check. Needs a desktop C++17 compiler and IDF_PATH (for cJSON).
#   cmake -S firmware/test/host -B firmware/test/host/build -G Ninja && cmake --build firmware/test/host/build
#   ctest --test-dir firmware/test/host/build --output-on-failure
cmake_minimum_required(VERSION 3.16)
project(doublelamp_host_tests C CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

set(FW "${CMAKE_CURRENT_LIST_DIR}/../..")
if(DEFINED ENV{IDF_PATH})
    set(CJSON "$ENV{IDF_PATH}/components/json/cJSON")
else()
    message(FATAL_ERROR "Set IDF_PATH to your ESP-IDF checkout (the tests use its cJSON)")
endif()

add_library(core STATIC
    ${FW}/components/effects/effects.cpp
    ${FW}/components/effects/math8.cpp
    ${FW}/components/lamp_core/state.cpp
    ${FW}/components/lamp_core/codec.cpp
    ${FW}/components/lamp_core/homekit_map.cpp
    ${FW}/components/lamp_core/misc.cpp
    ${CJSON}/cJSON.c)
target_include_directories(core PUBLIC ${FW}/components/effects/include ${FW}/components/lamp_core/include ${CJSON})
if(NOT MSVC)
    target_compile_options(core PRIVATE $<$<COMPILE_LANGUAGE:CXX>:-Wall -Wextra>)
endif()

add_executable(test_lamp_core test_lamp_core.cpp)
target_link_libraries(test_lamp_core core)
add_executable(gen_vectors gen_vectors.cpp)
target_link_libraries(gen_vectors core)

enable_testing()
add_test(NAME lamp_core COMMAND test_lamp_core)
add_test(NAME golden_vectors_current
         COMMAND gen_vectors --check ${FW}/../packages/protocol/test-vectors/effects/golden.json)
