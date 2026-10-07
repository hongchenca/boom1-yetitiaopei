# The following lines of boilerplate have to be in your project's
# CMakeLists in this exact order for cmake to work correctly
cmake_minimum_required(VERSION 3.16)

# The normal project build is the ESP32 web-client firmware. Keep the options
# overridable from the command line for the PCA004 bench target and CI jobs.
option(WEB_CLIENT "Build the ESP32 web-client firmware" ON)
option(PCA004_BENCH "Build the PCA004 bench firmware" OFF)
option(PCA004_CYCLE "Build the PCA9685 CH0 5-second cycle test firmware" OFF)
option(PUMP_CONTROL "Enable eight pump outputs in the web-client firmware" ON)
option(HX711_SCALE1 "Enable HX711 weighing service (legacy option name)" ON)
set(HX711_ENABLED_MASK "511" CACHE STRING "Enabled HX711 channels bit0..8 (1..511)")
set(PUMP_PWM_HZ "50" CACHE STRING "Shared PCA9685 PWM frequency (50 Hz with outlet servo)")
set(PUMP_MAX_PERCENT "100" CACHE STRING "Maximum pump duty percent (1..100)")
set(PUMP_MIN_PERCENT "40" CACHE STRING "Minimum effective liquid pump duty percent")
option(OUTLET_CONTROL "Enable CH8 air pump and CH9 500..2500 us servo" ON)

include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(yetitiaopei)
