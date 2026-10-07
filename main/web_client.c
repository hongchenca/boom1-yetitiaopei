/* 网络入口：命令校验后交给八路执行器服务，称重采样与执行器仍分开管理。 */
#include <inttypes.h>
#include <math.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <time.h>
#include "cJSON.h"
#include "actuator.h"
#include "dosing_service.h"
#include "esp_crt_bundle.h"
#include "esp_event.h"
#include "esp_http_client.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_random.h"
#include "esp_sntp.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/task.h"
#include "hx711_board.h"
#include "weight_service.h"
#include "nvs_flash.h"

#if __has_include("web_client.local.h")
#include "web_client.local.h"
#else
#define WEB_CLIENT_SERVER_URL ""
#define WEB_CLIENT_WIFI_SSID ""
#define WEB_CLIENT_WIFI_PASSWORD ""
#define WEB_CLIENT_DEVICE_ID "esp32-001"
#define WEB_CLIENT_DEVICE_TOKEN ""
#define WEB_CLIENT_SERIAL_TEST 0
#define WEB_CLIENT_HX711_PROBE_CHANNEL -1
#endif

#ifndef WEB_CLIENT_PUMP_CONTROL
#define WEB_CLIENT_PUMP_CONTROL 0
#endif
#ifndef WEB_CLIENT_HX711_SCALE1
#define WEB_CLIENT_HX711_SCALE1 0
#endif
#ifndef WEB_CLIENT_OUTLET_CONTROL
#define WEB_CLIENT_OUTLET_CONTROL 0
#endif
#define WEB_CLIENT_FIRMWARE "web-client-0.6.1"
// ESP-IDF 的功率单位为 0.25 dBm；80 对应 20 dBm 上限，实际发送受 PHY/国家配置限制。
#define WEB_CLIENT_WIFI_TX_POWER_QDBM 80

#ifndef WEB_CLIENT_HX711_PROBE_CHANNEL
#define WEB_CLIENT_HX711_PROBE_CHANNEL -1
#endif

#if WEB_CLIENT_HX711_PROBE_CHANNEL < -1 || WEB_CLIENT_HX711_PROBE_CHANNEL >= HX711_BOARD_SCALE_COUNT
#error WEB_CLIENT_HX711_PROBE_CHANNEL must be -1 or 0..8
#endif

#if WEB_CLIENT_SERIAL_TEST || WEB_CLIENT_HX711_PROBE_CHANNEL >= 0
#error Legacy serial input and raw probe were removed; set serial_test=false and hx711_probe_channel=-1
#endif

#define CONNECTED_BIT BIT0
#define DISCONNECTED_BIT BIT1
#define REGISTERED_BIT BIT2
static const char *TAG = "web_client";
static EventGroupHandle_t s_events;
static char s_boot[33];
static portMUX_TYPE s_config_lock = portMUX_INITIALIZER_UNLOCKED;
static uint32_t s_interval = 200, s_version = 1, s_http_ms;
static TaskHandle_t s_telemetry_task;
static bool s_https;

typedef struct { char *data; size_t capacity, length; bool overflow; } response_t;
typedef struct { char id[81]; char body[512]; } cached_ack_t;
static cached_ack_t s_acks[8]; /* 仅 command_task 所有。缓存覆盖至少八个已处理命令。 */
static unsigned s_ack_index;
#if WEB_CLIENT_PUMP_CONTROL
static uint64_t s_control_sequence; // 同一 boot 内不允许重放已离开回执缓存的旧控制命令。
#endif
static int64_t uptime_ms(void) { return esp_timer_get_time() / 1000; }
static bool number_in(cJSON *value, double min, double max) {
    return cJSON_IsNumber(value) && isfinite(value->valuedouble) && floor(value->valuedouble) == value->valuedouble && value->valuedouble >= min && value->valuedouble <= max;
}
static bool same_string(cJSON *value, const char *expected) { return cJSON_IsString(value) && strcmp(value->valuestring, expected) == 0; }
static bool valid_id(cJSON *value) {
    if (!cJSON_IsString(value)) return false;
    const char *s = value->valuestring;
    size_t n = strlen(s); if (n < 1 || n > 80) return false;
    for (size_t i = 0; i < n; i++) if (!((s[i]>='a'&&s[i]<='z')||(s[i]>='A'&&s[i]<='Z')||(s[i]>='0'&&s[i]<='9')||s[i]=='-'||s[i]=='_')) return false;
    return true;
}

/////////////////////////////////////////////////////////////////////////////
// 函数名：http_event
// 作用：接收有界响应，超长响应标记失败，不使用截断 JSON。
// 参数：event，HTTP 客户端事件，user_data 由调用方持有到 perform 返回。
// 用于：上传与长轮询任务；示例：由 esp_http_client_perform 自动回调。
/////////////////////////////////////////////////////////////////////////////
static esp_err_t http_event(esp_http_client_event_t *event) {
    response_t *r = event->user_data;
    if (event->event_id == HTTP_EVENT_ON_DATA && r && event->data_len > 0) {
        if ((size_t)event->data_len >= r->capacity - r->length) { r->overflow = true; return ESP_ERR_INVALID_SIZE; }
        memcpy(r->data + r->length, event->data, event->data_len);
        r->length += event->data_len; r->data[r->length] = 0;
    }
    return ESP_OK;
}

