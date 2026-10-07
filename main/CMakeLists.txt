if(PCA004_BENCH AND PCA004_CYCLE)
    message(FATAL_ERROR "PCA004_BENCH and PCA004_CYCLE are mutually exclusive")
endif()
if(PCA004_BENCH AND WEB_CLIENT)
    message(FATAL_ERROR "PCA004_BENCH and WEB_CLIENT are mutually exclusive")
endif()
if(PCA004_CYCLE AND WEB_CLIENT)
    message(FATAL_ERROR "PCA004_CYCLE and WEB_CLIENT are mutually exclusive")
endif()

if(WEB_CLIENT AND PUMP_CONTROL)
    if(OUTLET_CONTROL AND NOT PUMP_PWM_HZ EQUAL 50)
        message(FATAL_ERROR "OUTLET_CONTROL requires shared PUMP_PWM_HZ=50; override an old build cache explicitly")
    endif()
    if(NOT "${PUMP_MIN_PERCENT}" MATCHES "^[1-9][0-9]*$" OR PUMP_MIN_PERCENT LESS 40 OR PUMP_MIN_PERCENT GREATER PUMP_MAX_PERCENT)
        message(FATAL_ERROR "PUMP_MIN_PERCENT must be 40..PUMP_MAX_PERCENT")
    endif()
    if(NOT "${PUMP_PWM_HZ}" MATCHES "^[1-9][0-9]*$" OR
       PUMP_PWM_HZ LESS 40 OR PUMP_PWM_HZ GREATER 1000)
        message(FATAL_ERROR "PUMP_PWM_HZ must be 40..1000 Hz")
    endif()
    if(NOT "${PUMP_MAX_PERCENT}" MATCHES "^[1-9][0-9]*$" OR
       PUMP_MAX_PERCENT LESS 1 OR PUMP_MAX_PERCENT GREATER 100)
        message(FATAL_ERROR "PUMP_MAX_PERCENT must be 1..100")
    endif()
endif()

if(PCA004_BENCH OR PCA004_CYCLE)
    foreach(required PCA004_SDA_GPIO PCA004_SCL_GPIO PCA004_OE_GPIO PCA004_I2C_ADDRESS)
        if(NOT DEFINED ${required} OR "${${required}}" STREQUAL "")
            message(FATAL_ERROR "PCA004_BENCH/PCA004_CYCLE requires explicit ${required}")
        endif()
    endforeach()
    if(NOT "${PCA004_SDA_GPIO}" STREQUAL "8" OR
       NOT "${PCA004_SCL_GPIO}" STREQUAL "9" OR
       NOT "${PCA004_OE_GPIO}" STREQUAL "10")
        message(FATAL_ERROR "PCA004_BENCH/PCA004_CYCLE requires SDA=GPIO8, SCL=GPIO9, OE=GPIO10")
    endif()
    if(NOT "${PCA004_I2C_ADDRESS}" MATCHES "^0x[0-9A-Fa-f][0-9A-Fa-f]$")
        message(FATAL_ERROR "PCA004_I2C_ADDRESS must be an explicit 7-bit hexadecimal address")
    endif()
    math(EXPR pca004_address "${PCA004_I2C_ADDRESS}")
    if(pca004_address LESS 0x40 OR pca004_address GREATER 0x7f)
        message(FATAL_ERROR "PCA004_I2C_ADDRESS must be a PCA9685 strap address (0x40..0x7f)")
    endif()
endif()

if(PCA004_BENCH)
    set(main_sources "pca004_bench.c")
elseif(PCA004_CYCLE)
    set(main_sources "pca_cycle_test.c")
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
                       REQUIRES weight actuator dosing
                       INCLUDE_DIRS "")

if(WEB_CLIENT AND HX711_SCALE1)
    if(NOT "${HX711_ENABLED_MASK}" MATCHES "^[1-9][0-9]*$" OR HX711_ENABLED_MASK GREATER 511)
        message(FATAL_ERROR "HX711_ENABLED_MASK must be 1..511")
    endif()
    target_compile_definitions(${COMPONENT_LIB} PRIVATE WEB_CLIENT_HX711_SCALE1=1 HX711_ENABLED_MASK=${HX711_ENABLED_MASK})
endif()

if(WEB_CLIENT AND PUMP_CONTROL)
    target_compile_definitions(${COMPONENT_LIB} PRIVATE WEB_CLIENT_PUMP_CONTROL=1
                               PUMP_PWM_HZ=${PUMP_PWM_HZ}
                               PUMP_MIN_PERCENT=${PUMP_MIN_PERCENT}
                               PUMP_MAX_PERCENT=${PUMP_MAX_PERCENT})
    if(OUTLET_CONTROL)
        target_compile_definitions(${COMPONENT_LIB} PRIVATE WEB_CLIENT_OUTLET_CONTROL=1)
    endif()
endif()

if(PCA004_BENCH OR PCA004_CYCLE)
    target_compile_definitions(${COMPONENT_LIB} PRIVATE
                               PCA004_SDA_GPIO=${PCA004_SDA_GPIO}
                               PCA004_SCL_GPIO=${PCA004_SCL_GPIO}
                               PCA004_OE_GPIO=${PCA004_OE_GPIO}
                               PCA004_I2C_ADDRESS=${PCA004_I2C_ADDRESS})
endif()
