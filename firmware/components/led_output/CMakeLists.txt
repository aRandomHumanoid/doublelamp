idf_component_register(SRCS "render.cpp"
                       INCLUDE_DIRS "include"
                       REQUIRES effects lamp_core
                       PRIV_REQUIRES lamp esp_timer esp_system esp_driver_spi esp_driver_rmt)
