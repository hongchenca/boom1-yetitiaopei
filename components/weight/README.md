# HX711 驱动（原始采样阶段）

参考用户提供的 `HX711_Test.ino` 中的 `begin(DOUT, SCK)`、`is_ready()`、24 位读取和 A 通道 128 倍增益流程；实现为 ESP-IDF C 驱动，而不是复制 Arduino 库。

- `hx711_init(&scale, dout, sck)`：配置单路 GPIO；实例应以 `hx711_t scale = {0};` 初始化。
- `hx711_read(&scale, 300, &raw)`：最多等待 300 ms，返回有符号 24 位 ADC 原始计数；DOUT 始终不就绪时返回 `ESP_ERR_TIMEOUT`。
- `hx711_deinit(&scale)`：SCK 保持低电平，不自动释放输出模式，避免时钟浮空。

`hx711_board_pins[0..8]` 对应 8 路原料秤及 1 路中央秤，GPIO 分配遵循 `docs/HARDWARE_ARCHITECTURE.md`。示例里的 SCK=GPIO13 与已预留的功率级故障输入冲突，不能原样照抄。

Arduino 示例的 `calibration_factor=-420` 是占位值，`tare()` 依赖空载条件，不能直接用于本工程。该驱动**不做自动去皮、换算为克、滤波或网络上传**。当前默认 `idf.py build` 会编译本组件，但网页固件不会调用 `hx711_init`：原有串口模拟上传逻辑和无真实硬件数据的网页契约保持不变。

正式接线/采样前需要确认开发板引出 GPIO47、GPIO39～42 与 JTAG 的取舍、HX711 模块 DOUT 与 ESP32-S3 的 3.3 V 电平兼容、供电/地线、RATE 引脚是 10 SPS 还是 80 SPS、实际脉冲时序、每台称的零点及砝码校准。不能以 ADC 原始计数当作 mg 或 g。
