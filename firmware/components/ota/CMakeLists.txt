idf_component_register(SRCS "ota.cpp"
                       INCLUDE_DIRS "include"
                       REQUIRES app_update mbedtls
                       PRIV_REQUIRES lamp storage led_output esp_http_client esp_app_format bootloader_support esp_timer esp_system log)
