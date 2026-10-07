// telemetry_function.h 由脚本从当前 main/web_client.c 提取，不复制序列化逻辑。
#include <assert.h>
#include <stdio.h>
#include <string.h>
#include "host_stub.h"
#include "cJSON.h"
#include "weight_service.h"
#include "actuator.h"
#include "dosing_service.h"
#define WEB_CLIENT_HX711_SCALE1 1
#define WEB_CLIENT_PUMP_CONTROL 1
#define WEB_CLIENT_DEVICE_ID "123456789012345678901234567890123456789012345678"
#define WEB_CLIENT_FIRMWARE "web-client-0.5.0"
static char s_boot[]="0123456789abcdef0123456789abcdef";
static uint32_t s_interval=10000,s_version=2147483647,s_http_ms=4294967295u;
static portMUX_TYPE s_config_lock;
typedef struct { int rssi; } wifi_ap_record_t;
static int64_t uptime_ms(void) { return 9007199254740991LL; }
static int esp_wifi_sta_get_ap_info(wifi_ap_record_t *ap) { ap->rssi=-127; return ESP_OK; }
static unsigned esp_get_free_heap_size(void) { return 100000000; }
static const char *esp_err_to_name(esp_err_t err) { (void)err; return "ESP_ERR_NVS_NEW_VERSION_FOUND"; }
void actuator_get_status(actuator_status_t *a) {
    *a=(actuator_status_t){.initialized=true,.output_enabled=true,.active_channel=7,.duty_percent={10,20,30,40,50,60,70,100},
        .config_version=2147483647,.pwm_hz=1000,.maximum_percent=100,.remaining_ms=600000,
        .remaining_ms_by_channel={1000,2000,3000,4000,5000,6000,7000,600000}};
}
void weight_service_get_status(unsigned channel,weight_service_status_t *s) {
    (void)channel;
    *s=(weight_service_status_t){.enabled=true,.initialized=true,.raw_valid=true,.calibrated=true,.tare_ready=true,.valid=true,
        .raw_count=-8388607,.average_raw=-8388607,.mass_mg=-1000000000,.filtered_mg=-1000000000,
        .age_ms=500,.samples=16,.version=2147483647,.sample_period_ms=4294967295u,.sample_sequence=4294967295u,
        .noise_mg=4294967295u,.raw_band=100000,.noise_band_mg=10000};
}
#include "telemetry_function.h"
int main(void) {
    char payload[12288], small[128];
    assert(!telemetry_json(1,small,sizeof(small)));
    assert(telemetry_json(9007199254740991ULL,payload,sizeof(payload)));
    cJSON *root=cJSON_Parse(payload); assert(root);
    cJSON *channels=cJSON_GetObjectItem(cJSON_GetObjectItem(root,"status"),"channels");
    assert(cJSON_GetArraySize(channels)==9);
    for(unsigned i=0;i<9;++i) {
        cJSON *c=cJSON_GetArrayItem(channels,(int)i);
        assert(cJSON_GetObjectItem(c,"channel")->valueint==(int)i);
        assert(cJSON_GetObjectItem(c,"mass_mg")->valuedouble==-1000000000.0);
    }
    cJSON *actuator=cJSON_GetObjectItem(cJSON_GetObjectItem(root,"status"),"actuator");
    assert(cJSON_IsTrue(cJSON_GetObjectItem(actuator,"parallel_supported")));
    cJSON *duties=cJSON_GetObjectItem(actuator,"duty_percent");
    cJSON *remaining=cJSON_GetObjectItem(actuator,"remaining_ms_by_channel");
    assert(cJSON_GetArraySize(duties)==8 && cJSON_GetArraySize(remaining)==8);
    for(int i=0;i<8;++i) {
        assert(cJSON_GetArrayItem(duties,i)->valueint==(i==7 ? 100 : (i+1)*10));
        assert(cJSON_GetArrayItem(remaining,i)->valueint==(i==7 ? 600000 : (i+1)*1000));
    }
    printf("PASS actual firmware serializer: nine scales %u/12288 bytes; small buffer rejected\n",(unsigned)strlen(payload));
    cJSON_Delete(root);
    return 0;
}
