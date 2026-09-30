# TASK-PCA-004: PCA9685 I2C and unloaded PWM bench test

## Objective

Verify that the ESP32-S3 can address the actual PCA9685 module over I2C and produce a measured, bounded PWM waveform on one output isolated from power loads. HX711, pumps, air path, MOSFET power stages, and the production actuator service are out of scope.

## Hardware preflight

The wiring plan in `docs/HARDWARE_ARCHITECTURE.md` assigns SDA=GPIO8, SCL=GPIO9, and OE=GPIO10. Verify that the actual PCA9685 board has no fixed ground or other driver on OE before connecting GPIO10. Provide and verify an OE pull-up to 3.3 V so outputs remain disabled during MCU reset. If PCA9685 address straps A0-A5 are all low, use the expected 7-bit address `0x40`; otherwise establish the actual address from the module before writing registers. Before operating the board, verify that these GPIOs are exposed and unused on the actual carrier board, and record module marking, address straps, VCC, V+, OE idle level, I2C pull-up rail, common ground, isolated output channel, connected loads, USB/serial-port identity, current firmware, and recovery/download method. Confirm the ESP32-S3 I2C pins see no voltage above 3.3 V; power PCA9685 logic VCC from 3.3 V and leave motor/servo V+ and all power loads disconnected. CH15 is preferred if inspection confirms it is isolated from MOSFET/actuator paths. A scope probe or confirmed 3.3 V-compatible ESP32 input may be connected for measurement. If carrier routing, OE, address straps, or load isolation are uncertain, mark board operations `[NOT RUN]`; do not substitute other GPIOs without Architect review.

## Allowed changes

- A small, opt-in, one-shot bench test in `main/` and its necessary `main/CMakeLists.txt` wiring. Keep the existing memory probe behavior when the bench test is disabled. The bench test must be disabled by default; no automatic output on ordinary firmware boot.
- `docs/agent_reports/TASK-PCA-004.md` for the completion report.

Do not change `sdkconfig*`, partitions, architecture/ADR documents, `components/domain/`, or unrelated code. Do not implement the full actuator service or change the Architect's GPIO assignment. If a build-time option is needed, keep it local to the bench code/CMake and require explicit values for pins and the 7-bit address; reject unset or invalid values.

## Implementation and test sequence

1. Use the ESP-IDF 5.4.2 `driver/i2c_master.h` API at 100 kHz with finite transaction timeouts and checked return values. Probe only the physically established 7-bit device address. An ACK alone is not proof of module identity. Read and log relevant configuration registers before changing them.
2. Keep OE in its confirmed disabled state while initializing, if physically controllable. Set all 16 PCA9685 channels to FULL_OFF and read back the relevant channel registers. Do not release OE or request PWM when any initialization or readback step fails. If OE cannot be held disabled, proceed only with all downstream loads physically disconnected and record that limitation.
3. Configure one shared PWM frequency around 100 Hz using the PCA9685 datasheet sleep/prescale/wake sequence and nominal oscillator assumption; state the calculated prescale and expected nominal frequency. Do not treat the nominal oscillator value as a measured clock. Leave all other channels FULL_OFF.
4. On the confirmed isolated channel only, request 25% duty for at most 2 seconds, then return it and all channels to FULL_OFF. Use a single bounded run, with no automatic restart, retry loop, or persistent PWM. On every error after bus creation, attempt FULL_OFF, restore OE to disabled if controlled, release driver resources, and report the original and cleanup errors separately. Never claim I2C cleanup alone proves physical load shutdown.
5. Build once in the ESP-IDF 5.4.2 environment. Confirm the bench object was actually compiled. Do not flash merely because the build passed. Before any flash, verify exact target board and port, firmware/artifact identity, load isolation, power, download/recovery path, and a bounded command. Record the flashed binary hash and the board/port used. If any prerequisite is absent, stop at build and `[NOT RUN]` for board operations.
6. If board operation is cleared, collect actual boot/I2C logs, address ACK, register readback before and after, and a scope/logic-analyzer capture of the selected output showing frequency, duty, voltage levels, and return to OFF. A confirmed 3.3 V GPIO loopback with measured edges may instead establish frequency and duty, but it cannot establish analog voltage levels. If only a multimeter or LED is available, record that observation but leave waveform frequency/duty `[HW REQUIRED]`; do not report a full PWM PASS. Keep power loads disconnected throughout.

## Acceptance and report

Separate `[PASS]` build, `[PASS]` I2C communication, `[PASS]` register command/readback, and `[PASS]` physical PWM waveform. A failed or unperformed layer must not be inferred from another layer. The independent pump/air-path shutdown requirement of `ADR-0003` remains unverified by this test.

Write a concise report to `docs/agent_reports/TASK-PCA-004.md`: changed files, wiring/voltage/address evidence, build command/result, target/port and artifact hash if flashed, actual register values, waveform evidence and measured values, cleanup outcome, `[NOT RUN]`/`[HW REQUIRED]` items, and questions. Do not paste lengthy build logs or claim measurements from expected values. End with `READY FOR ARCHITECT REVIEW`; the Architect will provide `ACCEPTED` or `CHANGES REQUIRED` separately.
