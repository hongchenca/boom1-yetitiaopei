#include <assert.h>
#include <stdio.h>
#include <string.h>
#include "../dosing_controller.c"

static dosing_config_t config(void) {
    return (dosing_config_t){.version=1,.minimum_percent=40,.fast_percent=75,.slow_percent=50,.fine_percent=45,.air_percent=60,
        .route_ms=1000,.purge_ms=1500,.settle_min_ms=800,.settle_timeout_ms=10000,.step_timeout_ms=120000,.total_timeout_ms=600000,
        .no_flow_ms=5000,.pulse_min_ms=80,.pulse_max_ms=300,.max_jogs=20,.tail_ms=150,.slow_margin_mg=5000,.fine_margin_mg=1000,
        .compensation_mg=100,.max_flow_mg_s=50000,.progress_mg=100,.residual_limit_mg=3000,.balance_tolerance_mg=500,
        .vessel_capacity_mg=500000,.purge_leak_tolerance_mg=200};
}
static dosing_input_t input(int64_t now) {
    dosing_input_t in={.now_ms=now,.actuator_ok=true,.motors_off=true};
    for(unsigned i=0;i<9;++i)in.weights[i]=(dosing_weight_t){.valid=true,.stable=true,.control_mg=i==8?0:200000,
        .stable_mg=i==8?0:200000,.version=1,.sample_ms=now,.window_ms=200,.sequence=1,.filter_delay_ms=200};
    return in;
}
static unsigned visited;
static int32_t first_stop_mg;
static int32_t purge_settled_adjustment;
static void simulate(dosing_controller_t *c, dosing_input_t *in, bool noflow, bool leak) {
    unsigned off_ms=1000;
    for(unsigned tick=0;tick<40000 && c->active;++tick) {
        in->now_ms+=20;
        if(c->output.pump_percent || c->output.air_percent)off_ms=0; else off_ms+=20;
        if(!noflow && c->output.pump_percent) {
            int32_t gain=c->output.pump_percent*40*20/1000;
            in->weights[8].control_mg+=gain; in->weights[c->output.channel].control_mg-=gain;
        }
        if(leak && c->output.air_percent)in->weights[8].control_mg+=20;
        if(c->state==DOSE_PURGE_SETTLE && purge_settled_adjustment) {
            in->weights[8].control_mg+=purge_settled_adjustment;
            purge_settled_adjustment=0;
        }
        for(unsigned i=0;i<9;++i) {
            in->weights[i].sample_ms=in->now_ms; in->weights[i].sequence++;
            in->weights[i].stable=off_ms>=600;
            in->weights[i].stable_mg=in->weights[i].control_mg;
        }
        in->motors_off=!c->output.pump_percent && !c->output.air_percent;
        dosing_controller_tick(c,in);
        if(c->state==DOSE_STOPPING && !first_stop_mg)first_stop_mg=c->delivered_mg;
        visited|=1u<<c->state;
        assert(!(c->output.pump_percent && c->output.air_percent));
        assert(!c->output.pump_percent || c->output.pump_percent>=40);
        assert(!c->output.air_percent || c->output.route==DOSE_WASTE);
        if(!c->active)assert(!c->output.pump_percent && !c->output.air_percent && c->output.route==DOSE_ROUTE_OFF);
    }
    assert(!c->active);
}
static void expect_error(dosing_error_t error, void (*mutate)(dosing_input_t *)) {
    dosing_controller_t c={0}; dosing_config_t p=config(); dosing_step_t s={0,10000,250};
    dosing_input_t in=input(1000);
    assert(dosing_controller_start(&c,&p,&s,1,1000)); dosing_controller_tick(&c,&in);
    in.now_ms+=20; for(unsigned i=0;i<9;++i)in.weights[i].sample_ms=in.now_ms;
    mutate(&in); dosing_controller_tick(&c,&in);
    assert(c.state==DOSE_ERROR && c.error==error && !c.active && !c.output.pump_percent && !c.output.air_percent);
}
static void stale(dosing_input_t *i){i->weights[8].sample_ms-=501;}
static void changed(dosing_input_t *i){i->weights[0].version++;}
static void fault(dosing_input_t *i){i->actuator_ok=false;}
static void overdose(dosing_input_t *i){i->weights[8].control_mg=11000;}
static void loss(dosing_input_t *i){i->weights[0].control_mg-=20000;}
static void late(dosing_input_t *i){i->now_ms+=301;}
int main(void) {
    dosing_config_t p=config(); dosing_step_t steps[2]={{0,10000,250},{1,6000,250}};
    dosing_controller_t c={0}; dosing_input_t in=input(1000);
    p.fine_percent=39;assert(!dosing_controller_start(&c,&p,steps,2,1000)); p=config();
    assert(dosing_controller_start(&c,&p,steps,2,1000));assert(!dosing_controller_start(&c,&p,steps,2,1000));
    simulate(&c,&in,false,false);
    assert(c.state==DOSE_DONE && c.error==DOSE_OK);
    assert(c.dose_mg[0]>=9750 && c.dose_mg[0]<=10250 && c.dose_mg[1]>=5750 && c.dose_mg[1]<=6250);
    assert(visited&(1u<<DOSE_FAST));assert(visited&(1u<<DOSE_SLOW));assert(visited&(1u<<DOSE_FINE));
    assert(visited&(1u<<DOSE_JOG));assert(visited&(1u<<DOSE_PURGE));
    expect_error(DOSE_SENSOR,stale);expect_error(DOSE_CALIBRATION_CHANGED,changed);expect_error(DOSE_ACTUATOR,fault);
    expect_error(DOSE_OVERDOSE,overdose);expect_error(DOSE_MASS_BALANCE,loss);expect_error(DOSE_CONTROL_LATE,late);
    memset(&c,0,sizeof(c)); in=input(1000);assert(dosing_controller_start(&c,&p,steps,1,1000));simulate(&c,&in,true,false);
    assert(c.error==DOSE_NO_FLOW);
    // 小剂量只走脉冲时，无进展计时仍跨越多次停泵判稳，不被每次补液重置。
    dosing_step_t tiny={0,900,50};
    p=config();p.no_flow_ms=500;p.max_jogs=100;
    memset(&c,0,sizeof(c));in=input(1000);
    assert(dosing_controller_start(&c,&p,&tiny,1,1000));simulate(&c,&in,true,false);
    assert(c.error==DOSE_NO_FLOW && c.jogs>1 && c.jogs<100);
    // 上限是异常保护，超过时不能静默舍弃流速样本并继续高速输出。
    p=config();p.max_flow_mg_s=1000;
    memset(&c,0,sizeof(c));in=input(1000);
    assert(dosing_controller_start(&c,&p,steps,1,1000));simulate(&c,&in,false,false);
    assert(c.error==DOSE_FLOW_LIMIT && !c.output.pump_percent);
    // 较长尾流的预停质量可以大于慢速阈值，不能被裁成 1 g。
    p=config();p.tail_ms=1000;p.slow_margin_mg=1000;p.fine_margin_mg=100;
    memset(&c,0,sizeof(c));in=input(1000);first_stop_mg=0;
    assert(dosing_controller_start(&c,&p,steps,1,1000));simulate(&c,&in,false,false);
    assert(first_stop_mg>0 && first_stop_mg<8500);
    // 清液允许变化 0.2 g，不意味着 0.05 g 的单步容差可被放宽。
    // 两步任务的总容差不能掩盖第一步清液后减重。
    p=config();dosing_step_t precise[2]={{0,10000,50},{1,6000,500}};
    memset(&c,0,sizeof(c));in=input(1000);purge_settled_adjustment=-150;
    assert(dosing_controller_start(&c,&p,precise,2,1000));simulate(&c,&in,false,false);
    assert(c.error==DOSE_UNDERDOSE && c.step==0);
    p=config();
    memset(&c,0,sizeof(c)); in=input(1000);assert(dosing_controller_start(&c,&p,steps,1,1000));simulate(&c,&in,false,true);
    assert(c.error==DOSE_WASTE_LEAK || c.error==DOSE_OVERDOSE);
    memset(&c,0,sizeof(c));in=input(1000);in.weights[0].stable_mg=1000;
    assert(dosing_controller_start(&c,&p,steps,1,1000));dosing_controller_tick(&c,&in);assert(c.error==DOSE_INVENTORY);
    // 停后窗口不能复用停前 stable 标记；取消在所有阶段优先且无吹气收尾。
    for(unsigned s=DOSE_PRECHECK;s<=DOSE_PURGE_SETTLE;++s) {
        memset(&c,0,sizeof(c));in=input(1000);assert(dosing_controller_start(&c,&p,steps,1,1000));
        c.state=(dosing_state_t)s;c.output.pump_percent=50;c.output.air_percent=60;in.cancel=true;
        dosing_controller_tick(&c,&in);assert(c.state==DOSE_ABORTED && !c.active && c.output.route==DOSE_ROUTE_OFF);
    }
    memset(&c,0,sizeof(c));in=input(1000);assert(dosing_controller_start(&c,&p,steps,1,1000));dosing_controller_tick(&c,&in);
    c.state=DOSE_SETTLING;c.entered_ms=c.stopped_ms=1000;
    in.now_ms=2000;in.weights[8].sample_ms=1100;in.weights[0].sample_ms=1100;c.last_tick_ms=2000;
    dosing_controller_tick(&c,&in);assert(c.error==DOSE_SENSOR);
    puts("PASS actual controller: two-step dosing, deadzone-safe pulses, stable verification, waste purge, no-flow, sensor/version/I2C/overdose/loss/late faults, cancellation in every stage");
    return 0;
}
