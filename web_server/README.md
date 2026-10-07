# Yetitiaopei 网页与 ESP32 联调网关

更新：2026-10-07；实机固件版本 0.6.1。网页提供九路 HX711 称重/持久化校准、八路液泵、CH8 气泵、CH9 舵机位置试运行与保存、本地闭环配液；保留配方、人工标定记录和审计。业务 `/jobs` 仍不执行真实批次，闭环通过 `dosing_start` 下发不可变参数快照，完成状态读取设备遥测。

## 1. 本机启动

运行环境：Node.js **24.14.x**（已使用 24.14.0 验证）。使用标准库、内置 SQLite 和静态 HTML/CSS/JS，**不需要 npm install、Python 服务或前端构建**。Node 24 的 SQLite 仍会输出实验性功能提示；客户交付前固定并复测运行时版本。

在工程根目录运行：

```powershell
cd E:\111111111\yeti\yetitiaopei
& 'E:\Program Files\nodejs\node.exe' .\web_server\server.js
```

如果 node 已加入 PATH，可用 `node web_server/server.js`。此方式不受 npm.ps1/start.ps1 的 PowerShell 执行策略影响。已有 `start.ps1` 仅为可选封装。按 Ctrl+C 停止。

- 本机浏览器打开 `http://127.0.0.1:8000/`。
- 如果提示端口已有服务，直接访问现有地址。CLI 现在先监听成功再打开数据库，重复启动不会改变正在运行的服务或待执行命令。
- 首次启动自动生成 `web_server/data/connection.json`，用其中 username/password 登录。此文件同时包含实机 token，**不要截图、提交、放进交付包或发送聊天**。
- 默认监听 `0.0.0.0:8000`，手机/ESP32 使用电脑的实际局域网 IPv4；可用 `ipconfig` 查看。`127.0.0.1` 不能作为 ESP32 的服务器地址。
- 电脑与设备需网络互通，电脑不能休眠。仅在可信局域网调试 HTTP；本程序不自动更改防火墙。若访问被挡，由用户按实际网络配置仅限本地子网的入站规则；检查 AP 客户端隔离。

## 2. 现在可以做什么

登录后选择已注册 ESP32，查看九路重量、稳定状态、曲线及执行器回执。没有设备上报时显示离线；无效或未校准的质量显示“—”。

- 默认上报 200 ms，可设 200～10000 ms；设置只在 RAM 生效。后台收到上报立即 SSE 推送，1 秒心跳只更新在线/年龄。历史按每设备每秒最多一条入库。
- 默认使用“平衡滤波”，可在总览切换“平稳滤波”或“设备读数”。显示层采用最多 5 点中值、时间常数平滑及 0.02 g 末位滞回；大变化快速跟随，保留负数，不自动去皮。选项仅保存在本浏览器，不改变设备参数、校准门槛或历史记录。曲线默认仅显示当前模式的重量，勾选“原始对照”可核对原始质量；最小纵轴跨度为 1 g，避免将微小波动过度放大。
- 网页 4 秒收不到有效快照时将旧数据标为过期并禁用操作，自动只读查询恢复；实时连接受阻时每 2 秒查询设备快照，失败退避至 8 秒。恢复不补发泵或校准操作。后台会话过期会返回登录页；浏览器休眠恢复也会重查样本年龄。
- 配方编辑提示未保存修改，切配方/新建/刷新会确认；保存期间锁定表单，防止覆盖继续输入的内容。界面按账号角色禁用不能执行的操作。
- 八路泵使用独立控制卡片，每路可设置占空比、启动和停止；新版固件支持八路并发，每路每次最多运行 5 秒，由设备独立计时关断。网页以 `status.actuator.parallel_supported` 判断是否支持并发，旧固件会提示升级。
- “设备操作 → 称重校准”可选 9 路，去皮、砝码校准、阈值保存及清除本路校准，参数保存在设备 NVS，断电恢复。不能操作时会显示供电/接线、等待稳定、泵运行或连接状态原因。
- 演示设备、模拟批次、模拟数据来源、串口造数入口已移除，旧测试环境变量不再生效。历史演示记录保留数据库但不展示、不继续执行。

## 3. 配置 ESP32 上传

