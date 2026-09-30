# Phase 1：架构与硬件基线工作包

本阶段只建立可执行的设计、测量和验收基线，不实现业务控制代码，也不驱动真实泵做未经批准的动作。下列 `TASK-*` 是 Architect/硬件团队的规划工作包，不是可直接派发给 Coding Agent 的实现任务；后续派发时必须按 `CODING_TASK_TEMPLATE.md` 补齐全部字段。

## 任务清单

依赖顺序：`TASK-ARCH-001` 与 `TASK-HW-001` 可并行；`TASK-HW-002` 依赖板卡/功率级资料；`TASK-ARCH-002` 依赖需求边界；`TASK-CAL-001` 依赖量程、液路和泵资料；`TASK-TOOL-001` 先记录现状，配置变更须等待硬件核验。每项交付包含文档差异、来源证据、未关闭问题、验收记录和 Architect Review 结论。

### TASK-ARCH-001：冻结需求与术语

- **Objective**：评审 `PROJECT_REQUIREMENTS.md`，补齐产品目标、液体/批量/精度/节拍、取消/恢复/清洗流程，并建立需求 ID。
- **允许修改**：`docs/PROJECT_REQUIREMENTS.md`、`docs/ACCEPTANCE_CRITERIA.md`。
- **禁止**：实现固件、编造硬件数值。
- **验收**：每个产品目标都有单位、工况、证据方法或明确 `TBD` owner/due date；Architect Review 通过。

### TASK-HW-001：实物与电气资料核验

- **Objective**：取得主控、PCA9685、HX711、功率级、泵、气路、线束、供电和安全电路的料号/修订/数据手册/原理图/照片/实测证据。
- **允许修改**：`docs/HARDWARE_ARCHITECTURE.md`、`docs/adr/ADR-0001-hardware-baseline.md`。
- **禁止**：修改 GPIO 或 `sdkconfig` 作为猜测性修复；未完成身份核验不得接负载。
- **验收**：TBD 表逐项标记已确认/仍阻断，Flash/PSRAM/引脚/电源/关断路径有来源；安全项须 `[HW REQUIRED]` 测试计划。

### TASK-HW-002：安全关断与功率级验证计划

- **Objective**：定义上电、复位、OE、硬件使能、急停、过流/续流和负载端测量方法，给出响应时间和故障注入步骤。
- **允许修改**：`docs/HARDWARE_ARCHITECTURE.md`、`docs/TEST_PLAN.md`、`docs/ACCEPTANCE_CRITERIA.md`。
- **禁止**：在未审批的情况下写 GPIO、开泵或改变功率级。
- **验收**：每个安全触发都有预期负载电压/电流状态、探头位置、恢复方式和 `[HW REQUIRED]` 证据格式。

### TASK-ARCH-002：接口、状态与并发评审

- **Objective**：把 `SOFTWARE_ARCHITECTURE.md` 的语义契约转换为待实现的精确 C 类型/API 草案，并完成队列、锁、周期、超时的时序预算。
- **允许修改**：`docs/SOFTWARE_ARCHITECTURE.md`、`docs/STATE_MACHINE.md`、`docs/ERROR_MODEL.md`、`docs/adr/ADR-0002-control-ownership.md`。
- **禁止**：创建任务/组件代码；未经 ADR 改变单泵串行或控制所有权。
- **验收**：每个共享对象都有 owner、读写者、生命周期、最大阻塞时间和错误路径；状态机每条边可测试。

### TASK-CAL-001：计量试验与误差预算设计

- **Objective**：定义九路称重校准、稳定窗口、泵流量/尾流、中央交叉验证和液路残液测量方法。
- **允许修改**：`docs/CONTROL_ALGORITHM.md`、`docs/TEST_PLAN.md`、`docs/ACCEPTANCE_CRITERIA.md`。
- **禁止**：填入未经实测的容量、精度、滤波常数或 PWM 频率。
- **验收**：每个算法参数都有来源/单位/范围/标定步骤；输出原始数据格式、统计方法和通过界限的 owner。

### TASK-TOOL-001：构建与证据基线

- **Objective**：确认 ESP-IDF 5.4.2/目标、实际板卡配置、编译器和 CI 命令；记录当前示例构建与板上容量验证状态。
- **允许修改**：`docs/TEST_PLAN.md`、`README.md`（仅更新项目说明）。N16R8 容量配置已由 Architect 依据用户确认先行更新；后续其他配置变更须单独任务和证据。
- **禁止**：把 `sdkconfig.old` 当作当前硬件配置；不得为“通过构建”擅自切换 Flash 模式、PSRAM 模式或分区。
- **验收**：有可重复的环境版本、命令、ELF/bin/hash 记录；当前模板与目标配置差异清楚标出。

## Phase 1 完成定义

以上任务均有 Architect Review；阻断性 TBD（MCU/存储、GPIO、供电、关断、量程、泵/气路电气参数）必须关闭并附来源，否则 Phase 1 状态为 `CHANGES REQUIRED`；精度/节拍/产品流程等需求 TBD 也必须有 owner、冻结日期和对后续阶段的影响说明；`ACCEPTANCE_CRITERIA.md` 中的架构与安全门槛具备可执行证据计划。完成后才可创建 HX711/PCA9685 驱动等 Phase 2 Coding Task。
