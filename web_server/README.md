# Yetitiaopei 网页与 ESP32 联调网关

更新：2026-09-30；版本 0.2.0。当前只做网页、模拟设备和 ESP32 网络，不操作泵、PCA9685 或 HX711。

## 1. 本机启动

运行环境：Node.js **24.14.x**（已使用 24.14.0 验证）。使用标准库、内置 SQLite 和静态 HTML/CSS/JS，**不需要 npm install、Python 服务或前端构建**。Node 24 的 SQLite 仍会输出实验性功能提示；客户交付前固定并复测运行时版本。

在工程根目录运行：

```powershell
cd E:\111111111\yeti\yetitiaopei
& 'E:\Program Files\nodejs\node.exe' .\web_server\server.js
```

如果 node 已加入 PATH，可用 `node web_server/server.js`。此方式不受 npm.ps1/start.ps1 的 PowerShell 执行策略影响。已有 `start.ps1` 仅为可选封装。按 Ctrl+C 停止。

- 本机浏览器打开 `http://127.0.0.1:8000/`。
- 首次启动自动生成 `web_server/data/connection.json`，用其中 username/password 登录。此文件同时包含实机 token，**不要截图、提交、放进交付包或发送聊天**。
- 默认监听 `0.0.0.0:8000`，手机/ESP32 使用电脑的实际局域网 IPv4；可用 `ipconfig` 查看。`127.0.0.1` 不能作为 ESP32 的服务器地址。
- 电脑与设备需网络互通，电脑不能休眠。仅在可信局域网调试 HTTP；本程序不自动更改防火墙。若访问被挡，由用户按实际网络配置仅限本地子网的入站规则；检查 AP 客户端隔离。

## 2. 现在可以做什么

登录后选择“演示设备 · 模拟数据”，可以查看 8 路源容器和中央秤、九通道原始/滤波曲线、事件、上报周期和命令回执。模拟器通过真实 HTTP 设备接口上报，并非页面随机生成数据。

- 上报周期 200～10000 ms，RAM 生效；设备重启恢复 1000 ms。点击“应用周期”后等待**设备已确认**，页面“设备当前”以之后的遥测为准。
- SSE 每秒广播最新快照；200 ms 上报不等于浏览器 5 Hz 刷新。历史最多保存每设备每秒一条，接口返回最近 180 条；曲线不是精密采样/计量工具。
- 模拟点动有独立 5 秒归零计时器；可停止，只作用于 `sim-001`。这不是硬件调试租约、急停或真实执行器安全验收。
- 实机未连接时显示离线；连接后九路质量仍为 null/“—”，绝不补成 0。仅支持 ping 和上报周期，真实开泵/停止入口禁用。
- 配方编辑、标定、自动配液、用户角色、多用户审计和生产设备控制暂未实现。

## 3. 配置 ESP32 上传

1. 先启动后台生成凭据。将 `web_server/device.example.json` 复制为 `web_server/data/device.local.json`。
2. 本机编辑该文件：填写真实 Wi-Fi、电脑 LAN 服务 URL、`esp32-001` 及 connection.json 中对应设备 token。URL 不带末尾斜杠；子路径示例 `http://电脑IP:8000/console`。
   若要启用“串口输入样本”联调，将 `serial_test` 保持为 `true`，并在 `connection.json` 对应设备条目加入 `"serial_test": true`；这只是允许测试数据，不代表接入 HX711。修改 JSON 后需重启后台。
   也可以不改 JSON，在启动后台前设置 `$env:APP_SERIAL_TEST='1'`；这会把当前配置中的所有实机设备临时标记为串口测试设备，重启后台后仍需保留该环境变量。
3. 生成被忽略的私有头文件（不在命令行传密码）：

```powershell
& 'E:\Espressif\tools\python_env\idf5.4_py3.11_env\Scripts\python.exe' .\scripts\configure_web_client.py .\web_server\data\device.local.json
```

4. 在 ESP-IDF 5.4.2 已激活的终端构建：

```text
idf.py build
```

刷写后串口保持 115200。启用串口测试时，固件启动日志会打印 `SERIAL_TEST_READY`。每行发送一个 JSON 后回车，例如：

