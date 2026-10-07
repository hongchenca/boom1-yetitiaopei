| Supported Targets | ESP32 | ESP32-C2 | ESP32-C3 | ESP32-C5 | ESP32-C6 | ESP32-C61 | ESP32-H2 | ESP32-P4 | ESP32-S2 | ESP32-S3 | Linux |
| ----------------- | ----- | -------- | -------- | -------- | -------- | --------- | -------- | -------- | -------- | -------- | ----- |

# Yetitiaopei ESP32-S3 + LAN Web Client

默认构建目标是 ESP32-S3 网页客户端固件，构建目录固定使用 ESP-IDF 默认的 `build/`。

在已激活 ESP-IDF 5.4.2 的终端中直接执行：

```powershell
idf.py build
```

该命令会重新配置并覆盖 `build/` 中的同名构建产物。需要刷写时使用：

```powershell
idf.py -p COMx flash monitor
```

`WEB_CLIENT` 默认开启；PCA004 台架固件仅在明确需要时通过 `-DPCA004_BENCH=1 -DWEB_CLIENT=0` 单独构建。

## 八路泵产品控制

产品固件默认开启 `PUMP_CONTROL`，提供 PCA9685 **CH0～CH7** 的独立启停、PWM 占空比、逐路定时关断、八路并发、全部停止和故障锁存。`OUTLET_CONTROL=ON` 时增加 **CH8 气泵 / CH9 舵机**，CH10～15 保持关闭。手动控制允许同来源多路液泵并发；自动配液独占输出并逐路加液。上电初始化全关，等待明确控制请求。原 CH0 循环测试是独立构建入口。

接线沿用已确认配置：SDA=GPIO8、SCL=GPIO9、OE=GPIO10，地址 `0x40`；输出高有效、非反相推挽。PCA9685 全部通道共享一个频率，出口控制开启时固定使用标称 **50 Hz**。液泵默认有效输出为 **40～100%**，0 表示关闭；低于起转下限的非零输出被拒绝。普通舵机按 **500～2500 µs** 脉宽控制，不能按泵占空比控制。40% 起转值仍需在 50 Hz 和实际负载下复测。

在 ESP-IDF 5.4.2 终端中编译产品入口（明确关闭原测试入口，避免沿用 CMake 缓存）：

```powershell
idf.py -B build -DWEB_CLIENT=ON -DPCA004_BENCH=OFF -DPCA004_CYCLE=OFF -DPUMP_CONTROL=ON -DOUTLET_CONTROL=ON -DPUMP_PWM_HZ=50 -DPUMP_MIN_PERCENT=40 -DPUMP_MAX_PERCENT=100 build
```

网页接入步骤：

1. 保留已有 Wi-Fi、URL 和设备密钥配置。在 `web_server/data/connection.json` 的对应实机设备条目中增加 `"actuator": true`，然后重启 Node 后台。未授权的实机泵能力上报会被后台拒绝。
2. 烧录新版产品固件并重启 Node 后台后，进入“设备操作 → 八路泵独立控制”。泵 01～08 对应 PCA9685 CH0～CH7，每张卡片可输入百分比或拖动滑条，点击“启动 / 更新”。可连续启动多路，每路独立计时。
3. “停止本路”只停止对应泵；“停止全部泵”可在等待其他命令回执时提交。以设备回执和随后状态上报为准，HTTP 入队成功不代表输出已执行。旧固件仍限制单泵，网页会提示升级。

每路每次网页开泵受设备本地 5 秒运行期限及会话剩余时间共同限制，延迟到达可能缩短本次运行。网页关闭或网络断开后，本地期限仍生效；不会自动续跑或在重连后补开。单路停止撤销本路旧令牌和待执行指令，全停撤销所有路；设备用 `boot_id`、单调期限与控制序号拒绝过期、乱序和重放命令。

固件公共接口见 [`actuator.h`](components/actuator/include/actuator.h)。`app_main` 已调用 `actuator_init`，本地控制任务可直接使用：

```c
#include "actuator.h"
#include "esp_timer.h"

// 本地任务：CH0 以 50% 运行 5 秒，启动请求本身 1 秒内有效。
actuator_request_t request = {
    .source = ACTUATOR_SOURCE_LOCAL,
    .config_version = ACTUATOR_CONFIG_VERSION,
    .channel = 0,
    .duty_percent = 50,
    .duration_ms = 5000,
    .expires_at_ms = esp_timer_get_time() / 1000 + 1000,
    .stop_at_ms = 0,
};
esp_err_t result = actuator_set(&request);
// 需要提前停止时调用 actuator_stop_all()，并检查返回值。
```

