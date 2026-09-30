# TASK-PCA-005: PCA9685 read-only I2C communication test

## Objective

Produce a one-shot, read-only I2C test that confirms the ESP32-S3 can address the PCA9685 module at the planned wiring and read its registers. This task deliberately does not configure OE, write any PCA9685 register, set PWM, or test CH15.

## Fixed hardware contract

- ESP32-S3 SDA: GPIO8
- ESP32-S3 SCL: GPIO9
- I2C speed: 100 kHz
- PCA9685 7-bit address: `0x40` (A0-A5 default low, based on the user's physical confirmation)
- I2C transaction timeout: 100 ms maximum per transaction
- PCA9685 VCC: 3.3 V; ESP32 and module share GND
- PCA9685 V+: disconnected
- CH0-CH15, MOSFET modules, pumps, air path and all other power loads: disconnected
- GPIO10/OE: not touched by this test. Do not infer or change its level.

If the physical wiring differs from this contract, stop and report the discrepancy. Do not substitute pins or address.

## Allowed files

- `main/pca004_bench.c`
- `docs/agent_reports/TASK-PCA-005.md`

Do not modify `sdkconfig*`, partitions, architecture/ADR documents, `components/domain/`, or unrelated files. Do not change `main/CMakeLists.txt` unless the existing source selection makes this read-only test impossible; report the reason before doing so.

## Required behavior

1. Use ESP-IDF 5.4.2 `driver/i2c_master.h` with GPIO8/GPIO9, 100 kHz and finite 100 ms timeouts. Check every API result.
2. Create the bus and device handle, then call `i2c_master_probe()` at `0x40`. Log the address as a candidate PCA9685 ACK; an ACK alone is not device identity proof.
3. If the probe succeeds, read and log each of these registers with a write-register/read-data transaction, without writing them: `MODE1 (0x00)`, `MODE2 (0x01)`, `PRE_SCALE (0xfe)`, `ALL_LED_OFF_H (0xfd)`, and `LED15_OFF_H (0x4a)`.
4. Do not call `gpio_config`, `gpio_set_level`, `gpio_get_level`, `pca_write`, `pca_all_off`, `esp_timer`, `vTaskDelay`, or any PWM/output function. The source must contain no PCA9685 register write transaction.
5. On success or failure, remove the device and delete the I2C bus. Cleanup errors must be logged separately from the first operation error. Return from `app_main()` after this single pass; no task, retry loop, automatic reset or polling loop.
6. Log an unambiguous result with separate states for address probe and register reads. A successful build is not a communication result.

## Agent execution restrictions

The Coding Agent must not run `idf.py`, CMake, Ninja, esptool, `idf_monitor`, or open COM5 in this task. The user will compile, flash and capture serial output. The Agent may perform source inspection and static checks that do not create build output.

## Acceptance evidence to be supplied by the user

- `[PASS]` source review: fixed GPIO/address and read-only behavior.
- `[PASS]` user-run clean build, with `pca004_bench.c` actually compiled.
- `[PASS]` user-run flash of the exact image hash to COM5, only with V+ and all loads disconnected.
- `[PASS]` serial log showing `0x40` ACK and all five register reads returning `ESP_OK`.
- `[NOT RUN]` PWM waveform, OE behavior and load-side shutdown; those belong to a later task.

## Completion report

Write `docs/agent_reports/TASK-PCA-005.md` with changed files, source/static checks, and explicit `[NOT RUN]` entries for build, flash, monitor, I2C hardware communication and PWM because those actions are user-run. Do not invent register values. End with `READY FOR ARCHITECT REVIEW`.
