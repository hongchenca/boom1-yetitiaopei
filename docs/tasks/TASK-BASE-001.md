# TASK-BASE-001：N16R8 安全启动与内存探测

## Task ID / Task Name

`TASK-BASE-001` / N16R8 安全启动与内存探测。

## Objective

将 ESP-IDF `hello_world` 自动重启示例替换为一次性启动检查：输出实际 Flash、PSRAM 和可分配内存信息，验证显式 PSRAM 分配/读写/释放，然后保持所有外设未初始化、无负载输出的空闲状态。

## Background

用户确认主控模块为 ESP32-S3-WROOM-1-N16R8。工程已在 `sdkconfig.defaults`/`sdkconfig` 配置 16 MB Flash、8 MB Octal PSRAM、80 MHz PSRAM、启动自检和 `MALLOC_CAP_SPIRAM` 显式分配，且关闭外部 RAM 静态任务栈。现有 `main/hello_world_main.c` 在十秒倒计时后自动 `esp_restart()`，不能作为后续控制程序基线。Flash 仍保持 DIO/80 MHz，分区仍是单应用，暂不实施 OTA。

## Files Allowed To Modify

- `main/hello_world_main.c`
- `main/CMakeLists.txt`，仅在新增 ESP-IDF 组件依赖确有必要时修改。
- `docs/agent_reports/TASK-BASE-001.md`，用于初次完成报告及后续返工记录。

## Files Forbidden To Modify

- `sdkconfig`、`sdkconfig.defaults`、`sdkconfig.old`、`sdkconfig.ci`、分区表。
- `docs/`（仅允许新增/更新本任务报告 `docs/agent_reports/TASK-BASE-001.md`）、其他源码、第三方/ESP-IDF 文件、任何 GPIO/泵/气路驱动。

## Required API

- 保留唯一入口 `void app_main(void)`；不新增公共项目 API。
- 使用 ESP-IDF 5.4.2 原生接口分别读取镜像头配置的 Flash 容量（`esp_flash_get_size(NULL, &flash_header_bytes)`）和芯片物理容量（`esp_flash_get_physical_size(NULL, &flash_chip_bytes)`）；两者日志明确区分。PSRAM 容量使用 `esp_psram_get_size()`，堆统计使用 `MALLOC_CAP_INTERNAL`/`MALLOC_CAP_SPIRAM`。
- 使用 `heap_caps_malloc(4096, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT)` 取得测试缓冲区，完成确定性首尾及跨区写读校验后释放。不得假定 PSRAM 可分配堆恰好等于 8 MB。
- 日志以字节或 MiB 明确单位，区分“芯片报告容量”和“当前空闲/可分配堆”。

## Implementation Requirements

1. 删除模板倒计时与自动 `esp_restart()`；启动检查只执行一次。`app_main` 返回或以低资源空闲方式结束，不新增永久轮询任务。
2. 检查编译配置是 ESP32-S3、16 MB Flash、Octal PSRAM。读取到的 Flash 若非 16 MiB 或 PSRAM 若非 8 MiB，输出清楚的错误日志并停止后续探测；不得把错误记录成通过。
3. 检查每个 API 返回值、分配结果和缓冲区读写结果；任何失败路径都释放已分配资源，输出单一明确的失败原因。
4. 不调用 GPIO、I2C、PCA9685、HX711、网络或 OTA API；不使能任何执行机构。不要以本任务证明泵已经物理关断，硬件关断仍按 ADR-0003 单独验收。
5. 控制任务及其栈继续使用内部 RAM；不得更改 PSRAM 分配策略或 `sdkconfig`。

## Error Handling

- 任一 Flash 容量读取 API 失败、容量不符、PSRAM 未初始化/容量不符、PSRAM 堆不足、分配失败或模式校验失败时，记录 `ESP_LOGE` 并安全结束 `app_main`。
- 不使用 `ESP_ERROR_CHECK` 造成无解释的重启循环；不尝试复位或自动重试。

## Thread Safety Requirements

所有探测只在 `app_main` 启动上下文运行一次，不创建额外 Task、Queue、Mutex、EventGroup，不共享可变状态。不得在 ISR 或网络回调中调用。

## Test Requirements

- 执行 `idf.py build`；确认无新增编译警告/错误，生成的 `sdkconfig.h` 保留 16MB/OCT/80MHz/CAPS_ALLOC 选项。
- 主机侧可检查日志分支和代码路径；实物启动、Flash/PSRAM 读数及 4 KiB 读写属于 `[HW REQUIRED]`，提供完整启动日志与板卡/串口身份。
- 未获得板卡身份、端口、当前固件和恢复方式时不得执行 `flash`/`monitor` 或任何设备写操作。

## Acceptance Criteria

1. 代码构建通过，倒计时和自动重启消失；没有新增外设驱动、网络或业务状态机。
2. 成功日志明确显示 Flash 16 MiB、PSRAM 8 MiB、内部/PSRAM 堆统计及 4 KiB 校验通过；失败日志能指出对应错误。板上成功项须有启动日志，不接受仅凭编译声称通过。
3. 所有分配均释放，所有失败分支均返回且无死循环；`sdkconfig*` 与其他设计文档未被 Coding Agent 改动，仅允许新增/更新本任务报告。

## Build Command / Expected Result

在已激活 ESP-IDF 5.4.2 的 PowerShell 中运行 `idf.py build`；预期 exit code 0，目标 `esp32s3`，生成 `build/yetitiaopei.elf` 与 `.bin`。实物启动检查另列 `[HW REQUIRED]`。

## 禁止事项

禁止调整分区、Flash 模式/频率、PSRAM 选项、GPIO 或电机驱动；禁止自动重启、创建多余任务、把硬件未测项目报为通过。若实际 API 或板卡行为与契约不符，回报问题，由 Architect Agent 修改任务/设计。

## Coding Agent 完成报告

将报告写入 `docs/agent_reports/TASK-BASE-001.md`。报告包含修改文件；实现内容；测试内容；Build Result（命令、工具版本、产物）；Warnings；Known Issues；Questions；板上测试状态与日志位置；未执行项目的 `[NOT RUN]`/`[HW REQUIRED]` 原因。结尾写 `READY FOR ARCHITECT REVIEW`，不得代填 Architect Review 的 `ACCEPTED` 或 `CHANGES REQUIRED`。