所有 API 仅在任务上下文使用。产品初始化的本地单次上限为 600000 ms；网页单次上限保持 5000 ms。不同通道或不同来源不能抢占在运行的泵；同来源同通道可更新占空比和期限。`source` 由上层鉴权后填写，不替代鉴权。I2C 写入、回读或关断失败会锁存故障，先请求 OE 禁能；故障排除后由本地维护调用 `actuator_clear_fault()`，仅恢复接收新命令，不恢复旧动作。初始化失败需排除原因后重启。

回执和状态反映寄存器回读及 OE 软件状态，不是负载端电气测量。新版 `web-client-0.6.1` 包含出口控制、称重滤波与本地闭环；主机测试、网页测试及固件构建记录见 [本轮验证](docs/verification/2026-10-07-dosing-outlet.md)。尚未烧录或完成负载实测。

## 出口标定与闭环配液（固件 0.6.1）

1. 网页“设备操作 → 出口调试”：调整舵机滑块或 ±10 µs 按钮，点击“试此位置”。确认实际流路后点击“记为配液位置”或“记为废液位置”。记录的是设备回报的已应用指令值；滑块本身不会驱动舵机。
2. 两个不同位置记录好后，停止输出或等待测试结束，再点“保存两个位置”。位置写入 NVS，重启保留；没有预设开关方向。保存动作不驱动舵机。关闭信号不保证机械复位。
3. 各源秤按剩余液体净重校准，中央秤放好空容器后去皮。进入“闭环配液联调”，以 g 填写各步目标、容差，或载入配方管理中已保存的配方。展开参数表核对泵输出、等待时间、容量及质量核验阈值。
4. 每步按中央容器增重定量；停泵稳定核验合格后切废液位置，再吹气清残液，最后重新称重核验。残液排入废液口，不计入配液剂量。自动配液期间禁止调试输出和修改校准。
5. 启动回执仅表示设备接受任务，以 `status.dosing.state=done` 和各步最终剂量为完成依据。取消全停；断网后本地任务继续受期限与传感器检查约束，重启不自动恢复任务。

控制策略见 [控制算法](docs/CONTROL_ALGORITHM.md) 和 [状态机](docs/STATE_MACHINE.md)。批次状态保存在设备 RAM 与后台遥测历史中；业务 `/jobs` 持久化任务接口尚未接入本地配液。构建采用 ESP-IDF 的体积优化 `CONFIG_COMPILER_OPTIMIZATION_SIZE=y`，保留原 1 MiB 应用分区与 NVS。

## Wi-Fi 连接优化（固件 0.5.1）

网页 RSSI 是 ESP32 接收热点的信号强度。固件保留 `WIFI_PS_NONE`，并关闭断线状态的 modem-sleep；CPU 自动功耗管理保持关闭。固定 HT20（20 MHz）带宽，首次连接及断线重连时扫描全部信道、按信号强度选择同名 AP；全信道扫描可能增加连接耗时，不会在已连接时主动扫描或强制漫游。

发送功率上限显式设置为 20 dBm，与现有 PHY 配置上限一致；这不是已证实的功率提升，实际发射受 PHY、速率及国家配置限制。获取 IP 后串口输出实际读取的省电模式、带宽、功率上限、信道和 RSSI；断线日志包含 reason/RSSI。固件注册版本为 `web-client-0.5.1`，需重新编译、刷入设备后生效，重启网页服务不会更新设备固件。

关闭省电会增加耗电；这些设置主要改善响应和连接稳定性，不能保证 RSSI 提高。若仍为 −70～−80 dBm，优先缩短设备与 2.4 GHz 热点距离，让天线远离金属外壳、泵电机及线束，并核对开发板天线类型和供电。刷入后在同一位置比较 RSSI、HTTP 耗时、遥测间隔和掉线情况。

## 九路 HX711 称重（固件 0.5.x）

八路原液秤与中央容器秤已全部启用。`HX711_SCALE1` 为兼容旧构建保留的总开关名，`HX711_ENABLED_MASK=511` 表示 bit0..8 全开；仅第一路使用 1。GPIO 是主控编号，不是排针编号：

