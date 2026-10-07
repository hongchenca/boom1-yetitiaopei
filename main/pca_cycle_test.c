/* PCA9685 CH0 full-on/full-off cycle test for a physically verified bench setup. */

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "driver/gpio.h"
#include "driver/i2c_master.h"
#include "esp_err.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#ifndef PCA004_SDA_GPIO
#define PCA004_SDA_GPIO 8
#endif
#ifndef PCA004_SCL_GPIO
#define PCA004_SCL_GPIO 9
#endif
#ifndef PCA004_OE_GPIO
#define PCA004_OE_GPIO 10
#endif
#ifndef PCA004_I2C_ADDRESS
#define PCA004_I2C_ADDRESS 0x40
#endif

#define PCA004_I2C_SPEED_HZ 100000
#define PCA004_TIMEOUT_MS 100
#define PCA004_CYCLE_MS 5000
#define PCA_MODE1 0x00u
#define PCA_MODE2 0x01u
#define PCA_MODE1_AI 0x20u
#define PCA_MODE1_EXTCLK 0x40u
#define PCA_MODE1_RESTART 0x80u
#define PCA_MODE2_OUTDRV 0x04u
#define PCA_LED0_ON_L 0x06u
#define PCA_FULL_ON_BIT 0x10u
#define PCA_FULL_OFF_BIT 0x10u

static const char *TAG = "pca_cycle";

/////////////////////////////////////////////////////////////////////////////
// 函数名：pca_write_registers
// 作用：写入并回读校验 1~4 字节；连续访问前必须启用 MODE1.AI。
// 参数1：device，已创建的 PCA9685 I2C 设备句柄。
// 参数2：register_address，首个寄存器地址。
// 参数3：data，待写入的数据缓冲区。
// 参数4：length，数据字节数，范围为 1~4。
// 用于：初始化全部通道为关断状态，以及切换 CH0 的全开/全关状态。
// 使用示例：pca_write_registers(device, PCA_LED0_ON_L, values, 4)。
/////////////////////////////////////////////////////////////////////////////
static esp_err_t pca_write_registers(i2c_master_dev_handle_t device,
                                    uint8_t register_address,
                                    const uint8_t *data,
                                    size_t length)
{
    if (data == NULL || length == 0 || length > 4) {
        return ESP_ERR_INVALID_ARG;
    }

    uint8_t transaction[5] = {0};
    transaction[0] = register_address;
    for (size_t index = 0; index < length; ++index) {
        transaction[index + 1] = data[index];
    }
    esp_err_t error = i2c_master_transmit(device, transaction, length + 1,
                                        PCA004_TIMEOUT_MS);
    if (error != ESP_OK) {
        return error;
    }
    uint8_t readback[4] = {0};
    error = i2c_master_transmit_receive(device, &register_address, 1,
                                       readback, length, PCA004_TIMEOUT_MS);
    if (error != ESP_OK) {
        return error;
    }
    for (size_t index = 0; index < length; ++index) {
        /* RESTART 为硬件状态/命令位，写 0 不会清除；只核对 MODE1 配置位。 */
        const uint8_t mask = (register_address + index == PCA_MODE1)
                                 ? (uint8_t)~PCA_MODE1_RESTART : 0xffu;
        if ((readback[index] & mask) != (data[index] & mask)) {
            ESP_LOGE(TAG, "register 0x%02x: expected=0x%02x readback=0x%02x",
                     (unsigned)(register_address + index), data[index], readback[index]);
            return ESP_FAIL;
        }
    }
    return ESP_OK;
}

/////////////////////////////////////////////////////////////////////////////
// 函数名：pca_read_register
// 作用：读取 PCA9685 的单字节寄存器。
// 参数1：device，已创建的 PCA9685 I2C 设备句柄。
// 参数2：register_address，待读取的寄存器地址。
// 参数3：value，接收寄存器值的输出指针。
// 用于：输出切换前记录 MODE1/MODE2，确认设备响应正常。
// 使用示例：pca_read_register(device, PCA_MODE1, &mode1)。
/////////////////////////////////////////////////////////////////////////////
static esp_err_t pca_read_register(i2c_master_dev_handle_t device,
                                  uint8_t register_address,
                                  uint8_t *value)
{
    return i2c_master_transmit_receive(device, &register_address, 1, value, 1,
                                      PCA004_TIMEOUT_MS);
}

/////////////////////////////////////////////////////////////////////////////
// 函数名：pca_all_channels_off
// 作用：将 PCA9685 的 16 个通道写入 FULL_OFF，避免遗留输出在测试开始时导通。
// 参数1：device，已创建的 PCA9685 I2C 设备句柄。
// 用于：OE 仍处于禁能状态时的启动初始化。
// 使用示例：pca_all_channels_off(device)。
/////////////////////////////////////////////////////////////////////////////
static esp_err_t pca_all_channels_off(i2c_master_dev_handle_t device)
{
    const uint8_t off_values[4] = {0x00, 0x00, 0x00, PCA_FULL_OFF_BIT};
    for (uint8_t channel = 0; channel < 16; ++channel) {
        esp_err_t error = pca_write_registers(device,
                                             (uint8_t)(PCA_LED0_ON_L + channel * 4),
                                             off_values, sizeof(off_values));
        if (error != ESP_OK) {
            ESP_LOGE(TAG, "FULL_OFF CH%u failed: %s", channel, esp_err_to_name(error));
            return error;
        }
    }
    return ESP_OK;
}

