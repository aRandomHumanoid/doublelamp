idf_component_register(SRCS "server.cpp" "routes.cpp" "ws.cpp" "setup.cpp"
                       INCLUDE_DIRS "include"
                       PRIV_REQUIRES lamp lamp_core storage led_output net ota cloud_link homekit device_ui
                                     esp_http_server json esp_timer esp_system log)
