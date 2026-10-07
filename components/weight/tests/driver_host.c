// 时钟/数据线替身验证真实 hx711.c 的帧、符号扩展及故障返回；不测物理脉宽。
#include <assert.h>
#include <stdio.h>
#include "../hx711.c"

static int64_t fake_us;
static unsigned pulses, value;
static int clock_level;
static bool stuck_high, stuck_low, input_pullup;

int64_t esp_timer_get_time(void) { return fake_us; }
void vTaskDelay(unsigned ticks) { fake_us += ticks * 1000; }
void esp_rom_delay_us(unsigned us) { fake_us += us; }
esp_err_t gpio_config(const gpio_config_t *config) {
    if (config->mode == GPIO_MODE_INPUT) input_pullup = config->pull_up_en == GPIO_PULLUP_ENABLE;
    return ESP_OK;
}
esp_err_t gpio_set_level(gpio_num_t pin, unsigned level) {
    assert(pin == 2);
    if (level && !clock_level) pulses++;
    clock_level = level;
    return ESP_OK;
}
int gpio_get_level(gpio_num_t pin) {
    assert(pin == 1);
    if (stuck_high) return 1;
    if (stuck_low || pulses == 0) return 0;
    if (pulses == 25) return 1;
    assert(pulses <= 24 && clock_level);
    return (value >> (24 - pulses)) & 1;
}

int main(void) {
    hx711_t scale = {0};
    int32_t raw = 123;
    assert(hx711_read(&scale, 300, &raw) == ESP_ERR_INVALID_ARG);
    assert(hx711_init(&scale, 1, 1) == ESP_ERR_INVALID_ARG);
    assert(hx711_init(&scale, 1, 2) == ESP_OK);
    assert(input_pullup && clock_level == 0);
    const unsigned bits[] = {0, 1, 0x7fffff, 0x800000, 0xffffff};
    const int32_t expected[] = {0, 1, 8388607, -8388608, -1};
    for (unsigned i = 0; i < sizeof(bits) / sizeof(bits[0]); ++i) {
        pulses = 0; value = bits[i];
        assert(hx711_read(&scale, 300, &raw) == ESP_OK);
        assert(raw == expected[i] && pulses == 25 && clock_level == 0);
    }
    pulses = 0; stuck_high = true; raw = 123;
    assert(hx711_read(&scale, 0, &raw) == ESP_ERR_TIMEOUT);
    assert(raw == 123 && pulses == 0);
    int64_t start = fake_us;
    assert(hx711_read(&scale, 300, &raw) == ESP_ERR_TIMEOUT);
    assert(fake_us - start == 300000 && raw == 123 && pulses == 0);
    stuck_high = false; stuck_low = true;
    assert(hx711_read(&scale, 300, &raw) == ESP_ERR_INVALID_RESPONSE);
    assert(raw == 123 && pulses == 25 && clock_level == 0);
    assert(hx711_deinit(&scale) == ESP_OK && !scale.initialized && clock_level == 0);
    puts("PASS HX711 driver: signed 24-bit frame, 25 clocks, idle low, pull-up, bounded timeout, stuck DOUT");
    return 0;
}
