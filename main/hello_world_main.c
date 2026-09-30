/*
 * SPDX-FileCopyrightText: 2026 Yetitiaopei Project
 *
 * SPDX-License-Identifier: CC0-1.0
 */

/*
 * TASK-BASE-001: one-shot N16R8 startup and memory probe.
 *
 * This file replaces the ESP-IDF "hello_world" template, whose ten second
 * countdown followed by esp_restart() made it unusable as a control-program
 * baseline.
 *
 * Exactly one pass, executed in the app_main startup context:
 *   1. Verify the compile-time contract: ESP32-S3 target, 16 MiB Flash, Octal
 *      PSRAM at 80 MHz, PSRAM boot init, explicit MALLOC_CAP_SPIRAM allocation
 *      (CAPS_ALLOC) and no task stacks in external RAM.
 *   2. Report the real chip identity, the Flash chip physical capacity read back
 *      from the chip, and the capacity configured in the firmware image header.
 *   3. Report the PSRAM capacity reported by the chip.
 *   4. Report internal-RAM and PSRAM heap statistics: region byte size via
 *      heap_caps_get_total_size(), free / largest / lifetime-minimum via
 *      heap_caps_get_info().
 *   5. Allocate exactly 4096 bytes with
 *      heap_caps_malloc(4096, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT), confirm the
 *      block really is byte-accessible external RAM and word aligned, run a
 *      deterministic head / tail / cross-region write-read-back check, then
 *      release it.
 *
 * Deliberately out of scope: GPIO, I2C, PCA9685, HX711, pump, pneumatic path,
 * Wi-Fi, network and OTA are never touched. No task, queue, mutex or event
 * group is created, no automatic restart or retry happens, and this probe makes
 * no claim about the physical pump / gas-line shutdown (ADR-0003, separate
 * acceptance).
 *
 * The PSRAM heap that the driver hands to the allocator is NOT assumed to be
 * exactly 8 MiB. Only the chip-reported capacity is compared with the 8 MiB
 * module contract; every heap number is reported as measured.
 */

#include <inttypes.h>
#include <stdbool.h>
#include <stdint.h>
#include <string.h>

#include "sdkconfig.h"

#include "esp_chip_info.h"
#include "esp_err.h"
#include "esp_flash.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_memory_utils.h"
#include "esp_psram.h"

static const char *TAG = "base001";

/* Module contract for ESP32-S3-WROOM-1-N16R8. */
#define FLASH_EXPECT_BYTES  ((uint32_t)(16u * 1024u * 1024u))
#define PSRAM_EXPECT_BYTES  ((size_t)(8u * 1024u * 1024u))

/* Mandatory probe buffer: exactly 4 KiB, explicitly from PSRAM. */
#define PROBE_BLOCK_BYTES   ((uint32_t)4096u)
#define PROBE_EDGE_BYTES    ((uint32_t)64u)

/* Two different seeds so the head/tail overwrite can also prove that it did not
 * disturb the middle of the block (cross-region isolation). */
#define PROBE_SEED_BASE     ((uint8_t)0xA5u)
#define PROBE_SEED_EDGE     ((uint8_t)0x3Cu)

/* Byte count plus explicit MiB (two decimals) using integer arithmetic only, so
 * the log text is identical with or without float formatting support. */
#define MIB_X100(bytes)     ((uint32_t)(((uint64_t)(bytes) * 100u) / (1024u * 1024u)))

/* Deterministic, position dependent test pattern: the low byte of the pattern
 * depends on the offset itself, so an address alias or a dropped write shows up
 * as a mismatch at a specific offset instead of silently passing. */
static uint8_t s_probe_pattern(uint32_t offset, uint8_t seed)
{
    return (uint8_t)(((offset * 37u) ^ (offset >> 8)) + (uint32_t)seed);
}

static void s_probe_fill(uint8_t *block, uint32_t start, uint32_t length, uint8_t seed)
{
    for (uint32_t i = 0; i < length; i++) {
        uint32_t offset = start + i;
        block[offset] = s_probe_pattern(offset, seed);
    }
}

