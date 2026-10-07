idf_component_register(SRCS "actuator.c"
                       INCLUDE_DIRS "include"
                       REQUIRES esp_common
                       PRIV_REQUIRES esp_driver_gpio esp_driver_i2c esp_timer freertos)
