# 九路 HX711 称重服务

`hx711.c` 只负责 A/128 有符号 24 位读取、25 个时钟、就绪超时与 DOUT 恢复高电平检查。`hx711_board.c` 保留项目九组独立 DOUT/SCK 映射。

`weight_service_start(mask)` 在 NVS 初始化后调用；单个任务逐路以 `hx711_read(..., 0, ...)` 检查，不等待任何单路转换。数组状态全部在内部 RAM，临界区内只更新/复制状态，NVS 和网络 I/O 在临界区外。

- 闭环快通道 `control_mg`：median-of-3 + alpha=1/2 EMA，Q16 累加后取整，避免一个 count 的小变化被整数截断卡住。斜坡延迟估计为约两个采样周期。
- 设备显示 `filtered_mg`：median-of-5 + 按时间间隔计算的自适应 EMA，小变化时间常数 500 ms，大变化 50 ms。网页显示还可选择平衡/平稳滤波或设备读数；这些显示偏好不进入闭环。
- 最终核验 `stable_mg`：16 个原始样本平均，仅在 `stable=true` 时作为剂量依据。`window_ms` 和单调 `sample_time_ms` 用于保证完整窗口来自停泵之后；不自动去皮，不钳制负质量。
- 稳定：完整 16 点的原始范围（未校准默认 200 counts）或质量范围（校准后默认 50 mg），满足后持续 500 ms。阈值逐路可设，并非实测精度承诺。
- 有效性：断线 300 ms、ADC 饱和/帧错误清空窗口；快照超过 500 ms 无效。重新采集后自动恢复，不丢失校准。
- 质量：`(raw-zero)*reference_mg/span` 使用 int64 中间值，支持正/负系数，协议限 ±1e9 mg。校准跨度绝对值须大于原始阈值的 5 倍。
- 保存：逐路 NVS `weight/scale0..8` blob 包含格式 magic、版本、GPIO、零点、比例、阈值。加载校验范围与引脚，不自动擦除 NVS；用户操作以互斥锁串行，先提交存储再发布新版本。保存失败保持旧值并报告错误。
- 维护：去皮保留比例；清除校准只作用一路；新版本或断线后清空滤波/稳定窗口。普通采集不写 Flash，重启不自动去皮。

公开 API 见 `include/weight_service.h`；只有上层已校验权限和泵停止后才允许修改。接线、启用掩码与网页操作见根 README“九路 HX711 称重”。

主机测试（VS Developer Command Prompt，或配置 `CC` 的主机环境）：

```text
py -3 components/weight/tests/run_host_tests.py --idf-path E:/Espressif/frameworks/esp-idf-v5.4.2
```

测试真实 C 源码的帧/符号位、九路隔离、稳定/滤波、重启恢复、存储失败、损坏记录及参数清除；传入 IDF 路径还会编译当前固件实际 `telemetry_json` 与 cJSON，验证九路完整帧和缓冲边界。硬件替身不证明物理 SCK 脉宽、Flash 断电原子性或实际精度。
