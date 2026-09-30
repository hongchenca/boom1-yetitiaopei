# TASK-PCA-004 report (2026-09-24)

## Result and changed files

- `main/CMakeLists.txt`: bench image is opt-in (`PCA004_BENCH=ON`); requires explicit SDA=8, SCL=9, OE=10 and a 7-bit strap address. With the option absent, the existing memory-probe entry remains selected.
- `main/pca004_bench.c`: one-shot ESP-IDF 5.4.2 I2C master at 100 kHz; finite 100 ms transactions; OE held disabled by the required external 3.3 V pull-up; pre-write register reads, all 16 channels FULL_OFF and readback, nominal 100 Hz prescale, CH15-only 25% request, 1.5 s timer OE cutoff, final OE disable/FULL_OFF/readback and resource cleanup. Errors are logged separately from cleanup results. No pump, air-path or MOSFET control was added.
- This report. No `sdkconfig*`, partitions, domain, ADR or architecture files were edited. `sdkconfig` SHA-256 stayed `79759AA1C710ABD3728355853CD35D8C19CD3111C0E584C86EEB01163E39FA2E` before and after the build.

## Build evidence

- `[PASS]` Final command: in CMD with ESP-IDF 5.4.2 `export.bat` activated, `python E:\Espressif\frameworks\esp-idf-v5.4.2\tools\idf.py -B build-pca004 -DPCA004_BENCH=ON -DPCA004_SDA_GPIO=8 -DPCA004_SCL_GPIO=9 -DPCA004_OE_GPIO=10 -DPCA004_I2C_ADDRESS=0x40 build`. Exit 0 on 2026-09-24 about 21:05 CST. ESP-IDF identifies as `v5.4.2-dirty`; target `esp32s3`, 16 MB flash configuration, GCC toolchain `esp-14.2.0_20241119`. No `warning:` or `error:` diagnostics in the successful build log.
- `[PASS]` Final log `build-pca004/log/idf_py_stdout_output_47660` contains `Building C object .../pca004_bench.c.obj`, `Linking CXX executable yetitiaopei.elf`, and `Project build complete`. The object exists at `build-pca004/esp-idf/main/CMakeFiles/__idf_main.dir/pca004_bench.c.obj` (48,608 bytes). The build graph selects that source, not `hello_world_main.c`.
- Binary: `build-pca004/yetitiaopei.bin`, 246,240 bytes, SHA-256 `64CA73B27215A5949E5D2C1B4B62A20DAB466957396FE12927BE2A9CDECAD9C3`. ELF SHA-256 `C81488CDF930524E0D24D1ABAEDBAF3E4713FBB50360E7EE8EDE8C4556E0BD42`. Source SHA-256 `35900D6D643E299752C13FBC8F9B72385E73B2990B13EEBF1A23B709489EC6F7`. This workspace has no `.git`, so no project commit or dirty-state identifier is available.
- An earlier build attempt reached `pca004_bench.c` and failed because IDF's component dependency pre-scan did not see conditional `PRIV_REQUIRES`; the CMake registration was corrected, then the final build passed. No board operation was performed during either build.

## Wiring, address and board preflight

- `[PASS]` Build parameters are fixed SDA=GPIO8, SCL=GPIO9, OE=GPIO10. The build-time `0x40` is **only a candidate**: A0-A5 have not been inspected or measured, so the actual 7-bit address is unconfirmed. No address probe was run.
- `[NOT RUN]` Actual carrier GPIO availability, module marking/revision, A0-A5, OE not tied to ground/another driver, OE external pull-up and idle voltage, VCC=3.3 V, V+ disconnected, SDA/SCL pull-up rail and voltage, common ground, CH15 isolation, and absence of all power loads have no physical evidence in this workspace. Do not connect GPIO10 or flash this bench image until these are confirmed.
- `[NOT RUN]` On 2026-09-24 at about 21:05 CST, Windows enumerated `USB-Enhanced-SERIAL CH343 (COM5)`, `USB\VID_1A86&PID_55D3\5A33006825`. This identifies a USB serial adapter only; the exact ESP32-S3 board/revision, current firmware/chip identity, and recovery/download method remain unknown. COM5 was not opened or used for flashing.
- `[NOT RUN]` No `flash`, reset, monitor or other device-mutating command was issued. Therefore there is no flashed target/port/hash, boot log, or hardware cleanup outcome.

## I2C and register evidence

- `[NOT RUN]` I2C communication: no on-device ACK/NACK, device identity evidence, or boot/I2C log. `0x40` must be probed only after A0-A5 establish it. An ACK alone would not prove PCA9685 identity.
- `[NOT RUN]` Register command/readback: no actual pre-write MODE1, MODE2, PRE_SCALE, ALL_LED_OFF_H or channel values; no actual initial/final FULL_OFF readback; no measured cleanup errors. The firmware is designed to log/check these, but compilation is not a register test.
- `[ASSUMPTION]` Datasheet nominal 25 MHz oscillator gives PRE_SCALE=60 (`0x3c`) for approximately 100.058 Hz. CH15 request is ON=0, OFF=1024 (`0x400`), nominal 25%. These are calculated settings, not observed register values or a measured frequency.

## Physical output evidence

- `[HW REQUIRED]` No scope/logic-analyzer trace or confirmed 3.3 V GPIO edge capture exists. CH15 frequency, duty, high/low voltages, pulse duration and return to OFF are unmeasured. The software timer target (1.5 s) does not establish an actual maximum 2 s physical waveform.
- `[NOT RUN]` No pump, air-path, MOSFET power stage or V+ supply was connected or tested. Independent pump/air-path shutdown required by ADR-0003 remains unverified and is outside this task.

## Questions for bench acceptance

Confirm the physical board and module identities; A0-A5 state; GPIO8/9/10 routing; OE pull-up and idle voltage; 3.3 V logic/I2C levels; V+ and all loads disconnected; CH15 truly isolated; the serial port and recovery path; and availability of a scope/logic analyzer (or verified 3.3 V GPIO loopback). Only then can flashing, register readback and waveform measurement be attempted and this report updated with actual values.

READY FOR ARCHITECT REVIEW
