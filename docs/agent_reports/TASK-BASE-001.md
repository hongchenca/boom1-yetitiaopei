# TASK-BASE-001 完成报告（含返工与板上验证记录）

- Task ID：`TASK-BASE-001` / N16R8 安全启动与内存探测
- 最新轮次：**第 4 轮（板上验证前置核对）— 2026-09-24**
- Coding Agent 自评：`READY FOR ARCHITECT REVIEW`

> 本报告顶部为最新轮次。第 3 轮见附录 C，第 2 轮见附录 B，第 1 轮见附录 A，均按原样保留。
> 文中所有预期日志均标注为**示例**，不构成实际测试证据；板上项目一律为 `[HW REQUIRED]`。
> 泵/气路关断不并入本任务验收（ADR-0003 独立验收）。

---

## 1. 第 4 轮：板上验证前置核对（本轮）

本轮目标：在动板之前核对**目标板卡身份、唯一串口、当前固件、恢复方式**，并确认待测镜像哈希；资料不全则不动板。

### 1.1 待测镜像哈希核对 —— `[PASS]`

| 项 | 值 |
| --- | --- |
| 待测镜像 | `build/yetitiaopei.bin` |
| 要求 SHA256 | `A9418791D0EE2774CC2067935A5F0D0AAA7F7D1DE25FD435E5058748FAF0C124` |
| 实测 SHA256 | `A9418791D0EE2774CC2067935A5F0D0AAA7F7D1DE25FD435E5058748FAF0C124` |
| 结论 | **一致（MATCH = True）** |
| 镜像大小 / mtime | 223 216 B（`0x367f0`） / 2026-09-24 19:38:55 |

命令：`Get-FileHash -Algorithm SHA256 -LiteralPath build/yetitiaopei.bin`

同批产物哈希（供刷写时逐项核对）：

```text
build/bootloader/bootloader.bin       20928 B  SHA256=D324562F56FD569FEA77E60613567A4999871C8158CA98783B890F4AD0A7021B
build/partition_table/partition-table.bin 3072 B SHA256=7F00B6C042A89B15B0CAC534F82ED988CAF29278FF5700B0C511EB1B5BB7C820
build/yetitiaopei.elf               3849672 B  SHA256=E1FA300ED127897FFE22EFBB70C768D6002DA8DB195A99A6629E91F97239FFA4
build/flasher_args.json                 939 B  SHA256=124A8B22DE1C8D8C034B17B7427E902CF90D262EEA07CE46450F6774A6BDE821
```

### 1.2 四项前置条件核对 —— 全部缺失，判定资料不全

| # | 前置条件 | 核对结果 | 证据 / 缺口 |
| --- | --- | --- | --- |
| 1 | 目标板卡身份（丝印 / 模组序列号 / MAC） | `[HW REQUIRED]` **缺失** | 全仓库（排除 `build/`）检索 MAC 形态字符串与 `N16R8`/丝印/序列号记录：无任何实物身份信息。`docs/verification/2026-09-24-memory-config.md` 明确记载"此处的料号来自**用户声明**，实物丝印及容量尚未读回"；`docs/HARDWARE_ARCHITECTURE.md` 将"实物模块丝印/修订"列为待核实项。**当前只有"用户声明是 N16R8"这一条，不构成实物身份核对。** |
| 2 | 唯一串口 | `[HW REQUIRED]` **无法唯一确定** | 主机 PnP 数据库注册 22 个 COM 口，其中**仅 COM5 处于 Present=True**（其余 21 个为历史缓存，Present=False）。COM5 = `USB-Enhanced-SERIAL CH343`，`USB\VID_1A86&PID_55D3\5A33006825`，`Port_#0003.Hub_#0006`，父设备 `Generic USB Hub (USB\VID_35D6&PID_2510\6&19a9457f&0&1)`。**但 CH343 是通用 USB-UART 桥片，广泛用于各类开发板；无法据此证明 COM5 连接的就是本任务目标 N16R8 板。**（本轮复核见 §1.5：重复枚举时注册条目数在 21–22 之间波动，进一步说明缓存条目不能作为身份证据。） 另：全系统无 Espressif 原生 USB 设备（`VID_303A` 在 PnP 数据库中不存在），因此无法通过原生 USB 序列号反推板卡身份。 |
| 3 | 当前固件 | `[HW REQUIRED]` **未知** | 无任何"已刷写"记录；无 `read_flash` 备份镜像；`docs/verification` 仅记录过一次**构建**（当时产物为 `hello_world` 模板，SHA256 `6B76CB3DAF2B85CFEFEA37A05894CBD0B152673AECC71743F780E0BB282E5D01`），并未记录该镜像曾被写入设备。因此**当前板上跑的是什么固件、是否可恢复，均无证据**。 |
| 4 | 恢复方式 | `[HW REQUIRED]` **缺失** | 未提供 BOOT/EN 按键与下载模式进入方式、未提供备份镜像、未提供回退固件、未说明板载 USB-UART 的 DTR/RTS 自动复位电路是否可用。全仓库检索 `BOOT 键`/`download mode`/`read_flash`/`备份`/`恢复模式` 均无相关记录。 |

**判定：资料不全。** 按本轮指令"资料不全时，不执行 flash、monitor 或其他设备操作"，因此：

- **未执行** `idf.py flash`；
- **未执行** `idf.py monitor`；
- **未执行** `esptool read_flash` / `write_flash` / `erase_flash` / `chip_id` / `flash_id` 等任何 esptool 子命令；
- **未打开 COM5**（未做任何串口读写）。本轮的串口信息全部来自 Windows PnP 被动枚举，属只读查询，不涉及打开端口或与设备通信；
- 板上所有验证项**保持 `[HW REQUIRED]`**，不因本轮前置核对而改变。

### 1.3 关于 `.vscode/settings.json` 再次被外部改写（需 Architect 知悉）

| 项 | 值 |
| --- | --- |
| 现象 | 该文件于 **2026-09-24 19:50:37** 再次被写入 `"idf.portWin": "COM5"` |
| 当前大小 / SHA256 | 262 B / `F91F186D212F8CB815C5C0D34C945CC18E7356E950F76F93686329CA87E4DA72` |
| 任务前基线 SHA256 | `635279036F5880D0DA6FC59E334E8719EBCD30176C217B832A52C7AED29CF2B8`（235 B，无 `idf.portWin`） |
| 写入者判定 | **非本 Agent**。本 Agent 在本任务中从未写入该文件（第 1 轮曾发现同源写入并精确还原一次）。判定为后台 VS Code ESP-IDF 扩展（该扩展会在检测到串口后写入 `idf.portWin`）。 |
| 本轮处理 | **本轮未修改该文件**（不在本任务允许修改清单内）。此处仅作事实登记与风险提示。 |
| 风险提示 | 该扩展写入的 `COM5` 是扩展的**自动探测结果，不是任务授权的板卡身份**；若后续由扩展或人工据此直接执行 `idf.py -p COM5 flash`，即在**板卡身份未核实**的情况下写入未知设备。**在四项前置条件补齐前，不应依据该设置执行任何烧写。** |

### 1.4 资料补齐后拟执行的操作（本轮未执行，仅预案）

以下命令**本轮一律未执行**，仅作为资料齐全并获授权后的执行预案记录：

```text
# 1) 采集当前固件与芯片信息（只读，需授权 + 板卡身份确认后）
python -m esptool --chip esp32s3 -p <已确认端口> -b 115200 read_mac
python -m esptool --chip esp32s3 -p <已确认端口> -b 115200 flash_id

# 2) 备份当前固件（恢复手段，建议在烧写前完成）
python -m esptool --chip esp32s3 -p <已确认端口> -b 460800 read_flash 0 0x1000000 <备份路径>

# 3) 烧写待测镜像（哈希已核对）
idf.py -p <已确认端口> flash

# 4) 采集完整启动日志（115200 8N1），日志落盘归档
idf.py -p <已确认端口> monitor
```

其中 `<已确认端口>` 必须在板卡身份核对通过后才能填入；端口值不得来自 `.vscode/settings.json` 的扩展自动写入。

### 1.5 串口复核（本轮第二次枚举，全程只读）

为排除单次枚举误差，在 §1.2 首次枚举之后又做了 **4 次间隔约 2 s 的重复枚举**，并补充查询设备属性：

