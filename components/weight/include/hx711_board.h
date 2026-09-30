#ifndef YETI_HX711_BOARD_H
#define YETI_HX711_BOARD_H

#include "driver/gpio.h"

#define HX711_BOARD_SCALE_COUNT 9
#define HX711_BOARD_MAIN_SCALE_ID 8

typedef struct {
    gpio_num_t dout_gpio;
    gpio_num_t sck_gpio;
} hx711_pin_pair_t;

// 下标 0..7 为原料称，8 为中心容器称。引脚编号是 ESP32-S3 模块 GPIO，
// 不是开发板插针编号；接线前需核对板卡引出与 3.3 V 逻辑电平。
extern const hx711_pin_pair_t hx711_board_pins[HX711_BOARD_SCALE_COUNT];

#endif
