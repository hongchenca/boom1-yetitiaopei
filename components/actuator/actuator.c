#include "actuator.h"

#include <stddef.h>
#include <string.h>
#include "driver/gpio.h"
#include "driver/i2c_master.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

#define PCA_SDA GPIO_NUM_8
#define PCA_SCL GPIO_NUM_9
#define PCA_OE GPIO_NUM_10
#define PCA_ADDRESS 0x40
#define PCA_TIMEOUT_MS 100
#define PCA_MODE1 0x00u
#define PCA_MODE2 0x01u
#define PCA_LED0 0x06u
#define PCA_PRESCALE 0xfeu
#define PCA_AI 0x20u
#define PCA_SLEEP 0x10u
#define PCA_EXTCLK 0x40u
#define PCA_RESTART 0x80u
#define PCA_FULL 0x10u
#define PCA_CHANNELS 16u
#define LOCK_WAIT_MS 300

static const char *TAG = "actuator";
static i2c_master_bus_handle_t s_bus;
static i2c_master_dev_handle_t s_device;
static SemaphoreHandle_t s_io_lock;
static portMUX_TYPE s_state_lock = portMUX_INITIALIZER_UNLOCKED;
static actuator_config_t s_config;
static actuator_status_t s_status = {.active_channel = -1};
static bool s_init_attempted;
static bool s_oe_ready;
static bool s_cleanup_pending;
static uint32_t s_generation;
static int64_t s_deadline_ms[ACTUATOR_OUTPUT_COUNT];

static uint16_t s_values[ACTUATOR_OUTPUT_COUNT];

static int64_t now_ms(void) { return esp_timer_get_time() / 1000; }
static bool valid_source(actuator_source_t source) {
    return source == ACTUATOR_SOURCE_DOSING || source == ACTUATOR_SOURCE_LOCAL ||
           source == ACTUATOR_SOURCE_REMOTE_DEBUG;
}

/////////////////////////////////////////////////////////////////////////////
// 函数名：write_verified
// 作用：有限时写入并回读 1..64 字节；连续访问依赖 MODE1.AI。
// 参数1：reg，起始寄存器；参数2：data，调用期间有效的字节；参数3：length，长度。
// 用于：持有 s_io_lock 的驱动调用，初始化阶段尚无并发访问。
// 使用示例：write_verified(PCA_LED0, values, sizeof(values))。
/////////////////////////////////////////////////////////////////////////////
static esp_err_t write_verified(uint8_t reg, const uint8_t *data, size_t length) {
    if (!data || !length || length > 64) return ESP_ERR_INVALID_ARG;
    uint8_t tx[65], rx[64];
    tx[0] = reg;
    memcpy(tx + 1, data, length);
    esp_err_t err = i2c_master_transmit(s_device, tx, length + 1, PCA_TIMEOUT_MS);
    if (err != ESP_OK) return err;
    err = i2c_master_transmit_receive(s_device, &reg, 1, rx, length, PCA_TIMEOUT_MS);
    if (err != ESP_OK) return err;
    for (size_t i = 0; i < length; ++i) {
        // RESTART 写 0 不改变其硬件状态，不能与普通配置位一样严格比较。
        uint8_t mask = reg + i == PCA_MODE1 ? 0x7fu : 0xffu;
        if ((rx[i] & mask) != (data[i] & mask)) {
            ESP_LOGE(TAG, "readback mismatch register=0x%02x", (unsigned)(reg + i));
            return ESP_FAIL;
        }
    }
    return ESP_OK;
}

/////////////////////////////////////////////////////////////////////////////
// 函数名：all_off
// 作用：一次连续事务将 16 路 FULL_OFF，并回读实际通道寄存器。
// 参数：无。
// 用于：OE 已禁能时的初始化、停止和故障收尾；最多两次 100 ms I2C 事务。
// 使用示例：all_off()；不使用不可回读状态的 ALL_LED 广播寄存器作为证据。
/////////////////////////////////////////////////////////////////////////////
static esp_err_t all_off(void) {
    uint8_t values[PCA_CHANNELS * 4] = {0};
    for (unsigned i = 0; i < PCA_CHANNELS; ++i) values[i * 4 + 3] = PCA_FULL;
    return write_verified(PCA_LED0, values, sizeof(values));
}

