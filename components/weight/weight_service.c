#include "weight_service.h"
#include <limits.h>
#include <stdio.h>
#include <string.h>
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "hx711.h"
#include "nvs.h"

#define WINDOW_SIZE 16u
#define MAX_AGE_MS 500u
#define STABLE_MS 500u
#define MAX_MASS_MG 1000000000
#define CAL_MAGIC 0x57544731u

// 一路一个 NVS blob；GPIO 参与校验，改接线后不能套用旧系数。
typedef struct {
    uint32_t magic, version, channel, dout, sck;
    int32_t zero, span, reference_mg;
    uint32_t tare_ready, raw_band, noise_band_mg;
} calibration_t;
typedef struct {
    hx711_t device;
    calibration_t calibration;
    weight_service_status_t status;
    int32_t window[WINDOW_SIZE], filtered_raw, control_raw;
    int64_t display_q16, control_q16;
    int64_t times[WINDOW_SIZE];
    unsigned count, next;
    int64_t sum, sample_ms, stable_since_ms;
    bool filter_ready;
} scale_t;
static scale_t s_scales[HX711_BOARD_SCALE_COUNT];
static portMUX_TYPE s_lock = portMUX_INITIALIZER_UNLOCKED;
static SemaphoreHandle_t s_update_lock;
static bool s_started;

static int32_t rounded_counts(int64_t q16) {
    return (int32_t)((q16 + (q16 >= 0 ? 32768 : -32768)) / 65536);
}

static int32_t median3(int32_t a, int32_t b, int32_t c) {
    if (a > b) { int32_t t = a; a = b; b = t; }
    if (b > c) b = c;
    return a > b ? a : b;
}
static int32_t median5(const scale_t *scale) {
    int32_t sorted[5];
    unsigned n = scale->count < 5 ? scale->count : 5;
    for (unsigned i = 0; i < n; ++i) {
        int32_t v = scale->window[(scale->next + WINDOW_SIZE - 1 - i) % WINDOW_SIZE];
        unsigned j = i;
        while (j && sorted[j-1] > v) { sorted[j] = sorted[j-1]; --j; }
        sorted[j] = v;
    }
    return sorted[n / 2];
}
// 有符号 64 位中间乘积防溢出，支持反向传感器及负净重。
static bool convert_mass(const calibration_t *cal, int32_t raw, int32_t *mass) {
    if (!cal->span || !cal->reference_mg) return false;
    int64_t value = ((int64_t)raw - cal->zero) * cal->reference_mg / cal->span;
    if (value < -MAX_MASS_MG || value > MAX_MASS_MG) return false;
    *mass = (int32_t)value;
    return true;
}
static bool calibration_valid(const calibration_t *c, unsigned channel) {
    const hx711_pin_pair_t pins = hx711_board_pins[channel];
    return c->magic == CAL_MAGIC && c->channel == channel && c->version >= 1 && c->version <= INT32_MAX &&
           c->dout == (uint32_t)pins.dout_gpio && c->sck == (uint32_t)pins.sck_gpio &&
           c->zero >= -8388608 && c->zero <= 8388607 && c->span >= -16777215 && c->span <= 16777215 &&
           c->reference_mg >= 0 && c->reference_mg <= MAX_MASS_MG && c->tare_ready <= 1 &&
           ((c->span == 0 && c->reference_mg == 0) || (c->span != 0 && c->reference_mg > 0 && c->tare_ready)) &&
           c->raw_band >= 1 && c->raw_band <= 100000 && c->noise_band_mg >= 1 && c->noise_band_mg <= 10000;
}