/////////////////////////////////////////////////////////////////////////////
// 函数名：post_json
// 作用：发送设备鉴权 JSON，重定向被拒绝，HTTPS 使用 CA bundle 校验证书。
// 参数1：reuse，调用任务独占的 HTTP 句柄地址，句柄初值 NULL。
// 参数2：path，API 相对路径；参数3：body，调用期间有效的 JSON 字符串。
// 参数4：reply，调用方缓冲区；参数5：capacity，至少 1 字节。
// 参数6：timeout_ms，HTTP 超时毫秒；参数7：status，可为 NULL，接收 HTTP 状态。
// 用于：所有上行路径；示例：post_json(&client, path, body, reply, sizeof(reply), 5000, NULL)。
/////////////////////////////////////////////////////////////////////////////
static esp_err_t post_json(esp_http_client_handle_t *reuse, const char *path, const char *body, char *reply, size_t capacity, int timeout_ms, int *status) {
    char url[384];
    if (!reply || capacity == 0) return ESP_ERR_INVALID_ARG;
    reply[0] = 0; if (status) *status = 0;
    if (s_https && time(NULL) < 1700000000) return ESP_ERR_INVALID_STATE;
    int n = snprintf(url, sizeof(url), "%s/api/v1%s", WEB_CLIENT_SERVER_URL, path);
    if (n < 0 || (size_t)n >= sizeof(url)) return ESP_ERR_INVALID_SIZE;
    response_t response = { .data=reply, .capacity=capacity };
    esp_http_client_config_t config = {
        .url=url, .method=HTTP_METHOD_POST, .timeout_ms=timeout_ms,
        .event_handler=http_event, .user_data=&response, .disable_auto_redirect=true,
        .crt_bundle_attach=esp_crt_bundle_attach,
    };
    esp_http_client_handle_t client = *reuse;
    if (!client) client = esp_http_client_init(&config);
    if (!client) return ESP_ERR_NO_MEM;
    *reuse = client;
    esp_http_client_set_user_data(client, &response);
    esp_http_client_set_timeout_ms(client, timeout_ms);
    esp_err_t url_error = esp_http_client_set_url(client, url);
    if (url_error != ESP_OK) { esp_http_client_cleanup(client); *reuse = NULL; return url_error; }
    esp_err_t err = esp_http_client_set_header(client, "Content-Type", "application/json");
    if (err == ESP_OK) err = esp_http_client_set_header(client, "X-Device-Id", WEB_CLIENT_DEVICE_ID);
    if (err == ESP_OK) err = esp_http_client_set_header(client, "X-Device-Token", WEB_CLIENT_DEVICE_TOKEN);
    if (err == ESP_OK) err = esp_http_client_set_post_field(client, body, strlen(body));
    if (err == ESP_OK) err = esp_http_client_perform(client);
    int code = esp_http_client_get_status_code(client);
    if (status) *status = code;
    if (err != ESP_OK || response.overflow) { esp_http_client_cleanup(client); *reuse = NULL; }
    if (response.overflow) return ESP_ERR_INVALID_SIZE;
    return err != ESP_OK ? err : ((code >= 200 && code < 300) ? ESP_OK : ESP_FAIL);
}

/////////////////////////////////////////////////////////////////////////////
// 函数名：wifi_event
// 作用：发布连接位并记录连接参数/断线原因，事件线程不重连、不运行 HTTP。
// 参数1：arg，未使用；参数2：base，事件组；参数3：event，事件 ID。
// 参数4：data，事件数据，由 ESP-IDF 管理。
// 用于：系统事件循环；示例：通过 esp_event_handler_register 注册。
/////////////////////////////////////////////////////////////////////////////
static void wifi_event(void *arg, esp_event_base_t base, int32_t event, void *data) {
    (void)arg;
    if (base == WIFI_EVENT && event == WIFI_EVENT_STA_DISCONNECTED) {
        xEventGroupClearBits(s_events, CONNECTED_BIT | REGISTERED_BIT);
        xEventGroupSetBits(s_events, DISCONNECTED_BIT);
        const wifi_event_sta_disconnected_t *disconnected = data;
        if (disconnected) ESP_LOGW(TAG, "Wi-Fi disconnected: reason=%u, rssi=%d dBm",
            (unsigned)disconnected->reason, (int)disconnected->rssi);
    } else if (base == IP_EVENT && event == IP_EVENT_STA_GOT_IP) {
        xEventGroupClearBits(s_events, DISCONNECTED_BIT);
        xEventGroupSetBits(s_events, CONNECTED_BIT);
        ESP_LOGI(TAG, "Wi-Fi connected; telemetry enabled");
        wifi_ps_type_t ps;
        wifi_bandwidth_t bandwidth;
        int8_t tx_power;
        wifi_ap_record_t ap;
        if (esp_wifi_get_ps(&ps) == ESP_OK &&
            esp_wifi_get_bandwidth(WIFI_IF_STA, &bandwidth) == ESP_OK &&
            esp_wifi_get_max_tx_power(&tx_power) == ESP_OK &&
            esp_wifi_sta_get_ap_info(&ap) == ESP_OK) {
            ESP_LOGI(TAG, "Wi-Fi link: ps=%s, bandwidth=%s, tx_limit=%.2f dBm, channel=%u, rssi=%d dBm",
                ps == WIFI_PS_NONE ? "NONE" : "MODEM",
                bandwidth == WIFI_BW_HT20 ? "HT20" : "HT40",
                tx_power / 4.0, (unsigned)ap.primary, (int)ap.rssi);
        } else {
            ESP_LOGW(TAG, "Wi-Fi link parameters unavailable");
        }
    }
}

/////////////////////////////////////////////////////////////////////////////
// 函数名：connection_task
// 作用：在独立任务内有限退避重连，避免事件循环中紧密重试。
// 参数：arg，未使用；用于 FreeRTOS 网络维护；示例：xTaskCreate 创建。
/////////////////////////////////////////////////////////////////////////////
static void connection_task(void *arg) {
    (void)arg; uint32_t backoff = 1000;
    for (;;) {
        xEventGroupClearBits(s_events, DISCONNECTED_BIT);
        esp_err_t err = esp_wifi_connect();
        if (err != ESP_OK) ESP_LOGW(TAG, "Wi-Fi connect: %s", esp_err_to_name(err));
        EventBits_t bits = xEventGroupWaitBits(s_events, CONNECTED_BIT | DISCONNECTED_BIT, pdFALSE, pdFALSE, pdMS_TO_TICKS(15000));
        if (bits & CONNECTED_BIT) {
            backoff = 1000;
            xEventGroupWaitBits(s_events, DISCONNECTED_BIT, pdTRUE, pdFALSE, portMAX_DELAY);
        }
        vTaskDelay(pdMS_TO_TICKS(backoff + esp_random()%250));
        if (backoff < 16000) backoff *= 2;
    }
}