| 项 | 首次枚举（§1.2） | 复核枚举（连续 4 次，结果完全一致） |
| --- | --- | --- |
| `Get-PnpDevice -Class Ports` 注册条目 | 22 | **21** |
| 其中 Present=True | 1（COM5） | 1（COM5） |
| 其中 Present=False（历史缓存） | 21 | 20 |

- 两次枚举的 **Present 结论完全一致：只有 COM5**；差异仅在历史缓存条目数（22 → 21），说明 Windows PnP 缓存集合本身会自行变动，**不能作为板卡身份证据**。
- 全部命令均为被动查询（`Get-PnpDevice` / `Get-PnpDeviceProperty` / `Get-CimInstance` / 注册表只读读取），**未打开 COM5、未读写串口、未发送任何字节**。
- 另核对：`HKLM\HARDWARE\DEVICEMAP\SERIALCOMM` 仅登记 `\Device\Serial2 = COM5`，只能证明"当前有一个可用串口"，同样不能证明其连接对象。
- `Get-PnpDevice -Class Ports -PresentOnly` 与按 `DEVPKEY_Device_IsPresent` 逐项核对，两者结果一致：仅 COM5 为 True。

COM5 属性（只读查询结果）：

| 属性 | 值 |
| --- | --- |
| FriendlyName | `USB-Enhanced-SERIAL CH343 (COM5)` |
| InstanceId | `USB\VID_1A86&PID_55D3\5A33006825` |
| HardwareIds | `USB\VID_1A86&PID_55D3&REV_0445`、`USB\VID_1A86&PID_55D3` |
| Manufacturer / DriverProvider | `wch.cn`（驱动版本 `2.1.2025.7`） |
| BusReportedDeviceDesc | `USB Single Serial` |
| LocationInfo / Address | `Port_#0003.Hub_#0006` / 3 |
| Parent | `USB\VID_35D6&PID_2510\6&19a9457f&0&1`（BusReportedDeviceDesc = `USB2.1 Hub`） |
| 首次安装时间 | 2026-03-17 14:03（早于本任务，**非本任务插入的设备**） |
| DEVPKEY_Device_IsPresent | True |

- 判定：以上属性只描述 **WCH CH343 USB-UART 桥片**，不含任何板卡/模组标识（无 `VID_303A` 原生 USB、无板卡序列号）。**"COM5 在线" ≠ "COM5 就是目标 N16R8 板"**，故"唯一串口"仍为 `[HW REQUIRED]`。

### 1.6 板上验收项与将记录的字段（本轮未执行，仅登记）

| # | 板上验收项 | 判定依据（启动日志原文） | 本轮状态 |
| --- | --- | --- | --- |
| 1 | 物理 Flash 16 MiB | `[flash] chip-reported physical capacity: 16777216 bytes (16.00 MiB)` + `RESULT PASS` | `[HW REQUIRED]` |
| 2 | PSRAM 8 MiB | `[psram] chip-reported capacity: 8388608 bytes (8.00 MiB)` + `RESULT PASS` | `[HW REQUIRED]` |
| 3 | 内部 / PSRAM 堆统计 | `[heap internal]` / `[heap psram]` 行含 total / free / largest free block / lifetime minimum free | `[HW REQUIRED]` |
| 4 | 4 KiB PSRAM 分配 / 写入读回 / 释放 | `[psram alloc]` → `[psram check] full block write-read-back OK: 4096 bytes, offsets 0..4095` → `[psram free]` | `[HW REQUIRED]` |

每项在采集时必须同时记录：**板卡身份、串口（含设备实例路径）、镜像 SHA256（须等于 `A9418791D0EE2774CC2067935A5F0D0AAA7F7D1DE25FD435E5058748FAF0C124`）、执行命令、原始日志文件路径、该行原文**。任一字段缺失即不得判为 `[PASS]`。

泵 / 气路安全关断 **不属于本任务验收项**（ADR-0003 独立验收），本表及本任务结论均不包含该项。

---

## 2. 第 4 轮修改文件

| 文件 | 变更 | 原因 |
| --- | --- | --- |
| `docs/agent_reports/TASK-BASE-001.md` | 追加第 4 轮前置核对记录；第 3 轮记录降为附录 C | 按本轮指令把缺项记入报告 |

本轮**未修改**任何源码、`sdkconfig*`、分区表、其他 `docs/` 文件或 GPIO/外设代码；`main/hello_world_main.c` 与 `main/CMakeLists.txt` 保持第 3 轮冻结状态。**本轮未执行构建**（本轮无代码变更，构建无意义），故不新增 Build Result。

## 3. 第 4 轮测试内容与结果

| 项 | 命令 / 方法 | 结果 |
| --- | --- | --- |
| 待测镜像哈希核对 | `Get-FileHash -Algorithm SHA256 build/yetitiaopei.bin` | `[PASS]` 与要求值逐字符一致 |
| 同批产物哈希登记 | `Get-FileHash` × bootloader / 分区表 / elf / flasher_args | `[PASS]` 已记录（见 §1.1） |
| 串口枚举（被动、只读） | `Get-PnpDevice -Class Ports` + `Get-PnpDeviceProperty` + `Get-CimInstance` | `[PASS]` 枚举完成：首轮 22 个注册、1 个 Present（COM5）；随后 4 次复核均为 21 个注册、1 个 Present（COM5），见 §1.5 |
| Espressif 原生 USB 排查 | PnP 数据库检索 `VID_303A` | `[PASS]` 无此类设备，无法用于身份核对 |
| 板卡身份检索 | 全仓库（排除 `build/`）检索 MAC / 丝印 / 序列号 / 料号记录 | `[NOT RUN]`→ 实为**检索完成、无结果**，判定前置条件缺失 |
| 当前固件与恢复方式检索 | 检索备份镜像、`read_flash`、BOOT/下载模式、回退固件记录 | **检索完成、无结果**，判定前置条件缺失 |
| `flash` / `monitor` / esptool 设备操作 | — | `[NOT RUN]`（资料不全，按指令禁止） |
| 打开 COM5 或任何串口读写 | — | `[NOT RUN]`（属"其他设备操作"） |

## 4. 本轮结论

- **镜像侧**：`[PASS]` — 待测镜像哈希与要求值完全一致，可随时用于烧写。
- **板上侧**：`[HW REQUIRED]` — 四项前置条件（板卡身份、唯一串口、当前固件、恢复方式）**全部缺失**，判定资料不全，**未动板**。
- 本轮**不产生**任何板上 `[PASS]`；§6 中所有板卡项状态不变。

## 5. Warnings（第 4 轮）

- 本轮无编译行为，**无编译警告**。
- 非编译类提示：`.vscode/settings.json` 再次被外部扩展改写（见 §1.3），本 Agent 未修改该文件。
- 非编译类提示：串口注册条目数在两次枚举间由 22 变为 21（见 §1.5），提示后续不要以 PnP 缓存/注册条目数作为设备身份依据。

## 6. 剩余 `[HW REQUIRED]` 项（第 4 轮，状态不变）

| 项 | 状态 | 缺口 |
| --- | --- | --- |
| 目标板卡身份核对（丝印/序列号/MAC） | `[HW REQUIRED]` | 无实物身份记录 |
| 唯一串口确认 | `[HW REQUIRED]` | 仅 COM5 在线，但无法证明其为目标板 |
| 当前固件确认 | `[HW REQUIRED]` | 无已刷写记录、无备份镜像 |
| 恢复方式确认 | `[HW REQUIRED]` | 无 BOOT/下载模式说明、无回退固件 |
| 烧写待测镜像 | `[HW REQUIRED]` | 前置条件未满足，禁止执行 |
| 完整启动日志采集（115200 8N1） | `[HW REQUIRED]` | 同上 |
| 物理 Flash 16 MiB 实读核对 | `[HW REQUIRED]` | 同上 |
| PSRAM 8 MiB 实读核对 | `[HW REQUIRED]` | 同上 |
| 内部 RAM / PSRAM 堆统计实读 | `[HW REQUIRED]` | 同上 |
| 4 KiB PSRAM 分配 / 写入读回 / 释放实读 | `[HW REQUIRED]` | 同上 |
| 泵 / 气路安全关断 | **不在本任务验收范围** | 按 ADR-0003 由独立任务验收；本轮及本任务均**不**将其并入 TASK-BASE-001 的验收结论 |

## 7. Questions（第 4 轮）

