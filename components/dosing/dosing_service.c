#include "dosing_service.h"
#include "actuator.h"
#include "weight_service.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "nvs.h"
#include <limits.h>
#include <string.h>

typedef struct { uint32_t magic, version, vessel_us, waste_us; } positions_t;
static positions_t s_positions = {.magic=0x4f555431, .version=1};
static dosing_controller_t s_controller;
static dosing_service_status_t s_status;
static SemaphoreHandle_t s_mutex;
static portMUX_TYPE s_lock = portMUX_INITIALIZER_UNLOCKED;
static uint32_t s_stop_generation;
static bool s_cancel;
static int64_t dosing_clock_ms(void) { return esp_timer_get_time()/1000; }
static bool positions_valid(const positions_t *p) {
    return p->magic == 0x4f555431 && p->version > 0 && p->version < INT32_MAX &&
        p->vessel_us >= 500 && p->vessel_us <= 2500 && p->waste_us >= 500 && p->waste_us <= 2500 &&
        p->vessel_us != p->waste_us;
}
static void publish(esp_err_t error) {
    portENTER_CRITICAL(&s_lock);
    s_status.active = s_controller.active; s_status.state = s_controller.state; s_status.error = s_controller.error;
    s_status.step = s_controller.step; s_status.step_count = s_controller.count; s_status.jogs = s_controller.jogs;
    s_status.delivered_mg = s_controller.delivered_mg; s_status.source_loss_mg = s_controller.source_loss_mg;
    s_status.flow_mg_s = s_controller.flow_mg_s; s_status.last_error = error;
    memcpy(s_status.dose_mg, s_controller.dose_mg, sizeof(s_status.dose_mg));
    s_status.vessel_us = (uint16_t)s_positions.vessel_us; s_status.waste_us = (uint16_t)s_positions.waste_us;
    s_status.position_version = s_positions.version;
    s_status.positions_saved = positions_valid(&s_positions);
    portEXIT_CRITICAL(&s_lock);
}
void dosing_service_get_status(dosing_service_status_t *out) {
    if (!out) return;
    portENTER_CRITICAL(&s_lock); *out = s_status; portEXIT_CRITICAL(&s_lock);
}
static esp_err_t set_output(unsigned channel, uint16_t value, int64_t deadline, const actuator_status_t *a) {
    actuator_request_t r = {.source=ACTUATOR_SOURCE_DOSING,.config_version=a->config_version,
        .channel=(uint8_t)channel,.duration_ms=300,.expires_at_ms=dosing_clock_ms()+100,.stop_at_ms=deadline,
        .guard_stop_generation=true,.stop_generation=s_stop_generation};
    if (channel == ACTUATOR_SERVO_CHANNEL) r.pulse_us = value; else r.duty_percent = (uint8_t)value;
    return actuator_set(&r);
}
static esp_err_t apply_output(const actuator_status_t *a) {
    const dosing_output_t *o = &s_controller.output;
    uint16_t desired[10] = {0};
    desired[o->channel] = o->pump_percent; desired[8] = o->air_percent;
    desired[9] = (uint16_t)(o->route == DOSE_VESSEL ? s_positions.vessel_us : o->route == DOSE_WASTE ? s_positions.waste_us : 0);
    // 所有停止先完成，之后才允许换向或开启另一种泵。
    for (unsigned i=0;i<10;++i) {
        uint16_t current = i==9 ? a->servo_pulse_us : a->duty_percent[i];
        if (current && !desired[i]) { esp_err_t err=set_output(i,0,0,a); if(err!=ESP_OK)return err; }
    }
    // 舵机先设置；状态机额外等待 route_ms，不把寄存器回读当成机械到位反馈。
    const unsigned order[10]={9,0,1,2,3,4,5,6,7,8};
    for (unsigned n=0;n<10;++n) {
        unsigned i=order[n];
        uint16_t current=i==9 ? a->servo_pulse_us : a->duty_percent[i];
        if (!desired[i] || (current==desired[i] && a->remaining_ms_by_channel[i]>120)) continue;
        int64_t deadline=dosing_clock_ms()+300;
        if (i<8 && (s_controller.state==DOSE_FINE || s_controller.state==DOSE_JOG))
            deadline=s_controller.entered_ms+s_controller.pulse_ms;
        if (i==8) deadline=s_controller.entered_ms+s_controller.config.purge_ms;
        if (deadline<=dosing_clock_ms()) continue;
        esp_err_t err=set_output(i,desired[i],deadline,a); if(err!=ESP_OK)return err;
        if (i == ACTUATOR_SERVO_CHANNEL && current != desired[i] &&
            (s_controller.state == DOSE_ROUTE_VESSEL || s_controller.state == DOSE_ROUTE_WASTE)) {
            // 等待时间从指令实际应用完成起算，不能把 I2C 传输耗时当成舵机转动时间。
            s_controller.entered_ms = dosing_clock_ms();
        }
    }
    return ESP_OK;
}
// 网络/NVS 不在控制任务路径；驱动写入有界，独立期限监护兜底停机。
static void service_tick(void) {
    if (xSemaphoreTake(s_mutex,0)!=pdTRUE) return;
    if (!s_controller.active) { xSemaphoreGive(s_mutex); return; }
    actuator_status_t a; actuator_get_status(&a);
    dosing_input_t in = {.actuator_ok=a.initialized && !a.fault_latched && !a.shutdown_failed && a.reserved_source==ACTUATOR_SOURCE_DOSING,
                         .motors_off=true};
    for(unsigned i=0;i<9;++i) {
        weight_service_status_t w; weight_service_get_status(i,&w);
        in.weights[i]=(dosing_weight_t){.valid=w.valid,.stable=w.stable,.control_mg=w.control_mg,
            .stable_mg=w.stable_mg,.version=w.version,.sequence=w.sample_sequence,.window_ms=w.window_ms,
            .filter_delay_ms=w.filter_delay_ms,.noise_mg=w.noise_mg,.sample_ms=w.sample_time_ms};
        if(a.duty_percent[i]) in.motors_off=false;
    }
    in.now_ms=dosing_clock_ms();
    // 本地租约意外到期属于控制中断，不能在下次节拍自动复活原输出。
    const dosing_output_t *previous=&s_controller.output;
    if(previous->route!=DOSE_ROUTE_OFF && !a.servo_pulse_us)in.actuator_ok=false;
    if(previous->pump_percent && !a.duty_percent[previous->channel] &&
       !((s_controller.state==DOSE_FINE || s_controller.state==DOSE_JOG) && in.now_ms>=s_controller.entered_ms+s_controller.pulse_ms))in.actuator_ok=false;
    if(previous->air_percent && !a.duty_percent[8] && in.now_ms<s_controller.entered_ms+s_controller.config.purge_ms)in.actuator_ok=false;
    portENTER_CRITICAL(&s_lock); in.cancel=s_cancel; portEXIT_CRITICAL(&s_lock);
    in.cancel |= a.stop_generation != s_stop_generation;
    dosing_controller_tick(&s_controller,&in);
    esp_err_t err=ESP_OK;
    if (s_controller.active) err=apply_output(&a);
    if (err!=ESP_OK) {
        s_controller.active=false; s_controller.state=DOSE_ERROR; s_controller.error=DOSE_ACTUATOR;
    }
    if (!s_controller.active) {
        esp_err_t stopped=actuator_stop_all();
        if(stopped!=ESP_OK) { err=stopped; s_controller.state=DOSE_ERROR; s_controller.error=DOSE_ACTUATOR; }
        memset(&s_controller.output,0,sizeof(s_controller.output));
        actuator_release(ACTUATOR_SOURCE_DOSING);
    }
    publish(err); xSemaphoreGive(s_mutex);
}
static void control_task(void *arg) {
    (void)arg;
    for(;;) { service_tick(); vTaskDelay(pdMS_TO_TICKS(20) ? pdMS_TO_TICKS(20) : 1); }
}
esp_err_t dosing_service_init(void) {
    if(s_mutex) return ESP_ERR_INVALID_STATE;
    s_mutex=xSemaphoreCreateMutex(); if(!s_mutex)return ESP_ERR_NO_MEM;
    nvs_handle_t handle; esp_err_t err=nvs_open("outlet",NVS_READONLY,&handle);
    if(err==ESP_OK) {
        positions_t loaded; size_t length=sizeof(loaded);
        err=nvs_get_blob(handle,"positions",&loaded,&length); nvs_close(handle);
        if(err==ESP_OK && (length!=sizeof(loaded) || !positions_valid(&loaded)))err=ESP_ERR_INVALID_RESPONSE;
        if(err==ESP_OK)s_positions=loaded;
    }
    if(err==ESP_ERR_NVS_NOT_FOUND)err=ESP_OK;
    publish(err);
    if(xTaskCreate(control_task,"dosing",4096,NULL,6,NULL)!=pdPASS) {
        vSemaphoreDelete(s_mutex); s_mutex=NULL; return ESP_ERR_NO_MEM;
    }
    portENTER_CRITICAL(&s_lock); s_status.initialized=true; portEXIT_CRITICAL(&s_lock);
    return ESP_OK;
}
esp_err_t dosing_service_save_positions(uint32_t expected, uint16_t vessel, uint16_t waste) {
    positions_t pending={.magic=0x4f555431,.version=expected+1,.vessel_us=vessel,.waste_us=waste};
    if(!s_mutex || !positions_valid(&pending))return ESP_ERR_INVALID_ARG;
    if(xSemaphoreTake(s_mutex,pdMS_TO_TICKS(100))!=pdTRUE)return ESP_ERR_TIMEOUT;
    esp_err_t err=ESP_ERR_INVALID_STATE;
    if(!s_controller.active && expected==s_positions.version && actuator_claim(ACTUATOR_SOURCE_LOCAL)==ESP_OK) {
        nvs_handle_t h; err=nvs_open("outlet",NVS_READWRITE,&h);
        if(err==ESP_OK) {
            err=nvs_set_blob(h,"positions",&pending,sizeof(pending));
            if(err==ESP_OK)err=nvs_commit(h);
            nvs_close(h);
        }
        if(err==ESP_OK)s_positions=pending;
        actuator_release(ACTUATOR_SOURCE_LOCAL);
    }
    publish(err); xSemaphoreGive(s_mutex); return err;
}
esp_err_t dosing_service_start(const dosing_config_t *config, const dosing_step_t *steps, unsigned count, uint32_t expected) {
    if(!s_mutex)return ESP_ERR_INVALID_STATE;
    if(xSemaphoreTake(s_mutex,pdMS_TO_TICKS(100))!=pdTRUE)return ESP_ERR_TIMEOUT;
    actuator_status_t a; actuator_get_status(&a);
    esp_err_t err=ESP_ERR_INVALID_STATE;
    if(!s_controller.active && positions_valid(&s_positions) && expected==s_positions.version && a.auxiliaries_enabled &&
        config && config->minimum_percent>=a.minimum_percent && config->fast_percent<=a.maximum_percent && config->air_percent<=a.maximum_percent &&
        actuator_claim(ACTUATOR_SOURCE_DOSING)==ESP_OK) {
        // claim 与外部 stop 并发时，之后的每个输出仍核对 stop_generation。
        s_stop_generation=a.stop_generation;
        portENTER_CRITICAL(&s_lock); s_cancel=false; portEXIT_CRITICAL(&s_lock);
        if(!dosing_controller_start(&s_controller,config,steps,count,dosing_clock_ms())) {
            err=ESP_ERR_INVALID_ARG; actuator_release(ACTUATOR_SOURCE_DOSING);
        } else {
            err=ESP_OK;
            portENTER_CRITICAL(&s_lock); ++s_status.run_id; portEXIT_CRITICAL(&s_lock);
        }
    }
    publish(err); xSemaphoreGive(s_mutex); return err;
}
esp_err_t dosing_service_cancel(void) {
    portENTER_CRITICAL(&s_lock); s_cancel=true; portEXIT_CRITICAL(&s_lock);
    return actuator_stop_all();
}
