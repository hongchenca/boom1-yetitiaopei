# TASK-PCA-005 report (2026-09-26)

## Changed files

- `main/pca004_bench.c`: replaced the PCA-004 output test with a one-shot read-only PCA9685 I2C test.
- `docs/agent_reports/TASK-PCA-005.md`: this report.
- `main/CMakeLists.txt` was not changed; the existing source selection continues to provide `pca004_bench.c` when the bench option is enabled.

## Source contract and behavior

- `[PASS]` Fixed constants are SDA `GPIO8`, SCL `GPIO9`, 7-bit address `0x40`, I2C speed `100000 Hz`, and transaction timeout `100 ms`.
- `[PASS]` The source creates an I2C master bus and device handle, probes `0x40`, then reads exactly five registers using write-register/read-data transactions: `MODE1 (0x00)`, `MODE2 (0x01)`, `PRE_SCALE (0xfe)`, `ALL_LED_OFF_H (0xfd)`, and `LED15_OFF_H (0x45)`.
- `[PASS]` LED15 address corrected to `0x45`, calculated as `0x06 + 15*4 + 3`; the prior `0x4a` was an incorrect test address.
- `[PASS]` No GPIO API is used. GPIO10/OE is not initialized, read, or driven.
- `[PASS]` No PCA9685 register-value write transaction exists. There is no PWM configuration, output-control call, timer, delay, task, retry loop, reset or polling loop.
- `[PASS]` Every bus/device/probe/read API result is checked. Device removal and bus deletion run from the single cleanup path; cleanup errors are reported separately from the first operation error. The final log distinguishes `address_probe` and `register_reads` as `PASS`, `FAIL`, or `NOT_RUN`.
- Source SHA-256 after the edit: `5BA13FCDCBD0EF13404DA3FDCC039BE81F356AFED19CB74A0A3E21979914186B`.

## Static verification

- `[PASS]` Source-only PowerShell checks confirmed the fixed contract, all five register constants, `i2c_master_probe()`, `i2c_master_transmit_receive()`, cleanup calls, and explicit result-state logging.
- `[PASS]` A forbidden-token scan found no `gpio_` API, `esp_timer`, `vTaskDelay`, `esp_rom_delay_us`, `i2c_master_transmit()`, `pca_write`, `pca_all_off`, `ledc`, `mcpwm`, or output-control call.
- `[PASS]` No build, CMake, Ninja, esptool, monitor, flash, reset, or serial command was run during this task. No COM5 access was attempted.

## Hardware and execution evidence

- `[NOT RUN]` Clean build. The user must run the build and verify that this exact `pca004_bench.c` is compiled.
- `[NOT RUN]` Flash. No image was produced or written by this task; no target identity, board revision, or image hash is available.
- `[NOT RUN]` Serial monitor and COM5. No serial port was opened and no boot log was captured.
- `[PASS]` User-provided serial measurement: address `0x40` ACKed; `MODE1`, `MODE2`, `PRE_SCALE`, and `ALL_LED_OFF_H` each read successfully. The `LED15_OFF_H` read returned NACK because the prior test used the incorrect `0x4a` address.
- `[NOT RUN]` Agent-side actual I2C communication after correcting the source. No new serial port was opened, and no new ACK/NACK or register values were captured by this task.
- `[NOT RUN]` PWM, OE behavior, CH15 output, V+, pumps, air path, MOSFET modules and load-side shutdown. They are outside this read-only task.

The user-run hardware setup must retain the fixed contract: PCA9685 VCC at 3.3 V, common ground, V+ disconnected, all channels and loads disconnected, and no substitution of pins or address.

READY FOR ARCHITECT REVIEW
