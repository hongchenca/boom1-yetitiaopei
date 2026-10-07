# 网页连接恢复与称重显示验收

日期：2026-10-03，Asia/Shanghai。后台 0.5.1，实机仍为 `web-client-0.5.0`。基线 `5565356`，保留工作区原有未提交修改。本轮修改网页、后台启动/SSE 和测试，没有更改或烧录固件，没有发送泵、去皮或校准命令到实机。

## 实测问题与处理

- 实机已有 median-of-3 + 1/2 EMA，网页并非直接显示 ADC，但这层滤波仍偏轻。35 秒观察共 174 个不同遥测帧，CH0 设备滤波值范围 101.728～102.082 g，16 点原始窗口波动 0.170～0.497 g，稳定门槛为 0.050 g，设备持续判定不稳定。此次没有擅自放宽稳定门槛。
- 同段 Wi-Fi RSSI 为 −86～−60 dBm，中位 −79 dBm；上报间隔中位 193 ms、P95 280 ms、最大 1187 ms。观察期间未复现设备离线，弱信号是现场待核查项，不能单凭这段数据断言所有断连都来自 Wi-Fi。
- 网页原来仅依赖 EventSource error，没有静默失联检测、回退读取和本地样本过期时钟。现在 4 秒无快照即禁用写操作并恢复只读连接，SSE 受阻可用 2 秒轮询回退；失败 1～8 秒退避，网络恢复/页面唤醒重查，不自动重放写操作。服务与设备离线分别提示。
- 登录失效明确结束 SSE；重新登录重新加载业务状态，旧请求受会话代次隔离。浏览器与设备各自的在线状态不混用。
- CLI 重复启动原先在端口失败前就打开数据库并作重启恢复，可把现有待执行命令标记 unknown。现改为监听成功后才打开数据库；回归测试确认端口失败不改原命令。
- 配方未保存保护、保存期间锁定、跨通道标定记录迟到响应隔离、角色对应按钮、所有页面可见的断连提示一并修复。

## 显示滤波

`public/weight-filter.js` 以设备、boot、通道和校准版本隔离状态；重复 sample_sequence 不推进滤波，失效/长间隔/版本改变清空状态。默认 5 点中值 + 650 ms EMA；平稳模式 1400 ms；大于 max(1 g, 6 倍稳定阈值) 的变化使用 140 ms 跟随。慢速上报缩短中值窗口，不积累数十秒延迟。0.02 g 显示滞回降低末位抖动，不钳制负值或自动归零。

只影响网页读数和显示曲线，原始测量、数据库、设备校准/稳定判断不变。曲线可开启原始对照，最低纵轴跨度 1 g。浏览器存储不可用时仍能工作，仅不能持久保存显示偏好。

同一段已采集数据离线回放，去掉前 20 帧预热：设备读数范围 0.276 g、平衡模式 0.129 g、平稳模式 0.103 g。约 30 秒内 0.01 g 末位变化次数为 137 / 32 / 12。此为显示平稳程度，不是称重准确度。算法测试的 100 g 阶跃在五个 200 ms 帧内达到 90%以上；仍需现场砝码检验完整响应时间。

## 验证

- [PASS] 17 项接口/业务/算法测试：鉴权、命令往返、版本/通道隔离、备份/重启、重复启动保护、SSE 会话到期、噪声/尖峰/阶跃、负数、重复采样及跨通道隔离。
- [PASS] Edge/CDP 隔离测试：五页 × 320/390/768/1024/1440 px，真实指针交互；SSE 被阻断和静默停止、轮询回退、浏览器网络离线/恢复、设备停上报、会话失效再登录、只读角色、草稿保护、滤波偏好。无 JS 运行时异常。
- [PASS] 本机实机浏览器观察 100 次、约 20 秒：遥测序号 37160→37245，网页及设备离线计数均为 0；原始重量范围 0.338 g，设备滤波 0.274 g，网页显示 0.118 g。五份在用静态资源逐字节匹配工作区，哈希记录在证据中。
- [HW REQUIRED] CH1～CH8 仍没有 raw 数据、sample_sequence=0、ESP_ERR_TIMEOUT，需要检查供电/共地/接线。滤波不能恢复未接入的传感器。
- [NOT RUN] 长时间弱网浸泡、实物砝码精度/响应、全部九路验收、自动闭环配液。本轮不把短期网页验证作为完整硬件产品验收。

复验命令（工程根目录）：

```powershell
node --test --test-isolation=none web_server/tests/api.test.js web_server/tests/business.test.js web_server/tests/weight-filter.test.js
node web_server/tests/browser.test.js
node web_server/tests/running.test.js
```

本机证据（被 Git 忽略，不含密码或设备 token）：

- `web_server/artifacts/product-observation.json`：35 秒实机采集。
- `web_server/artifacts/product-filter-replay.json`：三种显示模式回放统计。
- `web_server/artifacts/product-api-tests.log`、`product-browser-tests.log`、`browser/result.json`。
- `web_server/artifacts/product-live-verified.json`：实际网页读数、状态和资产 SHA256。
- `web_server/artifacts/product-live-desktop.png`：实机网页截图。

## 更新和恢复

更新前确认实机输出 0%、无待执行命令，生成一致性备份 `web_server/data/backup-before-product-20261003-1730.db`。精确核对原进程 PID 41812 后替换为 PID 45596，继续监听 8000；`healthz` 返回 0.5.1。实机 boot_id 未变且序号继续增加，未复位设备。后台更新使旧网页会话失效，需要重新登录。

代码更新前备份位于 `web_server/artifacts/product-before/`。恢复数据库必须停止后台并按项目 README 恢复，不能覆盖运行中的 SQLite/WAL。正常前端回退不需要恢复数据库。
