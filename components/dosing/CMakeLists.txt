idf_component_register(SRCS "dosing_controller.c" "dosing_service.c"
                       INCLUDE_DIRS "include"
                       REQUIRES actuator weight
                       PRIV_REQUIRES esp_timer freertos nvs_flash)
