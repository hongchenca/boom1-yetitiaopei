# 2026-10-07 出口与闭环配液验证

本轮针对代码质量重新审查，固件标识 `web-client-0.6.1`。未烧录设备、未运行实际液泵/气泵/舵机，未重启用户正在使用的后台。测试数据库、浏览器 profile 和硬件替身均隔离。

## 修正及对应回归

| 发现 | 修正 | 验证 |
| --- | --- | --- |
| 精加脉冲每次重置无流量计时 | 累计启泵无进展时间，停泵判稳暂停计时 | 0.9 g 小剂量、泵不出液，多次补液后触发 `no_flow`，未到补液上限 |
| 超上限流速被忽略，可能保留旧预停估计 | 报 `flow_limit` 并停机 | 将流速上限设为 1 g/s，注入更大流速，输出关闭 |
| 预测尾流被慢速阈值裁剪 | 保留到本步目标的预测预算，计入样本年龄和控制周期 | 1 秒尾流、1 g 慢速阈值，10 g 目标在 8.5 g 之前预停 |
| 清液变化阈值可能掩盖更小的配方容差 | 清液后重新验证本步质量与平衡，更新最终剂量 | 两步任务，第一步容差 0.05 g，清液后减少 0.15 g，在进入第二步前判不足 |
| 到位等待包含 I2C 指令耗时 | 等待起点改为舵机指令应用完成时刻 | 注入 60 ms 回读耗时，仍完整等待 route_ms；续租不重置等待起点 |
| 整数 EMA 可能卡在相邻 count | 快/显示通道 Q16 累加及对称四舍五入 | 正负数的一 count 阶跃均收敛 |
| 页面依赖手填 JSON | 克数步骤表、分组参数表、舵机滑块与已应用位置记录 | 真正浏览器点击到队列、回执、遥测，12.345 g 下发为 12345 mg |
| 离线后迟到快照可复活页面状态 | 快照入口检查浏览器离线状态 | 离线时注入旧快照，仍离线且控制禁用 |

## 已执行检查

在有 MSVC `cl` 的终端执行，或先调用 VS BuildTools 的 `vcvars64.bat`：

```powershell
python components/dosing/tests/run_host_tests.py
python components/weight/tests/run_host_tests.py --idf-path E:/Espressif/frameworks/esp-idf-v5.4.2
```

均通过。测试编译真实控制器、服务、执行器、HX711 与称重服务源码；I2C/GPIO、时间、NVS 和传感器以替身注入。覆盖输出独占、液气互锁、租约截止、停止代次、NVS 失败及重载、过量、失效/过期传感器、取消等。遥测测试使用固件真实序列化函数及 IDF cJSON，样本帧 6634 / 12288 字节，小缓冲拒绝通过。

称重噪声合成序列中显示误差能量 82500，快通道 1595000；只证明此测试序列上的抑制效果，不代表真实称重精度。MSVC 主机测试仍报告现有 `sscanf` 弃用提示及 cJSON 长度参数转换提示；ESP-IDF 最终增量编译没有编译器 warning/error。

```powershell
cd web_server
node --test --test-isolation=none tests/api.test.js tests/business.test.js tests/weight-filter.test.js
node tests/browser.test.js
```

后台 **20 / 20** 通过。Edge/CDP 浏览器最终结果通过，时间 `2026-10-07T10:13:56.383Z`；覆盖 CH8/CH9 操作、两个位置保存、滑块不自动下发、克/毫克转换、无效容差阻止启动、运行时互锁、接受与完成区分、断网与迟到快照、只读角色。宽度 320/390/768/1024/1440 的各页面检查通过，闭环高级参数展开时也无横向溢出。浏览器协议夹具不证明物理动作。

产物：

- `web_server/artifacts/browser/result.json`
- `web_server/artifacts/browser/15-outlet-dosing-desktop.png`
- `web_server/artifacts/browser/desktop-debug.png`
- `web_server/artifacts/browser/mobile-debug.png`

## 固件构建

ESP-IDF 5.4.2，目标 ESP32-S3，原分区不变，编译优化使用 `CONFIG_COMPILER_OPTIMIZATION_SIZE=y`。

```powershell
idf.py -B build -DWEB_CLIENT=ON -DPCA004_BENCH=OFF -DPCA004_CYCLE=OFF -DPUMP_CONTROL=ON -DOUTLET_CONTROL=ON -DPUMP_PWM_HZ=50 -DPUMP_MIN_PERCENT=40 -DHX711_SCALE1=ON -DHX711_ENABLED_MASK=511 build
```

最终构建通过：`build/yetitiaopei.bin` 为 `0xeace0` / 961760 字节，原 1 MiB 应用分区剩余 `0x15320` / 86816 字节（8%）。日志为 `build/dosing-build.log`。

SHA-256：`332b911a00fb711af1789eec1c6d717cc3137cebceb2dc252532ff2420bb0f22`。

## 实机复核顺序

1. 更新后台代码并启动服务，烧录上述固件，确认网页显示 `web-client-0.6.1`、50 Hz、辅助通道支持；开机全部输出为零。烧录命令：`idf.py -p COMx app-flash monitor`，替换实际端口。
2. 舵机 CH9 输入脉宽，点击试运行，实测两个流路，再记录并保存位置。重启后核对保存值；确认停 PWM 时的机械行为。无到位传感器，按实际负载测量 `route_ms`。
3. 液泵在 50 Hz 下实测起转/重复启动下限及最短有效脉冲；约 40% 是输入条件，精加默认 45% 尚未证明足够。气泵 CH8 独立确认有效输出与清液时间。
4. 每路空载去皮、砝码校准；源秤加液后应显示剩余液体净重，中央秤放好空容器后去皮。观察原始、快通道、显示值和窗口噪声，再确定可达容差。
5. 用单路小批量逐步验证加液、停泵、稳定、补液、切废液、吹气及最终容差；最后扩展至多步并验证取消和断线行为。完成依据是中央容器的清液后稳定增重。

残余边界：改变输出时共享 OE 仍会短暂禁能，需要示波器确认舵机脉冲；相同输出续租不切换 OE。吹气振动可能触发重量变化保护，应基于真实数据调整参数。当前任务结果不在设备持久化，业务 `/jobs` 尚未接入；设备复位不恢复任务。
