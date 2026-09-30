# The following lines of boilerplate have to be in your project's
# CMakeLists in this exact order for cmake to work correctly
cmake_minimum_required(VERSION 3.16)

# The normal project build is the ESP32 web-client firmware. Keep the options
# overridable from the command line for the PCA004 bench target and CI jobs.
option(WEB_CLIENT "Build the ESP32 web-client firmware" ON)
option(PCA004_BENCH "Build the PCA004 bench firmware" OFF)

include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(yetitiaopei)
