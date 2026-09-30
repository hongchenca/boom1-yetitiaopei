/* 网络联调入口：仅在私有配置显式启用时探测单路 HX711 原始计数；永不驱动泵/PCA9685。 */
#include <inttypes.h>
#include <math.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <time.h>
#include "cJSON.h"
#include "driver/uart.h"
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
#include "hx711.h"
#include "hx711_board.h"
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

#ifndef WEB_CLIENT_HX711_PROBE_CHANNEL
#define WEB_CLIENT_HX711_PROBE_CHANNEL -1
#endif

#if WEB_CLIENT_HX711_PROBE_CHANNEL < -1 || WEB_CLIENT_HX711_PROBE_CHANNEL >= HX711_BOARD_SCALE_COUNT
#error WEB_CLIENT_HX711_PROBE_CHANNEL must be -1 or 0..8
#endif

#define CONNECTED_BIT BIT0
#define DISCONNECTED_BIT BIT1
#define REGISTERED_BIT BIT2
static const char *TAG = "web_client";
static EventGroupHandle_t s_events;
static char s_boot[33];
static portMUX_TYPE s_config_lock = portMUX_INITIALIZER_UNLOCKED;
static uint32_t s_interval = 1000, s_version = 1;
static bool s_https;

typedef struct { char *data; size_t capacity, length; bool overflow; } response_t;
typedef struct { char id[81]; char body[512]; } cached_ack_t;
static cached_ack_t s_acks[8]; /* 仅 command_task 所有。缓存覆盖至少八个已处理命令。 */
static unsigned s_ack_index;
typedef struct {
    int32_t mass_mg;
    int32_t filtered_mg;
    uint32_t age_ms;
    bool valid;
    bool stable;
} serial_channel_t;
static serial_channel_t s_serial_channels[9];
static bool s_serial_test_enabled;
static portMUX_TYPE s_sample_lock = portMUX_INITIALIZER_UNLOCKED;

#if WEB_CLIENT_HX711_PROBE_CHANNEL >= 0
/////////////////////////////////////////////////////////////////////////////
// 函数名：hx711_probe_task
// 作用：对一台已确认电平与接线的 HX711 周期性打印原始 ADC 计数。
// 参数1：arg，未使用。
// 用于：仅本机串口台架诊断；不会进入网络称重遥测或执行器控制。
// 使用示例：由 app_main 在 WEB_CLIENT_HX711_PROBE_CHANNEL=0 时创建。
/////////////////////////////////////////////////////////////////////////////
static void hx711_probe_task(void *arg) {
    (void)arg;
    hx711_t scale = {0};
    const hx711_pin_pair_t pins = hx711_board_pins[WEB_CLIENT_HX711_PROBE_CHANNEL];
    esp_err_t err = hx711_init(&scale, pins.dout_gpio, pins.sck_gpio);
    if (err != ESP_OK) {
        ESP_LOGE("hx711_probe", "init failed: %s", esp_err_to_name(err));
        vTaskDelete(NULL);
        return;
    }
    ESP_LOGI("hx711_probe", "channel=%d DOUT=GPIO%d SCK=GPIO%d raw ADC counts only",
             WEB_CLIENT_HX711_PROBE_CHANNEL, (int)pins.dout_gpio, (int)pins.sck_gpio);
    for (;;) {
        int32_t raw = 0;
        err = hx711_read(&scale, 300, &raw);
        if (err == ESP_OK) {
            ESP_LOGI("hx711_probe", "CH%02d raw=%" PRId32 " counts (uncalibrated)",
                     WEB_CLIENT_HX711_PROBE_CHANNEL, raw);
        } else {
            ESP_LOGW("hx711_probe", "CH%02d read=%s (check wiring and power)",
                     WEB_CLIENT_HX711_PROBE_CHANNEL, esp_err_to_name(err));
        }
        vTaskDelay(pdMS_TO_TICKS(600));
    }
}
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
// 函数名：json_integer
// 作用：读取有限范围内的 JSON 整数，避免把浮点或溢出值用于测试遥测。
// 参数1：value，待校验 JSON 值；参数2/3：允许的最小/最大值。
// 参数4：result，可选输出整数。
// 用于：串口测试输入边界校验。
/////////////////////////////////////////////////////////////////////////////
static bool json_integer(cJSON *value, int64_t minimum, int64_t maximum, int64_t *result) {
    if (!cJSON_IsNumber(value) || !isfinite(value->valuedouble) ||
        floor(value->valuedouble) != value->valuedouble ||
        value->valuedouble < (double)minimum || value->valuedouble > (double)maximum) {
        return false;
    }
    if (result) *result = (int64_t)value->valuedouble;
    return true;
}