```json
{"channel":0,"mass_mg":12345,"filtered_mg":12300,"valid":true,"stable":true,"age_ms":0}
{"channels":[{"channel":0,"mass_mg":12345,"filtered_mg":12300,"valid":true,"stable":true,"age_ms":0},{"channel":8,"mass_mg":80000,"filtered_mg":79800,"valid":true,"stable":true,"age_ms":0}],"interval_ms":500}
STATUS
CLEAR
```

单位是 mg；通道范围 0～8，周期 200～10000 ms。串口输入只保存在 RAM，下一次遥测上传到网页；`STATUS` 查看是否启用，`CLEAR` 恢复九路 null。串口与日志共用 UART0，因此发送时不要把日志内容作为 JSON；设备配置、编译成功和实机刷写仍需用户自行验证。

入口 `main/web_client.c`；配置 `main/web_client.local.h`。不再使用 CMake 凭据参数。没有私有头文件也可构建，但固件仅提示缺少配置，不连接网络。WEB_CLIENT 与 PCA004_BENCH 互斥；默认内存探针入口保持不变。

Wi-Fi、遥测和命令长轮询分别处理，断线退避；命令仅校验后修改网络 RAM 配置。NVS 初始化失败不会擦除分区。固件和备份包含凭据时必须按私密文件保管；正式交付应为客户重新配置设备身份。

HTTPS 已接入 CA bundle 校验和 SNTP 时间前置检查，但真实证书/授时/断线恢复尚需实机验证。内网自签 CA 或无互联网授时的客户环境需单独适配，不能关闭证书校验。

**本轮不刷写、不打开串口、不复位、不擦 NVS。** 构建、烧录、启动、实机 HTTP 和硬件验收是不同层级。

## 4. 配置与部署

| 环境变量 | 默认值 | 作用 |
| --- | --- | --- |
| APP_HOST | 0.0.0.0 | HTTP 监听地址 |
| APP_PORT | 8000 | 独立服务端口 |
| APP_BASE_PATH | 空 | 可选 /console，资源/API/SSE 使用同一前缀 |
| APP_DATA_DIR | web_server/data | 独立本地磁盘数据目录，不使用共享网络盘 |
| APP_SIMULATOR | 1 | 客户部署设置 0 |
| APP_SECURE_COOKIE | 0 | HTTPS 代理部署设置 1 |

应用**单进程单实例**。只读源码目录与可写数据目录可分离；不读取客户其他资料。部署和反向代理示例见 `deploy/README.md`。目前是单管理员 LAN 联调版本，不应直接公网开放。

## 5. 备份与恢复

在线一致性备份（工程根目录，目标不能已存在）：

```powershell
node web_server/backup.js web_server/data/backup-2026-09-30.db
```

使用 SQLite `VACUUM INTO`，不要只复制运行中的 telemetry-v1.db 而遗漏 WAL。connection.json 需要另外保密备份。

恢复时先停服务；保留完整旧数据目录用于回滚，在**新的空数据目录**放入备份并命名 telemetry-v1.db，放回匹配的 connection.json，再设置 APP_DATA_DIR 指向新目录启动。不要把旧 WAL/SHM 混入新目录。待设备新上报后再确认在线；重启前未确认命令显示 unknown，不自动重放。

历史保留 24 小时，事件/命令保留 7 天，每 30 秒清理一次；不承诺无限离线数据保存。

## 6. 复验

```powershell
node --test --test-isolation=none web_server/tests/api.test.js
node web_server/tests/browser.test.js
python web_server/tests/configure.test.py
node web_server/tests/running.test.js
```

第一条测试 HTTP 鉴权、真实空样本、完整命令下发/回执、幂等、长轮询、重启、备份、子路径/SSE 和模拟器自动停止。第二条使用独立临时 Edge 配置，保存截图至 web_server/artifacts/browser；不使用个人浏览器会话，启动需当前环境允许子进程。第三条在临时工程验证私有配置生成，不修改真实头文件；本机 python 不可用时改用前述 IDF Python 绝对路径。第四条检查已运行的本机服务并记录源码哈希，不发送设备操作命令。

实际验证和未完成项见 `../docs/agent_reports/TASK-SERVER-004.md`。客户服务器和另一台 LAN 终端未由本轮自动验收。