1. 请提供**目标板卡身份**：模组/主板丝印文字、序列号或 MAC（任一可唯一标识即可）。
2. 请确认**唯一串口**：当前主机仅 COM5（CH343，`USB\VID_1A86&PID_55D3\5A33006825`）在线，请确认它是否就是目标 N16R8 板的串口；若是，请一并说明该板的下载/复位电路（是否支持 DTR/RTS 自动复位）。
3. 请提供**当前固件**信息：板上现有固件名称/版本，或授权先执行 `read_flash` 备份以便留存恢复镜像。
4. 请提供**恢复方式**：进入下载模式的方法、是否有可回退的原始固件、以及烧写失败时的处置步骤。
5. 请确认**烧写授权与日志归档路径**：是否授权在补齐上述四项后执行 `flash` + `monitor`，以及原始启动日志应归档到哪个路径（`docs/verification/` 是否可用，或另指定）。
6. 关于 §1.3 的 `.vscode/settings.json`：是否需要在后续轮次中将其还原为基线内容，或将其加入本任务的允许修改清单以便纳入版本管理？

## 8. 板上测试状态与日志位置（第 4 轮）

- **状态**：`[HW REQUIRED]` / `[NOT RUN]` — 资料不全，未烧写、未监视、未打开串口、未做任何设备操作
- **本轮未产生板上日志**；构建日志见附录 C（第 3 轮）
- **预期启动日志（示例，非实际测试证据）**：见 §10（与第 3 轮一致，起始行已为准确措辞）
- **待归档**：板卡身份、串口、镜像哈希、命令、原始启动日志路径、每项 PASS/FAIL —— 待资料补齐后采集

## 9. 第 4 轮完整性证据

本轮由本 Agent 写入的文件：`docs/agent_reports/TASK-BASE-001.md`（仅此一个）。

```text
main/hello_world_main.c                  19866 bytes  SHA256=6EEC17B9B11632FA31CEC68483B48F9F94C17BADC9384C54E192F3DA6976D477  （未变，第 3 轮冻结）
main/CMakeLists.txt                        141 bytes  SHA256=DFAAA3AF93EFA7706C87DB5E717D1558E242261F475C9592D91DABF29C9FF84F  （未变）
sdkconfig                                79759AA1C710ABD3728355853CD35D8C19CD3111C0E584C86EEB01163E39FA2E  （未变）
sdkconfig.defaults                       3C3783D5C448CD1E104B1D9A001BD0096ECC3252573623D6227D7511601D66EB  （未变）
sdkconfig.old                            CCDB0B9EAB359B2E5D2A14D724154229EDB8B6ABAC50ADDB21AAB64A8FAC28B  （未变）
sdkconfig.ci                             E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855  （未变，0 字节）
build/partition_table/partition-table.bin 7F00B6C042A89B15B0CAC534F82ED988CAF29278FF5700B0C511EB1B5BB7C820 （未变）
```

本轮写入报告前后各重算一次，以下值与本报告同时段实测一致（`Get-FileHash -Algorithm SHA256`）：

```text
.vscode/settings.json      F91F186D212F8CB815C5C0D34C945CC18E7356E950F76F93686329CA87E4DA72  （外部扩展写入，非本 Agent，见 §1.3；本轮未修改）
sdkconfig.old              CCDB0B9EAB359B2E5D2A14D724154229EDB8B6ABAC50ADDB21AAB64A8FAC28B  （未变）
sdkconfig.ci               E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855  （未变，0 字节）
build/flasher_args.json    124A8B22DE1C8D8C034B17B7427E902CF90D262EEA07CE46450F6774A6BDE821  （未变）
```

## 10. 预期启动日志（示例，非实际测试证据）

板上运行后**应**出现（本任务尚未在板上执行）：

```text
I (xxx) base001: TASK-BASE-001 one-shot startup probe: begin (memory-only probing, including a 4 KiB PSRAM write/read-back check; no peripheral initialisation, no auto restart)
I (xxx) base001: [config] target chip: esp32s3 (ESP32-S3)
I (xxx) base001: [config] Flash size: 16MB, mode: dio, frequency: 80m
I (xxx) base001: [config] PSRAM: mode=OCT, speed=80 MHz, boot init=on, explicit caps alloc=on
I (xxx) base001: [config] task stacks stay in internal RAM (CONFIG_FREERTOS_TASK_CREATE_ALLOW_EXT_MEM disabled)
I (xxx) base001: [chip] model enum=9 (expected 9 = ESP32-S3), cores=2, silicon=vX.Y, features=0x...
I (xxx) base001: [flash] chip-reported physical capacity: 16777216 bytes (16.00 MiB)
I (xxx) base001: [flash] image-header configured capacity: 16777216 bytes (16.00 MiB)
I (xxx) base001: [flash] OK: 16 MiB (16.00 MiB) chip-physical capacity, image header configured to 16 MiB
I (xxx) base001: [psram] chip-reported capacity: 8388608 bytes (8.00 MiB)
I (xxx) base001: [psram] OK: 8 MiB (8.00 MiB) Octal PSRAM, initialised by the boot loader
I (xxx) base001: [heap internal] total ... free ... largest free block ... lifetime minimum free ...
I (xxx) base001: [heap psram]    total ... free ... largest free block ... lifetime minimum free ...
I (xxx) base001: [heap note] the PSRAM heap handed to the allocator is a measured value and is not required to equal the 8 MiB chip capacity
I (xxx) base001: [psram alloc] heap_caps_malloc(4096, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT) = 0x3c....
I (xxx) base001: [psram alloc] OK: pointer is byte-accessible external RAM and word aligned
I (xxx) base001: [psram check] full block write-read-back OK: 4096 bytes, offsets 0..4095
I (xxx) base001: [psram check] head write-read-back OK: offsets 0..63
I (xxx) base001: [psram check] tail write-read-back OK: offsets 4032..4095
I (xxx) base001: [psram check] cross-region isolation OK: middle offsets 64..4031 unchanged
I (xxx) base001: [psram free] probe buffer released with heap_caps_free()
I (xxx) base001: [psram free] PSRAM heap free before alloc: N bytes, after free: N bytes
I (xxx) base001: RESULT PASS: Flash 16 MiB, PSRAM 8 MiB, heap statistics reported, 4 KiB PSRAM write-read-back OK and buffer released
I (xxx) base001: TASK-BASE-001 one-shot startup probe: end (no task created, no restart, no polling loop; no GPIO / pump / pneumatic / network was initialised, physical shutdown is covered by ADR-0003)
```

任意失败时以 `E (xxx) base001: RESULT FAIL: <单一原因>` 结束，随后 `app_main` 返回、`main_task` 自行删除，无重启、无轮询。

---

# 附录 A：第 1 轮完成记录（2026-09-24，逐字保留）



## A.1 修改文件

| 文件 | 变更 | 原因 |
| --- | --- | --- |
| `main/hello_world_main.c` | 全部重写（模板 → 一次性启动探测） | 任务允许 |
| `main/CMakeLists.txt` | `PRIV_REQUIRES spi_flash` → `PRIV_REQUIRES spi_flash esp_psram` | 任务允许的例外：`esp_psram` 不是 IDF common component，不加依赖会 `fatal error: esp_psram.h: No such file or directory`（已实测复现） |

`sdkconfig`、`sdkconfig.defaults`、`sdkconfig.old`、`sdkconfig.ci`、分区表、`docs/`、其他源码均未改动。

## A.2 实现内容

`app_main()` 单次执行 6 个阶段（编译期契约检查、芯片身份、Flash 容量、PSRAM 容量、堆统计、4 KiB PSRAM 校验），全部只读探测；删除倒计时与 `esp_restart()`；单一 `finish:` 出口保证任何失败路径都释放已分配缓冲并输出唯一 `RESULT FAIL: <原因>`；未使用 `ESP_ERROR_CHECK`/`abort`/`assert`；仅两个定长 `for` 循环，无 `while`、无死循环、无重试；未创建任何 Task/Queue/Mutex/EventGroup；未调用 GPIO/I2C/PCA9685/HX711/网络/OTA。

## A.3 测试内容与结果

