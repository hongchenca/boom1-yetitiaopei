#ifndef YETI_WEIGHT_SERVICE_H
#define YETI_WEIGHT_SERVICE_H
#include <stdbool.h>
#include <stdint.h>
#include "esp_err.h"
#include "hx711_board.h"

typedef struct {
    bool enabled, initialized, raw_valid, calibrated, tare_ready, valid;
    bool stable, calibration_ready, saved;
    int32_t raw_count, average_raw, mass_mg, filtered_mg;
    // 控制快通道与静态窗口值独立于显示平滑；stable_mg 仅 stable=true 时使用。
    int32_t control_mg, stable_mg;
    uint32_t window_ms, filter_delay_ms;
    int64_t sample_time_ms;
    uint32_t age_ms, samples, version, sample_period_ms, sample_sequence;
    uint32_t noise_mg, raw_band, noise_band_mg;
    esp_err_t last_error, storage_error;
} weight_service_status_t;

// app_main 在 nvs_flash_init 后调用一次；mask 的 bit0..8 对应九路引脚表。
esp_err_t weight_service_start(uint16_t enabled_mask);
// 获取一路跨任务一致快照；超过 500 ms 的样本无效，未校准不输出质量。
void weight_service_get_status(unsigned channel, weight_service_status_t *status);
// 仅任务上下文：检查版本，先持久化再发布新版本。去皮/校准要求稳定窗口。
esp_err_t weight_service_tare(unsigned channel, uint32_t expected_version);
esp_err_t weight_service_calibrate(unsigned channel, uint32_t expected_version, int32_t reference_mg);
esp_err_t weight_service_reset(unsigned channel, uint32_t expected_version);
// raw_band 控制未校准时的原始稳定范围；noise_band_mg 控制校准后的重量稳定范围。
esp_err_t weight_service_configure(unsigned channel, uint32_t expected_version,
                                 uint32_t raw_band, uint32_t noise_band_mg);
#endif