/////////////////////////////////////////////////////////////////////////////
// 函数名：serial_channel_value
// 作用：解析一条串口通道样本；valid=false 时将数值归零为本地占位，不上传为有效称重。
// 参数1：item，JSON 对象；参数2：output，解析结果。
// 用于：串口测试任务。
/////////////////////////////////////////////////////////////////////////////
static bool serial_channel_value(cJSON *item, serial_channel_t *output, int *index) {
    int64_t channel, mass = 0, filtered = 0, age;
    cJSON *valid = cJSON_GetObjectItemCaseSensitive(item, "valid");
    cJSON *mass_value = cJSON_GetObjectItemCaseSensitive(item, "mass_mg");
    cJSON *filtered_value = cJSON_GetObjectItemCaseSensitive(item, "filtered_mg");
    if (!cJSON_IsObject(item) ||
        !json_integer(cJSON_GetObjectItemCaseSensitive(item, "channel"), 0, 8, &channel) ||
        !json_integer(cJSON_GetObjectItemCaseSensitive(item, "age_ms"), 0, 60000, &age) ||
        !cJSON_IsBool(valid) ||
        (cJSON_IsTrue(valid) &&
         (!json_integer(mass_value, -1000000000, 1000000000, &mass) ||
          !json_integer(filtered_value, -1000000000, 1000000000, &filtered))) ||
        (mass_value && !cJSON_IsNull(mass_value) &&
         !json_integer(mass_value, -1000000000, 1000000000, &mass)) ||
        (filtered_value && !cJSON_IsNull(filtered_value) &&
         !json_integer(filtered_value, -1000000000, 1000000000, &filtered))) {
        return false;
    }
    output->mass_mg = (int32_t)mass;
    output->filtered_mg = (int32_t)filtered;
    output->age_ms = (uint32_t)age;
    output->valid = cJSON_IsTrue(valid);
    output->stable = cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(item, "stable"));
    if (!output->valid) output->mass_mg = output->filtered_mg = 0;
    *index = (int)channel;
    return true;
}

/////////////////////////////////////////////////////////////////////////////
// 函数名：serial_apply
// 作用：原子更新串口测试样本或上传周期；不接入 GPIO、HX711、泵和 PCA9685。
// 参数1：root，串口 JSON 对象；返回值表示格式和范围是否有效。
// 用于：serial_test_task。
/////////////////////////////////////////////////////////////////////////////
static bool serial_apply(cJSON *root) {
    serial_channel_t pending[9];
    int indices[9];
    size_t count = 0;
    int64_t interval_value = 0;
    bool has_interval = false;
    cJSON *interval = cJSON_GetObjectItemCaseSensitive(root, "interval_ms");
    if (interval) {
        if (!json_integer(interval, 200, 10000, &interval_value)) return false;
        has_interval = true;
    }
    cJSON *channels = cJSON_GetObjectItemCaseSensitive(root, "channels");
    if (cJSON_IsArray(channels)) {
        cJSON *item = NULL;
        cJSON_ArrayForEach(item, channels) {
            if (count >= 9 || !serial_channel_value(item, &pending[count], &indices[count])) return false;
            count++;
        }
    } else if (cJSON_HasObjectItem(root, "channel")) {
        if (!serial_channel_value(root, &pending[0], &indices[0])) return false;
        count = 1;
    } else if (!interval) {
        return false;
    }
    if (has_interval) {
        portENTER_CRITICAL(&s_config_lock);
        s_interval = (uint32_t)interval_value;
        s_version++;
        portEXIT_CRITICAL(&s_config_lock);
    }
    if (count > 0) {
        portENTER_CRITICAL(&s_sample_lock);
        for (size_t i = 0; i < count; i++) s_serial_channels[indices[i]] = pending[i];
        s_serial_test_enabled = true;
        portEXIT_CRITICAL(&s_sample_lock);
    }
    return true;
}