/////////////////////////////////////////////////////////////////////////////
// 函数名：configure_pca
// 作用：保持禁能，选择内部时钟、设置共享频率和推挽模式，回读全部关断。
// 参数：无。
// 用于：启动或人工故障恢复，调用者独占 I2C。
// 使用示例：configure_pca()；25 MHz 为数据手册标称振荡频率，非实测值。
/////////////////////////////////////////////////////////////////////////////
static esp_err_t configure_pca(void) {
    esp_err_t err = i2c_master_probe(s_bus, PCA_ADDRESS, PCA_TIMEOUT_MS);
    if (err != ESP_OK) return err;
    uint8_t reg = PCA_MODE1, mode = 0;
    err = i2c_master_transmit_receive(s_device, &reg, 1, &mode, 1, PCA_TIMEOUT_MS);
    if (err != ESP_OK) return err;
    if (mode & PCA_EXTCLK) return ESP_ERR_INVALID_STATE;
    mode = PCA_AI | PCA_SLEEP;
    err = write_verified(PCA_MODE1, &mode, 1);
    if (err != ESP_OK) return err;
    uint32_t divisor = 4096u * s_config.pwm_hz;
    uint8_t prescale = (uint8_t)((25000000u + divisor / 2) / divisor - 1);
    err = write_verified(PCA_PRESCALE, &prescale, 1);
    if (err != ESP_OK) return err;
    mode = 0x04; // 非反相推挽；STOP 更新；OE 高时输出低。
    err = write_verified(PCA_MODE2, &mode, 1);
    if (err != ESP_OK) return err;
    mode = PCA_AI;
    err = write_verified(PCA_MODE1, &mode, 1);
    if (err != ESP_OK) return err;
    vTaskDelay(pdMS_TO_TICKS(1) + 1); // 内部振荡器唤醒至少 500 us。
    err = all_off();
    if (err == ESP_OK) ESP_LOGI(TAG, "CH0..7 ready, PWM=%u Hz nominal, prescale=%u, all off",
                               s_config.pwm_hz, prescale);
    return err;
}

/////////////////////////////////////////////////////////////////////////////
// 函数名：cutoff_locked
// 作用：不等 I2C 地拉高 OE，撤销在途启泵意图并安排一次寄存器清理。
// 参数1：fault，是否锁存故障；参数2：error，原始故障码，正常停止使用 ESP_OK。
// 用于：仅在 s_state_lock 临界区内调用，包含 GPIO 锁存写，不包含总线或日志。
// 使用示例：cutoff_locked(false, ESP_OK)。
/////////////////////////////////////////////////////////////////////////////
static esp_err_t cutoff_locked(bool fault, esp_err_t error) {
    ++s_generation;
    s_status.stop_generation = s_generation;
    esp_err_t err = s_oe_ready ? gpio_set_level(PCA_OE, 1) : ESP_ERR_INVALID_STATE;
    memset(s_deadline_ms, 0, sizeof(s_deadline_ms));
    s_cleanup_pending = true;
    s_status.registers_verified = false;
    if (err == ESP_OK) {
        s_status.output_enabled = false;
        s_status.active_channel = -1;
        memset(s_status.duty_percent, 0, sizeof(s_status.duty_percent));
        memset(s_values, 0, sizeof(s_values));
        s_status.servo_pulse_us = 0;
    } else {
        s_status.shutdown_failed = true;
        fault = true;
        error = err;
    }
    if (fault) {
        s_status.fault_latched = true;
        s_status.last_error = error;
    }
    return err;
}

