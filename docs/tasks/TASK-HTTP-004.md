# TASK-HTTP-004：设备 HTTP 上行、命令与回执适配

## Objective

为 ESP32 实现面向本机/客户后台的主动 HTTP 连接，复用 `../WEB_SERVER_PLAN.md` 的协议。完整网页由后台托管；设备所有改变状态的请求只进入 Command Service，不直接访问 GPIO、I2C、PCA9685 或状态机内部对象。

## API

调用后台 `/api/v1/device/telemetry`、`/events`、`/dose-records`、`/commands/poll` 和 `/commands/{id}/ack`（后四项均以前述 `/api/v1/device` 为前缀）。服务 URL、凭据、上报速率和超时可配置，客户端遵循同一 OpenAPI/schema。

遥测附 boot_id、样本序号、单调采样时间、样本年龄和生效配置；长轮询不得阻塞遥测、回执和调试续期。请求有限大小/超时，校验 request_id/schema/device_id/过期与期望版本，重复请求幂等，停止优先。连接恢复先核对状态，不能重放过期开泵请求。

## Dependencies

2026-09-30 阶段实现：main/web_client.c 提供独立 WEB_CLIENT 网络入口，main/CMakeLists.txt 负责互斥选择，scripts/configure_web_client.py 从私有 JSON 生成本机头文件。这些文件、main/.gitignore、协议测试和报告纳入当前阶段允许范围；后续再整理为 connectivity 服务。当前只实现遥测/启动事件/ping/上报周期/回执，不实现 dose-records、自动任务或硬件租约。构建和实机验证状态见 ../agent_reports/TASK-HTTP-004.md。

自动任务、配置保存、调试会话分别依赖 domain/command/control/storage/actuator 窄接口；相关能力须在对应实现任务中补齐。HTTP 模块不能代替设备侧租约计时或直接输出 PWM。能力未实现时明确拒绝并上报 capability，不伪造成功。轻量本地状态/配网页可后续增补；完整设备内置控制台不是此任务前置条件。

## Allowed files

仅允许新建 `components/connectivity/`、协议测试/fixtures 和 `docs/agent_reports/TASK-HTTP-004.md`；依赖接口或构建接入变更在相应任务中列明。不得修改服务器目录、执行器、控制器、`sdkconfig*` 或分区。不刷机、不启动真实泵。协议测试使用模拟后台，固件构建按授权执行，报告结尾 `READY FOR ARCHITECT REVIEW`。