/////////////////////////////////////////////////////////////////////////////
// 函数名：calibration_storage
// 作用：单路读取或提交 NVS blob；不自动擦除 NVS，失败不发布新系数。
// 参数1：cal，读写记录；参数2：write，true 保存、false 加载。
// 用于：启动加载与显式校准，在任务上下文、临界区外调用。
/////////////////////////////////////////////////////////////////////////////
static esp_err_t calibration_storage(calibration_t *cal, bool write) {
    nvs_handle_t handle;
    char key[12];
    snprintf(key, sizeof(key), "scale%u", (unsigned)cal->channel);
    esp_err_t err = nvs_open("weight", write ? NVS_READWRITE : NVS_READONLY, &handle);
    if (err != ESP_OK) return err;
    if (write) {
        err = nvs_set_blob(handle, key, cal, sizeof(*cal));
        if (err == ESP_OK) err = nvs_commit(handle);
    } else {
        size_t length = sizeof(*cal);
        err = nvs_get_blob(handle, key, cal, &length);
        if (err == ESP_OK && length != sizeof(*cal)) err = ESP_ERR_INVALID_SIZE;
    }
    nvs_close(handle);
    return err;
}

/////////////////////////////////////////////////////////////////////////////
// 函数名：weight_service_get_status
// 作用：按通道读取一致快照，依据单调时间使过期样本失效。
// 参数1：channel，0..8；参数2：status，调用方输出，NULL 时忽略。
// 用于：遥测/命令回执；示例：weight_service_get_status(8, &status)。
/////////////////////////////////////////////////////////////////////////////
void weight_service_get_status(unsigned channel, weight_service_status_t *status) {
    if (!status) return;
    memset(status, 0, sizeof(*status));
    if (channel >= HX711_BOARD_SCALE_COUNT) return;
    portENTER_CRITICAL(&s_lock);
    const scale_t *scale = &s_scales[channel];
    *status = scale->status;
    int64_t age = esp_timer_get_time() / 1000 - scale->sample_ms;
    status->age_ms = scale->count ? (uint32_t)(age > 60000 ? 60000 : age) : 60000;
    status->raw_valid = status->raw_valid && status->age_ms <= MAX_AGE_MS;
    status->calibrated = scale->calibration.span != 0;
    status->tare_ready = scale->calibration.tare_ready != 0;
    status->version = scale->calibration.version;
    status->raw_band = scale->calibration.raw_band;
    status->noise_band_mg = scale->calibration.noise_band_mg;
    status->valid = status->raw_valid && status->calibrated &&
                    convert_mass(&scale->calibration, status->raw_count, &status->mass_mg) &&
                    convert_mass(&scale->calibration, scale->filtered_raw, &status->filtered_mg) &&
                    convert_mass(&scale->calibration, scale->control_raw, &status->control_mg) &&
                    convert_mass(&scale->calibration, status->average_raw, &status->stable_mg);
    status->stable = status->stable && status->valid;
    status->calibration_ready = status->calibration_ready && status->raw_valid;
    if (!status->valid) status->mass_mg = status->filtered_mg = status->control_mg = status->stable_mg = 0;
    portEXIT_CRITICAL(&s_lock);
}

// s_lock 内调用；校准平均与快速显示分开，故障及修改系数后重新预热。
static void clear_window(scale_t *scale) {
    scale->count = scale->next = 0;
    scale->sum = 0;
    scale->filter_ready = false;
    scale->stable_since_ms = 0;
    scale->status.samples = 0;
    scale->status.stable = scale->status.calibration_ready = false;
    scale->status.raw_valid = false;
    scale->status.window_ms = scale->status.filter_delay_ms = 0;
}

