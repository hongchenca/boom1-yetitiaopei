#ifndef YETI_DOSING_CONTROLLER_H
#define YETI_DOSING_CONTROLLER_H
#include <stdbool.h>
#include <stdint.h>

#define DOSING_MAX_STEPS 8
typedef enum {
    DOSE_IDLE, DOSE_PRECHECK, DOSE_ROUTE_VESSEL, DOSE_FAST, DOSE_SLOW,
    DOSE_FINE, DOSE_STOPPING, DOSE_SETTLING, DOSE_JOG, DOSE_ROUTE_WASTE,
    DOSE_PURGE, DOSE_PURGE_SETTLE, DOSE_DONE, DOSE_ABORTED, DOSE_ERROR
} dosing_state_t;
typedef enum {
    DOSE_OK, DOSE_BAD_CONFIG, DOSE_SENSOR, DOSE_CALIBRATION_CHANGED,
    DOSE_TIMEOUT, DOSE_NO_FLOW, DOSE_OVERDOSE, DOSE_UNDERDOSE,
    DOSE_INVENTORY, DOSE_MASS_BALANCE, DOSE_WASTE_LEAK, DOSE_ACTUATOR,
    DOSE_CANCELLED, DOSE_CONTROL_LATE, DOSE_FLOW_LIMIT
} dosing_error_t;
typedef enum { DOSE_ROUTE_OFF, DOSE_VESSEL, DOSE_WASTE } dosing_route_t;
typedef struct { uint8_t channel; int32_t target_mg, tolerance_mg; } dosing_step_t;
typedef struct {
    uint32_t version;
    uint8_t minimum_percent, fast_percent, slow_percent, fine_percent, air_percent;
    uint32_t route_ms, purge_ms, settle_min_ms, settle_timeout_ms;
    uint32_t step_timeout_ms, total_timeout_ms, no_flow_ms;
    uint32_t pulse_min_ms, pulse_max_ms, max_jogs, tail_ms;
    int32_t slow_margin_mg, fine_margin_mg, compensation_mg;
    int32_t max_flow_mg_s, progress_mg, residual_limit_mg, balance_tolerance_mg;
    int32_t vessel_capacity_mg, purge_leak_tolerance_mg;
} dosing_config_t;
typedef struct {
    bool valid, stable;
    int32_t control_mg, stable_mg;
    uint32_t version, sequence, window_ms, filter_delay_ms, noise_mg;
    int64_t sample_ms;
} dosing_weight_t;
typedef struct {
    int64_t now_ms;
    dosing_weight_t weights[9];
    bool actuator_ok, motors_off, cancel;
} dosing_input_t;
typedef struct {
    uint8_t channel, pump_percent, air_percent;
    dosing_route_t route;
} dosing_output_t;
typedef struct {
    dosing_config_t config;
    dosing_step_t steps[DOSING_MAX_STEPS];
    unsigned count, step, jogs;
    dosing_state_t state;
    dosing_error_t error;
    dosing_output_t output;
    bool active;
    int64_t started_ms, entered_ms, step_started_ms, stopped_ms, last_tick_ms;
    int64_t flow_ms;
    uint32_t no_progress_on_ms; // 累计启泵无进展时间；停泵判稳不计入，也不清零。
    int32_t source_start_mg, vessel_start_mg, batch_start_mg;
    int32_t delivered_mg, source_loss_mg, flow_mg_s, flow_mass_mg, progress_mass_mg;
    int32_t verified_mg, purge_source_mg, dose_mg[DOSING_MAX_STEPS], loss_mg[DOSING_MAX_STEPS];
    uint32_t versions[9], flow_sequence, pulse_ms;
} dosing_controller_t;

bool dosing_config_valid(const dosing_config_t *config);
bool dosing_controller_start(dosing_controller_t *controller, const dosing_config_t *config,
                             const dosing_step_t *steps, unsigned count, int64_t now_ms);
void dosing_controller_tick(dosing_controller_t *controller, const dosing_input_t *input);
const char *dosing_state_name(dosing_state_t state);
const char *dosing_error_name(dosing_error_t error);
#endif
