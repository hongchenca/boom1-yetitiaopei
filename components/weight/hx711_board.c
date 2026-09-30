#include "hx711_board.h"

// 保留 GPIO13 给未来功率故障输入，与 Arduino 示例中的 SCK=13 不同。
// GPIO39..42 与外部 JTAG 冲突，项目已决定把它们分配给称重；如需
// 外部 JTAG 或开发板占用 GPIO47，必须先重排针脚再接入这些模块。
const hx711_pin_pair_t hx711_board_pins[HX711_BOARD_SCALE_COUNT] = {
    { GPIO_NUM_1, GPIO_NUM_2 },   // 原料称 0
    { GPIO_NUM_4, GPIO_NUM_5 },   // 原料称 1
    { GPIO_NUM_6, GPIO_NUM_7 },   // 原料称 2
    { GPIO_NUM_14, GPIO_NUM_15 }, // 原料称 3
    { GPIO_NUM_16, GPIO_NUM_17 }, // 原料称 4
    { GPIO_NUM_18, GPIO_NUM_21 }, // 原料称 5
    { GPIO_NUM_39, GPIO_NUM_38 }, // 原料称 6
    { GPIO_NUM_41, GPIO_NUM_40 }, // 原料称 7
    { GPIO_NUM_42, GPIO_NUM_47 }, // 中央容器称 8
};
