# TASK-WEIGHT-004：九路重量滤波与稳定窗口纯逻辑模块

## Objective

在 `components/domain/` 中实现无硬件依赖、确定性、有界的 median-of-3 + 定点 EMA + 稳定窗口逻辑，为后续 HX711 服务提供快照处理契约。

## Allowed files

- `components/domain/include/weight_filter.h`
- `components/domain/weight_filter.c`
- `components/domain/CMakeLists.txt`
- `docs/agent_reports/TASK-WEIGHT-004.md`

禁止修改 `main/`、`sdkconfig*`、分区、HTTP、PCA9685、HX711 GPIO、服务器目录或其他文档。禁止浮点、堆分配、日志、延时、FreeRTOS 对象和全局可变状态。

## Contract

输入是已经带 `timestamp_ms`、`raw_count`、`mass_mg`、`valid`、`fault`、`calibration_version` 的单路快照；输出包含滤波 mg、有效/稳定标志、样本年龄、窗口跨度、噪声范围、斜率和降级原因。配置包含 `alpha_q16`、预热样本数、窗口样本数、`noise_band_mg`、`slope_limit_mg_per_s`、`max_age_ms`，所有数值先做有限性、范围和跨字段检查。时间戳未来、过期、校准版本为零、原始值越界和故障样本按错误优先级拒绝。

## Tests

主机或 Unity 纯逻辑测试覆盖负质量、24 位边界、跳变、重复时间戳、未来/过期、窗口不足、恰好稳定边界、斜率边界、定点溢出和状态重置。Coding Agent 不编译、不刷机；用户按本项目约定自行构建。

报告写入 `docs/agent_reports/TASK-WEIGHT-004.md`，结尾 `READY FOR ARCHITECT REVIEW`。