/////////////////////////////////////////////////////////////////////////////
// 函数名：finish_stop
// 作用：完成一次全关回读并发布结果；失败锁存且不无限重试。
// 参数：无。
// 用于：持有 s_io_lock、OE 已请求禁能时的停止收尾。
// 使用示例：finish_stop()。
/////////////////////////////////////////////////////////////////////////////
static esp_err_t finish_stop(void) {
    esp_err_t err = all_off();
    portENTER_CRITICAL(&s_state_lock);
    s_cleanup_pending = false;
    s_status.registers_verified = err == ESP_OK;
    if (err != ESP_OK) {
        s_status.fault_latched = true;
        s_status.shutdown_failed = true;
        s_status.last_error = err;
    }
    portEXIT_CRITICAL(&s_state_lock);
    return err;
}

/////////////////////////////////////////////////////////////////////////////
// 函数名：stop_channel_io
// 作用：关闭并回读指定泵，保留其他泵的占空比及截止时间；总线失败时全关锁存故障。
// 参数1：channel，0..7。
// 用于：持有 s_io_lock 的单路停止和本地到期处理。
// 使用示例：stop_channel_io(2)。
/////////////////////////////////////////////////////////////////////////////
static esp_err_t stop_channel_io(unsigned channel) {
    uint8_t values[4] = {0, 0, 0, PCA_FULL};
    esp_err_t err = write_verified((uint8_t)(PCA_LED0 + channel * 4), values, sizeof(values));
    portENTER_CRITICAL(&s_state_lock);
    if (err == ESP_OK) {
        s_status.duty_percent[channel] = 0;
        s_values[channel] = 0;
        if (channel == ACTUATOR_SERVO_CHANNEL) s_status.servo_pulse_us = 0;
        s_deadline_ms[channel] = 0;
        if (s_status.active_channel == (int8_t)channel) {
            s_status.active_channel = -1;
            for (unsigned i = 0; i < ACTUATOR_OUTPUT_COUNT; ++i)
                if (s_values[i]) { s_status.active_channel = (int8_t)i; break; }
        }
        if (s_status.active_channel < 0) {
            err = gpio_set_level(PCA_OE, 1);
            if (err == ESP_OK) s_status.output_enabled = false;
        }
        if (!s_cleanup_pending) s_status.registers_verified = err == ESP_OK;
    }
    if (err != ESP_OK) cutoff_locked(true, err);
    portEXIT_CRITICAL(&s_state_lock);
    if (err != ESP_OK) finish_stop();
    return err;
}

// 持有状态临界区时取出一个到期通道；preserve_channel 是即将被新期限替换的路。
static int expired_channel_locked(int preserve_channel) {
    int64_t now = now_ms();
    for (unsigned i = 0; i < ACTUATOR_OUTPUT_COUNT; ++i)
        if ((int)i != preserve_channel && s_deadline_ms[i] > 0 && now >= s_deadline_ms[i]) return (int)i;
    return -1;
}

/////////////////////////////////////////////////////////////////////////////
// 函数名：prune_expired_io
// 作用：保持共享 OE 禁能，清理写后回读期间到期的其他路，避免恢复 OE 时复活旧输出。
// 参数1：preserve_channel，新命令将替换期限的通道；-1 表示检查全部通道。
// 用于：持有 s_io_lock 的输出恢复路径，每次关断后重新取单调时间。
// 使用示例：prune_expired_io(request->channel)。
/////////////////////////////////////////////////////////////////////////////
static esp_err_t prune_expired_io(int preserve_channel) {
    for (;;) {
        portENTER_CRITICAL(&s_state_lock);
        int expired = s_cleanup_pending || s_status.fault_latched ? -1 : expired_channel_locked(preserve_channel);
        portEXIT_CRITICAL(&s_state_lock);
        if (expired < 0) return ESP_OK;
        esp_err_t err = stop_channel_io((unsigned)expired);
        if (err != ESP_OK) return err;
    }
}

