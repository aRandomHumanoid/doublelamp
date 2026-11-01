# Pure C++ logic (state, codec, Apple Home mapping, setup codes, time sync). No IDF headers
# besides cJSON, so test/host compiles it on the PC.
idf_component_register(SRCS "state.cpp" "codec.cpp" "homekit_map.cpp" "misc.cpp"
                       INCLUDE_DIRS "include"
                       REQUIRES effects json)
