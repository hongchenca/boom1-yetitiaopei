# 2026-09-24 N16R8 内存配置验证

## 基线与变更

- 用户确认模块：ESP32-S3-WROOM-1-N16R8；此处的料号来自用户声明，实物丝印及容量尚未读回。
- 工程无 Git 元数据；无法提供提交号或基于 Git 的差异证明。
- ESP-IDF 5.4.2，目标 `esp32s3`，Xtensa GCC 14.2.0，PowerShell 本地构建，时间 2026-09-24 17:45 +08:00。
- `sdkconfig.defaults` 与 `sdkconfig`：16 MB Flash、Octal PSRAM 80 MHz、PSRAM 启动初始化/自检、显式 `MALLOC_CAP_SPIRAM` 分配；禁止外部 RAM 静态任务栈。保留 DIO/80 MHz Flash 与单应用分区。

## 执行结果

| 项目 | 结果 | 证据 |
| --- | --- | --- |
| `idf.py reconfigure` | `[PASS]` | ESP-IDF 成功为 `esp32s3` 生成构建配置 |
| `idf.py build` | `[PASS]` | 成功生成 bootloader、分区表、`build/yetitiaopei.elf` 和 `build/yetitiaopei.bin`；镜像大小 216704 字节，1 MiB 应用分区尚余约 79% |
| 生成配置检查 | `[PASS]` | `build/config/sdkconfig.h` 含 `CONFIG_ESPTOOLPY_FLASHSIZE_16MB`、`CONFIG_SPIRAM_MODE_OCT`、`CONFIG_SPIRAM_SPEED_80M`、`CONFIG_SPIRAM_USE_CAPS_ALLOC`、`CONFIG_SPIRAM_MEMTEST` |
| 实物启动、Flash/PSRAM 容量与读写 | `[HW REQUIRED]` | 未刷写设备；交由 `TASK-BASE-001` 的板上阶段验证 |
| 泵/气路安全关断 | `[HW REQUIRED]` | 内存配置构建与此无关，按 ADR-0003 独立验收 |

应用镜像 SHA-256：`6B76CB3DAF2B85CFEFEA37A05894CBD0B152673AECC71743F780E0BB282E5D01`。当前应用仍是 ESP-IDF `hello_world` 模板，不能因构建通过认定运行时内存或控制功能通过。
