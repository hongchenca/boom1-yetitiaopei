# TASK-WEIGHT-003：九路称重快照数据模型

## Task ID / Task Name

`TASK-WEIGHT-003` / 九路称重快照数据模型。

## Objective

在 `domain` 组件中实现供 HX711 驱动、Weight Service 和定量控制器共用的称重快照类型，以及一个有界、纯函数式的快照可用性判断函数。本任务不访问硬件、不采样、不滤波、不校准。

## Background

`SOFTWARE_ARCHITECTURE.md` 规定九个秤：0~7 为原液容器，8 为中央容器。质量统一用有符号 64 位整数 mg，时间用单调 ms；原始 HX711 计数是有符号 24 位值，存入 `int32_t`。控制器不能把故障、未校准、未来时间或过期样本当作有效质量。GPIO、量程、校准系数、滤波与采样周期尚未冻结，均不属于本任务。

## Files Allowed To Modify

- `components/domain/CMakeLists.txt`（新建）
- `components/domain/include/weight_types.h`（新建）
- `components/domain/weight_types.c`（新建）
- `docs/agent_reports/TASK-WEIGHT-003.md`（完成报告）

## Files Forbidden To Modify

- `main/`、`sdkconfig*`、分区表、现有其他 `components/`、`docs/` 中除本任务报告以外的文件。
- ESP-IDF/vendor 文件、GPIO/I2C/HX711/PCA9685 驱动及任何设备配置。

## Required API / Contract

在 `weight_types.h` 中公开以下精确类型和常量；名称、字段、单位与顺序均不得自行改变：

```c
#define WEIGHT_SOURCE_SCALE_COUNT 8u
#define WEIGHT_SCALE_COUNT 9u
#define WEIGHT_MAIN_SCALE_ID 8u
#define WEIGHT_RAW_MIN (-8388608)
#define WEIGHT_RAW_MAX 8388607

typedef struct {
    uint8_t scale_id;             // 0..8; 8 is the central vessel
    int32_t raw_count;            // signed 24-bit HX711 count, sign-extended
    int64_t mass_mg;              // calibrated mass; negative tare is allowed
    uint64_t timestamp_ms;       // monotonic sample time
    uint32_t calibration_version; // zero means no valid calibration
    bool valid;                   // measurement and calibration result valid
    bool stable;                  // stable window reported by the future service
    bool fault;                   // hardware/service fault attached to sample
} weight_snapshot_t;

typedef enum {
    WEIGHT_SNAPSHOT_OK = 0,
    WEIGHT_SNAPSHOT_NULL,
    WEIGHT_SNAPSHOT_BAD_SCALE,
    WEIGHT_SNAPSHOT_FAULT,
    WEIGHT_SNAPSHOT_INVALID,
    WEIGHT_SNAPSHOT_RAW_RANGE,
    WEIGHT_SNAPSHOT_UNCALIBRATED,
    WEIGHT_SNAPSHOT_BAD_MAX_AGE,
    WEIGHT_SNAPSHOT_FUTURE,
    WEIGHT_SNAPSHOT_STALE
} weight_snapshot_check_t;

weight_snapshot_check_t weight_snapshot_check(const weight_snapshot_t *snapshot,
                                               uint64_t now_ms,
                                               uint64_t max_age_ms);
```

头文件使用标准 C 的 `<stdint.h>` 和 `<stdbool.h>`，不得依赖 ESP-IDF 或 FreeRTOS 头文件。`weight_snapshot_check()` 按枚举顺序检查：空指针；通道 0~8；`fault`；`valid`；原始计数边界；非零校准版本；`max_age_ms > 0`；时间戳不得晚于 `now_ms`；最后用 `now_ms - timestamp_ms <= max_age_ms` 判断新鲜度。返回第一个失败原因。`stable=false` 不影响可用性；稳定性由后续阶段决策单独检查。质量可为负，不设未知量程上限。

## Implementation Requirements

1. `idf_component_register(SRCS "weight_types.c" INCLUDE_DIRS "include")`；组件不得依赖硬件或其他项目组件。
2. 函数只读取输入，固定时间复杂度，无堆分配、锁、日志、延时或全局可变状态。
3. 不提供生成时间戳、滤波、校准、质量差、单位转换或伪造测试样本的额外 API。
4. 不修改 `app_main` 来演示数据模型；本任务只提供可编译的公共契约。

## Error Handling

严格按 `weight_snapshot_check_t` 返回错误，不用 `ESP_ERROR_CHECK`、`assert` 或隐式成功。只有 `WEIGHT_SNAPSHOT_OK` 表示样本可用于后续判断；`stable` 仍需调用方根据阶段单独判断。

## Thread Safety Requirements

纯函数可由多个任务对各自稳定副本并发调用；发布/读取快照的一致性由后续 Weight Service 负责。本任务不创建 Task、Queue、Mutex 或 EventGroup，也不宣称对共享可变对象提供同步。

## Test Requirements

只执行一次 `idf.py build`，确认新组件编译且无新增 warning/error。代码审查覆盖通道 0/8/9、原始计数上下界及越界、负质量、零校准版本、未来时间、刚好达到时效边界与超过时效边界。无需独立板上测试；不要为了本任务反复重编、刷机或扫描串口。

## Acceptance Criteria

- 公开类型和函数签名逐字满足上述契约；头文件可被普通 C 代码引用，无 ESP-IDF/FreeRTOS 依赖。
- 各错误优先级、边界值和负质量行为与契约一致；无额外状态或硬件访问。
- `idf.py build` 通过，新组件确实被编译；只改允许文件，报告准确且简短。

## Build Command / Expected Result

在 ESP-IDF 5.4.2 环境运行 `idf.py build`，预期 exit code 0，无新增警告；报告中给出命令、结果和组件构建证据。

## Prohibited Changes

禁止自行选择 GPIO、秤量程、滤波/稳定阈值、任务模型、校准算法、持久化格式或任何其他公共 API。若组件构建无法纳入工程，返回具体 CMake 问题，不修改 `main/` 绕过。

## Completion Report

写入 `docs/agent_reports/TASK-WEIGHT-003.md`，包含修改文件、接口实现、一次构建结果、Warnings、Known Issues、Questions，结尾写 `READY FOR ARCHITECT REVIEW`。报告控制在两页左右；不复制大段构建日志、不做多轮自我验收。
