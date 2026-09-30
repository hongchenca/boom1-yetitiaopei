if(PCA004_BENCH AND WEB_CLIENT)
    message(FATAL_ERROR "PCA004_BENCH and WEB_CLIENT are mutually exclusive")
endif()

if(PCA004_BENCH)
    foreach(required PCA004_SDA_GPIO PCA004_SCL_GPIO PCA004_OE_GPIO PCA004_I2C_ADDRESS)
        if(NOT DEFINED ${required} OR "${${required}}" STREQUAL "")
            message(FATAL_ERROR "PCA004_BENCH requires explicit ${required}")
        endif()
    endforeach()
    if(NOT "${PCA004_SDA_GPIO}" STREQUAL "8" OR
       NOT "${PCA004_SCL_GPIO}" STREQUAL "9" OR
       NOT "${PCA004_OE_GPIO}" STREQUAL "10")
        message(FATAL_ERROR "TASK-PCA-004 requires SDA=GPIO8, SCL=GPIO9, OE=GPIO10")
    endif()
    if(NOT "${PCA004_I2C_ADDRESS}" MATCHES "^0x[0-9A-Fa-f][0-9A-Fa-f]$")
        message(FATAL_ERROR "PCA004_I2C_ADDRESS must be an explicit 7-bit hexadecimal address")
    endif()
    math(EXPR pca004_address "${PCA004_I2C_ADDRESS}")
    if(pca004_address LESS 0x40 OR pca004_address GREATER 0x7f)
        message(FATAL_ERROR "PCA004_I2C_ADDRESS must be a PCA9685 strap address (0x40..0x7f)")
    endif()

    set(main_sources "pca004_bench.c")
elseif(WEB_CLIENT)
    set(main_sources "web_client.c")
else()
    set(main_sources "hello_world_main.c")
endif()

set(main_dependencies spi_flash esp_psram esp_driver_gpio esp_driver_i2c esp_driver_uart esp_timer)
if(WEB_CLIENT)
    list(APPEND main_dependencies esp_wifi esp_event esp_netif nvs_flash esp_http_client mbedtls lwip json)
endif()
idf_component_register(SRCS ${main_sources}
                       # Keep the web-client requirements explicit as well as in
                       # the list above.  ESP-IDF's dependency checker examines
                       # this registration and otherwise misses headers such as
                       # esp_crt_bundle.h when requirements are assembled only
                       # through a CMake variable.
                       PRIV_REQUIRES ${main_dependencies}
                                     esp_wifi esp_event esp_netif nvs_flash
                                     esp_http_client json mbedtls lwip
                       REQUIRES weight
                       INCLUDE_DIRS "")

if(PCA004_BENCH)
    target_compile_definitions(${COMPONENT_LIB} PRIVATE
                               PCA004_SDA_GPIO=${PCA004_SDA_GPIO}
                               PCA004_SCL_GPIO=${PCA004_SCL_GPIO}
                               PCA004_OE_GPIO=${PCA004_OE_GPIO}
                               PCA004_I2C_ADDRESS=${PCA004_I2C_ADDRESS})
endif()