static bool s_probe_verify(const uint8_t *block, uint32_t start, uint32_t length, uint8_t seed,
                           uint32_t *out_bad_offset, uint8_t *out_expected, uint8_t *out_actual)
{
    for (uint32_t i = 0; i < length; i++) {
        uint32_t offset = start + i;
        uint8_t expected = s_probe_pattern(offset, seed);
        uint8_t actual = block[offset];
        if (actual != expected) {
            *out_bad_offset = offset;
            *out_expected = expected;
            *out_actual = actual;
            return false;
        }
    }
    return true;
}

/* Stage 1: the build configuration must match the N16R8 contract. Each item is
 * reported separately so a mismatch names the exact option, and the function
 * returns false so that no further probing happens. */
static bool s_check_build_configuration(void)
{
    bool all_ok = true;

#if CONFIG_IDF_TARGET_ESP32S3
    ESP_LOGI(TAG, "[config] target chip: %s (ESP32-S3)", CONFIG_IDF_TARGET);
#else
    ESP_LOGE(TAG, "[config] target chip mismatch: CONFIG_IDF_TARGET=\"%s\", expected \"esp32s3\"", CONFIG_IDF_TARGET);
    all_ok = false;
#endif

#if defined(CONFIG_ESPTOOLPY_FLASHSIZE_16MB)
    ESP_LOGI(TAG, "[config] Flash size: %s, mode: %s, frequency: %s",
             CONFIG_ESPTOOLPY_FLASHSIZE, CONFIG_ESPTOOLPY_FLASHMODE, CONFIG_ESPTOOLPY_FLASHFREQ);
#else
    ESP_LOGE(TAG, "[config] Flash size mismatch: CONFIG_ESPTOOLPY_FLASHSIZE=\"%s\", expected 16MB",
             CONFIG_ESPTOOLPY_FLASHSIZE);
    all_ok = false;
#endif

#if defined(CONFIG_SPIRAM) && defined(CONFIG_SPIRAM_MODE_OCT) && defined(CONFIG_SPIRAM_SPEED_80M) && \
    defined(CONFIG_SPIRAM_BOOT_INIT) && defined(CONFIG_SPIRAM_USE_CAPS_ALLOC)
    ESP_LOGI(TAG, "[config] PSRAM: mode=OCT, speed=%d MHz, boot init=on, explicit caps alloc=on",
             CONFIG_SPIRAM_SPEED);
#else
    ESP_LOGE(TAG, "[config] PSRAM configuration mismatch: need CONFIG_SPIRAM, CONFIG_SPIRAM_MODE_OCT, "
                  "CONFIG_SPIRAM_SPEED_80M, CONFIG_SPIRAM_BOOT_INIT and CONFIG_SPIRAM_USE_CAPS_ALLOC");
    all_ok = false;
#endif

#if defined(CONFIG_FREERTOS_TASK_CREATE_ALLOW_EXT_MEM)
    ESP_LOGE(TAG, "[config] task stacks may be created in external RAM "
                  "(CONFIG_FREERTOS_TASK_CREATE_ALLOW_EXT_MEM), expected it to be disabled");
    all_ok = false;
#else
    ESP_LOGI(TAG, "[config] task stacks stay in internal RAM "
                  "(CONFIG_FREERTOS_TASK_CREATE_ALLOW_EXT_MEM disabled)");
#endif

    return all_ok;
}

