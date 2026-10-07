#include <assert.h>
#include <stdio.h>
#include <string.h>
#include "host_stub.h"
#define GPIO_NUM_8 8
#define GPIO_NUM_9 9
#define GPIO_NUM_10 10
#define I2C_NUM_0 0
#define I2C_CLK_SRC_DEFAULT 0
#define I2C_ADDR_BIT_LEN_7 7
#define ESP_ERR_INVALID_VERSION 9
#define ESP_LOGE(...) ((void)0)
typedef void *i2c_master_bus_handle_t;
typedef void *i2c_master_dev_handle_t;
typedef struct {
    int i2c_port, sda_io_num, scl_io_num, clk_source, glitch_ignore_cnt;
    struct { int enable_internal_pullup; } flags;
} i2c_master_bus_config_t;
typedef struct { int dev_addr_length, device_address, scl_speed_hz; } i2c_device_config_t;
esp_err_t i2c_new_master_bus(const i2c_master_bus_config_t *, i2c_master_bus_handle_t *);
esp_err_t i2c_master_bus_add_device(i2c_master_bus_handle_t, const i2c_device_config_t *, i2c_master_dev_handle_t *);
esp_err_t i2c_master_probe(i2c_master_bus_handle_t, unsigned, unsigned);
esp_err_t i2c_master_transmit(i2c_master_dev_handle_t, const uint8_t *, size_t, unsigned);
esp_err_t i2c_master_transmit_receive(i2c_master_dev_handle_t, const uint8_t *, size_t, uint8_t *, size_t, unsigned);
esp_err_t i2c_master_bus_rm_device(i2c_master_dev_handle_t);
esp_err_t i2c_del_master_bus(i2c_master_bus_handle_t);
#include "../actuator.c"

static uint8_t registers[256];
static int64_t clock_ms;
static bool locked, fail_write, emergency_during_write;
static unsigned oe_level = 1;
static unsigned readback_delay_ms, readback_followup_delay_ms, unsafe_oe_enables;
static int watch_expired_channel = -1;
int64_t esp_timer_get_time(void) { return clock_ms * 1000; }
void vTaskDelay(unsigned ticks) { clock_ms += ticks; }
SemaphoreHandle_t xSemaphoreCreateMutex(void) { static uintptr_t next; return (void *)++next; }
int xSemaphoreTake(SemaphoreHandle_t s, unsigned timeout) {
    (void)timeout;
    if(s!=s_io_lock)return pdTRUE;
    if (locked) return 0;
    locked = true; return pdTRUE;
}
void xSemaphoreGive(SemaphoreHandle_t s) { if(s==s_io_lock)locked = false; }
void vSemaphoreDelete(SemaphoreHandle_t s) { (void)s; }
int xTaskCreate(void (*task)(void *), const char *name, unsigned stack, void *arg, unsigned priority, void *handle) {
    (void)task; (void)name; (void)stack; (void)arg; (void)priority; (void)handle; return pdPASS;
}
esp_err_t gpio_config(const gpio_config_t *c) { (void)c; return ESP_OK; }
esp_err_t gpio_set_level(gpio_num_t pin, unsigned level) {
    assert(pin == PCA_OE);
    if (!level && watch_expired_channel >= 0) {
        unsigned ch = (unsigned)watch_expired_channel;
        if (s_deadline_ms[ch] > 0 && clock_ms >= s_deadline_ms[ch] &&
            registers[PCA_LED0 + ch * 4 + 3] != PCA_FULL) ++unsafe_oe_enables;
    }
    oe_level = level; return ESP_OK;
}
esp_err_t i2c_new_master_bus(const i2c_master_bus_config_t *c, i2c_master_bus_handle_t *bus) {
    (void)c; *bus = (void *)1; return ESP_OK;
}
esp_err_t i2c_master_bus_add_device(i2c_master_bus_handle_t bus, const i2c_device_config_t *c, i2c_master_dev_handle_t *dev) {
    (void)bus; (void)c; *dev = (void *)1; return ESP_OK;
}
esp_err_t i2c_master_probe(i2c_master_bus_handle_t bus, unsigned address, unsigned timeout) {
    (void)bus; (void)address; (void)timeout; return ESP_OK;
}
esp_err_t i2c_master_transmit(i2c_master_dev_handle_t dev, const uint8_t *tx, size_t length, unsigned timeout) {
    (void)dev; (void)timeout;
    if (fail_write) { fail_write = false; return ESP_FAIL; }
    memcpy(registers + tx[0], tx + 1, length - 1);
    if (emergency_during_write) { emergency_during_write = false; actuator_emergency_stop(); }
    return ESP_OK;
}
esp_err_t i2c_master_transmit_receive(i2c_master_dev_handle_t dev, const uint8_t *tx, size_t tx_len,
                                    uint8_t *rx, size_t rx_len, unsigned timeout) {
    (void)dev; (void)timeout; assert(tx_len == 1);
    clock_ms += readback_delay_ms;
    readback_delay_ms = readback_followup_delay_ms; readback_followup_delay_ms = 0;
    memcpy(rx, registers + tx[0], rx_len); return ESP_OK;
}
esp_err_t i2c_master_bus_rm_device(i2c_master_dev_handle_t dev) { (void)dev; return ESP_OK; }
esp_err_t i2c_del_master_bus(i2c_master_bus_handle_t bus) { (void)bus; return ESP_OK; }

