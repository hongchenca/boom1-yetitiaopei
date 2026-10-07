// 编译真实服务，硬件/NVS 替身验证九路隔离、持久化、噪声与滤波响应。
#include <assert.h>
#include <stdio.h>
#include "../weight_service.c"

static int64_t fake_us;
static int32_t values[9];
static esp_err_t errors[9];
static calibration_t flash[9], staged;
static bool exists[9], fail_commit;
static unsigned reads[9];
const hx711_pin_pair_t hx711_board_pins[9] = {{1,2},{4,5},{6,7},{14,15},{16,17},{18,21},{39,38},{41,40},{42,47}};
int64_t esp_timer_get_time(void) { return fake_us; }
void vTaskDelay(unsigned ticks) { fake_us += ticks * 1000; }
int xTaskCreate(void (*task)(void *), const char *name, unsigned stack, void *arg, unsigned priority, void *handle) {
    (void)task; (void)name; (void)stack; (void)arg; (void)priority; (void)handle; return pdPASS;
}
SemaphoreHandle_t xSemaphoreCreateMutex(void) { return (void *)1; }
int xSemaphoreTake(SemaphoreHandle_t s, unsigned t) { (void)s; (void)t; return pdTRUE; }
void xSemaphoreGive(SemaphoreHandle_t s) { (void)s; }
void vSemaphoreDelete(SemaphoreHandle_t s) { (void)s; }
esp_err_t nvs_open(const char *name, int mode, nvs_handle_t *handle) { assert(!strcmp(name,"weight")); (void)mode; *handle=1; return ESP_OK; }
esp_err_t nvs_get_blob(nvs_handle_t h, const char *key, void *value, size_t *length) {
    (void)h; unsigned c=0; assert(sscanf(key,"scale%u",&c)==1 && c<9);
    if (!exists[c]) return ESP_ERR_NVS_NOT_FOUND;
    assert(*length == sizeof(calibration_t)); memcpy(value,&flash[c],*length); return ESP_OK;
}
esp_err_t nvs_set_blob(nvs_handle_t h, const char *key, const void *value, size_t length) {
    (void)h; (void)key; assert(length==sizeof(staged)); memcpy(&staged,value,length); return ESP_OK;
}
esp_err_t nvs_commit(nvs_handle_t h) {
    (void)h; if(fail_commit) return ESP_FAIL;
    flash[staged.channel]=staged; exists[staged.channel]=true; return ESP_OK;
}
void nvs_close(nvs_handle_t h) { (void)h; }
esp_err_t hx711_init(hx711_t *d, gpio_num_t dout, gpio_num_t sck) {
    d->dout_gpio=dout; d->sck_gpio=sck; d->initialized=true; return ESP_OK;
}
esp_err_t hx711_deinit(hx711_t *d) { d->initialized=false; return ESP_OK; }
esp_err_t hx711_read(hx711_t *d, uint32_t timeout, int32_t *raw) {
    assert(timeout==0); unsigned i=0; while(hx711_board_pins[i].dout_gpio != d->dout_gpio) ++i;
    reads[i]++; if(errors[i]) return errors[i]; *raw=values[i]; return ESP_OK;
}
static void feed(unsigned count) { for(unsigned j=0;j<count;++j) { fake_us+=100000; sample_channels(); } }
static weight_service_status_t status(unsigned c) { weight_service_status_t s; weight_service_get_status(c,&s); return s; }
static void reboot(void) { memset(s_scales,0,sizeof(s_scales)); s_started=false; s_update_lock=NULL; assert(weight_service_start(511)==ESP_OK); }

