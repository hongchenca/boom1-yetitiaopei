# 通信与命令协议边界

## 原则

网络只提供命令和状态适配，不直接操作 GPIO、I2C、PCA9685 或状态机。所有命令进入 `Command Service`，经过身份、授权、schema/版本、时间新鲜度、幂等键、配方/配置校验后，才转为控制服务可接受的定长内部命令。

## 命令语义

首版至少定义 `GetStatus`、`GetConfigMetadata`、`SubmitDose`、`CancelTask`、`AcknowledgeFault`、`StartCalibration`（权限更高，默认不远程开放）。每个请求包含 `request_id`、`device_id`、协议版本、发送时间/有效期、来源和签名或会话身份；状态变化返回 `accepted/rejected/running/completed/failed`，而不是把入队成功伪装为定量成功。

重复 `request_id` 必须返回同一业务结果或明确“仍处理中”；迟到、过期、乱序命令不得改变当前任务。取消只通过控制服务执行并有优先级，重复取消幂等。自动任务在网络断开时继续由设备本地状态机运行；实时调试会话在租约到期或设备确认失联后停止输出。重连后状态以设备任务记录为准，不能重放未知的执行动作。

## 状态与事件

设备发布只读状态快照和事件：schema 版本、任务/步骤状态、质量、故障码、配置/校准版本、单调时间与相关性 ID。事件队列有界、有丢弃计数和重要等级；安全/完成事件优先保留。日志与协议输出必须脱敏，不含密钥、完整令牌或任意 PWM 数值写入入口。

## 安全与 OTA 前置边界

TLS/证书、设备身份、密钥存储、服务器授权、固件签名、版本回滚和启动确认尚未冻结，均为 Phase 5 的前置设计项。在策略冻结前禁止实现“服务器命令直接变 PWM”或无验证 OTA。OTA 开始前必须拒绝新任务并安全结束/取消当前任务；升级失败回滚后仍保持执行器全关。

## 首版传输边界

网页和后台使用同源 HTTP API；浏览器通过 SSE 接收状态，断线后先读完整快照再恢复增量事件。设备主动向后台上传遥测、事件和配液记录，并以最长 25 秒的 HTTP 长轮询领取命令；有命令时立即返回，不能把 25 秒当作固定执行延迟。遥测、停止回执和调试租约续期使用独立的超时与退避，不能被长轮询阻塞。

请求路径统一使用 `/api/v1/` 版本前缀，浏览器端和设备端入口分开鉴权。请求至少携带 `request_id`、`device_id`、schema 版本、发送时间/有效期和期望配置版本；设备回执携带实际生效版本/值和失败原因。状态至少区分排队、送达、接受、运行、完成、拒绝、过期和执行结果未确认。

## 调试会话与参数更新

调试启动、参数应用和续期必须绑定短期会话、单操作者、会话序号和设备单调时间。设备重新检查权限、能力白名单、范围、输出上限和会话期限；旧会话、旧 `boot_id`、乱序或过期请求不得执行，调试启动命令不得在离线后排队补发。停止请求走独立优先通路。

显示偏好只在浏览器生效；调试中的临时参数经设备回执后在本次会话内生效；配方和自动任务参数显式保存后只对下一任务生效；标定、PWM 公共频率和硬件映射必须停机维护。HTTP 接受只表示后台接收或入队，不能表示执行器已动作。

## 仍待冻结的扩展项

MQTT、串口和 OTA 仍未纳入首版网页联调；TLS/证书、设备身份、密钥存储、消息大小、离线缓存上限、证书轮换、时钟来源和权限角色须在实现网络任务前以 ADR 冻结。HTTP/SSE、设备长轮询和本地模拟器是当前方案的开发基线，服务 URL、端口、超时和数据目录通过部署配置提供。

## 当前八路手动控制实现（2026-10-07）

此节接口已完成后端、浏览器和执行器主机验证及固件编译，实际多泵负载仍需烧录后验证；上文自动配液、OTA 等目标接口不因此视为已实现。