/////////////////////////////////////////////////////////////////////////////
// 函数名：serial_line
// 作用：处理一行串口测试命令；支持 JSON、STATUS 和 CLEAR，并返回可见结果。
// 参数：line，已写入 NUL 的可修改行缓冲。
// 用于：serial_test_task。
/////////////////////////////////////////////////////////////////////////////
static void serial_line(char *line) {
    while (*line == ' ' || *line == '\t') line++;
    size_t length = strlen(line);
    while (length > 0 && (line[length - 1] == '\r' || line[length - 1] == '\n' ||
                           line[length - 1] == ' ' || line[length - 1] == '\t')) line[--length] = 0;
    if (strcmp(line, "CLEAR") == 0) {
        portENTER_CRITICAL(&s_sample_lock);
        memset(s_serial_channels, 0, sizeof(s_serial_channels));
        s_serial_test_enabled = false;
        portEXIT_CRITICAL(&s_sample_lock);
        printf("SERIAL_OK clear\r\n");
        return;
    }
    if (strcmp(line, "STATUS") == 0) {
        bool enabled;
        uint32_t interval, version;
        portENTER_CRITICAL(&s_sample_lock); enabled = s_serial_test_enabled; portEXIT_CRITICAL(&s_sample_lock);
        portENTER_CRITICAL(&s_config_lock); interval = s_interval; version = s_version; portEXIT_CRITICAL(&s_config_lock);
        printf("SERIAL_STATUS enabled=%d interval_ms=%" PRIu32 " config_version=%" PRIu32 "\r\n",
               enabled ? 1 : 0, interval, version);
        return;
    }
    cJSON *root = cJSON_Parse(line);
    if (!root || !cJSON_IsObject(root) || !serial_apply(root)) {
        cJSON_Delete(root);
        printf("SERIAL_ERROR use {\"channel\":0,\"mass_mg\":12345,\"filtered_mg\":12300,\"valid\":true,\"stable\":true,\"age_ms\":0}\r\n");
        return;
    }
    cJSON_Delete(root);
    printf("SERIAL_OK accepted\r\n");
}