/////////////////////////////////////////////////////////////////////////////
// 函数名：accept_sample
// 作用：快通道 median3 + 1/2 EMA；显示 median5 + 自适应 EMA；原始窗口判稳。
// 参数1：scale，临界区保护的单路状态；参数2：raw，ADC；参数3：now，单调毫秒。
// 用于：采集成功后调用；不做存储或网络 I/O。
/////////////////////////////////////////////////////////////////////////////
static void accept_sample(scale_t *scale, int32_t raw, int64_t now) {
    weight_service_status_t *status = &scale->status;
    if (scale->count) status->sample_period_ms = (uint32_t)(now - scale->sample_ms);
    if (scale->count && now - scale->sample_ms > MAX_AGE_MS) clear_window(scale);
    if (scale->count == WINDOW_SIZE) scale->sum -= scale->window[scale->next]; else scale->count++;
    scale->window[scale->next] = raw;
    scale->times[scale->next] = now;
    scale->sum += raw;
    scale->next = (scale->next + 1) % WINDOW_SIZE;
    int32_t median = raw;
    if (scale->count >= 3) median = median3(raw, scale->window[(scale->next + WINDOW_SIZE - 2) % WINDOW_SIZE],
                                          scale->window[(scale->next + WINDOW_SIZE - 3) % WINDOW_SIZE]);
    int64_t control_target = (int64_t)median * 65536;
    if (!scale->filter_ready) scale->control_q16 = control_target;
    else scale->control_q16 += (control_target - scale->control_q16) / 2;
    // 四舍五入到 counts，避免整数 EMA 在恒定输入下滞留一 count 偏差。
    scale->control_raw = rounded_counts(scale->control_q16);
    int32_t display = median5(scale);
    int64_t delta = (int64_t)display - scale->filtered_raw;
    if (delta < 0) delta = -delta;
    int64_t band = scale->calibration.raw_band;
    if (scale->calibration.span) {
        int64_t span = scale->calibration.span;
        if (span < 0) span = -span;
        band = span * scale->calibration.noise_band_mg / scale->calibration.reference_mg;
    }
    if (band < 1) band = 1;
    // 小幅波动时间常数 500 ms，真实变化 50 ms；按采样时间适配 10/80 SPS。
    uint32_t dt = status->sample_period_ms ? status->sample_period_ms : 100;
    uint32_t tau = delta > band * 2 ? 50 : 500;
    int64_t target = (int64_t)display * 65536;
    if (!scale->filter_ready) scale->display_q16 = target;
    else scale->display_q16 += (target - scale->display_q16) * dt / (tau + dt);
    scale->filtered_raw = rounded_counts(scale->display_q16);
    scale->filter_ready = true;
    status->raw_count = raw;
    status->average_raw = (int32_t)(scale->sum / scale->count);
    status->samples = scale->count;
    status->sample_sequence++;
    status->raw_valid = true;
    status->last_error = ESP_OK;
    scale->sample_ms = now;
    status->sample_time_ms = now;
    status->window_ms = (uint32_t)(now - scale->times[(scale->next + WINDOW_SIZE - scale->count) % WINDOW_SIZE]);
    status->filter_delay_ms = 2 * dt; // median3 的 1 样本 + EMA 的约 1 样本斜坡延迟。
    int32_t minimum = raw, maximum = raw;
    for (unsigned i = 0; i < scale->count; ++i) {
        if (scale->window[i] < minimum) minimum = scale->window[i];
        if (scale->window[i] > maximum) maximum = scale->window[i];
    }
    uint32_t range = (uint32_t)(maximum - minimum);
    int64_t noise = scale->calibration.span ? (int64_t)range * scale->calibration.reference_mg / scale->calibration.span : 0;
    if (noise < 0) noise = -noise;
    status->noise_mg = noise > UINT32_MAX ? UINT32_MAX : (uint32_t)noise;
    bool quiet = scale->count == WINDOW_SIZE && (scale->calibration.span ?
                 noise <= scale->calibration.noise_band_mg : range <= scale->calibration.raw_band);
    if (!quiet) scale->stable_since_ms = 0;
    else if (!scale->stable_since_ms) scale->stable_since_ms = now;
    status->calibration_ready = quiet && now - scale->stable_since_ms >= STABLE_MS;
    status->stable = status->calibration_ready;
}