- 实机使用 `PUMP_CONTROL=ON` 固件；后台 `connection.json` 对应设备须有 `actuator: true`，且设备上报 `capabilities.actuator=true`。浏览器登录角色须具有 `operate` 权限。
- `POST /api/v1/devices/{id}/debug-sessions` 创建或续期单操作者 6000 ms 会话。新版返回 `channel_session_ids[8]`，页面使用对应路的令牌作为 `debug_apply.payload.session_id`；旧固件使用返回的全局 `session_id`。页面每次手动操作取得会话，不后台自动续租。
- `POST /api/v1/devices/{id}/commands` 沿用 schema 1 和幂等 `request_id`。`debug_apply.payload` 为 `{channel:0..7, value_percent:0..100, expected_config_version, session_id}`；真实设备版本取 `status.actuator.config_version`，占空比不得超过设备上限。`stop.payload` 为 `{}` 时全停，`{channel:0..7}` 时只停本路；均不要求调试会话，可在故障状态下提交。旧固件不支持逐路停止。
- 后台向设备添加 `boot_id`、`deadline_uptime_ms` 和递增安全整数 `control_sequence`；点动另有 `lease_deadline_uptime_ms`。点动入队有效期最多 3000 ms，停止 15000 ms。设备单调期限按最新遥测 uptime 与接收后的服务器经过时间估算，网络上传延迟会使可运行时间缩短。
- 控制序号按设备持久化，设备按本次启动严格递增接收；相同命令 ID 缓存回执，不重复执行。后台重启将未确认命令置为 unknown，不重放；恢复较旧的数据库后若序号回退，需重启设备建立新 boot 后再操作。
- 投递前后台再次核对会话及操作者有效性。新版允许不同路命令同时排队，保持设备全局控制序号按入队顺序投递；同路在途请求不能重叠。单停取消本路待执行命令并轮换本路令牌，其他路不受影响；全停撤销整个会话和所有待执行命令。网页同时撤销尚未提交的对应旧开泵意图。固件重新校验版本、通道、上限和期限后调用 `actuator_set`；HTTP 层不写 PCA9685 寄存器。
- 每路每次远程运行不超过 `min(开始时间+5000 ms, lease_deadline_uptime_ms)`，本地任务约每 10 ms 检查（受 RTOS 调度影响）。设备失去网络后仍按本地期限关断；此版本没有持续按住自动续跑。单路停止或到期仅写回该路 FULL_OFF 并回读，保留其他路；全停、故障或总线阻塞超过截止预算时通过共享 OE 全关。启泵写后回读期间短暂禁能共享 OE，回读成功后恢复仍有效输出。
- 完成回执包含 `applied_value_percent`、`applied_config_version`、`maximum_run_ms`、`remaining_ms`、`registers_verified`；表示该命令的输出应用/关断结果，不是定量配液完成。新版 `status.actuator` 增加 `parallel_supported:true` 和 `remaining_ms_by_channel[8]`，并保留 `duty_percent[8]` 及旧标量状态；网页逐路显示输出和剩余时长。它是软件与寄存器状态，不是负载端测量。

网页与固件均不开放 PWM 公共频率修改或清除故障；本地维护通过执行器接口处理故障。普通停止不会清除锁存故障。0.6.1 的出口与闭环接口见下一节。

## 出口与本地配液（2026-10-07，固件 0.6.1）

仍使用 schema 1、现有命令队列与全局 `control_sequence`，设备校验 boot、期限、参数、版本与互锁。

| 命令 | payload | 完成回执含义 |
| --- | --- | --- |
| `aux_apply` | CH8：`channel:8, value_percent, session_id, expected_config_version`；CH9：`channel:9, pulse_us, session_id, expected_config_version` | 指令应用成功，分别返回 `applied_value_percent` 或 `applied_pulse_us`；单次最多 5 秒 |
| `outlet_configure` | `vessel_us, waste_us, expected_position_version` | 两个不同的 500..2500 µs 位置已提交 NVS，返回新 `position_version`；不驱动舵机 |
| `dosing_start` | `steps:[{channel,target_mg,tolerance_mg}], config, expected_position_version` | `accepted:true, run_id`，仅表示本地任务已接受，尚未完成 |
| `stop` | `{}` 全停；旧单路 `{channel}` 在配液运行时也会取消当前批次 | 关断结果，不清除硬件故障 |

`config` 的完整字段、整数范围和字段关系定义在 `web_server/public/dosing-config.js`；固件重新独立验证。网页以带单位的表单输入，线上的质量仍为 mg、时间仍为 ms。默认液泵非零输出不得低于 40%，各速度依次满足 `minimum ≤ fine ≤ slow ≤ fast`。CH8 气泵不沿用液泵死区，需独立实测。

`status.actuator` 保留旧八路数组，并扩展 `minimum_percent, auxiliaries_supported, air_percent, servo_pulse_us, air_remaining_ms, servo_remaining_ms`。开启辅助输出时全 PCA 使用 50 Hz；液泵/气泵互斥，电机运行时禁止改变舵机位置。

