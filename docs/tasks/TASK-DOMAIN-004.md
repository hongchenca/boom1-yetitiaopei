# TASK-DOMAIN-004：控制配置、固定配方与事件纯数据模型

## Objective

在 `components/domain/` 中冻结后续 Weight、Dosing、Command、Storage 共用的 C 数据类型、单位、范围校验和错误/事件语义，不访问硬件、网络、文件或 FreeRTOS。

## Required types

实现版本化的 `control_config_t`、`dose_recipe_t`/步骤、`calibration_snapshot_t`、`actuator_intent_t`、任务状态/错误类别、事件记录和有限性/范围校验函数。质量统一 `int64_t mg`，时间统一单调 `uint64_t ms`；所有数组长度、步骤数量、占空比、超时、点动次数、质量守恒带和配置版本均显式限制。保留通道不能进入配方，运行任务必须复制不可变配置快照。

## Allowed files

- `components/domain/include/`
- `components/domain/*.c`
- `components/domain/CMakeLists.txt`
- `docs/agent_reports/TASK-DOMAIN-004.md`

禁止修改 `main/`、`sdkconfig*`、分区、HTTP、服务器目录和硬件驱动。主机边界测试由 Agent 运行；报告结尾 `READY FOR ARCHITECT REVIEW`。
