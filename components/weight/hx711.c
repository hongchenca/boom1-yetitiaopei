#include "hx711.h"

#include "esp_rom_sys.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

// HX711 数据手册 V2.0：PD_SCK 高电平必须在 0.2～50 us，超过 60 us
// 会进入掉电模式。一次连续发送 25 个脉冲，选择下一次 A 通道/128 倍增益。
// 每次事务关中断，不允许调度在 SCK 高电平时将任务挂起。
static portMUX_TYPE s_clock_lock = portMUX_INITIALIZER_UNLOCKED;

/////////////////////////////////////////////////////////////////////////////
// 函数名：hx711_init
// 作用：初始化一组独立的 DOUT 输入和 SCK 输出，先锁定 SCK 为低电平。
// 参数1：device，驱动实例；参数2：dout_gpio，模块输出；参数3：sck_gpio，模块时钟输入。
// 用于：台架开始前配置已核实接线的一路 HX711。
// 使用示例：hx711_init(&scale, GPIO_NUM_1, GPIO_NUM_2);
/////////////////////////////////////////////////////////////////////////////
esp_err_t hx711_init(hx711_t *device, gpio_num_t dout_gpio, gpio_num_t sck_gpio) {
    if (!device || !GPIO_IS_VALID_GPIO(dout_gpio) ||
        !GPIO_IS_VALID_OUTPUT_GPIO(sck_gpio) || dout_gpio == sck_gpio ||
        device->initialized) {
        return ESP_ERR_INVALID_ARG;
    }
    gpio_config_t input = {
        .pin_bit_mask = 1ULL << dout_gpio, .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_DISABLE, .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    gpio_config_t output = {
        .pin_bit_mask = 1ULL << sck_gpio, .mode = GPIO_MODE_OUTPUT,
        .pull_up_en = GPIO_PULLUP_DISABLE, .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    esp_err_t err = gpio_config(&input);
    if (err != ESP_OK) return err;
    err = gpio_config(&output);
    if (err != ESP_OK) return err;
    err = gpio_set_level(sck_gpio, 0);
    if (err != ESP_OK) return err;
    device->dout_gpio = dout_gpio;
    device->sck_gpio = sck_gpio;
    device->initialized = true;
    return ESP_OK;
}

/////////////////////////////////////////////////////////////////////////////
// 函数名：hx711_read
// 作用：有界等待转换完成，并在连续 25 个时钟周期中读出 24 位有符号原始值。
// 参数1：device，已初始化实例；参数2：ready_timeout_ms，等待上限，0 表示只检查一次。
// 参数3：raw_count，仅在成功时写入；范围为 -8388608～8388607。
// 用于：采样任务读取原始 ADC 计数；未校准数据不可作为克数上传。
// 使用示例：hx711_read(&scale, 300, &raw); 300 ms 内等待读数。
/////////////////////////////////////////////////////////////////////////////
esp_err_t hx711_read(hx711_t *device, uint32_t ready_timeout_ms, int32_t *raw_count) {
    if (!device || !device->initialized || !raw_count) return ESP_ERR_INVALID_ARG;
    const int64_t started_us = esp_timer_get_time();
    while (gpio_get_level(device->dout_gpio) != 0) {
        if ((uint64_t)(esp_timer_get_time() - started_us) >= (uint64_t)ready_timeout_ms * 1000ULL)
            return ESP_ERR_TIMEOUT;
        vTaskDelay(1);
    }
    if (ready_timeout_ms != 0 &&
        (uint64_t)(esp_timer_get_time() - started_us) >= (uint64_t)ready_timeout_ms * 1000ULL)
        return ESP_ERR_TIMEOUT;
    uint32_t bits = 0;
    portENTER_CRITICAL(&s_clock_lock);
    if (gpio_get_level(device->dout_gpio) != 0) {
        portEXIT_CRITICAL(&s_clock_lock);
        return ESP_ERR_INVALID_STATE;
    }
    for (unsigned i = 0; i < 24; ++i) {
        gpio_set_level(device->sck_gpio, 1);
        esp_rom_delay_us(1); // T2 最长 0.1 us，在高电平稳定后取样。
        bits = (bits << 1) | (uint32_t)gpio_get_level(device->dout_gpio);
        gpio_set_level(device->sck_gpio, 0);
        esp_rom_delay_us(1);
    }
    gpio_set_level(device->sck_gpio, 1);
    esp_rom_delay_us(1);
    gpio_set_level(device->sck_gpio, 0);
    portEXIT_CRITICAL(&s_clock_lock);
    *raw_count = (int32_t)bits - ((bits & 0x800000u) ? 0x1000000 : 0);
    return ESP_OK;
}

/////////////////////////////////////////////////////////////////////////////
// 函数名：hx711_deinit
// 作用：停止采样时保持 PD_SCK 低电平，不让模块时钟输入浮空。
// 参数1：device，已初始化实例。
// 用于：台架切换针脚或停止采样时释放该驱动。
// 使用示例：hx711_deinit(&scale);
/////////////////////////////////////////////////////////////////////////////
esp_err_t hx711_deinit(hx711_t *device) {
    if (!device || !device->initialized) return ESP_ERR_INVALID_ARG;
    esp_err_t err = gpio_set_level(device->sck_gpio, 0);
    if (err == ESP_OK) device->initialized = false;
    return err;
}