/////////////////////////////////////////////////////////////////////////////
// 函数名：pca_set_ch0_state
// 作用：设置并回读校验第一个通道 CH0 为全导通或全关断。
// 参数1：device，已创建的 PCA9685 I2C 设备句柄。
// 参数2：enabled，true 表示 FULL_ON，false 表示 FULL_OFF。
// 用于：按 5 秒保持时间交替驱动真实硬件的第一个 PCA 通道。
// 使用示例：pca_set_ch0_state(device, true)。
/////////////////////////////////////////////////////////////////////////////
static esp_err_t pca_set_ch0_state(i2c_master_dev_handle_t device, bool enabled)
{
    const uint8_t values[4] = {
        0x00,
        enabled ? PCA_FULL_ON_BIT : 0x00,
        0x00,
        enabled ? 0x00 : PCA_FULL_OFF_BIT,
    };
    return pca_write_registers(device, PCA_LED0_ON_L, values, sizeof(values));
}

/////////////////////////////////////////////////////////////////////////////
// 函数名：app_main
// 作用：初始化 PCA9685，并让 CH0 以“导通 5 秒、关断 5 秒”持续循环。
// 参数：无。
// 用于：真实硬件台架测试；仅在显式启用 PCA004_CYCLE 固件时执行。
// 使用示例：通过 PCA004_CYCLE=ON 构建后烧录，复位即可开始循环。
/////////////////////////////////////////////////////////////////////////////
void app_main(void)
{
    i2c_master_bus_handle_t bus = NULL;
    i2c_master_dev_handle_t device = NULL;
    esp_err_t operation_error = ESP_OK;
    esp_err_t cleanup_error = ESP_OK;
    bool oe_configured = false;
    esp_err_t oe_disable_error = ESP_OK;
    bool pca_initialized = false;
    uint8_t mode1 = 0;
    uint8_t mode2 = 0;
    uint32_t cycle = 0;

    const gpio_config_t oe_config = {
        .pin_bit_mask = 1ULL << PCA004_OE_GPIO,
        .mode = GPIO_MODE_OUTPUT,
        .pull_up_en = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    const i2c_master_bus_config_t bus_config = {
        .i2c_port = I2C_NUM_0,
        .sda_io_num = PCA004_SDA_GPIO,
        .scl_io_num = PCA004_SCL_GPIO,
        .clk_source = I2C_CLK_SRC_DEFAULT,
        .glitch_ignore_cnt = 7,
        .flags.enable_internal_pullup = false,
    };
    const i2c_device_config_t device_config = {
        .dev_addr_length = I2C_ADDR_BIT_LEN_7,
        .device_address = PCA004_I2C_ADDRESS,
        .scl_speed_hz = PCA004_I2C_SPEED_HZ,
    };

    /* 先预置输出锁存为高，再启用输出，避免 OE 在配置瞬间出现低电平。 */
    operation_error = gpio_set_level(PCA004_OE_GPIO, 1);
    if (operation_error != ESP_OK) {
        ESP_LOGE(TAG, "preload OE high failed: %s", esp_err_to_name(operation_error));
        return;
    }
    operation_error = gpio_config(&oe_config);
    if (operation_error != ESP_OK) {
        ESP_LOGE(TAG, "configure OE GPIO%d failed: %s", PCA004_OE_GPIO,
                 esp_err_to_name(operation_error));
        return;
    }
    oe_configured = true;

    operation_error = gpio_set_level(PCA004_OE_GPIO, 1);
    if (operation_error != ESP_OK) {
        ESP_LOGE(TAG, "disable PCA outputs through OE failed: %s",
                 esp_err_to_name(operation_error));
        goto cleanup;
    }

    ESP_LOGI(TAG,
             "CH0 cycle test: SDA=GPIO%d SCL=GPIO%d OE=GPIO%d address=0x%02x; "
             "conduct 5 s, cutoff 5 s",
             PCA004_SDA_GPIO, PCA004_SCL_GPIO, PCA004_OE_GPIO, PCA004_I2C_ADDRESS);

    operation_error = i2c_new_master_bus(&bus_config, &bus);
    if (operation_error != ESP_OK) {
        ESP_LOGE(TAG, "create I2C bus failed: %s", esp_err_to_name(operation_error));
        goto cleanup;
    }

    operation_error = i2c_master_bus_add_device(bus, &device_config, &device);
    if (operation_error != ESP_OK) {
        ESP_LOGE(TAG, "add PCA9685 device failed: %s", esp_err_to_name(operation_error));
        goto cleanup;
    }

    operation_error = i2c_master_probe(bus, PCA004_I2C_ADDRESS, PCA004_TIMEOUT_MS);
    if (operation_error != ESP_OK) {
        ESP_LOGE(TAG, "probe PCA9685 address 0x%02x failed: %s", PCA004_I2C_ADDRESS,
                 esp_err_to_name(operation_error));
        goto cleanup;
    }
    ESP_LOGI(TAG, "address probe 0x%02x: ACK", PCA004_I2C_ADDRESS);

    operation_error = pca_read_register(device, PCA_MODE1, &mode1);
    if (operation_error != ESP_OK) {
        ESP_LOGE(TAG, "read MODE1 failed: %s", esp_err_to_name(operation_error));
        goto cleanup;
    }
    operation_error = pca_read_register(device, PCA_MODE2, &mode2);
    if (operation_error != ESP_OK) {
        ESP_LOGE(TAG, "read MODE2 failed: %s", esp_err_to_name(operation_error));
        goto cleanup;
    }
    ESP_LOGI(TAG, "initial MODE1=0x%02x MODE2=0x%02x", mode1, mode2);

    /* EXTCLK 是粘滞位，不能靠普通寄存器写入切回内部时钟。 */
    if ((mode1 & PCA_MODE1_EXTCLK) != 0) {
        ESP_LOGE(TAG, "external clock mode detected; power-cycle PCA9685 before this test");
        operation_error = ESP_ERR_INVALID_STATE;
        goto cleanup;
    }
    /* 通道的四字节突发写依赖 AI；禁用反相和组地址，唤醒内部振荡器。 */
    mode1 = PCA_MODE1_AI;
    operation_error = pca_write_registers(device, PCA_MODE1, &mode1, 1);
    if (operation_error != ESP_OK) {
        ESP_LOGE(TAG, "configure MODE1 failed: %s", esp_err_to_name(operation_error));
        goto cleanup;
    }
    vTaskDelay(pdMS_TO_TICKS(10) + 1);  /* 唤醒后至少等待 500 us。 */
    mode2 = PCA_MODE2_OUTDRV;  /* 推挽、非反相、STOP 生效，OE 高时输出低。 */
    operation_error = pca_write_registers(device, PCA_MODE2, &mode2, 1);
    if (operation_error != ESP_OK) {
        ESP_LOGE(TAG, "configure MODE2 failed: %s", esp_err_to_name(operation_error));
        goto cleanup;
    }
    ESP_LOGI(TAG, "configuration verified: MODE1=0x%02x (RESTART ignored) MODE2=0x%02x",
             mode1, mode2);

    operation_error = pca_all_channels_off(device);
    if (operation_error != ESP_OK) {
        goto cleanup;
    }
    pca_initialized = true;
    ESP_LOGI(TAG, "all 16 channels FULL_OFF; register readback PASS");

    operation_error = gpio_set_level(PCA004_OE_GPIO, 0);
    if (operation_error != ESP_OK) {
        ESP_LOGE(TAG, "enable PCA outputs through OE failed: %s",
                 esp_err_to_name(operation_error));
        goto cleanup;
    }

    for (;;) {
        operation_error = pca_set_ch0_state(device, true);
        if (operation_error != ESP_OK) {
            ESP_LOGE(TAG, "cycle %lu CH0 FULL_ON failed: %s", (unsigned long)cycle,
                     esp_err_to_name(operation_error));
            goto cleanup;
        }
        ESP_LOGI(TAG, "cycle %lu: CH0 ON for %d ms; readback=00,10,00,00 PASS", (unsigned long)cycle,
                 PCA004_CYCLE_MS);
        vTaskDelay(pdMS_TO_TICKS(PCA004_CYCLE_MS));

        operation_error = pca_set_ch0_state(device, false);
        if (operation_error != ESP_OK) {
            ESP_LOGE(TAG, "cycle %lu CH0 FULL_OFF failed: %s", (unsigned long)cycle,
                     esp_err_to_name(operation_error));
            goto cleanup;
        }
        ESP_LOGI(TAG, "cycle %lu: CH0 OFF for %d ms; readback=00,00,00,10 PASS", (unsigned long)cycle,
                 PCA004_CYCLE_MS);
        ++cycle;
        vTaskDelay(pdMS_TO_TICKS(PCA004_CYCLE_MS));
    }

cleanup:
    /* 先禁止 PCA 输出，再做总线寄存器收尾，避免故障路径继续驱动外部节点。 */
    if (oe_configured) {
        oe_disable_error = gpio_set_level(PCA004_OE_GPIO, 1);
    }
    if (device != NULL) {
        if (pca_initialized) {
            esp_err_t error = pca_set_ch0_state(device, false);
            if (error != ESP_OK && cleanup_error == ESP_OK) {
                cleanup_error = error;
            }
        }
        esp_err_t error = i2c_master_bus_rm_device(device);
        if (error != ESP_OK && cleanup_error == ESP_OK) {
            cleanup_error = error;
        }
    }
    if (bus != NULL) {
        esp_err_t error = i2c_del_master_bus(bus);
        if (error != ESP_OK && cleanup_error == ESP_OK) {
            cleanup_error = error;
        }
    }
    ESP_LOGE(TAG, "test stopped: operation=%s cleanup=%s OE_disable=%s",
             esp_err_to_name(operation_error), esp_err_to_name(cleanup_error),
             esp_err_to_name(oe_disable_error));
}
