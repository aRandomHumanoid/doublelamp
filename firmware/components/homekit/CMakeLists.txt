# With esp-homekit-sdk (firmware/third_party/esp-homekit-sdk) this is the real accessory;
# without it, a stub so the rest of the firmware still builds.
idf_build_get_property(have_hk LAMP_HAVE_HOMEKIT_SDK)
if(have_hk)
    idf_component_register(SRCS "homekit.cpp" "setup_code.cpp"
                           INCLUDE_DIRS "include"
                           PRIV_REQUIRES lamp lamp_core storage led_output net esp_hap_core esp_hap_apple_profiles log)
else()
    idf_component_register(SRCS "homekit_stub.cpp" "setup_code.cpp"
                           INCLUDE_DIRS "include"
                           PRIV_REQUIRES lamp lamp_core storage log)
endif()
