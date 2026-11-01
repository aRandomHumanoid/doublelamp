# Pure C++ effects: no IDF dependencies, also compiled by test/host.
idf_component_register(SRCS "effects.cpp" "math8.cpp"
                       INCLUDE_DIRS "include")