| 网页通道 | DOUT / DT | PD_SCK / SCK |
| --- | --- | --- |
| 原液 01 / CH0 | GPIO1 | GPIO2 |
| 原液 02 / CH1 | GPIO4 | GPIO5 |
| 原液 03 / CH2 | GPIO6 | GPIO7 |
| 原液 04 / CH3 | GPIO14 | GPIO15 |
| 原液 05 / CH4 | GPIO16 | GPIO17 |
| 原液 06 / CH5 | GPIO18 | GPIO21 |
| 原液 07 / CH6 | GPIO39 | GPIO38 |
| 原液 08 / CH7 | GPIO41 | GPIO40 |
| 中央容器 / CH8 | GPIO42 | GPIO47 |

数字电源/电平使用 3.3 V，GND 共地；传感器激励接 E+/E-，信号接 A+/A-，以传感器资料确定极性。A 通道 128 倍增益；RATE 由模块硬件决定。GPIO39～42 已分配称重，不能同时用于外部 JTAG。

在对应实机的 `web_server/data/connection.json` 配置 `"weight": true`，保留 id/token 和 `"actuator": true`，重启 Node 后台。网页已移除演示设备、模拟批次、模拟来源与手工串口造数入口。历史演示数据留在数据库中，不在产品列表或导出中显示；没有删除真实记录。新版闭环入口与操作顺序见上节。

```powershell
idf.py -B build -DWEB_CLIENT=ON -DPCA004_BENCH=OFF -DPCA004_CYCLE=OFF -DPUMP_CONTROL=ON -DHX711_SCALE1=ON -DHX711_ENABLED_MASK=511 build
idf.py -p COMx app-flash monitor
```

`COMx` 替换为实际设备端口（当前编辑器配置为 COM10）。应用仍使用现有分区，不擦除 NVS。旧配置文件保留 `serial_test=false`、`hx711_probe_channel=-1` 或省略它们；不能再开启旧测试入口。

网页“实时调试 → 称重校准与诊断”操作：

1. 选择一路，确认 raw 随放置重物变化。空载静置，等到“可校准”后点击“空载去皮”。
2. 放上已知砝码，等待“可校准”，输入实际克数并校准；逐路重复。砝码引起的计数变化须大于原始稳定范围的 5 倍，否则换更合适的砝码或核对接线。
3. 设备回执后显示“已保存到设备”。零点、比例、校准版本和稳定阈值在 NVS 中逐路保存，正常重启后恢复；第一版 0.4.0 的 RAM 参数无法自动迁移，升级后需校准一次。
4. 默认未校准稳定范围 200 counts、校准后稳定范围 50 mg（0.05 g）。完整 16 点窗口满足阈值并持续 500 ms 才允许去皮/校准；它们是可调整的软件默认值，不是实测精度。实际噪声较大时在维护区修改对应阈值，不用等“稳定”即可保存阈值。
5. “清除本路校准”要求网页确认，仅清所选通道并持久化；其他通道不受影响。泵运行时拒绝参数修改；保存失败不会替换当前有效参数。

采集每 RTOS tick 非阻塞检查九路，一路断线不会拖慢其余通道。DOUT 超过 300 ms 不就绪、读帧错误、ADC 饱和会清空本路窗口；快照超过 500 ms 失效，恢复数据后自动重建窗口。显示使用 3 点中位数 + 1/2 EMA，校准另用 16 点平均。负净重保留，不自动归零，不用测量结果自动启动泵。

### 延迟优化

| 环节 | 原实现 | 当前实现 |
| --- | --- | --- |
| 显示滤波 | 16 点平均，10 SPS 下约 750 ms 群延迟 | 中位数 3 点 + 1/2 EMA；主机阶跃测试 5 次转换达到 90%以上 |
| 设备上报 | 请求结束后再等 1000 ms | 默认按 200 ms 起点间隔发送；请求超时仍退避 |
| HTTP / Wi-Fi | 每次重建 HTTP 连接、默认省电 | 每任务独占并复用连接，Wi-Fi 关闭省电 |
| 后台到网页 | 固定 1 秒广播 | 收到新上报立即 SSE 推送，另保留 1 秒在线心跳 |
| 操作反馈 | 500 ms 查一次回执 | 150 ms 查一次，设备执行后唤醒遥测任务 |