#if CONFIG_ESP_CONSOLE_UART
/////////////////////////////////////////////////////////////////////////////
// 函数名：serial_test_task
// 作用：从默认控制台 UART 逐行接收测试 JSON；与日志共用串口，仅用于联调。
// 参数：arg，未使用。
// 用于：WEB_CLIENT 测试 profile。
/////////////////////////////////////////////////////////////////////////////
static void serial_test_task(void *arg) {
    (void)arg;
    const uart_port_t port = (uart_port_t)CONFIG_ESP_CONSOLE_UART_NUM;
    uint8_t byte;
    char line[1024];
    size_t length = 0;
    bool discard_line = false;
    if (!uart_is_driver_installed(port)) {
        esp_err_t install = uart_driver_install(port, 2048, 0, 0, NULL, 0);
        if (install != ESP_OK && install != ESP_ERR_INVALID_STATE) {
            ESP_LOGE(TAG, "Serial test UART install failed: %s", esp_err_to_name(install));
            vTaskDelete(NULL);
            return;
        }
    }
    printf("SERIAL_TEST_READY format={\"channel\":0,\"mass_mg\":12345,\"filtered_mg\":12300,\"valid\":true,\"stable\":true,\"age_ms\":0}; commands=STATUS,CLEAR\r\n");
    for (;;) {
        int received = uart_read_bytes(port, &byte, 1, pdMS_TO_TICKS(100));
        if (received <= 0) continue;
        if (byte == '\r' || byte == '\n') {
            if (discard_line) { discard_line = false; length = 0; continue; }
            if (length > 0) {
                line[length] = 0;
                serial_line(line);
                length = 0;
            }
        } else if (discard_line) {
            continue;
        } else if (length + 1 < sizeof(line)) {
            line[length++] = (char)byte;
        } else {
            length = 0;
            discard_line = true;
            printf("SERIAL_ERROR line_too_long\r\n");
        }
    }
}
#endif

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
// 参数1：path，/device 开头的 API 后缀；参数2：body，调用期间有效的 JSON。
// 参数3：reply，调用方缓冲区；参数4：capacity，至少 1 字节。
// 参数5：timeout_ms，HTTP 超时；参数6：status，可为 NULL，接收 HTTP 状态。
// 用于：所有上行路径；示例：post_json(path, body, reply, sizeof(reply), 5000, NULL)。
/////////////////////////////////////////////////////////////////////////////
static esp_err_t post_json(const char *path, const char *body, char *reply, size_t capacity, int timeout_ms, int *status) {
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
    esp_http_client_handle_t client = esp_http_client_init(&config);
    if (!client) return ESP_ERR_NO_MEM;
    esp_err_t err = esp_http_client_set_header(client, "Content-Type", "application/json");
    if (err == ESP_OK) err = esp_http_client_set_header(client, "X-Device-Id", WEB_CLIENT_DEVICE_ID);
    if (err == ESP_OK) err = esp_http_client_set_header(client, "X-Device-Token", WEB_CLIENT_DEVICE_TOKEN);
    if (err == ESP_OK) err = esp_http_client_set_post_field(client, body, strlen(body));
    if (err == ESP_OK) err = esp_http_client_perform(client);
    int code = esp_http_client_get_status_code(client);
    if (status) *status = code;
    esp_http_client_cleanup(client);
    if (response.overflow) return ESP_ERR_INVALID_SIZE;
    return err != ESP_OK ? err : ((code >= 200 && code < 300) ? ESP_OK : ESP_FAIL);
}

