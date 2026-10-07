# 九路 HX711、实机网页与延迟优化验证

日期：2026-10-03，Asia/Shanghai。工程 `E:\111111111\yeti\yetitiaopei`。

## 交付状态

- [PASS] 九路软件默认启用；独立去皮、砝码校准、稳定阈值、NVS 保存、故障失效与恢复已实现。
- [PASS] 网页与后台不再创建演示设备、生成模拟称重或执行模拟批次。旧演示历史保留在数据库，不展示或导出；配方、实机记录及审计保留。
- [PASS] 本机网页后台完成一致性备份后更新，实机自动恢复上报。没有下发泵命令、去皮或修改设备参数。
- [PASS] 实机当前报告 `web-client-0.5.0`、称重服务版本 2、200 ms 上报。CH0 有有效读数且 `saved=true`。
- [HW REQUIRED] CH1～CH8 没有原始样本，尚不能完成九路硬件验收。GPIO 初始化成功不代表 HX711 已产生数据。
- [NOT RUN] 本轮未执行烧录、复位、擦除、现场砝码精度/阶跃测试、断电保持及长时间可靠性测试。实机上报的版本不等于最后重建产物的哈希，不能据此声称已烧录下述精确二进制。

## 构建与来源

Git 基线：`5565356e4aa120f677fe18d190d8151829906489`，工作区有未提交修改，包含原有八路泵等工作；没有清理或回退原有修改。精确文件哈希另存 `build/weight-nine-verification.json`。

工具：ESP-IDF 5.4.2，Xtensa GCC 14.2.0（esp-14.2.0_20241119），Node.js 24.14.0，MSVC 主机测试。目标 ESP32-S3，16 MB Flash，Octal PSRAM 80 MHz，FreeRTOS tick 100 Hz。

构建配置：`WEB_CLIENT=ON`、`PUMP_CONTROL=ON`、`PUMP_PWM_HZ=100`、`PUMP_MAX_PERCENT=100`、`PCA004_BENCH=OFF`、`PCA004_CYCLE=OFF`、`HX711_SCALE1=ON`、`HX711_ENABLED_MASK=511`。

在已激活的 ESP-IDF 5.4.2 终端执行：

```powershell
idf.py -B build -DWEB_CLIENT=ON -DPCA004_BENCH=OFF -DPCA004_CYCLE=OFF -DPUMP_CONTROL=ON -DPUMP_PWM_HZ=100 -DPUMP_MAX_PERCENT=100 -DHX711_SCALE1=ON -DHX711_ENABLED_MASK=511 build
```

实际最后构建复用上述缓存配置，命令为 `idf.py -B build -DHX711_ENABLED_MASK=511 build`，日志 `build/weight-nine-build.log`。

| 产物 | SHA256 |
| --- | --- |
| `build/yetitiaopei.bin` | `c296d7668504f024c24d04ef19377809f79154ba0d9b98eb0b9d880970d4d95e` |
| `build/yetitiaopei.elf` | `4b416b8f474127414a6d57cceca24a15a7067faca86c91d1825ef34b6b705945` |
| `build/yetitiaopei.map` | `72ed6d2de87c50ccb4c770f03b6eed19eed527493010d4382ab629f134356e5b` |

BIN 1,034,000 字节（`0xfc710`），当前 1 MiB 应用分区剩 14,576 字节（`0x38f0`，构建工具显示约 1%）。本次没有调整分区。继续增加功能时需先评估分区容量，不能仅依据整片 16 MB Flash 判断应用空间。固件包含本机配置，按私密产物保管。

## 软件复验

| 验证 | 结果与证据 |
| --- | --- |
| HX711 实际 C 驱动 | [PASS] 24 位有符号帧、25 个时钟、低电平空闲、超时和 DOUT 卡低；`build/weight-nine-host.log` |
| 实际九路服务主机测试 | [PASS] 九路隔离、负比例、稳定门槛、尖峰、过期/恢复、NVS 重启/提交失败/损坏/清除；同上 |
| 滤波阶跃 | [PASS] 主机输入阶跃后 5 次转换达到至少 90%；属于算法验证，不是实物响应时间 |
| 实际遥测序列化 | [PASS] 从当前 `main/web_client.c` 提取函数并链接 IDF cJSON，九路长字段帧 5557/8192 字节；过小缓冲拒绝 |
| HTTP 与业务接口 | [PASS] 12 项；旧第一路协议、九路校准命令、权限、版本、稳定门槛、禁用通道、幂等/重启、SSE；`web_server/artifacts/weight-nine-api.log` |
| 浏览器 | [PASS] 桌面及 390 px 手机布局，九路选择、中央秤去皮/校准/阈值、通道隔离、断线恢复、配方、记录、退出；无运行时异常 |
| 私有配置生成 | [PASS] 5 项配置测试；拒绝旧串口造数/probe 模式，保留关闭状态的兼容宏 |
| 运行中服务 | [PASS] 登录、健康、仅一个实机、在线上报，四个静态资产逐字节匹配当前磁盘文件 |

复验命令（工程根目录）：