| 项 | 方法 | 结果 |
| --- | --- | --- |
| 编译 | `idf.py build`（增量、强制重编、ccache 关闭全量 1035 目标、发布构建共 4 次） | `[PASS]` exit 0 |
| 警告预算 | 5 份构建日志 `warning:`/`error:`/`FAILED` 计数 | `[PASS]` 全部 0 |
| 生成配置 | `build/config/sdkconfig.h` | `[PASS]` 16MB / OCT / 80M / CAPS_ALLOC / BOOT_INIT / MEMTEST 齐备；`FREERTOS_TASK_CREATE_ALLOW_EXT_MEM` 未定义 |
| 日志分支与代码路径 | `.bin`/`.elf` 检索 38 条成功/失败分支字符串 | `[PASS]` 38/38 命中 |
| 符号边界 | `nm` 反查 `main` 目标文件未定义符号 | `[PASS]` 仅 IDF 原生 API + `memset` |
| 禁用 API 静态扫描 | 全文件正则（排除注释） | `[PASS]` 全部 0 |
| 校验图案有效性 | Python 复刻逻辑做故障注入 | `[PASS]` 4096 单比特翻转全检出等 |
| 实物启动、Flash/PSRAM 实读、4 KiB 读写 | — | `[HW REQUIRED]` |
| 泵/气路安全关断 | — | `[HW REQUIRED]`（ADR-0003 独立验收） |
| `flash`/`monitor`/设备写操作 | — | `[NOT RUN]`（无板卡身份/端口/恢复方式） |

## A.4 Build Result（第 1 轮）

- 命令：`idf.py build`（PowerShell，ESP-IDF v5.4.2）；目标 `esp32s3`；exit code 0
- `build/yetitiaopei.elf` — 3 849 672 B — SHA256 `3E6C2B5DB64D125FAD3F7FDD7180384F88365220430B3E423F1207F93071D851`
- `build/yetitiaopei.bin` — 223 136 B（`0x367a0`）— SHA256 `55D5C53762F0818D71939DAD90F3D48391359F96BAE92F2FD01875BB544F8BC1`
- 工具：ESP-IDF v5.4.2（`IDF_VER=v5.4.2-dirty`）、Xtensa GCC 14.2.0、esptool 4.10.0
- 第 1 轮源码哈希：`main/hello_world_main.c` = `72A5EFEB0EDE9B1FEC18C7B152F522BC12A65DD94D7888B09508CCFB31A0051E`；`main/CMakeLists.txt` = `DFAAA3AF93EFA7706C87DB5E717D1558E242261F475C9592D91DABF29C9FF84F`

## A.5 Warnings（第 1 轮）

0 条。全量重编（ccache 关闭、917 个编译步骤）与增量构建日志中 `warning:` / `error:` 计数均为 0。

## A.6 Known Issues（第 1 轮）

1. `main/CMakeLists.txt` 必须新增 `esp_psram` 依赖。
2. `.vscode/settings.json` 曾被后台 VS Code ESP-IDF 扩展写入 `"idf.portWin": "COM5"`（mtime `18:20:38`），已精确还原至基线哈希 `635279036F5880D0DA6FC59E334E8719EBCD30176C217B832A52C7AED29CF2B8`。
3. `IRAM` 段占用 16383/16384 B（99.99%），为既有基线。
4. 板卡侧结论均为 `[HW REQUIRED]`。

## A.7 Questions（第 1 轮）

1. 请提供板卡身份、目标串口、当前固件版本与恢复方式。
2. 板上验证需提供完整启动日志与板卡/串口身份。
3. 是否需另开任务单授权设备写操作与日志归档路径。

## A.8 板上测试状态（第 1 轮）

`[HW REQUIRED]` / `[NOT RUN]` — 未烧写、未监视、未做任何设备写操作。

---

READY FOR ARCHITECT REVIEW

---

# 附录 B：第 2 轮完成记录（2026-09-24，除最新轮次措辞外逐字保留）

## 1. 第 2 轮（返工）：评审意见与逐条处理

Architect 返工指令（原文要点）：

> `esp_flash_get_size()` 返回的是固件镜像头配置容量，不是"driver available capacity"。
> 1. 将 `flash_available_bytes` 重命名为 `flash_header_bytes`。
> 2. 将日志 `capacity available to the driver` 改为 `image-header configured capacity`。
> 3. 同步修改容量不匹配日志、成功日志和相关注释。
> 4. `esp_flash_get_physical_size()` 继续表示实际 Flash 芯片物理容量。
> 5. 不修改 `sdkconfig`、分区表、其他 docs 文件、GPIO 或外设代码。
> 6. 仅允许修改 `main/hello_world_main.c`、`main/CMakeLists.txt`（确有必要时）、`docs/agent_reports/TASK-BASE-001.md`。

| # | 返工项 | 处理 | 修改位置（`main/hello_world_main.c`，返工后行号） | 状态 |
| --- | --- | --- | --- | --- |
| 1 | `flash_available_bytes` → `flash_header_bytes` | 变量声明与全部 4 处使用点重命名；残留计数 0 | L163（声明）、L200、L217、L218、L220、L223 | `[PASS]` |
| 2 | 日志改为 `image-header configured capacity` | 逐字采用新措辞 | L217–L218 | `[PASS]` |
| 3a | 容量不匹配日志同步 | `chip-reported … driver-available …` → `chip-physical … image-header …` | L220–L223 | `[PASS]` |
| 3b | 成功日志同步 | `physical and available capacity` → `chip-physical capacity, image header configured to 16 MiB` | L227 | `[PASS]` |
| 3c | 相关注释同步 | ① 文件头阶段 2 说明改写；② 新增 `esp_flash_get_size()` 语义说明（明确"不是可分配容量"）；③ 新增 `esp_flash_get_physical_size()` 语义说明 | L18–L19、L196–L199、L206–L207 | `[PASS]` |
| 4 | 物理容量语义保持不变 | `esp_flash_get_physical_size(NULL, &flash_chip_bytes)` 仍为芯片物理容量，日志 `chip-reported physical capacity` 保留 | L208、L215–L216 | `[PASS]` |
| 5 | 不改 `sdkconfig`/分区表/其他 docs/GPIO | 哈希逐项核对：`sdkconfig*` 4 个文件与分区表均未变；本轮未写入任何 `docs/` 文件（见 §5 说明） | — | `[PASS]` |
| 6 | 仅改允许文件 | 本轮仅改 `main/hello_world_main.c` 并新增本报告；`main/CMakeLists.txt` 沿用第 1 轮结果未再改动 | — | `[PASS]` |

### 1.1 返工后的 Flash 阶段代码（返工后 L195–L227）

```c
    /* ---------------- Stage 3/6: Flash capacity (16 MiB required) ---------- */
    /* esp_flash_get_size() does NOT report a heap/allocatable capacity: it returns
     * the size recorded in the firmware image header (chip->size), i.e. the
     * CONFIG_ESPTOOLPY_FLASHSIZE value burned into the bootloader/app header. It is
     * reported here only as a configuration cross-check, never as available space. */
    err = esp_flash_get_size(NULL, &flash_header_bytes);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "[flash] esp_flash_get_size failed: %s (0x%x)", esp_err_to_name(err), (unsigned)err);
        failure = "esp_flash_get_size failed";
        goto finish;
    }
    /* esp_flash_get_physical_size() is the real Flash chip capacity read back from
     * the chip itself (detect_size). This is the physical hardware value. */
    err = esp_flash_get_physical_size(NULL, &flash_chip_bytes);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "[flash] esp_flash_get_physical_size failed: %s (0x%x)", esp_err_to_name(err), (unsigned)err);
        failure = "esp_flash_get_physical_size failed";
        goto finish;
    }

    ESP_LOGI(TAG, "[flash] chip-reported physical capacity: %" PRIu32 " bytes (%" PRIu32 ".%02" PRIu32 " MiB)",
             flash_chip_bytes, MIB_X100(flash_chip_bytes) / 100u, MIB_X100(flash_chip_bytes) % 100u);
    ESP_LOGI(TAG, "[flash] image-header configured capacity: %" PRIu32 " bytes (%" PRIu32 ".%02" PRIu32 " MiB)",
             flash_header_bytes, MIB_X100(flash_header_bytes) / 100u, MIB_X100(flash_header_bytes) % 100u);

    if (flash_header_bytes != FLASH_EXPECT_BYTES || flash_chip_bytes != FLASH_EXPECT_BYTES) {
        ESP_LOGE(TAG, "[flash] capacity mismatch: expected %" PRIu32 " bytes (16 MiB), "
                      "chip-physical %" PRIu32 " bytes, image-header %" PRIu32 " bytes",
                 FLASH_EXPECT_BYTES, flash_chip_bytes, flash_header_bytes);
        failure = "Flash capacity is not 16 MiB";
        goto finish;
    }
    ESP_LOGI(TAG, "[flash] OK: 16 MiB (16.00 MiB) chip-physical capacity, image header configured to 16 MiB");
```

