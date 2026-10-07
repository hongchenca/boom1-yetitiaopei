idf_component_register(SRCS "hx711.c" "hx711_board.c" "weight_service.c"
                       INCLUDE_DIRS "include"
                       REQUIRES esp_driver_gpio
                       PRIV_REQUIRES esp_timer esp_rom freertos nvs_flash)