int main(void) {
    assert(weight_service_start(0)==ESP_ERR_INVALID_ARG);
    reboot(); assert(weight_service_start(511)==ESP_ERR_INVALID_STATE);
    for(unsigned i=0;i<9;++i) values[i]=1000+(int32_t)i*100;
    feed(15); assert(!status(0).calibration_ready);
    assert(weight_service_tare(0,1)==ESP_ERR_INVALID_STATE);
    feed(7);
    for(unsigned i=0;i<9;++i) {
        assert(status(i).calibration_ready && !status(i).valid);
        assert(weight_service_tare(i,1)==ESP_OK);
        assert(weight_service_tare(i,1)==ESP_ERR_INVALID_STATE);
        assert(flash[i].zero==values[i] && flash[i].version==2);
        values[i]-=2000;
    }
    feed(22);
    for(unsigned i=0;i<9;++i) {
        assert(weight_service_calibrate(i,2,0)==ESP_ERR_INVALID_ARG);
        assert(weight_service_calibrate(i,2,100000)==ESP_OK);
    }
    feed(22);
    for(unsigned i=0;i<9;++i) assert(status(i).valid && status(i).stable && status(i).filtered_mg==100000);
    // 快速显示 5 次转换达到阶跃的 90%以上，校准平均仍未完全跟随。
    values[0]-=2000; feed(5);
    assert(status(0).filtered_mg>=190000 && status(0).filtered_mg<=200000);
    assert(!status(0).stable);
    values[0]+=2000; feed(22);
    // 单个尖峰被 median-of-3 拒绝，稳定窗口仍必须失效。
    values[0]+=2000; feed(1); assert(status(0).filtered_mg==100000 && !status(0).stable);
    values[0]-=2000; feed(22);
    errors[4]=ESP_ERR_TIMEOUT; values[6]=8388607; feed(5);
    assert(!status(4).valid && !status(6).valid && status(8).valid && status(0).valid);
    for(unsigned i=1;i<9;++i) assert(reads[i]==reads[0]);
    errors[4]=ESP_OK; values[6]=1600-2000; feed(22); assert(status(4).valid && status(6).valid);
    fake_us+=501000; assert(!status(8).valid && !status(8).calibration_ready);
    feed(22); fail_commit=true;
    assert(weight_service_reset(8,3)==ESP_FAIL);
    assert(status(8).version==3 && status(8).calibrated && flash[8].version==3);
    fail_commit=false; reboot(); feed(22);
    for(unsigned i=0;i<9;++i) assert(status(i).calibrated && status(i).saved && status(i).version==3 && status(i).filtered_mg==100000);
    assert(weight_service_configure(8,3,300,100)==ESP_OK);
    assert(weight_service_reset(7,3)==ESP_OK);
    reboot(); feed(22);
    assert(status(8).raw_band==300 && status(8).noise_band_mg==100 && status(8).version==4);
    assert(!status(7).calibrated && status(7).version==4 && status(7).saved);
    flash[6].sck=2; reboot(); feed(22);
    assert(!status(6).calibrated && status(6).storage_error==ESP_ERR_INVALID_RESPONSE && status(8).valid);
    // 低幅噪声独立量化：显示 RMS 小于控制快通道，但 stable 仍由未平滑原始窗口决定。
    values[0]=-1000;feed(40);
    assert(weight_service_configure(0,3,200,1000)==ESP_OK);feed(40);
    int64_t display_energy=0,control_energy=0;
    for(unsigned i=0;i<200;++i) {
        values[0]=-1000+(int32_t)(i%7)*2-6;feed(1);
        int64_t d=status(0).filtered_mg-100000, c=status(0).control_mg-100000;
        display_energy+=d*d;control_energy+=c*c;
    }
    assert(display_energy<control_energy);
    values[0]=-1000;feed(40);
    assert(status(0).window_ms==1500 && status(0).filter_delay_ms==200 && status(0).stable_mg==100000);
    // 一个 count 的正/负小阶跃最终必须收敛，整数 EMA 不能永久停在相邻 count。
    for(unsigned i=0;i<2;++i) {
        values[0]=i ? 1001 : -1001;feed(40);
        assert(status(0).control_mg==status(0).mass_mg);
        assert(status(0).filtered_mg==status(0).mass_mg);
        values[0]+=i ? -1 : 1;feed(40);
        assert(status(0).control_mg==status(0).mass_mg);
        assert(status(0).filtered_mg==status(0).mass_mg);
    }
    printf("PASS nine scales: nonblocking isolation, negative gain, step, impulse, stable gate, stale/recovery, NVS, display noise energy %lld < control %lld\n",(long long)display_energy,(long long)control_energy);
    return 0;
}