/////////////////////////////////////////////////////////////////////////////
// 函数名：telemetry_json
// 作用：构造九路称重快照与八路执行器状态；未校准或过期质量为 null。
// 参数1：sequence，单调递增上报序号；参数2：buffer，输出 JSON。
// 参数3：capacity，缓冲区大小；用于 telemetry_task；示例：telemetry_json(seq, payload, sizeof(payload))。
/////////////////////////////////////////////////////////////////////////////
static bool telemetry_json(uint64_t sequence, char *buffer, size_t capacity) {
    weight_service_status_t weights[9] = {0};
    bool weight_enabled = false;
#if WEB_CLIENT_HX711_SCALE1
    for (unsigned i=0;i<9;++i) { weight_service_get_status(i, &weights[i]); weight_enabled |= weights[i].initialized; }
#endif
    actuator_status_t pumps = {.active_channel = -1};
#if WEB_CLIENT_PUMP_CONTROL
    actuator_get_status(&pumps);
#endif
    dosing_service_status_t dose = {0};
#if WEB_CLIENT_OUTLET_CONTROL && WEB_CLIENT_HX711_SCALE1
    dosing_service_get_status(&dose);
#endif
    uint32_t interval, version;
    portENTER_CRITICAL(&s_config_lock); interval=s_interval; version=s_version; portEXIT_CRITICAL(&s_config_lock);
    wifi_ap_record_t ap; int rssi = esp_wifi_sta_get_ap_info(&ap) == ESP_OK ? ap.rssi : -127;
    cJSON *root = cJSON_CreateObject(); if (!root) return false;
    cJSON *caps = cJSON_AddObjectToObject(root, "capabilities");
    cJSON *status = cJSON_AddObjectToObject(root, "status");
    if (!caps || !status) { cJSON_Delete(root); return false; }
    cJSON_AddNumberToObject(root,"schema_version",1);
    cJSON_AddStringToObject(root,"device_id",WEB_CLIENT_DEVICE_ID);
    cJSON_AddStringToObject(root,"boot_id",s_boot);
    cJSON_AddNumberToObject(root,"sequence",(double)sequence);
    cJSON_AddNumberToObject(root,"uptime_ms",(double)uptime_ms());
    cJSON_AddNumberToObject(root,"sample_age_ms",0);
    cJSON_AddStringToObject(root,"firmware",WEB_CLIENT_FIRMWARE);
    cJSON_AddBoolToObject(caps,"telemetry",true); cJSON_AddBoolToObject(caps,"events",true);
    cJSON_AddBoolToObject(caps,"command_poll",true); cJSON_AddBoolToObject(caps,"weight",weight_enabled);
    cJSON_AddBoolToObject(caps,"actuator",pumps.initialized); cJSON_AddBoolToObject(caps,"simulation",false);
    cJSON_AddBoolToObject(caps,"test_input",false);
    cJSON_AddNumberToObject(status,"upload_interval_ms",interval); cJSON_AddNumberToObject(status,"config_version",version);
    cJSON_AddNumberToObject(status,"last_http_ms",s_http_ms);
    cJSON_AddNumberToObject(status,"weight_service_version",2);
    cJSON_AddNumberToObject(status,"free_heap_bytes",esp_get_free_heap_size()); cJSON_AddNumberToObject(status,"wifi_rssi",rssi);
    cJSON_AddStringToObject(status,"task_state",pumps.fault_latched ? "error" : dose.active ? "dosing" : pumps.output_enabled ? "debug" : "idle");
    cJSON *d=cJSON_AddObjectToObject(status,"dosing");
    if(!d) { cJSON_Delete(root); return false; }
    cJSON_AddBoolToObject(d,"supported",dose.initialized);
    cJSON_AddBoolToObject(d,"active",dose.active);
    cJSON_AddBoolToObject(d,"positions_saved",dose.positions_saved);
    cJSON_AddNumberToObject(d,"vessel_us",dose.vessel_us);
    cJSON_AddNumberToObject(d,"waste_us",dose.waste_us);
    cJSON_AddNumberToObject(d,"position_version",dose.position_version);
    cJSON_AddNumberToObject(d,"run_id",dose.run_id);
    cJSON_AddStringToObject(d,"state",dosing_state_name(dose.state));
    cJSON_AddStringToObject(d,"error",dosing_error_name(dose.error));
    cJSON_AddNumberToObject(d,"step",dose.step);
    cJSON_AddNumberToObject(d,"step_count",dose.step_count);
    cJSON_AddNumberToObject(d,"delivered_mg",dose.delivered_mg);
    cJSON_AddNumberToObject(d,"source_loss_mg",dose.source_loss_mg);
    cJSON_AddNumberToObject(d,"flow_mg_s",dose.flow_mg_s);
    cJSON_AddNumberToObject(d,"jogs",dose.jogs);
    cJSON *dose_values=cJSON_AddArrayToObject(d,"dose_mg");
    if(!dose_values) { cJSON_Delete(root); return false; }
    for(unsigned i=0;i<dose.step_count;++i)cJSON_AddItemToArray(dose_values,cJSON_CreateNumber(dose.dose_mg[i]));
    cJSON *channels = cJSON_AddArrayToObject(status,"channels");
    if (!channels) { cJSON_Delete(root); return false; }
    for (int i=0;i<9;i++) {
        cJSON *c=cJSON_CreateObject(); if (!c) { cJSON_Delete(root); return false; }
        cJSON_AddNumberToObject(c,"channel",i);
        weight_service_status_t weight = weights[i];
        if (weight.enabled) {
            cJSON_AddBoolToObject(c,"enabled",true);
            cJSON_AddBoolToObject(c,"initialized",weight.initialized);
            if (weight.raw_valid) {
                cJSON_AddNumberToObject(c,"raw_count",weight.raw_count);
                cJSON_AddNumberToObject(c,"average_raw",weight.average_raw);
            } else {
                cJSON_AddNullToObject(c,"raw_count"); cJSON_AddNullToObject(c,"average_raw");
            }
            if (weight.valid) {
                cJSON_AddNumberToObject(c,"mass_mg",weight.mass_mg);
                cJSON_AddNumberToObject(c,"filtered_mg",weight.filtered_mg);
                cJSON_AddNumberToObject(c,"control_mg",weight.control_mg);
                if(weight.stable)cJSON_AddNumberToObject(c,"stable_mg",weight.stable_mg);
                else cJSON_AddNullToObject(c,"stable_mg");
            } else {
                cJSON_AddNullToObject(c,"mass_mg"); cJSON_AddNullToObject(c,"filtered_mg");
            }
            cJSON_AddBoolToObject(c,"valid",weight.valid);
            cJSON_AddBoolToObject(c,"stable",weight.stable);
            cJSON_AddBoolToObject(c,"calibration_ready",weight.calibration_ready);
            cJSON_AddBoolToObject(c,"saved",weight.saved);
            cJSON_AddNumberToObject(c,"noise_mg",weight.noise_mg);
            cJSON_AddNumberToObject(c,"raw_band",weight.raw_band);
            cJSON_AddNumberToObject(c,"noise_band_mg",weight.noise_band_mg);
            cJSON_AddNumberToObject(c,"sample_period_ms",weight.sample_period_ms);
            cJSON_AddNumberToObject(c,"sample_sequence",weight.sample_sequence);
            cJSON_AddNumberToObject(c,"window_ms",weight.window_ms);
            cJSON_AddNumberToObject(c,"filter_delay_ms",weight.filter_delay_ms);
            cJSON_AddStringToObject(c,"storage_error",esp_err_to_name(weight.storage_error));
            cJSON_AddNumberToObject(c,"age_ms",weight.age_ms);
            cJSON_AddBoolToObject(c,"calibrated",weight.calibrated);
            cJSON_AddBoolToObject(c,"tare_ready",weight.tare_ready);
            cJSON_AddNumberToObject(c,"calibration_version",weight.version);
            cJSON_AddNumberToObject(c,"samples",weight.samples);
            cJSON_AddStringToObject(c,"last_error",esp_err_to_name(weight.last_error));
        } else {
            cJSON_AddBoolToObject(c,"enabled",false);
            cJSON_AddNullToObject(c,"mass_mg"); cJSON_AddNullToObject(c,"filtered_mg");
            cJSON_AddBoolToObject(c,"valid",false); cJSON_AddBoolToObject(c,"stable",false);
            cJSON_AddNumberToObject(c,"age_ms",60000);
        }
        cJSON_AddItemToArray(channels,c);
    }
    cJSON *a=cJSON_AddObjectToObject(status,"actuator");
    if (!a) { cJSON_Delete(root); return false; }
    int active = 0;
    for(int i=0;i<ACTUATOR_PUMP_COUNT;++i)if(pumps.duty_percent[i])active=i;
    unsigned applied = pumps.output_enabled ? pumps.duty_percent[active] : 0;
    cJSON_AddNumberToObject(a,"channel",active);
    cJSON_AddNumberToObject(a,"requested_percent",applied);
    cJSON_AddNumberToObject(a,"applied_percent",applied);
    cJSON_AddStringToObject(a,"output",pumps.initialized ? "pca9685" : "hardware_pending");
    cJSON_AddNumberToObject(a,"config_version",pumps.config_version);
    cJSON_AddNumberToObject(a,"pwm_hz",pumps.pwm_hz);
    cJSON_AddNumberToObject(a,"maximum_percent",pumps.maximum_percent);
    cJSON_AddNumberToObject(a,"minimum_percent",pumps.minimum_percent);
    cJSON_AddNumberToObject(a,"remaining_ms",pumps.remaining_ms_by_channel[active]);
    cJSON_AddBoolToObject(a,"auxiliaries_supported",pumps.auxiliaries_enabled);
    cJSON_AddNumberToObject(a,"air_percent",pumps.duty_percent[8]);
    cJSON_AddNumberToObject(a,"servo_pulse_us",pumps.servo_pulse_us);
    cJSON_AddNumberToObject(a,"air_remaining_ms",pumps.remaining_ms_by_channel[8]);
    cJSON_AddNumberToObject(a,"servo_remaining_ms",pumps.remaining_ms_by_channel[9]);
    cJSON_AddBoolToObject(a,"parallel_supported",true);
    cJSON_AddBoolToObject(a,"fault_latched",pumps.fault_latched);
    cJSON_AddBoolToObject(a,"shutdown_failed",pumps.shutdown_failed);
    cJSON_AddBoolToObject(a,"registers_verified",pumps.registers_verified);
    cJSON_AddStringToObject(a,"last_error",esp_err_to_name(pumps.last_error));
    cJSON *duties = cJSON_AddArrayToObject(a,"duty_percent");
    cJSON *remaining = cJSON_AddArrayToObject(a,"remaining_ms_by_channel");
    if (!duties || !remaining) { cJSON_Delete(root); return false; }
    for (int i = 0; i < ACTUATOR_PUMP_COUNT; ++i) {
        cJSON_AddItemToArray(duties,cJSON_CreateNumber(pumps.output_enabled ? pumps.duty_percent[i] : 0));
        cJSON_AddItemToArray(remaining,cJSON_CreateNumber(pumps.remaining_ms_by_channel[i]));
    }
    bool ok=cJSON_PrintPreallocated(root,buffer,capacity,false); cJSON_Delete(root); return ok;
}

