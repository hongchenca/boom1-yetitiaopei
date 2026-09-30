# TASK-INTEGRATION-004：控制仿真与分层集成验收

## Objective

建立从配方提交到状态/事件结果的主机仿真和硬件分层验收，不接真实泵，不把构建成功当作液体调配通过。

## Required layers

覆盖重复/过期/未授权命令、滤波预热/跳变/过期、快慢精加边界、预测尾流、点动上限、过量、秤故障、PCA NACK、取消抢占、事件队列满、掉电恢复和网络断开。每层明确 `[PASS]`、`[FAIL]`、`[NOT RUN]`、`[HW REQUIRED]`；本地控制结果不依赖服务器。

## Hardware gate

真实 HX711 采样、PCA9685 PWM、MOSFET/泵、气路、独立关断、噪声/尾流/精度和长稳均需要实物证据。未完成硬件门槛时只能运行仿真和空载台架，禁止开启液体输出。

## Allowed files

仅允许 `tests/`、测试 fixtures、测试说明和 `docs/agent_reports/TASK-INTEGRATION-004.md`。不修改 `fwq` 中既有文件；报告结尾 `READY FOR ARCHITECT REVIEW`。
