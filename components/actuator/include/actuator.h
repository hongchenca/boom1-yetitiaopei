#ifndef YETI_ACTUATOR_H
#define YETI_ACTUATOR_H

#include <stdbool.h>
#include <stdint.h>
#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

#define ACTUATOR_PUMP_COUNT 8
#define ACTUATOR_AIR_CHANNEL 8
#define ACTUATOR_SERVO_CHANNEL 9
#define ACTUATOR_OUTPUT_COUNT 10
#define ACTUATOR_CONFIG_VERSION 1u

typedef enum {
    ACTUATOR_SOURCE_DOSING = 1,
    ACTUATOR_SOURCE_LOCAL,
    ACTUATOR_SOURCE_REMOTE_DEBUG,
} actuator_source_t;

typedef struct {
    uint32_t version;
    uint16_t pwm_hz;             // 40..1000 Hz，所有通道共享；须按实际泵选择。
    uint8_t maximum_percent;     // 1..100，各来源都不能绕过此上限。
    uint32_t maximum_run_ms;     // 1..600000 ms，每次输出必须携带运行期限。
    uint8_t minimum_percent;     // 液泵非零输出下限；产品默认 40%，拒绝静默钳位。
    bool auxiliaries_enabled;    // CH8 气泵 / CH9 舵机；开启时共享频率必须为 50 Hz。
} actuator_config_t;

typedef struct {
    actuator_source_t source;    // 由已完成鉴权/本地授权的控制层填写，不替代鉴权。
    uint32_t config_version;
    uint8_t channel;             // Pump0..7 -> PCA9685 CH0..7。
    uint8_t duty_percent;        // 0=停止，100=FULL_ON，其余为 12 位 PWM。
    uint32_t duration_ms;        // 非零占空比必填；停止可为 0。
    int64_t expires_at_ms;       // esp_timer 单调毫秒；过期意图不能启泵。
    int64_t stop_at_ms;          // 可选绝对关断期限，0=只用 duration_ms；用于远程租约。
    uint16_t pulse_us;           // 仅 CH9：500..2500 us；0=释放信号，duty_percent 必须为 0。
    bool guard_stop_generation;  // 控制任务携带领取所有权时的代次，外部 stop 后不能续跑。
    uint32_t stop_generation;
} actuator_request_t;

typedef struct {
    bool initialized;
    bool output_enabled;        // 软件已使能 OE；不是负载端电气测量。
    bool registers_verified;
    bool fault_latched;
    bool shutdown_failed;       // OE 写失败或无法回读确认全关。
    esp_err_t last_error;
    uint32_t config_version;
    uint16_t pwm_hz;
    uint8_t maximum_percent;
    uint32_t maximum_run_ms;
    uint8_t duty_percent[ACTUATOR_OUTPUT_COUNT]; // CH0..8 占空比；CH9 始终为 0。
    uint16_t servo_pulse_us;
    uint8_t minimum_percent;
    bool auxiliaries_enabled;
    actuator_source_t reserved_source; // 跨停止/稳定阶段的独占控制。
    uint32_t stop_generation;    // 外部全停使正在执行的任务失效。
    int8_t active_channel;       // 兼容单路状态：最近操作且仍有输出的通道，-1=无输出。
    actuator_source_t source;
    uint32_t remaining_ms;       // active_channel 的剩余时间。
    uint32_t remaining_ms_by_channel[ACTUATOR_OUTPUT_COUNT]; // 每路独立截止时间。
} actuator_status_t;

// 所有接口仅在任务上下文调用；初始化一次后组件独占 I2C0/ GPIO8、9、10。
// 液泵与气泵互斥；CH10..15 始终关闭。无舵机信号不等于机械阀已关闭。
esp_err_t actuator_claim(actuator_source_t source);
esp_err_t actuator_release(actuator_source_t source);

/////////////////////////////////////////////////////////////////////////////
// 函数名：actuator_init
// 作用：创建驱动与本地截止时间监护，设置共享频率，回读确认全关后待命。
// 参数1：config，非空，复制到组件内部；必须在应用创建控制任务前调用一次。
// 用于：产品上电初始化，不自动启动任一通道。
// 使用示例：actuator_init(&config)。
/////////////////////////////////////////////////////////////////////////////
esp_err_t actuator_init(const actuator_config_t *config);

/////////////////////////////////////////////////////////////////////////////
// 函数名：actuator_set
// 作用：校验来源、版本和每路期限，写后回读成功才恢复输出；不改变其他路配置。
// 参数1：request，非空，调用期间有效；运行中的不同控制来源返回 INVALID_STATE。
// 用于：本地定量控制器或经授权的调试命令；可能等待有限 I2C 事务。
// 使用示例：actuator_set(&request)；duty_percent=0 关闭指定通道。
/////////////////////////////////////////////////////////////////////////////
esp_err_t actuator_set(const actuator_request_t *request);

/////////////////////////////////////////////////////////////////////////////
// 函数名：actuator_stop_all
// 作用：先拉高 OE 并撤销在途启泵意图，再尝试清零全部寄存器；不清除故障。
// 参数：无。
// 用于：用户停止、取消、网络调试失联；OE 关断不等待 I2C 互斥量。
// 使用示例：actuator_stop_all()；返回非 ESP_OK 时查询故障快照。
/////////////////////////////////////////////////////////////////////////////
esp_err_t actuator_stop_all(void);

/////////////////////////////////////////////////////////////////////////////
// 函数名：actuator_emergency_stop
// 作用：立即通过 OE 禁止输出并锁存故障，寄存器清理交由后台任务。
// 参数：无。
// 用于：控制/安全任务报告急停或传感器故障；不执行 I2C，不自动恢复。
// 使用示例：actuator_emergency_stop()。
/////////////////////////////////////////////////////////////////////////////
void actuator_emergency_stop(void);

/////////////////////////////////////////////////////////////////////////////
// 函数名：actuator_clear_fault
// 作用：保持 OE 禁能，重新配置并回读全关；成功后仅允许接受新命令。
// 参数：无。
// 用于：本地维护确认故障原因已排除；上层负责授权，不对网络直接开放。
// 使用示例：actuator_clear_fault()；不会恢复此前的泵动作。
/////////////////////////////////////////////////////////////////////////////
esp_err_t actuator_clear_fault(void);

/////////////////////////////////////////////////////////////////////////////
// 函数名：actuator_get_status
// 作用：复制一致性快照，提供八路输出、剩余时长和锁存故障。
// 参数1：status，非空输出缓冲，不保留指针；无需等待 I2C。
// 用于：控制状态检查、串口或网页遥测。
// 使用示例：actuator_get_status(&status)。
/////////////////////////////////////////////////////////////////////////////
void actuator_get_status(actuator_status_t *status);

#ifdef __cplusplus
}
#endif
#endif