void app_main(void)
{
    const char *failure = NULL;
    void *probe_block = NULL;
    bool probe_allocated = false;
    esp_chip_info_t chip_info;
    multi_heap_info_t internal_heap;
    multi_heap_info_t psram_heap;
    esp_err_t err = ESP_OK;
    uint32_t flash_chip_bytes = 0;
    uint32_t flash_header_bytes = 0;
    size_t psram_chip_bytes = 0;
    size_t internal_heap_bytes = 0;
    size_t psram_heap_bytes = 0;
    size_t psram_free_before = 0;
    size_t psram_free_after = 0;
    uint32_t bad_offset = 0;
    uint8_t bad_expected = 0;
    uint8_t bad_actual = 0;

    ESP_LOGI(TAG, "TASK-BASE-001 one-shot startup probe: begin "
                  "(memory-only probing, including a 4 KiB PSRAM write/read-back check; "
                  "no peripheral initialisation, no auto restart)");

    /* ---------------- Stage 1/6: compile-time configuration ---------------- */
    if (!s_check_build_configuration()) {
        failure = "compile-time configuration does not match the N16R8 contract";
        goto finish;
    }

    /* ---------------- Stage 2/6: real chip identity ------------------------ */
    memset(&chip_info, 0, sizeof(chip_info));
    esp_chip_info(&chip_info);
    ESP_LOGI(TAG, "[chip] model enum=%d (expected %d = ESP32-S3), cores=%u, silicon=v%u.%u, features=0x%08" PRIx32,
             (int)chip_info.model, (int)CHIP_ESP32S3, (unsigned)chip_info.cores,
             (unsigned)(chip_info.revision / 100u), (unsigned)(chip_info.revision % 100u),
             (uint32_t)chip_info.features);
    if (chip_info.model != CHIP_ESP32S3) {
        ESP_LOGE(TAG, "[chip] actual chip is not ESP32-S3: model enum=%d", (int)chip_info.model);
        failure = "actual chip is not ESP32-S3";
        goto finish;
    }

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

    /* ---------------- Stage 4/6: PSRAM capacity (8 MiB required) ----------- */
    if (!esp_psram_is_initialized()) {
        ESP_LOGE(TAG, "[psram] PSRAM is not initialised (check the Octal PSRAM wiring and CONFIG_SPIRAM_BOOT_INIT)");
        failure = "PSRAM is not initialised";
        goto finish;
    }
    psram_chip_bytes = esp_psram_get_size();
    ESP_LOGI(TAG, "[psram] chip-reported capacity: %" PRIu32 " bytes (%" PRIu32 ".%02" PRIu32 " MiB)",
             (uint32_t)psram_chip_bytes, MIB_X100(psram_chip_bytes) / 100u, MIB_X100(psram_chip_bytes) % 100u);
    if (psram_chip_bytes != PSRAM_EXPECT_BYTES) {
        ESP_LOGE(TAG, "[psram] capacity mismatch: expected %" PRIu32 " bytes (8 MiB), reported %" PRIu32 " bytes",
                 (uint32_t)PSRAM_EXPECT_BYTES, (uint32_t)psram_chip_bytes);
        failure = "PSRAM capacity is not 8 MiB";
        goto finish;
    }
    ESP_LOGI(TAG, "[psram] OK: 8 MiB (8.00 MiB) Octal PSRAM, initialised by the boot loader");

    /* ---------------- Stage 5/6: heap statistics -------------------------- */
    memset(&internal_heap, 0, sizeof(internal_heap));
    memset(&psram_heap, 0, sizeof(psram_heap));
    heap_caps_get_info(&internal_heap, MALLOC_CAP_INTERNAL);
    heap_caps_get_info(&psram_heap, MALLOC_CAP_SPIRAM);

    /* heap_caps_get_total_size() is the only source of the heap byte size: the
     * multi_heap_info_t fields carry free / block counts, not the region size. */
    internal_heap_bytes = heap_caps_get_total_size(MALLOC_CAP_INTERNAL);
    psram_heap_bytes = heap_caps_get_total_size(MALLOC_CAP_SPIRAM);

    ESP_LOGI(TAG, "[heap internal] total %" PRIu32 " bytes (%" PRIu32 ".%02" PRIu32 " MiB), "
                  "free %" PRIu32 " bytes (%" PRIu32 ".%02" PRIu32 " MiB), largest free block %" PRIu32 " bytes, "
                  "lifetime minimum free %" PRIu32 " bytes",
             (uint32_t)internal_heap_bytes, MIB_X100(internal_heap_bytes) / 100u,
             MIB_X100(internal_heap_bytes) % 100u,
             (uint32_t)internal_heap.total_free_bytes, MIB_X100(internal_heap.total_free_bytes) / 100u,
             MIB_X100(internal_heap.total_free_bytes) % 100u,
             (uint32_t)internal_heap.largest_free_block, (uint32_t)internal_heap.minimum_free_bytes);
    ESP_LOGI(TAG, "[heap psram]    total %" PRIu32 " bytes (%" PRIu32 ".%02" PRIu32 " MiB), "
                  "free %" PRIu32 " bytes (%" PRIu32 ".%02" PRIu32 " MiB), largest free block %" PRIu32 " bytes, "
                  "lifetime minimum free %" PRIu32 " bytes",
             (uint32_t)psram_heap_bytes, MIB_X100(psram_heap_bytes) / 100u,
             MIB_X100(psram_heap_bytes) % 100u,
             (uint32_t)psram_heap.total_free_bytes, MIB_X100(psram_heap.total_free_bytes) / 100u,
             MIB_X100(psram_heap.total_free_bytes) % 100u,
             (uint32_t)psram_heap.largest_free_block, (uint32_t)psram_heap.minimum_free_bytes);
    ESP_LOGI(TAG, "[heap note] the PSRAM heap handed to the allocator is a measured value and is not "
                  "required to equal the 8 MiB chip capacity");

    psram_free_before = psram_heap.total_free_bytes;
    if (psram_free_before < (size_t)PROBE_BLOCK_BYTES) {
        ESP_LOGE(TAG, "[heap psram] not enough allocatable PSRAM: free %" PRIu32 " bytes, need %" PRIu32 " bytes",
                 (uint32_t)psram_free_before, PROBE_BLOCK_BYTES);
        failure = "PSRAM heap is smaller than the required 4 KiB probe buffer";
        goto finish;
    }

    /* ---------------- Stage 6/6: 4 KiB PSRAM alloc/verify/free ------------- */
    probe_block = heap_caps_malloc((size_t)PROBE_BLOCK_BYTES, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (probe_block == NULL) {
        ESP_LOGE(TAG, "[psram alloc] heap_caps_malloc(%" PRIu32 ", MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT) returned NULL",
                 PROBE_BLOCK_BYTES);
        failure = "4 KiB PSRAM allocation failed";
        goto finish;
    }
    probe_allocated = true;
    ESP_LOGI(TAG, "[psram alloc] heap_caps_malloc(%" PRIu32 ", MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT) = %p",
             PROBE_BLOCK_BYTES, probe_block);

    if (!esp_ptr_external_ram(probe_block)) {
        ESP_LOGE(TAG, "[psram alloc] returned pointer %p is not in external RAM", probe_block);
        failure = "allocated block is not in external RAM";
        goto finish;
    }
    if (!esp_ptr_byte_accessible(probe_block)) {
        ESP_LOGE(TAG, "[psram alloc] returned pointer %p is not byte accessible, so MALLOC_CAP_8BIT was not honoured", probe_block);
        failure = "allocated block is not byte accessible";
        goto finish;
    }
    if (!esp_ptr_word_aligned(probe_block)) {
        ESP_LOGE(TAG, "[psram alloc] returned pointer %p is not word aligned", probe_block);
        failure = "allocated block is not word aligned";
        goto finish;
    }
    ESP_LOGI(TAG, "[psram alloc] OK: pointer is byte-accessible external RAM and word aligned");

    /* Full block: fill, read back, compare. */
    s_probe_fill((uint8_t *)probe_block, 0u, PROBE_BLOCK_BYTES, PROBE_SEED_BASE);
    if (!s_probe_verify((const uint8_t *)probe_block, 0u, PROBE_BLOCK_BYTES, PROBE_SEED_BASE,
                        &bad_offset, &bad_expected, &bad_actual)) {
        ESP_LOGE(TAG, "[psram check] full block read-back mismatch at offset %" PRIu32
                      ": expected 0x%02X, read 0x%02X", bad_offset, (unsigned)bad_expected, (unsigned)bad_actual);
        failure = "4 KiB PSRAM full block write-read check failed";
        goto finish;
    }
    ESP_LOGI(TAG, "[psram check] full block write-read-back OK: %" PRIu32 " bytes, offsets 0..%" PRIu32,
             PROBE_BLOCK_BYTES, PROBE_BLOCK_BYTES - 1u);

    /* Head and tail: overwrite both edges with a different seed, then verify
     * each edge and verify that the middle kept the first pattern. */
    s_probe_fill((uint8_t *)probe_block, 0u, PROBE_EDGE_BYTES, PROBE_SEED_EDGE);
    s_probe_fill((uint8_t *)probe_block, PROBE_BLOCK_BYTES - PROBE_EDGE_BYTES, PROBE_EDGE_BYTES, PROBE_SEED_EDGE);

    if (!s_probe_verify((const uint8_t *)probe_block, 0u, PROBE_EDGE_BYTES, PROBE_SEED_EDGE,
                        &bad_offset, &bad_expected, &bad_actual)) {
        ESP_LOGE(TAG, "[psram check] head read-back mismatch at offset %" PRIu32
                      ": expected 0x%02X, read 0x%02X", bad_offset, (unsigned)bad_expected, (unsigned)bad_actual);
        failure = "4 KiB PSRAM head write-read check failed";
        goto finish;
    }
    ESP_LOGI(TAG, "[psram check] head write-read-back OK: offsets 0..%" PRIu32, PROBE_EDGE_BYTES - 1u);

    if (!s_probe_verify((const uint8_t *)probe_block, PROBE_BLOCK_BYTES - PROBE_EDGE_BYTES, PROBE_EDGE_BYTES,
                        PROBE_SEED_EDGE, &bad_offset, &bad_expected, &bad_actual)) {
        ESP_LOGE(TAG, "[psram check] tail read-back mismatch at offset %" PRIu32
                      ": expected 0x%02X, read 0x%02X", bad_offset, (unsigned)bad_expected, (unsigned)bad_actual);
        failure = "4 KiB PSRAM tail write-read check failed";
        goto finish;
    }
    ESP_LOGI(TAG, "[psram check] tail write-read-back OK: offsets %" PRIu32 "..%" PRIu32,
             PROBE_BLOCK_BYTES - PROBE_EDGE_BYTES, PROBE_BLOCK_BYTES - 1u);

    if (!s_probe_verify((const uint8_t *)probe_block, PROBE_EDGE_BYTES,
                        PROBE_BLOCK_BYTES - (2u * PROBE_EDGE_BYTES), PROBE_SEED_BASE,
                        &bad_offset, &bad_expected, &bad_actual)) {
        ESP_LOGE(TAG, "[psram check] middle region was disturbed at offset %" PRIu32
                      ": expected 0x%02X, read 0x%02X", bad_offset, (unsigned)bad_expected, (unsigned)bad_actual);
        failure = "head/tail write disturbed the middle of the 4 KiB PSRAM block";
        goto finish;
    }
    ESP_LOGI(TAG, "[psram check] cross-region isolation OK: middle offsets %" PRIu32 "..%" PRIu32 " unchanged",
             PROBE_EDGE_BYTES, PROBE_BLOCK_BYTES - PROBE_EDGE_BYTES - 1u);

finish:
    /* Every failure path lands here, so an already allocated buffer is always
     * released again and exactly one failure reason is reported. */
    if (probe_block != NULL) {
        heap_caps_free(probe_block);
        probe_block = NULL;
        ESP_LOGI(TAG, "[psram free] probe buffer released with heap_caps_free()");
    }

    if (probe_allocated) {
        heap_caps_get_info(&psram_heap, MALLOC_CAP_SPIRAM);
        psram_free_after = psram_heap.total_free_bytes;
        ESP_LOGI(TAG, "[psram free] PSRAM heap free before alloc: %" PRIu32 " bytes, after free: %" PRIu32 " bytes",
                 (uint32_t)psram_free_before, (uint32_t)psram_free_after);
        if (psram_free_after < psram_free_before) {
            ESP_LOGE(TAG, "[psram free] PSRAM heap did not recover after heap_caps_free(): %" PRIu32
                          " bytes below the pre-allocation value", (uint32_t)(psram_free_before - psram_free_after));
            if (failure == NULL) {
                failure = "PSRAM heap did not recover after releasing the probe buffer";
            }
        }
    }

    if (failure == NULL) {
        ESP_LOGI(TAG, "RESULT PASS: Flash 16 MiB, PSRAM 8 MiB, heap statistics reported, "
                      "4 KiB PSRAM write-read-back OK and buffer released");
    } else {
        ESP_LOGE(TAG, "RESULT FAIL: %s", failure);
    }
    ESP_LOGI(TAG, "TASK-BASE-001 one-shot startup probe: end (no task created, no restart, no polling loop; "
                  "no GPIO / pump / pneumatic / network was initialised, physical shutdown is covered by ADR-0003)");
}