1. 先启动后台生成凭据。将 `web_server/device.example.json` 复制为 `web_server/data/device.local.json`。
2. 本机编辑该文件：填写真实 Wi-Fi、电脑 LAN 服务 URL、`esp32-001` 及 connection.json 中对应设备 token。URL 不带末尾斜杠；子路径示例 `http://电脑IP:8000/console`。
   八路产品固件默认启用 `PUMP_CONTROL`。在 `connection.json` 对应实机设备条目加入 `"actuator": true` 后重启后台，允许该设备的泵能力上报与网页控制；保留原有 id/token。若只需旧网络功能，编译时显式使用 `-DPUMP_CONTROL=OFF`。
   在对应设备条目加入 `"weight": true`，允许真实称重上报与校准。旧字段 `serial_test` 保持 false，`hx711_probe_channel` 保持 -1 或省略。
3. 生成被忽略的私有头文件（不在命令行传密码）：

```powershell
& 'E:\Espressif\tools\python_env\idf5.4_py3.11_env\Scripts\python.exe' .\scripts\configure_web_client.py .\web_server\data\device.local.json
```

4. 在 ESP-IDF 5.4.2 已激活的终端构建：

```text
idf.py -B build -DWEB_CLIENT=ON -DPCA004_BENCH=OFF -DPCA004_CYCLE=OFF -DPUMP_CONTROL=ON -DOUTLET_CONTROL=ON -DPUMP_PWM_HZ=50 -DPUMP_MIN_PERCENT=40 -DPUMP_MAX_PERCENT=100 -DHX711_SCALE1=ON -DHX711_ENABLED_MASK=511 build
```

刷写后串口保持 115200，九路初始化日志显示各自 GPIO。原始计数、状态和诊断在网页查看；产品不接受串口测试数据。未配置 Wi-Fi 时独立称重采集仍会启动。

校准先选择通道、空载等待可校准并去皮，再放砝码、等稳定后输入实际质量（g）。零点与系数只在用户操作时写 Flash，不按采样频率写入。阈值默认 200 counts / 50 mg，按实际噪声调整；其他接线/算法/构建参数见根目录 README。

Wi-Fi、遥测和命令长轮询分别处理，断线退避；泵命令校验后进入 `actuator` 服务，本地独立任务管理运行截止时间。NVS 初始化失败不会擦除分区。固件和备份包含凭据时必须按私密文件保管；正式交付应为客户重新配置设备身份。

HTTPS 已接入 CA bundle 校验和 SNTP 时间前置检查，但真实证书/授时/断线恢复尚需实机验证。内网自签 CA 或无互联网授时的客户环境需单独适配，不能关闭证书校验。

**本轮不刷写、不打开串口、不复位、不擦 NVS。** 构建、烧录、启动、实机 HTTP 和硬件验收是不同层级。

## 4. 配置与部署

| 环境变量 | 默认值 | 作用 |
| --- | --- | --- |
| APP_HOST | 0.0.0.0 | HTTP 监听地址 |
| APP_PORT | 8000 | 独立服务端口 |
| APP_BASE_PATH | 空 | 可选 /console，资源/API/SSE 使用同一前缀 |
| APP_DATA_DIR | web_server/data | 独立本地磁盘数据目录，不使用共享网络盘 |
| APP_SECURE_COOKIE | 0 | HTTPS 代理部署设置 1 |

应用**单进程单实例**。只读源码目录与可写数据目录可分离；不读取客户其他资料。部署和反向代理示例见 `deploy/README.md`。目前支持 viewer/operator/engineer/admin 角色，不应直接公网开放。

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
node --test --test-isolation=none web_server/tests/api.test.js web_server/tests/business.test.js
node web_server/tests/browser.test.js
python web_server/tests/configure.test.py
node web_server/tests/running.test.js
```

第一条测试 HTTP 鉴权、真实空样本、完整命令下发/回执、幂等、长轮询、重启、备份、子路径/SSE 、九路校准授权与即时推送延迟。第二条使用独立临时 Edge 配置，保存截图至 web_server/artifacts/browser；不使用个人浏览器会话，启动需当前环境允许子进程。第三条在临时工程验证私有配置生成，不修改真实头文件；本机 python 不可用时改用前述 IDF Python 绝对路径。第四条检查已运行的本机服务并记录源码哈希，不发送设备操作命令。

本次九路称重验证见 `../docs/verification/2026-10-03-weight-nine.md`；早期后台验证保留在 `../docs/agent_reports/TASK-SERVER-004.md`。客户服务器和另一台 LAN 终端未由本轮自动验收。