```powershell
cmd.exe /d /c .\build\run-weight-host.cmd
node --test --test-isolation=none web_server/tests/api.test.js web_server/tests/business.test.js
node web_server/tests/browser.test.js
py -3 web_server/tests/configure.test.py
node web_server/tests/running.test.js
node build/check-live-weight.cjs after
node build/measure-live-weight.cjs
```

主机测试脚本需 VS 2022 Build Tools C 编译环境；可在已初始化的开发者终端运行 `py -3 components/weight/tests/run_host_tests.py --idf-path E:\Espressif\frameworks\esp-idf-v5.4.2`。接口和浏览器测试使用独立临时数据库及设备协议替身，不对实机发送测试遥测或操作命令。最后三条只读取真实设备状态（登录/退出仅变更网页会话）。

浏览器证据：`web_server/artifacts/browser/result.json`、`13-nine-scales-calibrated.png`、`mobile-debug.png`。测试中的砝码值不构成硬件精度证明。

## 延迟证据

优化前数据：`web_server/artifacts/weight-latency-before.json`，旧固件 0.4.0，上报配置 1000 ms，实际约 1.1～1.3 s，RSSI 约 −76～−77 dBm。

落地修改：显示改为 median-of-3 + 1/2 EMA，16 点窗口仅用于校准/稳定判断；九路逐路非阻塞检查；200 ms 上报扣除请求耗时；复用每任务独占 HTTP 连接；关闭 Wi-Fi 省电；命令后唤醒遥测；新遥测立即 SSE 广播；网页回执轮询 150 ms，后台页面不绘制曲线。

2026-10-03 15:34，本机接收真实设备连续 30 个不同序号 SSE 帧：

| 指标 | 中位数 | P95 | 范围 |
| --- | ---: | ---: | ---: |
| 后台收到相邻遥测的间隔 | 188 ms | 278 ms | 105～282 ms |
| 后台收包至本机 SSE 接收 | 2 ms | 6 ms | 1～7 ms |
| 设备报告的上一次 HTTP 耗时 | 52 ms | 122 ms | 39～141 ms |
| CH0 采样周期 | 90 ms | 90 ms | 79～91 ms |
| RSSI | −73 dBm | −72 dBm | −74～−72 dBm |

证据：`web_server/artifacts/weight-latency-after.json`；首个历史 SSE 快照不计入推送延迟。软件协议测试的 SSE 延迟为 1～3 ms。以上没有覆盖物体放置时刻、机械稳定过程和浏览器绘制，因此不是称重到页面的完整延迟。实机 RSSI 一度为 −50 dBm，随后回到约 −73 dBm，仍有波动；优先改善信号、供电及天线附近环境，再复测。

若实际 HX711 模块支持 RATE 引脚切换，可按该模块接法选择 80 SPS 并重新评估噪声；这不是软件改上报周期就能完成的。当前每 tick 检查一次、tick 10 ms，实际速率还受检查间隔影响，不能承诺精确 80 SPS。

## 真实九路状态与下一步

证据：`web_server/artifacts/weight-live-after.json`。CH0 的 `sample_sequence` 持续增加、`last_error=ESP_OK`、`storage_error=ESP_OK`、`saved=true`。CH1～CH8 均为 `enabled=true`、`initialized=true`、`sample_sequence=0`、`raw_count=null`、`age_ms=60000`、`last_error=ESP_ERR_TIMEOUT`。采集失败并未阻塞 CH0 或 200 ms 上报。

按当前驱动，超时表示检查 DOUT 时仍为高电平，未进入 24 位读数流程。现有证据不能区分供电、共地、线序或模块故障；也不能用未校准解释零样本。

1. 核对 CH1～CH8 模块已供电并与 ESP32 共地，GPIO 编号与板上排针编号区分开，逐路核对根 README 的 DOUT/SCK 表。
2. 保持泵停止，只选一路排查；在网页观察原始计数和样本年龄。接线恢复后采集会自动恢复，不需要用清除校准来解除超时。
3. 各路有新鲜原始计数后，空载等待“可校准”再去皮，放置已知砝码、稳定后填写实际克数并校准，确认“已保存到设备”。不拿软件默认阈值当精度指标。
4. 已保存且读数正确的 CH0 无须清除参数。旧 0.4.0 的 RAM 系数无法迁移；尚未校准的各路应重新标定。
5. 最后逐路验证多点质量、卸载归零、独立通道、断电保持、断线恢复和砝码阶跃到页面的延迟，再进行长时间运行验收。

## 后台更新与恢复

更新前确认实机泵占空比全为 0、无 queued/delivered 命令。SQLite 一致性备份：`web_server/data/backup-before-weight-nine-20261003-1534.db`。仅停止确认属于本工程的 Node PID 8328，使用同一工作目录以隐藏窗口启动新进程 PID 41812；日志 `web_server/artifacts/weight-nine-server.stdout.log` 与 `.stderr.log`。实机没有复位，序号继续增加；网页资源哈希与磁盘一致，`running.test.js` 通过。

如需数据库恢复，按 `web_server/README.md` 的备份恢复步骤操作，不覆盖运行中的 SQLite 文件或混用旧 WAL。备份和本机连接配置均留在被 Git 忽略的私有目录。