### 1.2 语义依据（ESP-IDF 5.4.2 源码，用于确认评审意见成立）

- `components/spi_flash/include/esp_flash.h`：`struct esp_flash_t::size` 注释为
  *"Note: this stands for the size in the binary image header. If you want to get the flash physical size, please call `esp_flash_get_physical_size`."*
- `components/spi_flash/esp_flash_api.c` L563 `esp_flash_get_size()`：`chip->size != 0` 时直接返回 `*out_size = chip->size;`
- `components/spi_flash/esp_flash_spi_init.c` L418–L419：`default_chip.size = legacy_chip->chip_size;`，即镜像头配置值。
- 结论：返工意见成立，第 1 轮的 "driver available capacity" 措辞错误，已纠正。

---

## 2. 修改文件（累计）

| 文件 | 轮次 | 变更 | 变更原因 |
| --- | --- | --- | --- |
| `main/hello_world_main.c` | 1、2 | 模板 `hello_world` → 一次性启动探测；第 2 轮修正 Flash 容量命名与措辞 | 任务授权；第 2 轮按评审意见返工 |
| `main/CMakeLists.txt` | 1（第 2 轮未改） | `PRIV_REQUIRES spi_flash` → `PRIV_REQUIRES spi_flash esp_psram` | 任务允许的例外：`esp_psram` 非 IDF common component，不加依赖则 `fatal error: esp_psram.h: No such file or directory`（第 1 轮已实测复现） |
| `docs/agent_reports/TASK-BASE-001.md` | 2 | 新建本报告 | 任务授权 |

## 3. 实现内容（累计，第 2 轮后）

`void app_main(void)` 单次执行 6 阶段，仅探测内存（含 4 KiB PSRAM 写入/读回校验），不初始化任何外设；无 Task/Queue/Mutex/EventGroup，无轮询、无重试、无自动重启：

1. **编译期契约检查**：ESP32-S3、`CONFIG_ESPTOOLPY_FLASHSIZE_16MB`、`CONFIG_SPIRAM`+`_MODE_OCT`+`_SPEED_80M`+`_BOOT_INIT`+`_USE_CAPS_ALLOC`，并反向断言 `CONFIG_FREERTOS_TASK_CREATE_ALLOW_EXT_MEM` 未定义。
2. **芯片身份**：`esp_chip_info()`，非 `CHIP_ESP32S3` 即失败。
3. **Flash 容量（本轮修正）**：`esp_flash_get_physical_size(NULL, &flash_chip_bytes)` = 芯片物理容量；`esp_flash_get_size(NULL, &flash_header_bytes)` = 镜像头配置容量。两者分别以 `chip-reported physical capacity` / `image-header configured capacity` 输出，均须等于 16 MiB。
4. **PSRAM 容量**：`esp_psram_is_initialized()` 后 `esp_psram_get_size()`，须等于 8 MiB。
5. **堆统计**：`MALLOC_CAP_INTERNAL` / `MALLOC_CAP_SPIRAM` 输出 region 字节数（`heap_caps_get_total_size`）、free、largest free block、lifetime minimum（`heap_caps_get_info`）；显式声明 PSRAM 可分配堆不假定等于 8 MiB。
6. **4 KiB PSRAM 校验**：`heap_caps_malloc(4096, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT)` → 指针 `esp_ptr_external_ram` / `esp_ptr_byte_accessible` / `esp_ptr_word_aligned` 校验 → 位置相关图案全块写读回 → 首/尾 64 B 异 seed 覆写并读回 → 中段 3968 B 复核（跨区隔离）→ `heap_caps_free()` → 比对释放前后 free 确认归还。

**接口变化**：无新增公共 API；`app_main` 为唯一入口。**安全边界**：未调用 GPIO/I2C/PCA9685/HX711/网络/OTA；未声明泵物理关断（属 ADR-0003 独立验收）。

## 4. 测试内容与结果

### 4.1 本轮（第 2 轮）测试命令与结果

| 项 | 命令 / 方法 | 结果 |
| --- | --- | --- |
| 构建（增量、强制重编主对象） | `idf.py build` | `[PASS]` exit 0 |
| 构建（`CCACHE_RECACHE=1` 强制真实编译，非缓存命中） | `idf.py build` | `[PASS]` exit 0；主对象 mtime `2026-09-24 19:00:01` 证明真实重编 |
| 警告预算 | 两份构建日志 `warning:` / `error:` / `FAILED` 计数 | `[PASS]` 全部 0 |
| 日志措辞落地 | 对 `build/yetitiaopei.bin` 与 `.elf` 检索 `image-header configured capacity`、`chip-physical capacity` | `[PASS]` 均存在 |
| 旧措辞清除 | 对源码、两份构建日志、`.bin`/`.elf` 检索 `capacity available to the driver`、`driver-available`、`driver makes available`、`physical and available`、`available capacity` | `[PASS]` 全部 0 命中 |
| 变量重命名彻底 | 源码检索 `flash_available_bytes` | `[PASS]` 计数 0 |
| 物理容量语义保持 | 源码检索 `esp_flash_get_physical_size` / `chip-reported physical capacity` | `[PASS]` 保留且日志标签未变 |

### 4.2 主机侧（累计）

| 项 | 方法 | 结果 |
| --- | --- | --- |
| 生成配置 | `build/config/sdkconfig.h` | `[PASS]` 16MB / OCT / 80M / CAPS_ALLOC / BOOT_INIT / MEMTEST 齐备；`FREERTOS_TASK_CREATE_ALLOW_EXT_MEM` 未定义 |
| 日志分支与代码路径 | 第 1 轮对 `.bin`/`.elf` 检索 38 条成功/失败分支字符串 | `[PASS]` 38/38 命中 |
| 符号边界 | `nm` 反查 `main` 目标文件未定义符号 | `[PASS]` 仅 IDF 原生 API + `memset`，无外设/网络/OTA/重启符号 |
| 禁用 API 静态扫描 | 全文件正则（排除注释） | `[PASS]` `esp_restart`/`vTaskDelay`/`gpio_`/`i2c_`/PCA9685/HX711/wifi/netif/ota/`xTaskCreate`/`xQueue*`/`xSemaphore*`/`ESP_ERROR_CHECK`/`abort`/`assert`/`printf` 均为 0（注释中的说明性提及除外） |
| 校验图案有效性 | Python 精确复刻 C 图案/校验逻辑做故障注入 | `[PASS]` 4096 个单比特翻转全部检出；全 0x00/0xFF 块检出；2 KiB 地址别名检出；漏写首/尾检出；完整缓冲无误报 |

### 4.3 板卡侧

| 项 | 状态 | 原因 |
| --- | --- | --- |
| 实物启动、Flash/PSRAM 实读值、内部/PSRAM 堆统计、4 KiB 读写校验 | `[HW REQUIRED]` | 未获得板卡身份、目标端口、当前固件与恢复方式；按 Test Requirements 禁止执行 `flash`/`monitor` |
| 泵/气路安全关断 | `[HW REQUIRED]` | 按 ADR-0003 独立验收，本任务不作声明 |
| `flash` / `monitor` / 任何设备写操作 | `[NOT RUN]` | 同上，本轮与第 1 轮均未执行 |

## 5. 完整性证据（本轮）

**本轮由本 Agent 写入的文件**：`main/hello_world_main.c`、`docs/agent_reports/TASK-BASE-001.md`（新建）。
`main/CMakeLists.txt` 本轮未改动。`sdkconfig*`、分区表、其他 `docs/` 文件、GPIO/外设代码本轮均未写入。

**`sdkconfig*` 与分区表（与任务前基线逐字节一致）**：

```text
sdkconfig           79759AA1C710ABD3728355853CD35D8C19CD3111C0E584C86EEB01163E39FA2E  （未变）
sdkconfig.defaults  3C3783D5C448CD1E104B1D9A001BD0096ECC3252573623D6227D7511601D66EB  （未变）
sdkconfig.old       CCDB0B9EAB359B2E5D2A14D724154D229EDB8B6ABAC50ADDB21AAB64A8FAC28B  （未变）
sdkconfig.ci        E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855  （未变，0 字节）
partition-table.bin 7F00B6C042A89B15B0CAC534F82ED988CAF29278FF5700B0C511EB1B5BB7C820  （未变）
```