/////////////////////////////////////////////////////////////////////////////
// 函数名：wifi_event
// 作用：发布连接位，事件线程不重连、不运行 HTTP。
// 参数1：arg，未使用；参数2：base，事件组；参数3：event，事件 ID。
// 参数4：data，事件数据，由 ESP-IDF 管理。
// 用于：系统事件循环；示例：通过 esp_event_handler_register 注册。
/////////////////////////////////////////////////////////////////////////////
static void wifi_event(void *arg, esp_event_base_t base, int32_t event, void *data) {
    (void)arg; (void)data;
    if (base == WIFI_EVENT && event == WIFI_EVENT_STA_DISCONNECTED) {
        xEventGroupClearBits(s_events, CONNECTED_BIT | REGISTERED_BIT);
        xEventGroupSetBits(s_events, DISCONNECTED_BIT);
    } else if (base == IP_EVENT && event == IP_EVENT_STA_GOT_IP) {
        xEventGroupClearBits(s_events, DISCONNECTED_BIT);
        xEventGroupSetBits(s_events, CONNECTED_BIT);
        ESP_LOGI(TAG, "Wi-Fi connected; telemetry enabled");
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
// 作用：构造真实网络状态；九路质量为 null，无有效传感器读数。
// 参数1：sequence，单调递增上报序号；参数2：buffer，输出 JSON。
// 参数3：capacity，缓冲区大小；用于 telemetry_task；示例：telemetry_json(seq, data, 4096)。
/////////////////////////////////////////////////////////////////////////////
static bool telemetry_json(uint64_t sequence, char *buffer, size_t capacity) {
    uint32_t interval, version;
    portENTER_CRITICAL(&s_config_lock); interval=s_interval; version=s_version; portEXIT_CRITICAL(&s_config_lock);
    wifi_ap_record_t ap; int rssi = esp_wifi_sta_get_ap_info(&ap) == ESP_OK ? ap.rssi : -127;
    serial_channel_t test_channels[9];
    bool serial_test;
    portENTER_CRITICAL(&s_sample_lock);
    memcpy(test_channels, s_serial_channels, sizeof(test_channels));
    serial_test = s_serial_test_enabled;
    portEXIT_CRITICAL(&s_sample_lock);
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
    cJSON_AddStringToObject(root,"firmware","web-client-0.2.0");
    cJSON_AddBoolToObject(caps,"telemetry",true); cJSON_AddBoolToObject(caps,"events",true);
    cJSON_AddBoolToObject(caps,"command_poll",true); cJSON_AddBoolToObject(caps,"weight",false);
    cJSON_AddBoolToObject(caps,"actuator",false); cJSON_AddBoolToObject(caps,"simulation",false);
    cJSON_AddBoolToObject(caps,"test_input",WEB_CLIENT_SERIAL_TEST != 0);
    cJSON_AddNumberToObject(status,"upload_interval_ms",interval); cJSON_AddNumberToObject(status,"config_version",version);
    cJSON_AddNumberToObject(status,"free_heap_bytes",esp_get_free_heap_size()); cJSON_AddNumberToObject(status,"wifi_rssi",rssi);
    cJSON_AddStringToObject(status,"task_state","idle");
    cJSON *channels = cJSON_AddArrayToObject(status,"channels");
    if (!channels) { cJSON_Delete(root); return false; }
    for (int i=0;i<9;i++) {
        cJSON *c=cJSON_CreateObject(); if (!c) { cJSON_Delete(root); return false; }
        cJSON_AddNumberToObject(c,"channel",i);
        if (serial_test && test_channels[i].valid) {
            cJSON_AddNumberToObject(c,"mass_mg",test_channels[i].mass_mg);
            cJSON_AddNumberToObject(c,"filtered_mg",test_channels[i].filtered_mg);
            cJSON_AddBoolToObject(c,"valid",true);
            cJSON_AddBoolToObject(c,"stable",test_channels[i].stable);
            cJSON_AddNumberToObject(c,"age_ms",test_channels[i].age_ms);
        } else {
            cJSON_AddNullToObject(c,"mass_mg"); cJSON_AddNullToObject(c,"filtered_mg");
            cJSON_AddBoolToObject(c,"valid",false); cJSON_AddBoolToObject(c,"stable",false);
            cJSON_AddNumberToObject(c,"age_ms",serial_test ? test_channels[i].age_ms : 0);
        }
        cJSON_AddItemToArray(channels,c);
    }
    cJSON *a=cJSON_AddObjectToObject(status,"actuator");
    if (!a) { cJSON_Delete(root); return false; }
    cJSON_AddNumberToObject(a,"channel",0); cJSON_AddNumberToObject(a,"requested_percent",0); cJSON_AddNumberToObject(a,"applied_percent",0);
    cJSON_AddStringToObject(a,"output","hardware_pending");
    bool ok=cJSON_PrintPreallocated(root,buffer,capacity,false); cJSON_Delete(root); return ok;
}

/////////////////////////////////////////////////////////////////////////////
// 函数名：telemetry_task
// 作用：上报、启动事件重试与退避。周期配置仅 RAM 生效，不写 NVS。
// 参数：arg，未使用；用于独立低优先级任务，栈与缓冲留在内部 RAM。
// 使用示例：xTaskCreate(telemetry_task, "telemetry", 8192, NULL, 4, NULL)。
/////////////////////////////////////////////////////////////////////////////
static void telemetry_task(void *arg) {
    (void)arg; char payload[4096], reply[512], event[384];
    uint64_t sequence=0; bool announced=false; uint32_t backoff=1000;
    snprintf(event,sizeof(event),"{\"schema_version\":1,\"device_id\":\"%s\",\"boot_id\":\"%s\",\"event_id\":\"boot-%s\",\"type\":\"boot\",\"payload\":{\"firmware\":\"web-client-0.2.0\"}}",WEB_CLIENT_DEVICE_ID,s_boot,s_boot);
    for (;;) {
        xEventGroupWaitBits(s_events,CONNECTED_BIT,pdFALSE,pdFALSE,portMAX_DELAY);
        int status=0;
        esp_err_t err=telemetry_json(sequence++,payload,sizeof(payload)) ? post_json("/device/telemetry",payload,reply,sizeof(reply),5000,&status) : ESP_ERR_NO_MEM;
        if (err==ESP_OK) {
            cJSON *r=cJSON_Parse(reply);
            bool accepted=cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(r,"accepted")); cJSON_Delete(r);
            if (accepted) {
                xEventGroupSetBits(s_events,REGISTERED_BIT); backoff=1000;
                if (!announced) announced=post_json("/device/events",event,reply,sizeof(reply),5000,NULL)==ESP_OK;
            } else err=ESP_FAIL;
        }
        uint32_t interval;
        portENTER_CRITICAL(&s_config_lock); interval=s_interval; portEXIT_CRITICAL(&s_config_lock);
        if (err!=ESP_OK) {
            xEventGroupClearBits(s_events,REGISTERED_BIT);
            ESP_LOGW(TAG,"upload failed: %s HTTP=%d",esp_err_to_name(err),status);
            interval=backoff; if(backoff<16000)backoff*=2;
        }
        vTaskDelay(pdMS_TO_TICKS(interval));
    }
}

/////////////////////////////////////////////////////////////////////////////
// 函数名：process_command
// 作用：验证身份、启动代次、有效期、幂等缓存和版本，只执行 ping/上报周期。
// 参数1：command，借用已解析 JSON；参数2：cached，接收缓存地址，禁止跨任务使用。
// 用于：command_task；示例：process_command(c, &ack)，硬件命令一律拒绝。
/////////////////////////////////////////////////////////////////////////////
static bool process_command(cJSON *command, cached_ack_t **cached) {
    cJSON *id=cJSON_GetObjectItemCaseSensitive(command,"id"); if(!valid_id(id))return false;
    if(!same_string(cJSON_GetObjectItemCaseSensitive(command,"device_id"),WEB_CLIENT_DEVICE_ID) || !same_string(cJSON_GetObjectItemCaseSensitive(command,"boot_id"),s_boot))return false;
    for(unsigned i=0;i<8;i++)if(strcmp(s_acks[i].id,id->valuestring)==0){*cached=&s_acks[i];return true;}
    cJSON *deadline=cJSON_GetObjectItemCaseSensitive(command,"deadline_uptime_ms");
    cJSON *schema=cJSON_GetObjectItemCaseSensitive(command,"schema_version");
    cJSON *type=cJSON_GetObjectItemCaseSensitive(command,"type"), *payload=cJSON_GetObjectItemCaseSensitive(command,"payload");
    const char *reason=NULL; uint32_t applied=0, version=0;
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
    } else if(!same_string(type,"ping"))reason="hardware_control_pending";
    cached_ack_t *ack=&s_acks[s_ack_index++%8]; snprintf(ack->id,sizeof(ack->id),"%s",id->valuestring);
    char result[160];
    if(reason)snprintf(result,sizeof(result),"{\"reason\":\"%s\"}",reason);
    else if(applied)snprintf(result,sizeof(result),"{\"applied_interval_ms\":%"PRIu32",\"applied_config_version\":%"PRIu32"}",applied,version);
    else snprintf(result,sizeof(result),"{\"ok\":true}");
    snprintf(ack->body,sizeof(ack->body),"{\"schema_version\":1,\"device_id\":\"%s\",\"boot_id\":\"%s\",\"status\":\"%s\",\"result\":%s}",WEB_CLIENT_DEVICE_ID,s_boot,reason?"rejected":"completed",result);
    *cached=ack; return true;
}