`status.dosing` 提供能力、活动标记、阶段、错误、位置及版本、批次号、步骤、补液次数、容器增重、源液减重、估计流速和各步最终 `dose_mg`。`state=done` 才表示清液后最终核验合格。`flow_limit` 表示实测流速超过配置上限；其他错误见控制器枚举。字段是软件状态，不是舵机机械到位反馈。

九路称重增加 `control_mg, stable_mg, window_ms, filter_delay_ms`。`stable_mg` 只能在有效且稳定时用于核验。固件使用本地单调采样时间；网页显示滤波不回传控制器。

自动任务运行时独占输出，禁止调试与称重校准。断网后本地闭环继续，外部全停代次使任何迟到控制请求失效；重启不恢复任务。结果存在设备 RAM 与后台遥测/命令历史中，当前 `/jobs` 业务持久化接口尚未接入。

## 第一台 HX711 接入（2026-10-03，固件 0.4.0）

- schema 1 增量扩展。实机需服务端身份 `weight: true` 才可上报 `capabilities.weight: true`；不允许同时启用 `serial_test`。仅 channel 0 可提交真实重量，其余未连接通道仍保持无效和 null。
- 第一通道新增 `raw_count`、`average_raw`（有符号 24 位 counts 或 null）、`samples`（0..16）、`calibrated`、`tare_ready`、`calibration_version`（1..INT32_MAX）与 `last_error`。未校准、读取失败、饱和、质量越界或样本超过 500 ms 时，`valid=false`、质量为 null。`stable=false` 表示尚未定义稳定检测。
- `weight_tare.payload = {channel:0, expected_calibration_version}`；`weight_calibrate.payload` 额外要求 `reference_mg`（整数 1..1e9）。浏览器以 g 输入并转换为 mg。命令经现有登录操作权限、设备授权、boot、期限、版本和幂等缓存校验；设备与后台均拒绝在泵运行时去皮/校准。采集任务独占 HX711，网络读取快照。
- 去皮/校准使用最近完整 16 点窗口，调用前用户静置至少 2 秒；成功使版本加一。先去皮再校准，有符号比例支持反向接法；已有校准后的再次去皮保留比例。参数只保存在 RAM，重启后重新去皮/校准，旧 boot 命令不可应用。
- 成功回执包含 `calibration_version` 和 `calibrated`，随后遥测才是当前重量的状态依据；校准失败回执为 `weight_not_ready`，泵运行返回 `pump_busy`。网页“记录”页保存的标定记录仍不自动下发。

## 九路持久化与实时推送（2026-10-03，固件 0.5.0）

本节取代上文 0.4.0 的第一路/RAM 限制。schema 1 保留，新增 `status.weight_service_version=2`，九路各自 `enabled/initialized`；服务端仍接受旧 0.4.0 第一通道报文以便先更新后台。

每路新增 `calibration_ready/saved/storage_error/raw_band/noise_band_mg/noise_mg/sample_period_ms/sample_sequence`，`stable` 由设备实际稳定窗口输出。`last_http_ms` 表示设备上一次遥测构建与 HTTP 往返耗时，不能当作单向总延迟。未接入通道质量始终 null。

`weight_tare/weight_calibrate` 的 channel 扩展为 0..8；`weight_reset` 使用相同 channel/expected_calibration_version 清除一路校准；`weight_configure` 另带 raw_band（1..100000 counts）与 noise_band_mg（1..10000 mg）。去皮和校准要求设备新鲜稳定窗口；阈值保存/清除允许不稳定状态，以便故障维护。四种命令均要求当前设备在线、有称重授权、泵停止、版本匹配，并通过原有 boot/期限/幂等校验。

操作先提交 NVS，再返回成功版本。失败不会发布新参数，storage_error 保留诊断；重启按 GPIO/格式/数值范围加载。旧 0.4.0 RAM 校准需升级后重新进行。人工标定记录接口仍仅归档，不自动修改设备。

生产后台拒绝 simulation/test_input=true，移除模拟器与模拟批次执行；保留这两个 false 字段以兼容 schema 1。SSE 在新遥测入库/更新内存后立即推送；独立 1 秒心跳更新在线状态，慢连接超过背压上限关闭重连。UI 保留最近 180 点，SQLite 仍限每秒一条；更快显示不增加历史写入频率。
