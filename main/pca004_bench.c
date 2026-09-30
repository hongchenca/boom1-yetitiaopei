/* TASK-PCA-005: one-shot, read-only PCA9685 I2C communication test. */

#include <stdbool.h>
#include <stdint.h>
#include <stddef.h>

#include "driver/i2c_master.h"
#include "esp_err.h"
#include "esp_log.h"

#ifndef PCA004_SDA_GPIO
#define PCA004_SDA_GPIO       8
#endif
#ifndef PCA004_SCL_GPIO
#define PCA004_SCL_GPIO       9
#endif
#ifndef PCA004_I2C_ADDRESS
#define PCA004_I2C_ADDRESS    0x40
#endif
#define PCA004_I2C_SPEED_HZ   100000
#define PCA004_TIMEOUT_MS     100

#define PCA_MODE1             0x00u
#define PCA_MODE2             0x01u
#define PCA_PRE_SCALE         0xfeu
#define PCA_ALL_LED_OFF_H     0xfdu
/* LED15_OFF_H = LED0_ON_L + 15*4 + OFF_H = 0x06 + 15*4 + 3 = 0x45. */
#define PCA_LED15_OFF_H       0x45u

static const char *TAG = "pca005";

static esp_err_t pca_read_register(i2c_master_dev_handle_t device, uint8_t reg, uint8_t *value)
{
    /* The register pointer is sent as part of a repeated-start read transaction;
     * no PCA9685 register value is written. */
    return i2c_master_transmit_receive(device, &reg, 1, value, 1, PCA004_TIMEOUT_MS);
}

void app_main(void)
{
    i2c_master_bus_handle_t bus = NULL;
    i2c_master_dev_handle_t device = NULL;
    esp_err_t operation_error = ESP_OK;
    esp_err_t cleanup_error = ESP_OK;
    const char *failed_step = NULL;
    bool probe_attempted = false;
    bool probe_passed = false;
    bool registers_attempted = false;
    bool registers_passed = false;

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
    const struct {
        uint8_t address;
        const char *name;
    } registers[] = {
        {PCA_MODE1, "MODE1"},
        {PCA_MODE2, "MODE2"},
        {PCA_PRE_SCALE, "PRE_SCALE"},
        {PCA_ALL_LED_OFF_H, "ALL_LED_OFF_H"},
        {PCA_LED15_OFF_H, "LED15_OFF_H"},
    };

    ESP_LOGI(TAG, "read-only test: SDA=GPIO%d SCL=GPIO%d speed=%u Hz address=0x%02x",
             PCA004_SDA_GPIO, PCA004_SCL_GPIO, PCA004_I2C_SPEED_HZ, PCA004_I2C_ADDRESS);
    ESP_LOGI(TAG, "output-control pins and PCA9685 register values are intentionally untouched");

    operation_error = i2c_new_master_bus(&bus_config, &bus);
    if (operation_error != ESP_OK) {
        failed_step = "create I2C bus";
        goto cleanup;
    }

    operation_error = i2c_master_bus_add_device(bus, &device_config, &device);
    if (operation_error != ESP_OK) {
        failed_step = "add I2C device";
        goto cleanup;
    }

    probe_attempted = true;
    operation_error = i2c_master_probe(bus, PCA004_I2C_ADDRESS, PCA004_TIMEOUT_MS);
    if (operation_error != ESP_OK) {
        failed_step = "probe address 0x40";
        goto cleanup;
    }
    probe_passed = true;
    ESP_LOGI(TAG, "address probe 0x%02x: ACK candidate (ACK alone is not PCA9685 identity proof)",
             PCA004_I2C_ADDRESS);

    registers_attempted = true;
    for (size_t index = 0; index < sizeof(registers) / sizeof(registers[0]); ++index) {
        uint8_t value = 0;
        operation_error = pca_read_register(device, registers[index].address, &value);
        if (operation_error != ESP_OK) {
            failed_step = registers[index].name;
            ESP_LOGE(TAG, "read %s (0x%02x): %s", registers[index].name,
                     registers[index].address, esp_err_to_name(operation_error));
            goto cleanup;
        }
        ESP_LOGI(TAG, "read %s (0x%02x): value=0x%02x result=ESP_OK",
                 registers[index].name, registers[index].address, value);
    }
    registers_passed = true;

cleanup:
    if (device != NULL) {
        esp_err_t err = i2c_master_bus_rm_device(device);
        if (err != ESP_OK) {
            cleanup_error = err;
        }
    }
    if (bus != NULL) {
        esp_err_t err = i2c_del_master_bus(bus);
        if (err != ESP_OK && cleanup_error == ESP_OK) {
            cleanup_error = err;
        }
    }

    if (operation_error == ESP_OK && cleanup_error == ESP_OK) {
        ESP_LOGI(TAG, "RESULT: address_probe=%s register_reads=%s cleanup=ESP_OK",
                 probe_passed ? "PASS" : (probe_attempted ? "FAIL" : "NOT_RUN"),
                 registers_passed ? "PASS" : (registers_attempted ? "FAIL" : "NOT_RUN"));
    } else {
        ESP_LOGE(TAG, "RESULT: address_probe=%s register_reads=%s failed_step=%s operation=%s cleanup=%s",
                 probe_passed ? "PASS" : (probe_attempted ? "FAIL" : "NOT_RUN"),
                 registers_passed ? "PASS" : (registers_attempted ? "FAIL" : "NOT_RUN"),
                 failed_step == NULL ? "none" : failed_step,
                 esp_err_to_name(operation_error), esp_err_to_name(cleanup_error));
    }
}