/////////////////////////////////////////////////////////////////////////////
// 函数名：command_task
// 作用：25 秒长轮询使用 30 秒请求超时，回执失败保留同 ID 结果供重投确认。
// 参数：arg，未使用；用于独立任务，不阻塞遥测。示例：xTaskCreate 创建。
/////////////////////////////////////////////////////////////////////////////
static void command_task(void *arg) {
    (void)arg; char request[256], response[2048], ack_path[128]; uint32_t backoff=1000;
    snprintf(request,sizeof(request),"{\"schema_version\":1,\"device_id\":\"%s\",\"boot_id\":\"%s\",\"wait_ms\":25000}",WEB_CLIENT_DEVICE_ID,s_boot);
    for (;;) {
        xEventGroupWaitBits(s_events,CONNECTED_BIT|REGISTERED_BIT,pdFALSE,pdTRUE,portMAX_DELAY);
        esp_err_t err=post_json("/device/commands/poll",request,response,sizeof(response),30000,NULL);
        if(err==ESP_OK) {
            backoff=1000;
            cJSON *root=cJSON_Parse(response),*c=cJSON_GetObjectItemCaseSensitive(root,"command");
            cached_ack_t *ack=NULL;
            if(cJSON_IsObject(c)&&process_command(c,&ack)) {
                snprintf(ack_path,sizeof(ack_path),"/device/commands/%s/ack",ack->id);
                err=post_json(ack_path,ack->body,response,sizeof(response),5000,NULL);
                ESP_LOGI(TAG,"command %s: acknowledgement %s",ack->id,err==ESP_OK?"confirmed":"pending retry");
            }
            cJSON_Delete(root);
        }
        if(err!=ESP_OK) {vTaskDelay(pdMS_TO_TICKS(backoff+esp_random()%250));if(backoff<16000)backoff*=2;}
    }
}