/////////////////////////////////////////////////////////////////////////////
// 函数名：service_deadlines
// 作用：以单调时间逐路关闭到期输出，完成急停留下的全关清理。
// 参数：无。
// 用于：截止时间任务；I2C 事务有限时，其他控制写入持锁时在下一节拍重查。
// 使用示例：service_deadlines()；到期后只撤销对应通道。
/////////////////////////////////////////////////////////////////////////////
static void service_deadlines(void) {
    if (xSemaphoreTake(s_io_lock, 0) != pdTRUE) {
        // 单路关闭要使用总线；若在途事务超过两次 I2C 超时预算，仍通过 OE 兜底全关。
        portENTER_CRITICAL(&s_state_lock);
        int64_t now = now_ms();
        for (unsigned i = 0; i < ACTUATOR_OUTPUT_COUNT; ++i)
            if (s_deadline_ms[i] > 0 && now >= s_deadline_ms[i] + 2 * PCA_TIMEOUT_MS) {
                cutoff_locked(true, ESP_ERR_TIMEOUT);
                break;
            }
        portEXIT_CRITICAL(&s_state_lock);
        return;
    }
    portENTER_CRITICAL(&s_state_lock);
    bool pending = s_cleanup_pending;
    portEXIT_CRITICAL(&s_state_lock);
    if (pending) finish_stop();
    else for (unsigned i = 0; i < ACTUATOR_OUTPUT_COUNT; ++i) {
        portENTER_CRITICAL(&s_state_lock);
        bool expired = s_deadline_ms[i] > 0 && now_ms() >= s_deadline_ms[i];
        portEXIT_CRITICAL(&s_state_lock);
        if (expired && stop_channel_io(i) != ESP_OK) break;
    }
    xSemaphoreGive(s_io_lock);
}

/////////////////////////////////////////////////////////////////////////////
// 函数名：deadline_task
// 作用：使用本地单调时间逐路截止输出，执行延后的全关，不依赖网络/调用者续跑。
// 参数1：arg，未使用。
// 用于：独立高优先级任务，单路到期不会清除其他路有效输出。
// 使用示例：由 actuator_init 创建，10 ms 检查节拍受 RTOS 调度影响。
/////////////////////////////////////////////////////////////////////////////
static void deadline_task(void *arg) {
    (void)arg;
    for (;;) {
        service_deadlines();
        vTaskDelay(pdMS_TO_TICKS(10) ? pdMS_TO_TICKS(10) : 1);
    }
}

