idf_component_register(SRCS "cloud.cpp" "claim.cpp"
                       INCLUDE_DIRS "include"
                       PRIV_REQUIRES lamp lamp_core effects led_output net ota json mbedtls esp_http_client
                                     esp_timer esp_system esp_driver_tsens log)