**允许文件的当前哈希（返工后）**：

```text
main/hello_world_main.c  19785 bytes  SHA256=F30158AF7A645036FE0BDFD1A593CCCEC6B4192DC9DDE385FDB881D2683A099A
main/CMakeLists.txt        141 bytes  SHA256=DFAAA3AF93EFA7706C87DB5E717D1558E242261F475C9592D91DABF29C9FF84F
```

**关于其他 `docs/` 文件的时间戳说明**：与任务前基线比对时，`docs/README.md`、`docs/CODING_TASK_TEMPLATE.md`、`docs/tasks/TASK-BASE-001.md` 亦显示为已变更。三者 `LastWriteTime` 均为 `2026-09-24 18:54:22`，且 `docs/agent_reports/README.md` 的 `CreationTime` 为 `18:47:29`；本 Agent 在本任务中从未写入这些文件（本轮唯一 `docs/` 写入为新建本报告）。经核对该时点的改动内容为：任务单新增 `docs/agent_reports/TASK-BASE-001.md` 授权并把 `Required API` 改为 `flash_header_bytes` / `flash_chip_bytes` 双变量措辞，与本次返工指令一致 —— 判定为 Architect Agent 的授权编辑，**不属于 Coding Agent 改动**，在此如实登记以便追溯。

**源码编码**：UTF-8 无 BOM，CRLF 一致（384 CRLF / 0 LF-only），纯 ASCII（0 个非 ASCII 字节）。

## 6. Build Result（本轮）

- 命令：`idf.py build`（PowerShell，`IDF_PATH=E:\Espressif\frameworks\esp-idf-v5.4.2`，`IDF_TOOLS_PATH=E:\Espressif\tools`）
- 目标：`esp32s3`；**exit code 0**
- 产物：
  - `build/yetitiaopei.elf` — 3 849 672 B — SHA256 `6439F1F6E439DFEAAF83B397D454922776BE66F90F6FD3A00FEA966CF91EC7F6`
  - `build/yetitiaopei.bin` — 223 152 B（`0x367b0`）— SHA256 `6D54EFC8C37C7F18D40AE635F0637D0ADC6B1F01F019FD6D48F798AEB57264BA`
  - `build/bootloader/bootloader.bin` — 20 928 B；`build/partition_table/partition-table.bin` — 3 072 B（内容未变）
- 空间：应用分区 `0x100000`，剩余 `0xc9850`（79%）
- 工具版本：ESP-IDF **v5.4.2**（`IDF_VER=v5.4.2-dirty`）、Xtensa GCC **14.2.0**、esptool 4.10.0、CMake 3.30.2、Ninja 1.12.1、Python 3.11.2
- 日志：`%TEMP%\base001_rework_build.log`、`%TEMP%\base001_rework_recache.log`（第 1 轮日志：`base001_build*.log`、`base001_build_raw.log`）

## 7. Warnings

**本轮 0 条。** 增量构建与 `CCACHE_RECACHE=1` 强制真实编译两份日志中，`warning:` / `error:` / `FAILED` 计数均为 0。构建日志中唯一含 `fatal` 的行是 `-- git rev-parse returned 'fatal: not a git repository'`，属本工程无 Git 元数据的既有提示，非编译警告。

## 8. Known Issues

1. **`main/CMakeLists.txt` 的 `esp_psram` 依赖**（第 1 轮引入，本轮未改）：`esp_psram` 非 IDF common component，不加依赖无法包含 `esp_psram.h`。请 Architect 确认该例外是否接受。
2. **外部进程改写工作区文件（已复原一次）**：第 1 轮构建期间后台 VS Code ESP-IDF 扩展曾写入 `.vscode/settings.json`（新增 `"idf.portWin": "COM5"`，mtime `18:20:38`），已按原始内容精确还原（235 B，SHA256 回到基线 `635279036F5880D0DA6FC59E334E8719EBCD30176C217B832A52C7AED29CF2B8`）。该文件不在允许清单内，**后台扩展可能再次写入**，请 Architect 知悉。
3. **`IRAM` 段占用 16383/16384 B（99.99%）**：本工程既有基线（`hello_world` 模板同样如此），本任务未新增 IRAM 需求；后续功能开发需注意该余量仅 1 B。
4. **`esp_flash_get_size()` 的返回值语义**：它返回镜像头配置值（`chip->size`），在配置值与实际芯片不一致时**不会**反映真实芯片容量；因此 16 MiB 的判定同时依赖 `esp_flash_get_physical_size()`。若二者不一致，当前实现判为失败并停止后续探测（符合"容量不符即报错"要求）。
5. **板卡侧全部结论为 `[HW REQUIRED]`**：不接受仅凭编译声称通过。

## 9. Questions

1. 请提供**板卡身份**（丝印/模组序列号）、**目标串口**、**当前固件版本**与**恢复方式**；主机现有 22 个串口（含多个 CH340/CH343/FTDI），无法据此唯一确定 N16R8 目标，故未执行 `flash`/`monitor`。
2. 板上验证需提供完整启动日志（115200 8N1）与板卡/串口身份，以形成 §4.3 中 `[HW REQUIRED]` 项的 `[PASS]` 证据；请确认日志归档路径与授权任务单。
3. 若需把 `image-header configured capacity` 与 `chip-reported physical capacity` 的不一致情形区分为"仅告警继续"而非"失败停止"，请由 Architect 修改任务/设计后另行派单（当前实现按任务要求一律判失败）。

## 10. 板上测试状态与日志位置

- **状态**：`[HW REQUIRED]` / `[NOT RUN]` — 未烧写、未监视、未做任何设备写操作
- **预期启动日志（示例，非实际证据）**，板上运行后应出现：
  ```text
  I (xxx) base001: TASK-BASE-001 one-shot startup probe: begin (memory-only probing, including a 4 KiB PSRAM write/read-back check; no peripheral initialisation, no auto restart)
  I (xxx) base001: [config] target chip: esp32s3 (ESP32-S3)
  I (xxx) base001: [config] Flash size: 16MB, mode: dio, frequency: 80m
  I (xxx) base001: [config] PSRAM: mode=OCT, speed=80 MHz, boot init=on, explicit caps alloc=on
  I (xxx) base001: [config] task stacks stay in internal RAM (CONFIG_FREERTOS_TASK_CREATE_ALLOW_EXT_MEM disabled)
  I (xxx) base001: [chip] model enum=9 (expected 9 = ESP32-S3), cores=2, silicon=vX.Y, features=0x...
  I (xxx) base001: [flash] chip-reported physical capacity: 16777216 bytes (16.00 MiB)
  I (xxx) base001: [flash] image-header configured capacity: 16777216 bytes (16.00 MiB)
  I (xxx) base001: [flash] OK: 16 MiB (16.00 MiB) chip-physical capacity, image header configured to 16 MiB
  I (xxx) base001: [psram] chip-reported capacity: 8388608 bytes (8.00 MiB)
  I (xxx) base001: [psram] OK: 8 MiB (8.00 MiB) Octal PSRAM, initialised by the boot loader
  I (xxx) base001: [heap internal] total ... free ... largest free block ... lifetime minimum free ...
  I (xxx) base001: [heap psram]    total ... free ... largest free block ... lifetime minimum free ...
  I (xxx) base001: [heap note] the PSRAM heap handed to the allocator is a measured value and is not required to equal the 8 MiB chip capacity
  I (xxx) base001: [psram alloc] heap_caps_malloc(4096, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT) = 0x3c....
  I (xxx) base001: [psram alloc] OK: pointer is byte-accessible external RAM and word aligned
  I (xxx) base001: [psram check] full block write-read-back OK: 4096 bytes, offsets 0..4095
  I (xxx) base001: [psram check] head write-read-back OK: offsets 0..63
  I (xxx) base001: [psram check] tail write-read-back OK: offsets 4032..4095
  I (xxx) base001: [psram check] cross-region isolation OK: middle offsets 64..4031 unchanged
  I (xxx) base001: [psram free] probe buffer released with heap_caps_free()
  I (xxx) base001: [psram free] PSRAM heap free before alloc: N bytes, after free: N bytes
  I (xxx) base001: RESULT PASS: Flash 16 MiB, PSRAM 8 MiB, heap statistics reported, 4 KiB PSRAM write-read-back OK and buffer released
  I (xxx) base001: TASK-BASE-001 one-shot startup probe: end (no task created, no restart, no polling loop; no GPIO / pump / pneumatic / network was initialised, physical shutdown is covered by ADR-0003)
  ```
  任意失败时以 `E (xxx) base001: RESULT FAIL: <单一原因>` 结束，随后 `app_main` 返回、`main_task` 自行删除，无重启、无轮询。
