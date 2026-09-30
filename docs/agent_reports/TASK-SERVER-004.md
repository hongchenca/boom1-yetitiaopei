# TASK-SERVER-004 阶段报告：网页与网络联调

时间：2026-09-30（Asia/Shanghai）。范围：网页、后台、模拟器与网络命令闭环，不包括真实硬件和客户服务器部署。

## 结果

已在本工程 web_server/ 建立可运行的 0.2.0 联调应用，并在本机启动。当前 Node 进程 PID 35160，监听 0.0.0.0:8000；本机入口 http://127.0.0.1:8000/。此 PID 仅描述本次启动，重启后会变化。

2026-09-30 16:04 本机健康检查成功；sim-001 在线且序号持续增长，esp32-001 未连接。当前 WLAN IPv4 是 192.168.31.96；同一 Wi-Fi 的终端可尝试 http://192.168.31.96:8000/，但跨终端和防火墙路径尚未实测。VMware 虚拟网卡地址不是推荐设备地址。

登录凭据位于 web_server/data/connection.json，仅本机存储；报告不包含密码或 token。

## 改动与边界

- 技术栈：Node.js 24.14.0 标准库 + node:sqlite + 原生 HTML/CSS/JS，无第三方依赖。与早期 Vue/FastAPI 建议的差异已在 WEB_SERVER_PLAN/ADR-0006 记明；未写入兄弟 fwq 目录。
- 中文桌面/手机页面：总览、八路卡片和中央秤、九通道原始/滤波曲线、实时调参、回执、模拟输出、事件和连接设置。配方页面明确为占位。
- 设备上传、事件、25 秒长轮询与回执分开；身份绑定 token。schema/boot/sequence/版本/TTL、重复请求/回执均校验。未知命令 payload 字段拒绝，限制 ESP 2 KiB 回复缓存压力。
- 回执完成才显示“设备已确认”；上报周期实际显示值仍以随后遥测为准。输入草稿不会被每秒 SSE 快照覆盖。总览停止有可见回执区。
- 重启前待确认命令转 unknown，旧 boot 上传被拒；重复遥测不刷新在线。单设备仅一条普通待确认命令及一个长轮询。退出时先阻止轮询继续访问已关闭 SQLite，已消除退出 ERR_INVALID_STATE。
- SQLite WAL、每设备每秒最多一条历史、24 小时历史/7 天事件命令保留，单进程。实时快照每秒推送，不声称页面 5 Hz。
- 模拟器经真实 HTTP 接口交互，输出独立五秒归零；与实机设备 ID 隔离，但共享应用专用 SQLite。真实开泵/停止不可用。
- 客户交付说明、环境变量、nginx 可合并片段、备份/恢复/回滚边界已补齐，不自动修改其他业务配置。

## 可复验命令

在工程根目录使用本机 Node/Python（若未加入 PATH，见 web_server/README.md 中绝对路径）：

    node --test --test-isolation=none web_server/tests/api.test.js
    node web_server/tests/browser.test.js
    python web_server/tests/configure.test.py
    node web_server/tests/running.test.js

最后一条要求已有本机服务，并读取本机凭据登录、读取状态、退出；不发送设备控制命令。

## 证据

| 项目 | 结果 | 证据/说明 |
| --- | --- | --- |
| API 集成测试 | [PASS] 7/7 | web_server/artifacts/api-test.log；最终回归无退出错误 |
| 固件配置生成 | [PASS] 4/4 | tests/configure.test.py；临时目录验证字符串转义、控制字符、身份/URL和 SSID 字节长度 |
| 实际 Edge 交互 | [PASS] | 独立临时浏览器配置；登录、SSE、周期/回执、草稿保留、ping、点动自动停止、总览停止反馈、实机禁用、记录、登出 |
| 桌面/手机布局 | [PASS] | 1440×1100 与 390×844；无横向页面溢出；截图视觉检查 |
| 浏览器脚本异常 | [PASS] 0 | artifacts/browser/result.json |
| 真实运行服务 | [PASS] | artifacts/local-smoke.json；健康检查/登录/设备列表/退出 |
| 一致性备份与数据库重启 | [PASS] | API 测试中 VACUUM INTO + integrity_check、重启 pending→unknown/离线 |
| 客户服务器/真实 LAN 终端 | [NOT RUN] | 只验证本机 HTTP 和浏览器移动视口，不当作真实手机/客户部署测试 |
| ESP 编译与实机上传 | [NOT RUN] 完整构建未成功 | 详见 TASK-HTTP-004.md；没有本轮 ELF/bin |
| 泵/HX711/PCA9685 | [HW REQUIRED] | 明确留待后续任务，未访问硬件 |

实际浏览器运行时间为 2026-09-30 15:55～15:56；之后对启动错误处理和未知命令字段进行了局部加固，再运行 7 项 API 全量回归。页面代码未在截图验证后更改。浏览器最初在受限环境因 spawn EPERM 失败，经用户允许后运行成功；失败不计为通过证据。

截图：web_server/artifacts/browser/01-login-desktop.png 至 06-debug-mobile.png。当前服务/前端/协议/固件源码 SHA-256 已记录在 web_server/artifacts/local-smoke.json 的 sources 中；无 Git 元数据，因此以时间、命令、文件哈希记录当前工作区版本。

## 仍待完成

1. 配置真实 Wi-Fi、ESP token 与 LAN 地址，完成固件编译/受控刷写/启动及上传验证。
2. 真实浏览器/ESP 的断网、电脑休眠、Wi-Fi 恢复和长时运行测试。
3. 真实称重/泵/本地安全控制、配方与自动配液；模拟器结果不能作为硬件安全依据。
4. 客户环境确认后的 HTTPS/证书/授时、权限分级、离线封包、干净目录升级恢复和部署验收。Node 24 SQLite 有实验性提示，需固定运行时并测试。

建议提交说明：feat: add LAN web console and network-only ESP telemetry client

READY FOR ARCHITECT REVIEW（仅网页/网络第一阶段，不表示硬件或生产交付完成）