/////////////////////////////////////////////////////////////////////////////
// 函数名：telemetry_task
// 作用：上报、启动事件重试与退避。周期配置仅 RAM 生效，不写 NVS。
// 参数：arg，未使用；用于独立低优先级任务，栈与缓冲留在内部 RAM。
// 使用示例：xTaskCreate(telemetry_task, "telemetry", 16384, NULL, 4, &s_telemetry_task)。
/////////////////////////////////////////////////////////////////////////////
static void telemetry_task(void *arg) {
    (void)arg; char payload[12288], reply[512], event[384];
    esp_http_client_handle_t client = NULL;
    uint64_t sequence=0; bool announced=false; uint32_t backoff=1000;
    snprintf(event,sizeof(event),"{\"schema_version\":1,\"device_id\":\"%s\",\"boot_id\":\"%s\",\"event_id\":\"boot-%s\",\"type\":\"boot\",\"payload\":{\"firmware\":\"%s\"}}",WEB_CLIENT_DEVICE_ID,s_boot,s_boot,WEB_CLIENT_FIRMWARE);
    for (;;) {
        xEventGroupWaitBits(s_events,CONNECTED_BIT,pdFALSE,pdFALSE,portMAX_DELAY);
        int status=0;
        int64_t cycle_started = uptime_ms();
        esp_err_t err=telemetry_json(sequence++,payload,sizeof(payload)) ? post_json(&client,"/device/telemetry",payload,reply,sizeof(reply),5000,&status) : ESP_ERR_NO_MEM;
        s_http_ms = (uint32_t)(uptime_ms() - cycle_started);
        if (err==ESP_OK) {
            cJSON *r=cJSON_Parse(reply);
            bool accepted=cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(r,"accepted")); cJSON_Delete(r);
            if (accepted) {
                xEventGroupSetBits(s_events,REGISTERED_BIT); backoff=1000;
                if (!announced) announced=post_json(&client,"/device/events",event,reply,sizeof(reply),5000,NULL)==ESP_OK;
            } else err=ESP_FAIL;
        }
        uint32_t interval;
        portENTER_CRITICAL(&s_config_lock); interval=s_interval; portEXIT_CRITICAL(&s_config_lock);
        if (err!=ESP_OK) {
            xEventGroupClearBits(s_events,REGISTERED_BIT);
            ESP_LOGW(TAG,"upload failed: %s HTTP=%d",esp_err_to_name(err),status);
            interval=backoff; if(backoff<16000)backoff*=2;
        }
        int64_t elapsed = uptime_ms() - cycle_started;
        uint32_t delay_ms = err == ESP_OK ? (elapsed < interval ? interval - (uint32_t)elapsed : 1) : interval;
        ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(delay_ms) ? pdMS_TO_TICKS(delay_ms) : 1);
    }
}

