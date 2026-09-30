# TASK-HTTP-004 阶段报告：ESP32 仅网络入口

日期：2026-09-30。目标平台沿用现工程 ESP32-S3/ESP-IDF 5.4.2；不修改硬件映射或分区。

## 实现

- main/CMakeLists.txt 加入 WEB_CLIENT，与 PCA004_BENCH 互斥，未选择时仍运行原默认入口。
- main/web_client.c：Wi-Fi RAM 配置/事件/退避重连；独立遥测和长轮询任务；设备身份、boot ID、sequence、单调 uptime、网络状态与空硬件样本。
- 遥测/事件请求超时 5 秒，长轮询等待 25 秒、客户端请求超时 30 秒；回复缓存有界且拒绝截断 JSON，重定向不跟随。
- 仅 ping/set_upload_interval；校验 schema/device/boot/request ID/单调期限/配置版本，缓存最近八个 ACK，重投时不再次应用。
- 上报周期 200～10000 ms，仅 RAM 生效，默认 1000 ms。启动事件使用稳定 event_id 重试；真实九路质量 null/valid=false，weight/actuator=false。
- HTTPS 接入 CA bundle 与 SNTP 时间前置条件，未实机验证；内部 CA/封闭网络授时还需客户环境适配。
- scripts/configure_web_client.py 从私密 JSON 生成 main/web_client.local.h，避免凭据进入命令行/CMake 日志。当前未生成真实配置头。
- 新增可选串口测试输入：编译配置 `serial_test: true` 时从默认 UART0 逐行接收 JSON，更新 RAM 中 9 个测试通道/上传周期；遥测增加 `capabilities.test_input=true`，服务端仅对同样标记的设备放行有效测试样本。该路径不初始化 HX711/PCA9685/泵，不代表硬件数据。
- 服务端测试身份可在对应 connection.json 设备条目设置 `serial_test: true`，或启动时设置 `APP_SERIAL_TEST=1`；两边都必须启用，否则服务端拒绝测试模式遥测，避免误把串口样本当作实机称重。
- 默认配置仍无 GPIO/I2C 初始化，不调用泵、HX711 或 PCA9685；仅当私有配置显式将 `hx711_probe_channel` 设为 `0..8` 时，启动一个只读单路 HX711 原始计数探测任务。NVS 出错不自动擦除。没有刷写、串口、复位或实机控制操作。

## 验证与阻塞

| 层级 | 当前状态 |
| --- | --- |
| HTTP 协议/命令线格式 | [PASS] 软件侧：7 项 Node 测试通过；不能代替 MCU 执行 |
| 配置生成/隔离测试 | [PASS] 4 项 Python 测试通过，未写真实私有头 |
| ESP-IDF 完整构建 | [FAIL] 本机执行环境阻塞；未产生当前 ELF/bin/map。CMake 已识别 esp_driver_uart，定点 Ninja 对象构建仍无输出并被停止 |
| 刷写/启动/Wi-Fi/真实上传 | [NOT RUN] |
| 真实网络恢复/HTTPS/内存水位 | [HW REQUIRED] |
| 称重/执行器 | [HW REQUIRED] 不属于本阶段 |

先前 idf.py 在 Windows asyncio named-pipe 创建处出现 PermissionError: WinError 5，未进入本轮编译。用户未允许此前的提升权限构建，本轮未再次申请同一提升权限。

2026-09-30 15:53 尝试已有构建目录的直接 Ninja：

    E:/Espressif/tools/tools/ninja/1.12.1/ninja.exe -C build-web-probe -j 4

设置现有 IDF_PATH/IDF_TOOLS_PATH/工具链 PATH 后，Ninja 长时间未输出或推进；verify-build.log 为 0 字节。仅停止了本次创建、启动时间和进程名匹配的 Ninja PID 5928，不扩大到其他构建进程。当前 build-web-probe 下不存在应用 ELF/bin/map，因此不以历史局部对象文件当作本轮编译通过。

## 下一步（用户本机已激活 IDF 的终端）

1. 使用 web_server/README.md 的私密 JSON 方法配置本机 LAN URL、Wi-Fi 和对应设备 token，不将凭据粘贴到命令行。
2. 正常终端执行 `idf.py build`；默认构建目录为 `build`，默认目标为 WEB_CLIENT。记录完整输出与新 ELF/bin 哈希。缺配置的通用构建只提示配置缺失，不连接网络。
3. 在确认具体开发板、串口、当前固件、恢复路径后，另行批准刷写；本报告不提供推断的串口。
4. 从干净启动验证上报、boot/sequence、ping、周期变化→回执→随后遥测实际值、断网重连/后台重启及不重放旧命令。
5. 检查真实堆栈高水位/内存、25 秒长轮询是否阻塞遥测、HTTPS 证书和授时；不连接泵测试网络。

当前源码 SHA-256 与软件证据见 web_server/artifacts/local-smoke.json，不包含密码/token；原始方案文件只读未改。

READY FOR ARCHITECT REVIEW（网络源码待完整构建与实机验证）