现场优化前实机上报间隔约 1.1～1.3 秒，Wi-Fi RSSI 约 -77 dBm。2026-10-03 复核实机已运行 0.5.0：连续 30 帧的上报间隔中位数 188 ms、P95 278 ms；后台收包到本机 SSE 接收中位数 2 ms、P95 6 ms。这不包含物理称重、滤波和浏览器绘制的全部耗时，不能当作整机响应时间。页面诊断提供采样间隔、样本年龄、上次上传往返时间、RSSI 和噪声；完整响应仍需用砝码阶跃实测。

同次实机复核中 CH0 有有效读数且参数已保存；CH1～CH8 均已启用、GPIO 初始化成功，但样本序号为 0、报 `ESP_ERR_TIMEOUT`。这八路尚未收到数据就绪信号，需要检查模块供电、共地以及 GPIO 与 DOUT/SCK 对应；只有收到原始计数后才能逐路校准。详情及复验命令见本轮验证记录。

若仍慢，优先改善约 -77 dBm 的弱信号/天线位置；再根据噪声实测决定是否把模块 RATE 从 10 SPS 改为 80 SPS。软件不会改动 RATE；当前 RTOS tick 为 10 ms，80 SPS 模块的实际读取率会受轮询相位影响，不能承诺满 80 SPS。若后续需要更快采集，应改 DOUT 中断唤醒并重新验收脉宽/噪声；本次未更改时钟、分区或 RTOS tick。

验证记录见 `docs/verification/2026-10-03-weight-nine.md`。软件测试不能代替逐路砝码精度、泵干扰、掉电恢复实测。

## CH0 独立循环测试

PCA9685 第一个通道（CH0）的循环测试使用 `PCA004_CYCLE`：上电初始化全部通道关断，然后 CH0 导通 5 秒、关断 5 秒，持续循环，其余通道保持关断。SDA=GPIO8、SCL=GPIO9、OE=GPIO10，地址为 `0x40`；每次写入后回读校验，遇到错误先通过 OE 禁止输出并停止循环。此测试使用非反相推挽输出，导通为高电平。

在 ESP-IDF 5.4.2 终端中由用户编译和烧录：

```powershell
idf.py -B build-pca-cycle -DPCA004_CYCLE=ON -DPCA004_BENCH=OFF -DWEB_CLIENT=OFF -DPCA004_SDA_GPIO=8 -DPCA004_SCL_GPIO=9 -DPCA004_OE_GPIO=10 -DPCA004_I2C_ADDRESS=0x40 build
idf.py -B build-pca-cycle -p COM5 app-flash monitor
```

串口将交替输出 `CH0 ON` / `CH0 OFF` 和寄存器回读结果。退出串口监视器不会停止循环；停止测试需切断 ESP32 与 PCA9685 的供电，重新上电会再次开始。

## 项目说明

Starts a FreeRTOS task to print "Hello World".

(See the README.md file in the upper level 'examples' directory for more information about examples.)

## How to use example

Follow detailed instructions provided specifically for this example.

Select the instructions depending on Espressif chip installed on your development board:

- [ESP32 Getting Started Guide](https://docs.espressif.com/projects/esp-idf/en/stable/get-started/index.html)
- [ESP32-S2 Getting Started Guide](https://docs.espressif.com/projects/esp-idf/en/latest/esp32s2/get-started/index.html)


## Example folder contents

The project **hello_world** contains one source file in C language [hello_world_main.c](main/hello_world_main.c). The file is located in folder [main](main).

ESP-IDF projects are built using CMake. The project build configuration is contained in `CMakeLists.txt` files that provide set of directives and instructions describing the project's source files and targets (executable, library, or both).

Below is short explanation of remaining files in the project folder.

```
├── CMakeLists.txt
├── pytest_hello_world.py      Python script used for automated testing
├── main
│   ├── CMakeLists.txt
│   └── hello_world_main.c
└── README.md                  This is the file you are currently reading
```

For more information on structure and contents of ESP-IDF projects, please refer to Section [Build System](https://docs.espressif.com/projects/esp-idf/en/latest/esp32/api-guides/build-system.html) of the ESP-IDF Programming Guide.

## Troubleshooting

* Program upload failure

    * Hardware connection is not correct: run `idf.py -p PORT monitor`, and reboot your board to see if there are any output logs.
    * The baud rate for downloading is too high: lower your baud rate in the `menuconfig` menu, and try again.

## Technical support and feedback

Please use the following feedback channels:

* For technical queries, go to the [esp32.com](https://esp32.com/) forum
* For a feature request or bug report, create a [GitHub issue](https://github.com/espressif/esp-idf/issues)

We will get back to you as soon as possible.
