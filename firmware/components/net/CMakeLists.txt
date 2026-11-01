idf_component_register(SRCS "wifi.cpp" "captive_dns.cpp" "services.cpp"
                       INCLUDE_DIRS "include"
                       PRIV_REQUIRES lamp lamp_core led_output esp_wifi esp_netif esp_event esp_timer lwip log)
