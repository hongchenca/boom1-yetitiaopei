# TASK-DOSING-004：分阶段定量控制纯逻辑状态机

## Objective

实现不访问硬件、网络或存储的单泵串行定量状态机仿真，覆盖 FAST/SLOW/FINE/STOPPING/SETTLING/JOG/VERIFY 及所有超时、取消、过量和传感器失效出口。

## Boundary

输入为不可变配方/控制配置快照、最新重量快照、执行器结果和单调时间；输出为有限的 `ActuatorIntent`、状态转移事件和错误码。状态机不能直接写 PCA9685，不能阻塞，不能无限重试，任何故障先产生有界 stop intent 再锁存 ERROR。目标、容差、阶段入口、固定超调、速度上限、点动限制和质量守恒带都从配置读取，未标定时不得提供生产默认精度。

## Allowed files

- `components/domain/include/dosing_types.h`
- `components/domain/dosing_types.c`
- `components/domain/include/dosing_controller.h`
- `components/domain/dosing_controller.c`
- `components/domain/CMakeLists.txt`
- `docs/agent_reports/TASK-DOSING-004.md`

禁止修改硬件驱动、HTTP、服务器、`sdkconfig*`、分区或真实执行器。测试使用仿真输入和边界表；不接泵、不刷机。报告写入指定路径并以 `READY FOR ARCHITECT REVIEW` 结束。