/////////////////////////////////////////////////////////////////////////////
// 函数名：app_main
// 作用：启动网络固件；可选单路 HX711 原始串口探测，缺网络配置仍可采样。
// 参数：无；用于 WEB_CLIENT=1 profile；示例：ESP-IDF 自动调用。
/////////////////////////////////////////////////////////////////////////////
void app_main(void) {
#if WEB_CLIENT_HX711_PROBE_CHANNEL >= 0
    if (xTaskCreate(hx711_probe_task, "hx711_probe", 3072, NULL, 3, NULL) != pdPASS) {
        ESP_LOGE(TAG, "HX711 raw probe task allocation failed");
    }
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
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA)); ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA,&config)); ESP_ERROR_CHECK(esp_wifi_start());
    if(s_https){esp_sntp_setoperatingmode(SNTP_OPMODE_POLL);esp_sntp_setservername(0,"pool.ntp.org");esp_sntp_init();}
    ESP_LOGI(TAG,"Network-only firmware; device=%s; hardware capabilities disabled%s",
             WEB_CLIENT_DEVICE_ID,
#if WEB_CLIENT_SERIAL_TEST
             "; serial test input enabled"
#else
             ""
#endif
    );
    if(xTaskCreate(connection_task,"wifi_connect",4096,NULL,3,NULL)!=pdPASS ||
       xTaskCreate(telemetry_task,"telemetry",10240,NULL,4,NULL)!=pdPASS ||
       xTaskCreate(command_task,"command_poll",8192,NULL,4,NULL)!=pdPASS) {
        ESP_LOGE(TAG,"Network task allocation failed; stopping Wi-Fi"); esp_wifi_stop();
    }
#if CONFIG_ESP_CONSOLE_UART && WEB_CLIENT_SERIAL_TEST
    if (xTaskCreate(serial_test_task, "serial_test", 4096, NULL, 3, NULL) != pdPASS) {
        ESP_LOGE(TAG, "Serial test task allocation failed");
    }
#endif
}
