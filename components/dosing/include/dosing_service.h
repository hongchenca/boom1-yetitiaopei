#ifndef YETI_DOSING_SERVICE_H
#define YETI_DOSING_SERVICE_H
#include "dosing_controller.h"
#include "esp_err.h"
typedef struct {
    bool initialized, active, positions_saved;
    uint16_t vessel_us, waste_us;
    uint32_t position_version, run_id;
    dosing_state_t state;
    dosing_error_t error;
    unsigned step, step_count, jogs;
    int32_t delivered_mg, source_loss_mg, flow_mg_s;
    int32_t dose_mg[DOSING_MAX_STEPS];
    esp_err_t last_error;
} dosing_service_status_t;
esp_err_t dosing_service_init(void);
void dosing_service_get_status(dosing_service_status_t *out);
// 不自动执行位置；保存前必须全部停止，两个不同位置分别用网页测试后填写。
esp_err_t dosing_service_save_positions(uint32_t expected_version, uint16_t vessel_us, uint16_t waste_us);
// 明确传入不可变控制参数，不做自动精度承诺；网页提供台架初始值。
esp_err_t dosing_service_start(const dosing_config_t *config, const dosing_step_t *steps, unsigned count,
                             uint32_t expected_position_version);
esp_err_t dosing_service_cancel(void);
#endif