#if WEB_CLIENT_PUMP_CONTROL
/////////////////////////////////////////////////////////////////////////////
// 函数名：process_pump_command
// 作用：将已核对设备/boot/时效的控制命令转为有界执行器请求。
// 参数1：command，借用 JSON；参数2：result，回执输出；参数3：capacity，缓冲字节数。
// 用于：仅 command_task 调用；服务器鉴权后仍核对序号、会话、版本、范围和租约。
// 使用示例：process_pump_command(command, result, sizeof(result))；返回 NULL 表示成功。
/////////////////////////////////////////////////////////////////////////////
static const char *process_pump_command(cJSON *command, char *result, size_t capacity) {
    cJSON *sequence = cJSON_GetObjectItemCaseSensitive(command,"control_sequence");
    if (!number_in(sequence,1,9007199254740991.0)) return "invalid_control_sequence";
    uint64_t seq = (uint64_t)sequence->valuedouble;
    if (seq <= s_control_sequence) return "stale_control_sequence";
    s_control_sequence = seq;
    cJSON *type = cJSON_GetObjectItemCaseSensitive(command,"type");
    cJSON *payload = cJSON_GetObjectItemCaseSensitive(command,"payload");
    cJSON *channel = cJSON_GetObjectItemCaseSensitive(payload,"channel");
    int target = -1;
    esp_err_t err;
    if (same_string(type,"stop")) {
        if (!channel) err = dosing_service_cancel();
        else {
            if (!number_in(channel,0,7)) return "invalid_pump_request";
            target = (int)channel->valuedouble;
            actuator_status_t current;
            actuator_get_status(&current);
            actuator_request_t request = {
                .source = ACTUATOR_SOURCE_REMOTE_DEBUG, .config_version = current.config_version,
                .channel = (uint8_t)target, .duty_percent = 0,
            };
            dosing_service_status_t dose; dosing_service_get_status(&dose);
            err = dose.active ? dosing_service_cancel() : actuator_set(&request);
        }
    } else {
        bool auxiliary = same_string(type,"aux_apply");
        cJSON *percent = cJSON_GetObjectItemCaseSensitive(payload,"value_percent");
        cJSON *pulse = cJSON_GetObjectItemCaseSensitive(payload,"pulse_us");
        cJSON *version = cJSON_GetObjectItemCaseSensitive(payload,"expected_config_version");
        cJSON *lease = cJSON_GetObjectItemCaseSensitive(command,"lease_deadline_uptime_ms");
        if (!number_in(channel,auxiliary ? 8 : 0,auxiliary ? 9 : 7) ||
            ((auxiliary && channel->valuedouble==9) ? (!number_in(pulse,500,2500) || percent!=NULL) :
             (!number_in(percent,0,100) || pulse!=NULL)) ||
            !number_in(version,1,UINT32_MAX) ||
            !valid_id(cJSON_GetObjectItemCaseSensitive(payload,"session_id"))) return "invalid_pump_request";
        target = (int)channel->valuedouble;
        int64_t now = uptime_ms();
        if (!number_in(lease,now + 1,now + 6000)) return "debug_session_expired";
        actuator_request_t request = {
            .source = ACTUATOR_SOURCE_REMOTE_DEBUG,
            .config_version = (uint32_t)version->valuedouble,
            .channel = (uint8_t)channel->valuedouble,
            .duty_percent = percent ? (uint8_t)percent->valuedouble : 0,
            .pulse_us = pulse ? (uint16_t)pulse->valuedouble : 0,
            .duration_ms = 5000,
            .expires_at_ms = (int64_t)cJSON_GetObjectItemCaseSensitive(command,"deadline_uptime_ms")->valuedouble,
            .stop_at_ms = (int64_t)lease->valuedouble,
        };
        err = actuator_set(&request);
    }
    if (err != ESP_OK) return esp_err_to_name(err);
    actuator_status_t pumps;
    actuator_get_status(&pumps);
    unsigned applied = pumps.output_enabled && target >= 0 ? pumps.duty_percent[target] : 0;
    uint32_t remaining = target >= 0 ? pumps.remaining_ms_by_channel[target] : 0;
    snprintf(result,capacity,"{\"applied_value_percent\":%u,\"applied_pulse_us\":%u,\"applied_config_version\":%"PRIu32
             ",\"maximum_run_ms\":5000,\"remaining_ms\":%"PRIu32",\"registers_verified\":%s}",
             applied,pumps.servo_pulse_us,pumps.config_version,remaining,pumps.registers_verified ? "true" : "false");
    return NULL;
}
#endif