static actuator_request_t request(unsigned ch, unsigned duty, unsigned duration) {
    return (actuator_request_t){.source=ACTUATOR_SOURCE_REMOTE_DEBUG,.config_version=1,
        .channel=(uint8_t)ch,.duty_percent=(uint8_t)duty,.duration_ms=duration,.expires_at_ms=clock_ms+1000};
}
static void check_duty(unsigned ch, unsigned duty) {
    actuator_status_t status; actuator_get_status(&status);
    assert(status.duty_percent[ch] == duty);
    if (!duty) assert(registers[PCA_LED0 + ch * 4 + 3] == PCA_FULL);
    else {
        assert(oe_level == 0 && status.output_enabled);
        uint16_t counts = (uint16_t)((4096u * duty + 50) / 100);
        uint8_t expected[4] = {0,0,(uint8_t)counts,(uint8_t)(counts >> 8)};
        assert(!memcmp(registers + PCA_LED0 + ch * 4, expected, sizeof(expected)));
    }
}

int main(void) {
    actuator_config_t config={.version=1,.pwm_hz=100,.maximum_percent=80,.maximum_run_ms=10000};
    assert(actuator_init(&config) == ESP_OK);
    actuator_request_t a=request(0,40,1000), b=request(3,60,2000);
    assert(actuator_set(&a) == ESP_OK && actuator_set(&b) == ESP_OK);
    check_duty(0,40); check_duty(3,60);
    actuator_status_t before, after; actuator_get_status(&before);
    clock_ms+=100; a=request(0,50,1500); assert(actuator_set(&a) == ESP_OK);
    actuator_get_status(&after);
    assert(after.remaining_ms_by_channel[0] == 1500);
    assert(after.remaining_ms_by_channel[3] == before.remaining_ms_by_channel[3]-100);
    a=request(0,0,0); assert(actuator_set(&a) == ESP_OK); check_duty(0,0); check_duty(3,60);
    a=request(1,20,100); b=request(2,30,300);
    assert(actuator_set(&a) == ESP_OK && actuator_set(&b) == ESP_OK);
    clock_ms+=101; service_deadlines(); check_duty(1,0); check_duty(2,30); check_duty(3,60);
    a=request(4,20,300); a.source=ACTUATOR_SOURCE_LOCAL; assert(actuator_set(&a) == ESP_ERR_INVALID_STATE);
    a=request(4,81,300); assert(actuator_set(&a) == ESP_ERR_INVALID_ARG);
    a=request(4,20,300); a.expires_at_ms=clock_ms; assert(actuator_set(&a) == ESP_ERR_TIMEOUT);
    assert(actuator_stop_all() == ESP_OK); for(unsigned i=0;i<8;++i) check_duty(i,0); assert(oe_level==1);

    int64_t eight_started = clock_ms;
    for(unsigned i=0;i<8;++i) {
        a=request(i,(i+1)*10,1000+i*100); assert(actuator_set(&a) == ESP_OK);
    }
    uint8_t eight_registers[64]; memcpy(eight_registers,registers+PCA_LED0,sizeof(eight_registers));
    for(unsigned i=0;i<8;++i) check_duty(i,(i+1)*10);
    for(unsigned i=8;i<16;++i) assert(registers[PCA_LED0+i*4+3]==PCA_FULL);
    a=request(4,0,0); assert(actuator_set(&a) == ESP_OK); check_duty(4,0);
    for(unsigned i=0;i<8;++i) if(i!=4) {
        check_duty(i,(i+1)*10);
        assert(!memcmp(registers+PCA_LED0+i*4,eight_registers+i*4,4));
    }
    a=request(4,50,1400); assert(actuator_set(&a) == ESP_OK);
    for(unsigned i=0;i<8;++i) {
        clock_ms=eight_started+1000+i*100; service_deadlines();
        actuator_get_status(&after);
        for(unsigned ch=0;ch<8;++ch) {
            check_duty(ch,ch<=i ? 0 : (ch+1)*10);
            assert(after.remaining_ms_by_channel[ch]==(ch<=i ? 0 : (ch-i)*100));
        }
    }
    puts("PASS all eight actual PCA registers: concurrent PWM, single stop preserves other seven, staggered independent deadlines");

    a=request(0,20,100); b=request(2,30,1000);
    assert(actuator_set(&a) == ESP_OK && actuator_set(&b) == ESP_OK);
    clock_ms+=301; locked=true; service_deadlines(); locked=false;
    actuator_get_status(&after); assert(after.fault_latched && !after.output_enabled && oe_level==1);
    service_deadlines(); assert(actuator_clear_fault() == ESP_OK);

    a=request(0,20,1000); assert(actuator_set(&a) == ESP_OK);
    b=request(2,30,1000); fail_write=true; assert(actuator_set(&b) == ESP_FAIL);
    actuator_get_status(&after); assert(after.fault_latched && !after.output_enabled && oe_level==1);
    assert(actuator_set(&a) == ESP_ERR_INVALID_STATE); assert(actuator_clear_fault() == ESP_OK);
    emergency_during_write=true; a=request(0,20,1000); assert(actuator_set(&a) == ESP_ERR_INVALID_STATE);
    actuator_get_status(&after); assert(after.fault_latched && !after.output_enabled && oe_level==1);
    assert(actuator_clear_fault() == ESP_OK);
    a=request(0,20,40); b=request(2,30,1000);
    assert(actuator_set(&a) == ESP_OK && actuator_set(&b) == ESP_OK);
    watch_expired_channel=0; readback_delay_ms=50;
    b=request(1,40,500); assert(actuator_set(&b) == ESP_OK);
    assert(unsafe_oe_enables==0);
    check_duty(0,0); check_duty(1,40); check_duty(2,30);
    watch_expired_channel=-1; assert(actuator_stop_all() == ESP_OK);
    a=request(0,20,40); b=request(2,30,80);
    assert(actuator_set(&a) == ESP_OK && actuator_set(&b) == ESP_OK);
    a=request(3,60,1000); assert(actuator_set(&a) == ESP_OK);
    watch_expired_channel=2; readback_delay_ms=50; readback_followup_delay_ms=50;
    b=request(1,40,500); assert(actuator_set(&b) == ESP_OK);
    assert(unsafe_oe_enables==0);
    check_duty(0,0); check_duty(2,0); check_duty(1,40); check_duty(3,60);
    watch_expired_channel=-1; assert(actuator_stop_all() == ESP_OK);
    a=request(0,20,40); b=request(3,60,1000);
    assert(actuator_set(&a) == ESP_OK && actuator_set(&b) == ESP_OK);
    watch_expired_channel=0; readback_delay_ms=50;
    b=request(1,40,500); b.expires_at_ms=clock_ms+30;
    assert(actuator_set(&b) == ESP_ERR_TIMEOUT);
    assert(unsafe_oe_enables==0);
    check_duty(0,0); check_duty(1,0); check_duty(3,60);
    puts("PASS I2C readback crosses peer deadline: expired output stays off when shared OE is restored");
    puts("PASS deadlines crossed during peer cleanup and expired new command: valid peer preserved, no expired output re-enabled");
    puts("PASS actual actuator: concurrent duty, independent renewal/stop/expiry, limits, bounded cutoff, faults and in-flight emergency");
    return 0;
}
