// Real actuator register driver + real controller/service, fake I2C/scale/NVS only.
#define main actuator_regression_main
#include "../../actuator/tests/actuator_host.c"
#undef main
#include "../dosing_controller.c"
#define s_status s_dose_status
#include "../dosing_service.c"
#undef s_status
static positions_t flash_positions, staged_positions;
static bool positions_exist, fail_commit;
static int32_t masses[9];
static unsigned quiet_ms=1000;
static bool invalid_scale;
esp_err_t nvs_open(const char *name,int mode,nvs_handle_t *h) {assert(!strcmp(name,"outlet"));(void)mode;*h=1;return ESP_OK;}
esp_err_t nvs_get_blob(nvs_handle_t h,const char *key,void *value,size_t *length) {
    (void)h;assert(!strcmp(key,"positions"));assert(*length==sizeof(positions_t));
    if(!positions_exist)return ESP_ERR_NVS_NOT_FOUND;memcpy(value,&flash_positions,*length);return ESP_OK;
}
esp_err_t nvs_set_blob(nvs_handle_t h,const char *key,const void *value,size_t length) {
    (void)h;assert(!strcmp(key,"positions") && length==sizeof(positions_t));memcpy(&staged_positions,value,length);return ESP_OK;
}
esp_err_t nvs_commit(nvs_handle_t h) {(void)h;if(fail_commit)return ESP_FAIL;flash_positions=staged_positions;positions_exist=true;return ESP_OK;}
void nvs_close(nvs_handle_t h) {(void)h;}
void weight_service_get_status(unsigned channel,weight_service_status_t *w) {
    *w=(weight_service_status_t){.enabled=true,.initialized=true,.valid=!invalid_scale,.stable=quiet_ms>=600,
        .control_mg=masses[channel],.stable_mg=masses[channel],.version=1,.sample_sequence=(uint32_t)clock_ms/20,
        .sample_time_ms=clock_ms,.window_ms=200,.filter_delay_ms=200,.noise_mg=0};
}
static dosing_config_t config(void) {
    return (dosing_config_t){.version=1,.minimum_percent=40,.fast_percent=75,.slow_percent=50,.fine_percent=45,.air_percent=60,
        .route_ms=1000,.purge_ms=1500,.settle_min_ms=800,.settle_timeout_ms=10000,.step_timeout_ms=120000,.total_timeout_ms=600000,
        .no_flow_ms=5000,.pulse_min_ms=80,.pulse_max_ms=300,.max_jogs=20,.tail_ms=150,.slow_margin_mg=5000,.fine_margin_mg=1000,
        .compensation_mg=100,.max_flow_mg_s=50000,.progress_mg=100,.residual_limit_mg=3000,.balance_tolerance_mg=500,
        .vessel_capacity_mg=500000,.purge_leak_tolerance_mg=200};
}
static void simulate(void) {
    for(unsigned tick=0;tick<10000 && s_controller.active;++tick) {
        bool running=false;
        for(unsigned i=0;i<9;++i)if(s_status.duty_percent[i])running=true;
        quiet_ms=running?0:quiet_ms+20;
        for(unsigned i=0;i<8;++i) {
            int32_t gain=s_status.duty_percent[i]*40*20/1000;masses[8]+=gain;masses[i]-=gain;
        }
        clock_ms+=20;service_deadlines();service_tick();
        unsigned liquid=0;
        for(unsigned i=0;i<8;++i)if(s_status.duty_percent[i])liquid++;
        assert(liquid<=1 && !(liquid && s_status.duty_percent[8]));
        for(unsigned i=10;i<16;++i)assert(registers[PCA_LED0+i*4+3]==PCA_FULL);
    }
    assert(!s_controller.active);
}
int main(void) {
    assert(actuator_regression_main()==0);
    assert(actuator_stop_all()==ESP_OK);
    s_config.pwm_hz=50;s_config.auxiliaries_enabled=true;s_config.minimum_percent=40;
    s_status.auxiliaries_enabled=true;s_status.minimum_percent=40;s_status.pwm_hz=50;
    assert(actuator_clear_fault()==ESP_OK);
    actuator_request_t r=request(0,39,1000);assert(actuator_set(&r)==ESP_ERR_INVALID_ARG);
    r=request(9,0,1000);r.pulse_us=500;assert(actuator_set(&r)==ESP_OK);
    unsigned counts=registers[PCA_LED0+9*4+2] | registers[PCA_LED0+9*4+3]<<8;
    assert(counts==102 && !(registers[PCA_LED0+9*4+1]&PCA_FULL));
    r.pulse_us=2500;assert(actuator_set(&r)==ESP_OK);
    counts=registers[PCA_LED0+9*4+2] | registers[PCA_LED0+9*4+3]<<8;assert(counts==512);
    r=request(8,60,1000);assert(actuator_set(&r)==ESP_OK);
    r=request(0,45,1000);assert(actuator_set(&r)==ESP_ERR_INVALID_STATE);
    r=request(9,0,1000);r.pulse_us=1500;assert(actuator_set(&r)==ESP_ERR_INVALID_STATE);
    assert(actuator_stop_all()==ESP_OK);
    for(unsigned i=0;i<9;++i)masses[i]=i==8?0:200000;
    assert(dosing_service_init()==ESP_OK);
    dosing_config_t p=config();dosing_step_t steps[2]={{0,10000,250},{1,6000,250}};
    assert(dosing_service_start(&p,steps,2,1)==ESP_ERR_INVALID_STATE);
    assert(dosing_service_save_positions(1,1000,1000)==ESP_ERR_INVALID_ARG);
    assert(dosing_service_save_positions(1,1000,2000)==ESP_OK);
    fail_commit=true;assert(dosing_service_save_positions(2,1100,2100)==ESP_FAIL);fail_commit=false;
    assert(s_positions.vessel_us==1000 && s_positions.version==2);
    assert(dosing_service_start(&p,steps,2,1)==ESP_ERR_INVALID_STATE);
    assert(dosing_service_start(&p,steps,2,2)==ESP_OK);
    r=request(2,50,1000);assert(actuator_set(&r)==ESP_ERR_INVALID_STATE);
    assert(dosing_service_save_positions(2,1100,2100)==ESP_ERR_INVALID_STATE);
    simulate();assert(s_controller.state==DOSE_DONE);
    assert(!s_status.output_enabled && s_status.reserved_source==0);
    assert(s_controller.dose_mg[0]>=9750 && s_controller.dose_mg[1]>=5750);
    assert(dosing_service_start(&p,steps,1,2)==ESP_OK);
    int64_t before_route=clock_ms;
    readback_delay_ms=60;service_tick();
    assert(s_controller.state==DOSE_ROUTE_VESSEL && s_controller.entered_ms==before_route+60);
    // 总线耗时之后仍需完整等待 route_ms，期间续租不得重复重置到位计时。
    int64_t route_applied=s_controller.entered_ms;
    while(clock_ms<route_applied+p.route_ms-20) {
        clock_ms+=20;service_deadlines();service_tick();
        assert(!s_status.duty_percent[0] && s_controller.entered_ms==route_applied);
    }
    // 真正 stop_all 的代次改变使服务不能在下一次更新恢复动作。
    assert(actuator_stop_all()==ESP_OK);clock_ms+=20;service_tick();
    assert(s_controller.state==DOSE_ABORTED && !s_status.output_enabled && s_status.reserved_source==0);
    quiet_ms=1000;assert(dosing_service_start(&p,steps,1,2)==ESP_OK);service_tick();
    invalid_scale=true;clock_ms+=20;service_tick();assert(s_controller.state==DOSE_ERROR && s_controller.error==DOSE_SENSOR);
    invalid_scale=false;quiet_ms=1000;
    assert(dosing_service_start(&p,steps,1,2)==ESP_OK);service_tick();
    // 长时间失去控制节拍后，真实本地期限先停信号，任务随后判错，不自动续跑。
    clock_ms+=400;service_deadlines();service_tick();assert(!s_controller.active && !s_status.output_enabled);
    memset(&s_controller,0,sizeof(s_controller));s_mutex=NULL;s_positions=(positions_t){.magic=0x4f555431,.version=1};
    assert(dosing_service_init()==ESP_OK);assert(s_positions.version==2 && s_positions.vessel_us==1000 && s_positions.waste_us==2000);
    puts("PASS real service/actuator: CH8+CH9 counts, deadzone, liquid/air/route interlocks, NVS failure/reload, exclusive batch, two doses, cancel generation, sensor and expired lease shutdown");
    return 0;
}