// 配液参数显式传入并逐项限界；命令完成只表示本地任务接受，最终结果看遥测。
#if WEB_CLIENT_OUTLET_CONTROL && WEB_CLIENT_HX711_SCALE1
static const char *process_dosing_command(cJSON *command, char *result, size_t capacity) {
    cJSON *sequence=cJSON_GetObjectItemCaseSensitive(command,"control_sequence");
    if(!number_in(sequence,1,9007199254740991.0))return "invalid_control_sequence";
    uint64_t seq=(uint64_t)sequence->valuedouble;
    if(seq<=s_control_sequence)return "stale_control_sequence";
    s_control_sequence=seq;
    cJSON *type=cJSON_GetObjectItemCaseSensitive(command,"type"), *payload=cJSON_GetObjectItemCaseSensitive(command,"payload");
    cJSON *version=cJSON_GetObjectItemCaseSensitive(payload,"expected_position_version");
    if(!number_in(version,1,INT32_MAX-1))return "invalid_position_version";
    esp_err_t err;
    if(same_string(type,"outlet_configure")) {
        cJSON *v=cJSON_GetObjectItemCaseSensitive(payload,"vessel_us"), *w=cJSON_GetObjectItemCaseSensitive(payload,"waste_us");
        if(!number_in(v,500,2500)||!number_in(w,500,2500)||v->valuedouble==w->valuedouble)return "invalid_servo_positions";
        err=dosing_service_save_positions((uint32_t)version->valuedouble,(uint16_t)v->valuedouble,(uint16_t)w->valuedouble);
    } else {
        dosing_config_t config={0};
        cJSON *params=cJSON_GetObjectItemCaseSensitive(payload,"config");
#define PARAM(name, low, high) do { cJSON *v=cJSON_GetObjectItemCaseSensitive(params,#name); \
    if(!number_in(v,low,high)) { return "invalid_dosing_config"; } config.name=v->valuedouble; } while(0)
        PARAM(version,1,INT32_MAX); PARAM(minimum_percent,40,100); PARAM(fast_percent,40,100);
        PARAM(slow_percent,40,100); PARAM(fine_percent,40,100); PARAM(air_percent,1,100);
        PARAM(route_ms,100,5000); PARAM(purge_ms,100,10000); PARAM(settle_min_ms,200,60000);
        PARAM(settle_timeout_ms,201,60000); PARAM(step_timeout_ms,1000,600000);
        PARAM(total_timeout_ms,1000,3600000); PARAM(no_flow_ms,500,600000);
        PARAM(pulse_min_ms,60,1000); PARAM(pulse_max_ms,60,1000); PARAM(max_jogs,1,100); PARAM(tail_ms,0,5000);
        PARAM(slow_margin_mg,1,10000000); PARAM(fine_margin_mg,1,10000000); PARAM(compensation_mg,0,10000000);
        PARAM(max_flow_mg_s,1,10000000); PARAM(progress_mg,1,1000000); PARAM(residual_limit_mg,0,10000000);
        PARAM(balance_tolerance_mg,1,1000000); PARAM(vessel_capacity_mg,1,1000000000); PARAM(purge_leak_tolerance_mg,1,1000000);
#undef PARAM
        if(!dosing_config_valid(&config))return "invalid_dosing_config";
        cJSON *array=cJSON_GetObjectItemCaseSensitive(payload,"steps");
        int count=cJSON_GetArraySize(array); dosing_step_t steps[8];
        if(!cJSON_IsArray(array)||count<1||count>8)return "invalid_dosing_steps";
        for(int i=0;i<count;++i) {
            cJSON *s=cJSON_GetArrayItem(array,i), *ch=cJSON_GetObjectItemCaseSensitive(s,"channel");
            cJSON *t=cJSON_GetObjectItemCaseSensitive(s,"target_mg"), *tol=cJSON_GetObjectItemCaseSensitive(s,"tolerance_mg");
            if(!number_in(ch,0,7)||!number_in(t,1,100000000)||!number_in(tol,1,10000000))return "invalid_dosing_steps";
            steps[i]=(dosing_step_t){.channel=(uint8_t)ch->valuedouble,.target_mg=(int32_t)t->valuedouble,.tolerance_mg=(int32_t)tol->valuedouble};
        }
        err=dosing_service_start(&config,steps,(unsigned)count,(uint32_t)version->valuedouble);
    }
    if(err!=ESP_OK)return esp_err_to_name(err);
    dosing_service_status_t s; dosing_service_get_status(&s);
    snprintf(result,capacity,"{\"accepted\":true,\"position_version\":%"PRIu32",\"run_id\":%"PRIu32"}",s.position_version,s.run_id);
    return NULL;
}
#endif