- **日志归档位置**：构建日志见 §6；板卡日志待 `[HW REQUIRED]` 阶段生成后按 Architect 指定路径归档。

---

---

READY FOR ARCHITECT REVIEW


---

# 附录 C：第 3 轮完成记录（2026-09-24，逐字保留）

## 1. 第 3 轮（返工）：评审意见与逐条处理

Architect 返工指令（原文要点）：

> 1. 将 `main/hello_world_main.c:174` 的 "read-only probing" 改为准确表述：仅探测内存，包含 4KiB PSRAM 写入/读回，不初始化外设。
> 2. 同步修正 `docs/agent_reports/TASK-BASE-001.md` 最新轮次摘要和预期日志中的"只读"表述；历史附录保留原记录。
> 3. 不修改其他代码、配置或设计文档。运行 `idf.py build`。
> 4. 在同一报告追加本轮修改、构建结果和剩余的 `[HW REQUIRED]` 项，结尾写 `READY FOR ARCHITECT REVIEW`。
> 5. 尚未获得板卡身份、唯一串口、当前固件和恢复方式，不执行 `flash` 或 `monitor`。

### 1.1 评审意见成立性核对

第 2 轮及以前把该探测称为 "read-only probing"（只读探测）确实不准确：阶段 6 会对 4 KiB PSRAM 缓冲区执行**写入**（全块填充、首/尾 64 B 覆写），再读回比对。该写入只作用于本次 `heap_caps_malloc` 取得的、由本函数独占的堆缓冲，不触及任何外设寄存器、Flash 内容或持久化状态；但"只读"一词在字面上与之矛盾，属措辞缺陷。**评审意见成立，本轮已纠正。**

准确表述应为：**仅探测内存（含 4 KiB PSRAM 写入/读回校验），不初始化任何外设。**

### 1.2 逐条处理

| # | 返工项 | 处理 | 修改位置 | 状态 |
| --- | --- | --- | --- | --- |
| 1 | 源码 L174 "read-only probing" 改为准确表述 | 起始日志改为 `memory-only probing, including a 4 KiB PSRAM write/read-back check; no peripheral initialisation, no auto restart`；因文本变长，该 `ESP_LOGI` 拆为 3 行字符串字面量（现 L173–L175） | `main/hello_world_main.c` L173–L175（原 L173–L174） | `[PASS]` |
| 2a | 报告最新轮次摘要的"只读"表述 | §3 摘要改为"仅探测内存（含 4 KiB PSRAM 写入/读回校验），不初始化任何外设" | `docs/agent_reports/TASK-BASE-001.md` §3 | `[PASS]` |
| 2b | 报告预期日志的"只读"表述 | §10 预期日志首行同步为新措辞（仍标注为示例，非实际证据） | `docs/agent_reports/TASK-BASE-001.md` §10 | `[PASS]` |
| 2c | 历史附录保留原记录 | 第 1 轮附录 A **逐字保留**（未改动，SHA256 `aa20758f069e70cf245084727b3d885a292c9bcaa43b82c19adcd946eb5d749f`）；第 2 轮记录**除上述两处措辞外逐字保留**并降为附录 B | 见附录 A / 附录 B | `[PASS]` |
| 3 | 不改其他代码、配置、设计文档 | 本轮仅写入 `main/hello_world_main.c` 与 `docs/agent_reports/TASK-BASE-001.md`；`sdkconfig*`、分区表、其他 `docs/` 文件哈希逐项核对未变（§5） | — | `[PASS]` |
| 4 | 追加本轮修改、构建结果、剩余 `[HW REQUIRED]`，结尾 `READY FOR ARCHITECT REVIEW` | 本报告 §1–§7 为本轮内容，§6 列剩余 `[HW REQUIRED]` 项，文末为该声明 | — | `[PASS]` |
| 5 | 不执行 `flash` / `monitor` | 未执行；无板卡身份、唯一串口、当前固件与恢复方式 | — | `[NOT RUN]` |

### 1.3 返工后源码片段（现 L172–L176）

```c
    ESP_LOGI(TAG, "TASK-BASE-001 one-shot startup probe: begin "
                  "(memory-only probing, including a 4 KiB PSRAM write/read-back check; "
                  "no peripheral initialisation, no auto restart)");
```

说明：本探测确实会写内存（4 KiB PSRAM 缓冲区），故不再声明为只读；同时明确不初始化外设。源码全文已无 `read-only` / `read only` / `readonly` 字样（命中数 0）。

---

## 2. 第 3 轮修改文件

| 文件 | 变更 | 原因 |
| --- | --- | --- |
| `main/hello_world_main.c` | 起始日志措辞修正（L173–L175） | 按评审意见 1 纠正不准确的 "read-only" 表述 |
| `docs/agent_reports/TASK-BASE-001.md` | 追加第 3 轮记录；修正最新轮次摘要与预期日志的措辞；第 2 轮降为附录 B | 按评审意见 2、4 |

本轮未改动 `main/CMakeLists.txt`（沿用第 1 轮结果：`PRIV_REQUIRES spi_flash esp_psram`），未改动 `sdkconfig*`、分区表、其他 `docs/` 文件、GPIO 或外设代码。

## 3. 第 3 轮测试内容与结果

| 项 | 命令 / 方法 | 结果 |
| --- | --- | --- |
| 构建（`CCACHE_RECACHE=1` 强制真实编译，非缓存命中） | `idf.py build` | `[PASS]` exit 0；主对象 mtime `2026-09-24 19:38:40` 证明真实重编 |
| 警告预算 | 构建日志 `warning:` / `error:` / `FAILED` 计数 | `[PASS]` 全部 0 |
| 新措辞落地 | 对 `build/yetitiaopei.bin` 与 `.elf` 检索 `memory-only probing, including a 4 KiB PSRAM write/read-back check; ` 与 `no peripheral initialisation, no auto restart` | `[PASS]` 均存在 |
| 旧措辞清除 | 对源码检索 `read-only` / `read only` / `readonly`；对 `.bin`/`.elf` 检索 `read-only probing` | `[PASS]` 源码命中 0；二进制中旧串不存在 |
| 报告措辞 | 报告全文检索 `read-only` / `只读` | `[PASS]` 最新轮次 §2–§10 已无旧的"只读探测"断言；§1 中的同词仅出现在评审指令引用与"该措辞不准确"的说明句中（非断言）；附录 A/B 作为历史记录保留 |
| 构建配置 | `build/config/sdkconfig.h` | `[PASS]` 16MB / OCT / 80M / CAPS_ALLOC / BOOT_INIT / MEMTEST 齐备 |
| `flash` / `monitor` / 设备写操作 | 检查构建日志是否出现 `Connecting...` / `Serial port` / `--port COM` / `Chip is ESP` / `Hash of data` / `Leaving...` | `[PASS]` 全部未出现 → 未打开串口、未执行设备写操作。日志中 `python -m esptool ... write_flash ...` 两行是 `idf.py` 构建完成后打印的"To flash, run:"提示文本，未被执行 |
| 执行 `flash` / `monitor` | — | `[NOT RUN]`（无板卡身份、唯一串口、当前固件、恢复方式） |

## 4. Build Result（第 3 轮）

- 命令：`idf.py build`（PowerShell，`IDF_PATH=E:\Espressif\frameworks\esp-idf-v5.4.2`，`IDF_TOOLS_PATH=E:\Espressif\tools`，`CCACHE_RECACHE=1`）
- 目标：`esp32s3`；**exit code 0**
- 产物：
  - `build/yetitiaopei.elf` — 3 849 672 B — SHA256 `E1FA300ED127897FFE22EFBB70C768D6002DA8DB195A99A6629E91F97239FFA4`
  - `build/yetitiaopei.bin` — 223 216 B（`0x367f0`）— SHA256 `A9418791D0EE2774CC2067935A5F0D0AAA7F7D1DE25FD435E5058748FAF0C124`