/////////////////////////////////////////////////////////////////////////////
// 函数名：sample_channels
// 作用：逐路非阻塞就绪检查，断线通道不占用其他路的等待预算。
// 参数：无。用于 weight_task，每 RTOS tick 调用一次。
/////////////////////////////////////////////////////////////////////////////
static void sample_channels(void) {
    for (unsigned i = 0; i < HX711_BOARD_SCALE_COUNT; ++i) {
        scale_t *scale = &s_scales[i];
        if (!scale->device.initialized) continue;
        int32_t raw = 0;
        esp_err_t err = hx711_read(&scale->device, 0, &raw);
        if (err == ESP_OK && (raw == -8388608 || raw == 8388607)) err = ESP_ERR_INVALID_RESPONSE;
        int64_t now = esp_timer_get_time() / 1000;
        portENTER_CRITICAL(&s_lock);
        if (err == ESP_OK) accept_sample(scale, raw, now);
        else if (err != ESP_ERR_TIMEOUT || now - scale->sample_ms > 300) {
            clear_window(scale);
            scale->status.last_error = err;
        }
        portEXIT_CRITICAL(&s_lock);
    }
}

/////////////////////////////////////////////////////////////////////////////
// 函数名：weight_task
// 作用：独占九路 HX711，每 tick 扫描已启用通道。
// 参数1：arg，未使用。用于启动后独立采集，无网络依赖。
/////////////////////////////////////////////////////////////////////////////
static void weight_task(void *arg) {
    (void)arg;
    vTaskDelay(pdMS_TO_TICKS(500));
    for (;;) { sample_channels(); vTaskDelay(1); }
}

/////////////////////////////////////////////////////////////////////////////
// 函数名：weight_service_start
// 作用：加载逐路参数，初始化所选 GPIO，创建单个采样任务。
// 参数1：enabled_mask，bit0..8，至少一路；NVS 已初始化。
// 用于：启动时调用一次；示例：weight_service_start(0x1ff)。
/////////////////////////////////////////////////////////////////////////////
esp_err_t weight_service_start(uint16_t enabled_mask) {
    if (!enabled_mask || (enabled_mask & ~0x1ffu)) return ESP_ERR_INVALID_ARG;
    if (s_started) return ESP_ERR_INVALID_STATE;
    s_update_lock = xSemaphoreCreateMutex();
    if (!s_update_lock) return ESP_ERR_NO_MEM;
    for (unsigned i = 0; i < HX711_BOARD_SCALE_COUNT; ++i) {
        scale_t *scale = &s_scales[i];
        const hx711_pin_pair_t pins = hx711_board_pins[i];
        scale->calibration = (calibration_t){.magic=CAL_MAGIC, .version=1, .channel=i,
            .dout=pins.dout_gpio, .sck=pins.sck_gpio, .raw_band=200, .noise_band_mg=50};
        scale->status.enabled = (enabled_mask & (1u << i)) != 0;
        scale->status.last_error = ESP_ERR_INVALID_STATE;
        if (!scale->status.enabled) continue;
        calibration_t loaded = scale->calibration;
        esp_err_t err = calibration_storage(&loaded, false);
        if (err == ESP_OK && !calibration_valid(&loaded, i)) err = ESP_ERR_INVALID_RESPONSE;
        if (err == ESP_OK) { scale->calibration = loaded; scale->status.saved = true; }
        scale->status.storage_error = err == ESP_ERR_NVS_NOT_FOUND ? ESP_OK : err;
        err = hx711_init(&scale->device, pins.dout_gpio, pins.sck_gpio);
        scale->status.initialized = err == ESP_OK;
        scale->status.last_error = err;
        ESP_LOGI("weight", "CH%02u DOUT=%d SCK=%d init=%s saved=%d", i,
                 (int)pins.dout_gpio, (int)pins.sck_gpio, esp_err_to_name(err), scale->status.saved);
    }
    if (xTaskCreate(weight_task, "weight", 3072, NULL, 5, NULL) != pdPASS) {
        for (unsigned i = 0; i < HX711_BOARD_SCALE_COUNT; ++i) {
            if (s_scales[i].device.initialized) hx711_deinit(&s_scales[i].device);
            s_scales[i].status.initialized = false;
        }
        vSemaphoreDelete(s_update_lock); s_update_lock = NULL;
        return ESP_ERR_NO_MEM;
    }
    s_started = true;
    return ESP_OK;
}