esp_err_t actuator_init(const actuator_config_t *config) {
    if (!config || !config->version || config->pwm_hz < 40 || config->pwm_hz > 1000 ||
        !config->maximum_percent || config->maximum_percent > 100 ||
        !config->maximum_run_ms || config->maximum_run_ms > 600000 ||
        config->minimum_percent > config->maximum_percent ||
        (config->auxiliaries_enabled && config->pwm_hz != 50)) return ESP_ERR_INVALID_ARG;
    if (s_init_attempted) return ESP_ERR_INVALID_STATE;
    s_init_attempted = true;
    s_config = *config;
    portENTER_CRITICAL(&s_state_lock);
    s_status.config_version = config->version;
    s_status.pwm_hz = config->pwm_hz;
    s_status.maximum_percent = config->maximum_percent;
    s_status.minimum_percent = config->minimum_percent;
    s_status.auxiliaries_enabled = config->auxiliaries_enabled;
    s_status.maximum_run_ms = config->maximum_run_ms;
    portEXIT_CRITICAL(&s_state_lock);
    const gpio_config_t oe = {
        .pin_bit_mask = 1ULL << PCA_OE, .mode = GPIO_MODE_OUTPUT,
        .pull_up_en = GPIO_PULLUP_DISABLE, .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    esp_err_t err = gpio_set_level(PCA_OE, 1);
    if (err == ESP_OK) err = gpio_config(&oe);
    if (err != ESP_OK) goto init_failed;
    s_oe_ready = true;
    s_io_lock = xSemaphoreCreateMutex();
    if (!s_io_lock) { err = ESP_ERR_NO_MEM; goto init_failed; }
    const i2c_master_bus_config_t bus = {
        .i2c_port = I2C_NUM_0, .sda_io_num = PCA_SDA, .scl_io_num = PCA_SCL,
        .clk_source = I2C_CLK_SRC_DEFAULT, .glitch_ignore_cnt = 7,
        .flags.enable_internal_pullup = false,
    };
    const i2c_device_config_t device = {
        .dev_addr_length = I2C_ADDR_BIT_LEN_7, .device_address = PCA_ADDRESS,
        .scl_speed_hz = 100000,
    };
    err = i2c_new_master_bus(&bus, &s_bus);
    if (err == ESP_OK) err = i2c_master_bus_add_device(s_bus, &device, &s_device);
    if (err == ESP_OK) err = configure_pca();
    if (err == ESP_OK) {
        portENTER_CRITICAL(&s_state_lock);
        s_status.initialized = true;
        s_status.registers_verified = true;
        portEXIT_CRITICAL(&s_state_lock);
        if (xTaskCreate(deadline_task, "pump_deadline", 3072, NULL, 8, NULL) == pdPASS) return ESP_OK;
        err = ESP_ERR_NO_MEM;
    }
init_failed:
    portENTER_CRITICAL(&s_state_lock);
    if (s_oe_ready) cutoff_locked(true, err);
    else {
        s_status.fault_latched = true;
        s_status.shutdown_failed = true;
        s_status.last_error = err;
    }
    s_status.initialized = false;
    s_status.shutdown_failed = !s_status.registers_verified;
    portEXIT_CRITICAL(&s_state_lock);
    if (s_device) {
        esp_err_t cleanup = i2c_master_bus_rm_device(s_device);
        if (cleanup != ESP_OK) ESP_LOGE(TAG, "device cleanup: %s", esp_err_to_name(cleanup));
        s_device = NULL;
    }
    if (s_bus) {
        esp_err_t cleanup = i2c_del_master_bus(s_bus);
        if (cleanup != ESP_OK) ESP_LOGE(TAG, "bus cleanup: %s", esp_err_to_name(cleanup));
        s_bus = NULL;
    }
    if (s_io_lock) vSemaphoreDelete(s_io_lock);
    s_io_lock = NULL;
    return err;
}

esp_err_t actuator_set(const actuator_request_t *request) {
    if (!request || !valid_source(request->source) || request->channel >= ACTUATOR_OUTPUT_COUNT ||
        request->duty_percent > 100 ||
        (request->channel == ACTUATOR_SERVO_CHANNEL ?
         (request->duty_percent || (request->pulse_us && (request->pulse_us < 500 || request->pulse_us > 2500))) :
         request->pulse_us != 0)) return ESP_ERR_INVALID_ARG;
    portENTER_CRITICAL(&s_state_lock);
    bool ready = s_status.initialized;
    uint32_t generation = s_generation;
    portEXIT_CRITICAL(&s_state_lock);
    if (!ready) return ESP_ERR_INVALID_STATE;
    uint16_t value = request->channel == ACTUATOR_SERVO_CHANNEL ? request->pulse_us : request->duty_percent;
    if (request->channel >= ACTUATOR_PUMP_COUNT && !s_config.auxiliaries_enabled) return ESP_ERR_INVALID_ARG;
    if (request->channel < ACTUATOR_PUMP_COUNT && value && value < s_config.minimum_percent) return ESP_ERR_INVALID_ARG;
    if (request->config_version != s_config.version) return ESP_ERR_INVALID_VERSION;
    if (request->duty_percent > s_config.maximum_percent ||
        (value && (!request->duration_ms ||
         request->duration_ms > s_config.maximum_run_ms))) return ESP_ERR_INVALID_ARG;
    if (xSemaphoreTake(s_io_lock, pdMS_TO_TICKS(LOCK_WAIT_MS)) != pdTRUE) return ESP_ERR_TIMEOUT;
    esp_err_t err = ESP_OK;
    portENTER_CRITICAL(&s_state_lock);
    bool blocked = generation != s_generation || (value && request->guard_stop_generation && request->stop_generation != s_generation) || (value &&
                   ((s_status.reserved_source && s_status.reserved_source != request->source) || s_status.fault_latched || s_cleanup_pending ||
                    (s_status.active_channel >= 0 && s_status.source != request->source)));
    bool already_off = !s_values[request->channel];
    bool liquid_on = false;
    for (unsigned i = 0; i < ACTUATOR_PUMP_COUNT; ++i) liquid_on |= s_values[i] != 0;
    if (value && ((request->channel < ACTUATOR_PUMP_COUNT && s_values[ACTUATOR_AIR_CHANNEL]) ||
        (request->channel == ACTUATOR_AIR_CHANNEL && liquid_on) ||
        (request->channel == ACTUATOR_SERVO_CHANNEL && value != s_values[ACTUATOR_SERVO_CHANNEL] &&
         (liquid_on || s_values[ACTUATOR_AIR_CHANNEL])))) blocked = true;
    portEXIT_CRITICAL(&s_state_lock);
    if (blocked) { err = ESP_ERR_INVALID_STATE; goto done; }
    if (!value) {
        if (!already_off) {
            err = stop_channel_io(request->channel);
        }
        goto done;
    }
    if (request->expires_at_ms <= now_ms() || (request->stop_at_ms && request->stop_at_ms <= now_ms())) { err = ESP_ERR_TIMEOUT; goto done; }
    // 续租相同输出不反复切换共享 OE，避免截断舵机脉冲；已到期的闭环租约不得复活。
    portENTER_CRITICAL(&s_state_lock);
    int64_t renew_at = now_ms();
    bool renewed = generation == s_generation && s_status.output_enabled &&
        !s_status.fault_latched && !s_cleanup_pending && s_values[request->channel] == value &&
        s_deadline_ms[request->channel] > renew_at;
    if (renewed) {
        s_deadline_ms[request->channel] = renew_at + request->duration_ms;
        if (request->stop_at_ms > 0 && request->stop_at_ms < s_deadline_ms[request->channel])
            s_deadline_ms[request->channel] = request->stop_at_ms;
    }
    bool interrupted = request->guard_stop_generation && s_values[request->channel] &&
        s_deadline_ms[request->channel] <= renew_at;
    portEXIT_CRITICAL(&s_state_lock);
    if (renewed) goto done;
    if (interrupted) { err = ESP_ERR_INVALID_STATE; goto done; }
    // OE 为所有路共享；写后回读期间短暂禁能，保留其他路寄存器和截止时间。
    err = gpio_set_level(PCA_OE, 1);
    if (err != ESP_OK) goto failed;
    portENTER_CRITICAL(&s_state_lock);
    s_status.output_enabled = false;
    s_status.registers_verified = false;
    portEXIT_CRITICAL(&s_state_lock);
    uint16_t counts = (uint16_t)((4096u * request->duty_percent + 50) / 100);
    if (request->channel == ACTUATOR_SERVO_CHANNEL) {
        uint32_t divisor = 4096u * s_config.pwm_hz;
        uint32_t prescale_plus_one = (25000000u + divisor / 2) / divisor;
        // 用预分频值转换微秒，不把舵机角度当作泵占空比。
        counts = (uint16_t)(((uint32_t)value * 25u + prescale_plus_one / 2) / prescale_plus_one);
    }
    uint8_t values[4] = {0, 0, (uint8_t)counts, (uint8_t)(counts >> 8)};
    if (request->duty_percent == 100) {
        values[1] = PCA_FULL; values[2] = 0; values[3] = 0;
    }
    err = write_verified((uint8_t)(PCA_LED0 + request->channel * 4), values, sizeof(values));
    if (err != ESP_OK) goto failed;
resume:
    err = prune_expired_io(request->channel);
    if (err != ESP_OK) goto failed;
    portENTER_CRITICAL(&s_state_lock);
    int64_t applied_at = now_ms();
    bool cancelled = false, expired = false, retry_expired = false;
    if (generation != s_generation || s_status.fault_latched) {
        // 已停止/过期的命令不能在完成迟到的 I2C 写入后重新使能。
        cutoff_locked(false, ESP_OK);
        cancelled = true;
        err = ESP_ERR_INVALID_STATE;
    } else if (request->expires_at_ms <= applied_at ||
               (request->stop_at_ms != 0 && request->stop_at_ms <= applied_at)) {
        expired = true;
        err = ESP_ERR_TIMEOUT;
    } else if (expired_channel_locked(request->channel) >= 0) {
        // 清理最后一路到再次入临界区之间仍可能跨过下一路期限。
        retry_expired = true;
    } else {
        err = gpio_set_level(PCA_OE, 0);
        if (err == ESP_OK) {
            s_status.duty_percent[request->channel] = request->duty_percent;
            s_values[request->channel] = value;
            if (request->channel == ACTUATOR_SERVO_CHANNEL) s_status.servo_pulse_us = value;
            s_status.active_channel = (int8_t)request->channel;
            s_status.source = request->source;
            s_status.output_enabled = true;
            s_status.registers_verified = true;
            s_deadline_ms[request->channel] = applied_at + request->duration_ms;
            if (request->stop_at_ms > 0 && request->stop_at_ms < s_deadline_ms[request->channel])
                s_deadline_ms[request->channel] = request->stop_at_ms;
        }
    }
    portEXIT_CRITICAL(&s_state_lock);
    if (retry_expired) goto resume;
    if (cancelled) finish_stop();
    else if (expired) {
        esp_err_t cleanup = stop_channel_io(request->channel);
resume_after_expiry:
        if (cleanup == ESP_OK) cleanup = prune_expired_io(-1);
        bool retry_cleanup = false;
        portENTER_CRITICAL(&s_state_lock);
        if (cleanup == ESP_OK && generation == s_generation && !s_status.fault_latched &&
            s_status.active_channel >= 0) {
            if (expired_channel_locked(-1) >= 0) retry_cleanup = true;
            else {
                cleanup = gpio_set_level(PCA_OE, 0);
                if (cleanup == ESP_OK) s_status.output_enabled = true;
                else cutoff_locked(true, cleanup);
            }
        }
        portEXIT_CRITICAL(&s_state_lock);
        if (retry_cleanup) goto resume_after_expiry;
        if (cleanup != ESP_OK) { finish_stop(); err = cleanup; }
    }
    else if (err != ESP_OK) goto failed;
    goto done;
failed:
    portENTER_CRITICAL(&s_state_lock);
    cutoff_locked(true, err);
    portEXIT_CRITICAL(&s_state_lock);
    finish_stop();
done:
    xSemaphoreGive(s_io_lock);
    return err;
}

esp_err_t actuator_stop_all(void) {
    portENTER_CRITICAL(&s_state_lock);
    bool ready = s_status.initialized;
    esp_err_t err = ready ? cutoff_locked(false, ESP_OK) : ESP_ERR_INVALID_STATE;
    portEXIT_CRITICAL(&s_state_lock);
    if (!ready) return err;
    if (xSemaphoreTake(s_io_lock, pdMS_TO_TICKS(LOCK_WAIT_MS)) != pdTRUE) return ESP_ERR_TIMEOUT;
    // 后台可能已完成上一轮清理；获得锁后再次禁能，覆盖期间新提交的启泵。
    portENTER_CRITICAL(&s_state_lock);
    esp_err_t disabled = cutoff_locked(false, ESP_OK);
    portEXIT_CRITICAL(&s_state_lock);
    esp_err_t cleanup = finish_stop();
    xSemaphoreGive(s_io_lock);
    return err != ESP_OK ? err : (disabled != ESP_OK ? disabled : cleanup);
}

void actuator_emergency_stop(void) {
    portENTER_CRITICAL(&s_state_lock);
    if (s_oe_ready) cutoff_locked(true, ESP_ERR_INVALID_STATE);
    portEXIT_CRITICAL(&s_state_lock);
}

esp_err_t actuator_clear_fault(void) {
    portENTER_CRITICAL(&s_state_lock);
    bool ready = s_status.initialized && !s_status.output_enabled;
    uint32_t generation = s_generation;
    portEXIT_CRITICAL(&s_state_lock);
    if (!ready) return ESP_ERR_INVALID_STATE;
    if (xSemaphoreTake(s_io_lock, pdMS_TO_TICKS(LOCK_WAIT_MS)) != pdTRUE) return ESP_ERR_TIMEOUT;
    // 未锁存时不允许用维护调用打断输出；获得锁后重查并阻止并发停止被清除。
    portENTER_CRITICAL(&s_state_lock);
    ready = !s_status.output_enabled && generation == s_generation;
    portEXIT_CRITICAL(&s_state_lock);
    esp_err_t err = ready ? gpio_set_level(PCA_OE, 1) : ESP_ERR_INVALID_STATE;
    if (err == ESP_OK) err = configure_pca();
    portENTER_CRITICAL(&s_state_lock);
    if (err == ESP_OK && generation == s_generation) {
        s_status.fault_latched = false;
        s_status.shutdown_failed = false;
        s_status.last_error = ESP_OK;
        s_status.registers_verified = true;
        s_status.active_channel = -1;
        memset(s_status.duty_percent, 0, sizeof(s_status.duty_percent));
        memset(s_values, 0, sizeof(s_values));
        s_status.servo_pulse_us = 0;
        memset(s_deadline_ms, 0, sizeof(s_deadline_ms));
        s_cleanup_pending = false;
    } else if (ready) {
        if (err == ESP_OK) err = ESP_ERR_INVALID_STATE;
        cutoff_locked(true, err);
        s_cleanup_pending = false;
    }
    portEXIT_CRITICAL(&s_state_lock);
    xSemaphoreGive(s_io_lock);
    return err;
}

void actuator_get_status(actuator_status_t *status) {
    if (!status) return;
    portENTER_CRITICAL(&s_state_lock);
    *status = s_status;
    int64_t now = now_ms();
    for (unsigned i = 0; i < ACTUATOR_OUTPUT_COUNT; ++i) {
        int64_t remaining = s_deadline_ms[i] - now;
        status->remaining_ms_by_channel[i] = remaining > 0 && s_values[i] ? (uint32_t)remaining : 0;
    }
    status->remaining_ms = status->active_channel >= 0 ?
        status->remaining_ms_by_channel[status->active_channel] : 0;
    portEXIT_CRITICAL(&s_state_lock);
}

// 配液独占所有输出，稳定阶段也不允许调试插入。
esp_err_t actuator_claim(actuator_source_t source) {
    if (!valid_source(source) || !s_io_lock) return ESP_ERR_INVALID_ARG;
    if (xSemaphoreTake(s_io_lock, pdMS_TO_TICKS(LOCK_WAIT_MS)) != pdTRUE) return ESP_ERR_TIMEOUT;
    portENTER_CRITICAL(&s_state_lock);
    bool ready = s_status.initialized && !s_status.fault_latched && !s_cleanup_pending &&
                 !s_status.output_enabled && !s_status.reserved_source;
    if (ready) s_status.reserved_source = source;
    portEXIT_CRITICAL(&s_state_lock);
    xSemaphoreGive(s_io_lock);
    return ready ? ESP_OK : ESP_ERR_INVALID_STATE;
}
esp_err_t actuator_release(actuator_source_t source) {
    portENTER_CRITICAL(&s_state_lock);
    bool ready = s_status.reserved_source == source && !s_status.output_enabled;
    if (ready) s_status.reserved_source = 0;
    portEXIT_CRITICAL(&s_state_lock);
    return ready ? ESP_OK : ESP_ERR_INVALID_STATE;
}