- 空间：应用分区 `0x100000`，剩余 `0xc9810`（79%）
- 工具版本：ESP-IDF **v5.4.2**（`IDF_VER=v5.4.2-dirty`）、Xtensa GCC **14.2.0**、esptool 4.10.0、CMake 3.30.2、Ninja 1.12.1、Python 3.11.2
- 日志：`%TEMP%\base001_r3_build.log`

## 5. 完整性证据（第 3 轮）

本轮由本 Agent 写入的文件：`main/hello_world_main.c`、`docs/agent_reports/TASK-BASE-001.md`。

```text
main/hello_world_main.c                  19866 bytes  SHA256=6EEC17B9B11632FA31CEC68483B48F9F94C17BADC9384C54E192F3DA6976D477  （本轮已改）
main/CMakeLists.txt                      SHA256=DFAAA3AF93EFA7706C87DB5E717D1558E242261F475C9592D91DABF29C9FF84F  （本轮未改）
sdkconfig                                79759AA1C710ABD3728355853CD35D8C19CD3111C0E584C86EEB01163E39FA2E  （未变）
sdkconfig.defaults                       3C3783D5C448CD1E104B1D9A001BD0096ECC3252573623D6227D7511601D66EB  （未变）
sdkconfig.old                            CCDB0B9EAB359B2E5D2A14D724154229EDB8B6ABAC50ADDB21AAB64A8FAC28B  （未变）
sdkconfig.ci                             E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855  （未变，0 字节）
build/partition_table/partition-table.bin 7F00B6C042A89B15B0CAC534F82ED988CAF29278FF5700B0C511EB1B5BB7C820 （未变）
```

源码编码：UTF-8 无 BOM，CRLF 一致，纯 ASCII（0 个非 ASCII 字节）。

## 6. 剩余 `[HW REQUIRED]` 项（第 3 轮）

| 项 | 状态 | 未完成原因 / 所需前置条件 |
| --- | --- | --- |
| 实物启动并取得完整启动日志（115200 8N1） | `[HW REQUIRED]` | 无板卡身份、唯一串口、当前固件版本与恢复方式 |
| Flash 实读值（`esp_flash_get_physical_size` / `esp_flash_get_size` 板上返回值） | `[HW REQUIRED]` | 同上 |
| PSRAM 实读值与初始化确认（`esp_psram_get_size` 板上返回值） | `[HW REQUIRED]` | 同上 |
| 内部 RAM / PSRAM 堆统计板上实测值 | `[HW REQUIRED]` | 同上 |
| 4 KiB PSRAM 分配/写入/读回/释放板上实测 | `[HW REQUIRED]` | 同上 |
| 泵/气路安全关断 | `[HW REQUIRED]` | 按 ADR-0003 独立验收，本任务不作声明 |
| `flash` / `monitor` / 任何设备写操作 | `[NOT RUN]` | 前置条件未满足，按任务要求禁止执行 |

## 7. Warnings（第 3 轮）

**0 条。** `CCACHE_RECACHE=1` 强制真实编译的构建日志中，`warning:` / `error:` / `FAILED` 计数均为 0。日志中唯一含 `fatal` 的行是 `-- git rev-parse returned 'fatal: not a git repository'`，属本工程无 Git 元数据的既有提示，非编译警告。

## 8. Known Issues（累计，未变化）

1. `main/CMakeLists.txt` 的 `esp_psram` 依赖（第 1 轮引入）仍待 Architect 确认是否接受该例外。
2. 后台 VS Code ESP-IDF 扩展曾于第 1 轮改写 `.vscode/settings.json`，已精确还原；该文件不在允许清单内，扩展可能再次写入。
3. `IRAM` 段占用 16383/16384 B（99.99%），为既有基线，本任务未新增 IRAM 需求。
4. `esp_flash_get_size()` 返回镜像头配置值而非物理容量；16 MiB 判定同时依赖 `esp_flash_get_physical_size()`，两者不一致时判失败并停止后续探测。
5. 板卡侧全部结论为 `[HW REQUIRED]`，不接受仅凭编译声称通过。

## 9. Questions（第 3 轮）

1. 请提供板卡身份（丝印/模组序列号）、唯一目标串口、当前固件版本与恢复方式，以便安排板上验证。
2. 板上验证的日志归档路径与设备写操作授权任务单是否由 Architect 指定？
3. 本轮把起始日志拆为 3 行字符串字面量仅因文本变长；如需固定单行长度上限或特定措辞模板，请指明。
4. 对"历史附录保留原记录"的理解与执行：本轮按指令修正了当时位于报告顶部的"最新轮次"（即第 2 轮）§3 摘要与 §10 预期日志两处措辞，随后将其降为附录 B；第 1 轮附录 A 未作任何改动。若 Architect 的本意是第 2 轮记录也应逐字冻结，请指示，我将恢复该两处原文并另作标注。

## 10. 板上测试状态与日志位置（第 3 轮）

- **状态**：`[HW REQUIRED]` / `[NOT RUN]` — 未烧写、未监视、未做任何设备写操作
- **预期启动日志（示例，非实际测试证据）**：
  ```text
  I (xxx) base001: TASK-BASE-001 one-shot startup probe: begin (memory-only probing, including a 4 KiB PSRAM write/read-back check; no peripheral initialisation, no auto restart)
  I (xxx) base001: [config] target chip: esp32s3 (ESP32-S3)
  I (xxx) base001: [config] Flash size: 16MB, mode: dio, frequency: 80m
  I (xxx) base001: [config] PSRAM: mode=OCT, speed=80 MHz, boot init=on, explicit caps alloc=on
  I (xxx) base001: [config] task stacks stay in internal RAM (CONFIG_FREERTOS_TASK_CREATE_ALLOW_EXT_MEM disabled)
  I (xxx) base001: [chip] model enum=9 (expected 9 = ESP32-S3), cores=2, silicon=vX.Y, features=0x...
  I (xxx) base001: [flash] chip-reported physical capacity: 16777216 bytes (16.00 MiB)
  I (xxx) base001: [flash] image-header configured capacity: 16777216 bytes (16.00 MiB)
  I (xxx) base001: [flash] OK: 16 MiB (16.00 MiB) chip-physical capacity, image header configured to 16 MiB
  I (xxx) base001: [psram] chip-reported capacity: 8388608 bytes (8.00 MiB)
  I (xxx) base001: [psram] OK: 8 MiB (8.00 MiB) Octal PSRAM, initialised by the boot loader
  I (xxx) base001: [heap internal] total ... free ... largest free block ... lifetime minimum free ...
  I (xxx) base001: [heap psram]    total ... free ... largest free block ... lifetime minimum free ...
  I (xxx) base001: [heap note] the PSRAM heap handed to the allocator is a measured value and is not required to equal the 8 MiB chip capacity
  I (xxx) base001: [psram alloc] heap_caps_malloc(4096, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT) = 0x3c....
  I (xxx) base001: [psram alloc] OK: pointer is byte-accessible external RAM and word aligned
  I (xxx) base001: [psram check] full block write-read-back OK: 4096 bytes, offsets 0..4095
  I (xxx) base001: [psram check] head write-read-back OK: offsets 0..63
  I (xxx) base001: [psram check] tail write-read-back OK: offsets 4032..4095
  I (xxx) base001: [psram check] cross-region isolation OK: middle offsets 64..4031 unchanged
  I (xxx) base001: [psram free] probe buffer released with heap_caps_free()
  I (xxx) base001: [psram free] PSRAM heap free before alloc: N bytes, after free: N bytes
  I (xxx) base001: RESULT PASS: Flash 16 MiB, PSRAM 8 MiB, heap statistics reported, 4 KiB PSRAM write-read-back OK and buffer released
  I (xxx) base001: TASK-BASE-001 one-shot startup probe: end (no task created, no restart, no polling loop; no GPIO / pump / pneumatic / network was initialised, physical shutdown is covered by ADR-0003)
  ```
  任意失败时以 `E (xxx) base001: RESULT FAIL: <单一原因>` 结束，随后 `app_main` 返回、`main_task` 自行删除，无重启、无轮询。
- **日志归档位置**：构建日志见 §4；板卡日志待 `[HW REQUIRED]` 阶段生成后按 Architect 指定路径归档。

---

---

READY FOR ARCHITECT REVIEW
