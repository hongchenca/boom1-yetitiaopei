#ifndef YETI_HX711_H
#define YETI_HX711_H

#include <stdbool.h>
#include <stdint.h>
#include "driver/gpio.h"
#include "esp_err.h"

typedef struct {
    gpio_num_t dout_gpio;
    gpio_num_t sck_gpio;
    bool initialized; // 创建时以 {0} 清零，禁止未初始化的栈对象。
} hx711_t;

// 初始化单路 HX711：DOUT 必须是 3.3 V 兼容输入，SCK 为独立输出。
// 只选择 A 通道 128 倍增益；不执行去皮、校准或重量换算。
esp_err_t hx711_init(hx711_t *device, gpio_num_t dout_gpio, gpio_num_t sck_gpio);

// 在至多 ready_timeout_ms 毫秒内等待 DOUT 变低，再读取一个有符号
// 24 位原始计数；超时返回 ESP_ERR_TIMEOUT，不修改 raw_count。
// 25 个时钟后 DOUT 未恢复高电平则返回 ESP_ERR_INVALID_RESPONSE。
// 同一设备只能由一个任务读取；不同设备内部时钟事务互斥。
esp_err_t hx711_read(hx711_t *device, uint32_t ready_timeout_ms, int32_t *raw_count);

// 停止采样时保持 SCK 低电平，避免浮空导致意外掉电；
// 之后若需要复用 GPIO，再由上层显式重新配置。
esp_err_t hx711_deinit(hx711_t *device);

#endif