/////////////////////////////////////////////////////////////////////////////
// 函数名：update_calibration
// 作用：串行校验并更新一路参数；临界区外持久化，成功才发布。
// 参数1：channel，0..8；参数2：version，期望版本；参数3：operation，0 去皮/1 校准/2 清除/3 阈值。
// 参数4/5：value/extra，质量 mg 或两个阈值。用于以下公共操作接口。
/////////////////////////////////////////////////////////////////////////////
static esp_err_t update_calibration(unsigned channel, uint32_t version, unsigned operation, int32_t value, uint32_t extra) {
    if (channel >= HX711_BOARD_SCALE_COUNT || !s_update_lock) return ESP_ERR_INVALID_ARG;
    if (xSemaphoreTake(s_update_lock, pdMS_TO_TICKS(100)) != pdTRUE) return ESP_ERR_TIMEOUT;
    scale_t *scale = &s_scales[channel];
    portENTER_CRITICAL(&s_lock);
    calibration_t pending = scale->calibration;
    bool ready = scale->status.initialized && pending.version == version && version < INT32_MAX;
    if (operation < 2) ready = ready && scale->status.raw_valid && scale->status.calibration_ready &&
                            esp_timer_get_time() / 1000 - scale->sample_ms <= MAX_AGE_MS;
    esp_err_t err = ready ? ESP_OK : ESP_ERR_INVALID_STATE;
    if (err == ESP_OK) {
        if (operation == 0) { pending.zero = scale->status.average_raw; pending.tare_ready = 1; }
        else if (operation == 1) {
            int32_t span = scale->status.average_raw - pending.zero;
            if (!pending.tare_ready || (span >= -(int32_t)pending.raw_band * 5 && span <= (int32_t)pending.raw_band * 5))
                err = ESP_ERR_INVALID_STATE;
            else { pending.span = span; pending.reference_mg = value; }
        } else if (operation == 2) { pending.zero = pending.span = pending.reference_mg = 0; pending.tare_ready = 0; }
        else { pending.raw_band = (uint32_t)value; pending.noise_band_mg = extra; }
        pending.version++;
    }
    portEXIT_CRITICAL(&s_lock);
    if (err == ESP_OK) {
        err = calibration_storage(&pending, true);
        portENTER_CRITICAL(&s_lock);
        scale->status.storage_error = err;
        if (err == ESP_OK) {
            scale->calibration = pending;
            scale->status.saved = true;
            clear_window(scale);
        }
        portEXIT_CRITICAL(&s_lock);
    }
    xSemaphoreGive(s_update_lock);
    return err;
}

// 显式用户操作；版本、单位和上下文约束见头文件，所有成功操作均写入 NVS。
esp_err_t weight_service_tare(unsigned channel, uint32_t version) {
    return update_calibration(channel, version, 0, 0, 0);
}
esp_err_t weight_service_calibrate(unsigned channel, uint32_t version, int32_t reference_mg) {
    if (reference_mg < 1 || reference_mg > MAX_MASS_MG) return ESP_ERR_INVALID_ARG;
    return update_calibration(channel, version, 1, reference_mg, 0);
}
esp_err_t weight_service_reset(unsigned channel, uint32_t version) {
    return update_calibration(channel, version, 2, 0, 0);
}
esp_err_t weight_service_configure(unsigned channel, uint32_t version, uint32_t raw_band, uint32_t noise_band_mg) {
    if (raw_band < 1 || raw_band > 100000 || noise_band_mg < 1 || noise_band_mg > 10000) return ESP_ERR_INVALID_ARG;
    return update_calibration(channel, version, 3, (int32_t)raw_band, noise_band_mg);
}