/////////////////////////////////////////////////////////////////////////////
// 函数名：process_command
// 作用：验证身份、启动代次、有效期、幂等缓存和版本，分发泵控制或称重校准。
// 参数1：command，借用已解析 JSON；参数2：cached，接收缓存地址，禁止跨任务使用。
// 用于：command_task；示例：process_command(c, &ack)，回读成功后才返回完成。
/////////////////////////////////////////////////////////////////////////////
static bool process_command(cJSON *command, cached_ack_t **cached) {
    cJSON *id=cJSON_GetObjectItemCaseSensitive(command,"id"); if(!valid_id(id))return false;
    if(!same_string(cJSON_GetObjectItemCaseSensitive(command,"device_id"),WEB_CLIENT_DEVICE_ID) || !same_string(cJSON_GetObjectItemCaseSensitive(command,"boot_id"),s_boot))return false;
    for(unsigned i=0;i<8;i++)if(strcmp(s_acks[i].id,id->valuestring)==0){*cached=&s_acks[i];return true;}
    cJSON *deadline=cJSON_GetObjectItemCaseSensitive(command,"deadline_uptime_ms");
    cJSON *schema=cJSON_GetObjectItemCaseSensitive(command,"schema_version");
    cJSON *type=cJSON_GetObjectItemCaseSensitive(command,"type"), *payload=cJSON_GetObjectItemCaseSensitive(command,"payload");
    const char *reason=NULL; uint32_t applied=0, version=0;
    char result[256] = "{\"ok\":true}";
    if(!number_in(schema,1,1) || !valid_id(cJSON_GetObjectItemCaseSensitive(command,"request_id")))reason="unsupported_schema";
    else if(!number_in(deadline,uptime_ms(),uptime_ms()+60000))reason="command_expired";
    else if(same_string(type,"set_upload_interval")) {
        cJSON *interval=cJSON_GetObjectItemCaseSensitive(payload,"interval_ms"), *expected=cJSON_GetObjectItemCaseSensitive(payload,"expected_config_version");
        if(!number_in(interval,200,10000)||!number_in(expected,1,2147483646))reason="invalid_range";
        else {
            portENTER_CRITICAL(&s_config_lock);
            if((uint32_t)expected->valuedouble!=s_version)reason="config_version_conflict";
            else {s_interval=(uint32_t)interval->valuedouble;s_version++;applied=s_interval;version=s_version;}
            portEXIT_CRITICAL(&s_config_lock);
        }
    }
#if WEB_CLIENT_PUMP_CONTROL
    else if(same_string(type,"debug_apply") || same_string(type,"aux_apply") || same_string(type,"stop")) {
        reason = process_pump_command(command,result,sizeof(result));
    }
#endif
#if WEB_CLIENT_OUTLET_CONTROL && WEB_CLIENT_HX711_SCALE1
    else if(same_string(type,"outlet_configure") || same_string(type,"dosing_start")) {
        reason=process_dosing_command(command,result,sizeof(result));
    }
#endif
#if WEB_CLIENT_HX711_SCALE1
    else if(same_string(type,"weight_tare") || same_string(type,"weight_calibrate") || same_string(type,"weight_reset") || same_string(type,"weight_configure")) {
        cJSON *channel = cJSON_GetObjectItemCaseSensitive(payload,"channel");
        cJSON *expected = cJSON_GetObjectItemCaseSensitive(payload,"expected_calibration_version");
        cJSON *mass = cJSON_GetObjectItemCaseSensitive(payload,"reference_mg");
        bool calibrate = same_string(type,"weight_calibrate");
        bool configure = same_string(type,"weight_configure");
        cJSON *raw_band = cJSON_GetObjectItemCaseSensitive(payload,"raw_band");
        cJSON *noise_band = cJSON_GetObjectItemCaseSensitive(payload,"noise_band_mg");
        if (!number_in(channel,0,8) || !number_in(expected,1,INT32_MAX) ||
            (calibrate && !number_in(mass,1,1000000000)) ||
            (configure && (!number_in(raw_band,1,100000) || !number_in(noise_band,1,10000)))) reason="invalid_weight_request";
        else {
            actuator_status_t pumps = {0};
            dosing_service_status_t dose; dosing_service_get_status(&dose);
#if WEB_CLIENT_PUMP_CONTROL
            actuator_get_status(&pumps);
#endif
            esp_err_t err = (pumps.output_enabled || dose.active) ? ESP_ERR_INVALID_STATE :
                calibrate ? weight_service_calibrate((unsigned)channel->valuedouble, (uint32_t)expected->valuedouble, (int32_t)mass->valuedouble) :
                configure ? weight_service_configure((unsigned)channel->valuedouble, (uint32_t)expected->valuedouble,
                                                    (uint32_t)raw_band->valuedouble, (uint32_t)noise_band->valuedouble) :
                same_string(type,"weight_reset") ? weight_service_reset((unsigned)channel->valuedouble, (uint32_t)expected->valuedouble) :
                            weight_service_tare((unsigned)channel->valuedouble, (uint32_t)expected->valuedouble);
            if (err != ESP_OK) reason = pumps.output_enabled ? "pump_busy" : err == ESP_ERR_INVALID_STATE ? "weight_not_ready" : esp_err_to_name(err);
            else {
                weight_service_status_t weight;
                weight_service_get_status((unsigned)channel->valuedouble, &weight);
                snprintf(result,sizeof(result),"{\"calibration_version\":%"PRIu32",\"calibrated\":%s}",
                         weight.version,weight.calibrated ? "true" : "false");
            }
        }
    }
#endif
    else if(!same_string(type,"ping"))reason="hardware_control_pending";
    cached_ack_t *ack=&s_acks[s_ack_index++%8]; snprintf(ack->id,sizeof(ack->id),"%s",id->valuestring);
    if(reason)snprintf(result,sizeof(result),"{\"reason\":\"%s\"}",reason);
    else if(applied)snprintf(result,sizeof(result),"{\"applied_interval_ms\":%"PRIu32",\"applied_config_version\":%"PRIu32"}",applied,version);
    snprintf(ack->body,sizeof(ack->body),"{\"schema_version\":1,\"device_id\":\"%s\",\"boot_id\":\"%s\",\"status\":\"%s\",\"result\":%s}",WEB_CLIENT_DEVICE_ID,s_boot,reason?"rejected":"completed",result);
    *cached=ack; return true;
}

/////////////////////////////////////////////////////////////////////////////
// 函数名：command_task
// 作用：25 秒长轮询使用 30 秒请求超时，回执失败保留同 ID 结果供重投确认。
// 参数：arg，未使用；用于独立任务，不阻塞遥测。示例：xTaskCreate 创建。
/////////////////////////////////////////////////////////////////////////////
static void command_task(void *arg) {
    (void)arg; char request[256], response[4096], ack_path[128]; uint32_t backoff=1000;
    esp_http_client_handle_t client = NULL;
    snprintf(request,sizeof(request),"{\"schema_version\":1,\"device_id\":\"%s\",\"boot_id\":\"%s\",\"wait_ms\":25000}",WEB_CLIENT_DEVICE_ID,s_boot);
    for (;;) {
        xEventGroupWaitBits(s_events,CONNECTED_BIT|REGISTERED_BIT,pdFALSE,pdTRUE,portMAX_DELAY);
        esp_err_t err=post_json(&client,"/device/commands/poll",request,response,sizeof(response),30000,NULL);
        if(err==ESP_OK) {
            backoff=1000;
            cJSON *root=cJSON_Parse(response),*c=cJSON_GetObjectItemCaseSensitive(root,"command");
            cached_ack_t *ack=NULL;
            if(cJSON_IsObject(c)&&process_command(c,&ack)) {
                snprintf(ack_path,sizeof(ack_path),"/device/commands/%s/ack",ack->id);
                err=post_json(&client,ack_path,ack->body,response,sizeof(response),5000,NULL);
                if (s_telemetry_task) xTaskNotifyGive(s_telemetry_task);
                ESP_LOGI(TAG,"command %s: acknowledgement %s",ack->id,err==ESP_OK?"confirmed":"pending retry");
            }
            cJSON_Delete(root);
        }
        if(err!=ESP_OK) {vTaskDelay(pdMS_TO_TICKS(backoff+esp_random()%250));if(backoff<16000)backoff*=2;}
    }
}

