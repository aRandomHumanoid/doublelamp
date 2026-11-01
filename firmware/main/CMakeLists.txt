idf_component_register(SRCS "app_main.cpp"
                       REQUIRES lamp lamp_core storage led_output net local_api cloud_link ota input homekit
                                esp_system esp_timer nvs_flash app_update)
