idf_component_register(SRCS "hub.cpp" "settings.cpp" "status.cpp" "clock.cpp" "identity.cpp" "log_ring.cpp"
                       INCLUDE_DIRS "include"
                       REQUIRES lamp_core effects storage json
                       PRIV_REQUIRES esp_timer esp_app_format esp_hw_support mbedtls log)