/////////////////////////////////////////////////////////////////////////////
// 函数名：app_main
// 作用：初始化泵为全关，启动九路称重采集，再以无省电、HT20 的网络配置连接。
// 参数：无；用于 WEB_CLIENT=1 profile；示例：ESP-IDF 自动调用。
/////////////////////////////////////////////////////////////////////////////
void app_main(void) {
#if WEB_CLIENT_PUMP_CONTROL
    const actuator_config_t pump_config = {
        .version = ACTUATOR_CONFIG_VERSION, .pwm_hz = PUMP_PWM_HZ,
        .maximum_percent = PUMP_MAX_PERCENT, .maximum_run_ms = 600000,
        .minimum_percent = PUMP_MIN_PERCENT,
#if WEB_CLIENT_OUTLET_CONTROL
        .auxiliaries_enabled = true,
#endif
    };
    esp_err_t pump_error = actuator_init(&pump_config);
    if (pump_error != ESP_OK) ESP_LOGE(TAG,"Pump initialization failed: %s",esp_err_to_name(pump_error));
#endif
#if WEB_CLIENT_HX711_SCALE1
    esp_err_t nvs_error = nvs_flash_init();
    if (nvs_error != ESP_OK) ESP_LOGE(TAG,"NVS init: %s (no automatic erase)",esp_err_to_name(nvs_error));
    esp_err_t weight_error = weight_service_start(HX711_ENABLED_MASK);
    if (weight_error != ESP_OK) ESP_LOGE(TAG,"Weight initialization failed: %s",esp_err_to_name(weight_error));
#endif
#if WEB_CLIENT_OUTLET_CONTROL && WEB_CLIENT_HX711_SCALE1
    esp_err_t dose_error = dosing_service_init();
    if (dose_error != ESP_OK) ESP_LOGE(TAG,"Dosing initialization failed: %s",esp_err_to_name(dose_error));
#endif
    const size_t ssid_length=strlen(WEB_CLIENT_WIFI_SSID), password_length=strlen(WEB_CLIENT_WIFI_PASSWORD), url_length=strlen(WEB_CLIENT_SERVER_URL);
    if(!ssid_length||ssid_length>32||password_length>63||strlen(WEB_CLIENT_DEVICE_TOKEN)<24||url_length<10||url_length>200) {
        ESP_LOGE(TAG,"Configure main/web_client.local.h using scripts/configure_web_client.py before network use"); return;
    }
    if(WEB_CLIENT_SERVER_URL[url_length-1]=='/' || (strncmp(WEB_CLIENT_SERVER_URL,"http://",7)!=0&&strncmp(WEB_CLIENT_SERVER_URL,"https://",8)!=0)) {
        ESP_LOGE(TAG,"Server URL must use HTTP(S) and omit trailing slash"); return;
    }
    ESP_ERROR_CHECK(nvs_flash_init()); /* 不自动擦除整个 NVS 分区。 */
    s_events=xEventGroupCreate(); if(!s_events){ESP_LOGE(TAG,"No memory for network event group");return;}
    uint32_t random[4]; esp_fill_random(random,sizeof(random));
    snprintf(s_boot,sizeof(s_boot),"%08"PRIx32"%08"PRIx32"%08"PRIx32"%08"PRIx32,random[0],random[1],random[2],random[3]);
    s_https=strncmp(WEB_CLIENT_SERVER_URL,"https://",8)==0;
    ESP_ERROR_CHECK(esp_netif_init()); ESP_ERROR_CHECK(esp_event_loop_create_default());
    if(!esp_netif_create_default_wifi_sta()){ESP_LOGE(TAG,"No memory for Wi-Fi netif");return;}
    wifi_init_config_t init=WIFI_INIT_CONFIG_DEFAULT(); ESP_ERROR_CHECK(esp_wifi_init(&init));
    ESP_ERROR_CHECK(esp_wifi_set_storage(WIFI_STORAGE_RAM));
    ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT,ESP_EVENT_ANY_ID,wifi_event,NULL));
    ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT,IP_EVENT_STA_GOT_IP,wifi_event,NULL));
    wifi_config_t config={0};
    memcpy(config.sta.ssid,WEB_CLIENT_WIFI_SSID,ssid_length); memcpy(config.sta.password,WEB_CLIENT_WIFI_PASSWORD,password_length);
    config.sta.threshold.authmode=password_length?WIFI_AUTH_WPA2_PSK:WIFI_AUTH_OPEN;
    // 扫描全部信道后按 RSSI 选择同名 AP，避免快速扫描停在第一个较弱的热点。
    config.sta.scan_method = WIFI_ALL_CHANNEL_SCAN;
    config.sta.sort_method = WIFI_CONNECT_AP_BY_SIGNAL;
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA,&config));
    // 遥测无需 HT40 峰值吞吐，20 MHz 在拥挤的 2.4 GHz 环境中更合适。
    ESP_ERROR_CHECK(esp_wifi_set_bandwidth(WIFI_IF_STA, WIFI_BW_HT20));
    ESP_ERROR_CHECK(esp_wifi_start());
    ESP_ERROR_CHECK(esp_wifi_set_ps(WIFI_PS_NONE)); // 持续供电称重，关闭省电等待以降低交互延迟。
    ESP_ERROR_CHECK(esp_wifi_set_max_tx_power(WEB_CLIENT_WIFI_TX_POWER_QDBM));
    if(s_https){esp_sntp_setoperatingmode(SNTP_OPMODE_POLL);esp_sntp_setservername(0,"pool.ntp.org");esp_sntp_init();}
    ESP_LOGI(TAG,"Device=%s; real weighing telemetry every 200 ms",WEB_CLIENT_DEVICE_ID);
    if(xTaskCreate(connection_task,"wifi_connect",4096,NULL,3,NULL)!=pdPASS ||
       xTaskCreate(telemetry_task,"telemetry",20480,NULL,4,&s_telemetry_task)!=pdPASS ||
       xTaskCreate(command_task,"command_poll",12288,NULL,4,NULL)!=pdPASS) {
        ESP_LOGE(TAG,"Network task allocation failed; stopping Wi-Fi"); esp_wifi_stop();
    }

}
