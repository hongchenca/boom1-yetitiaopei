#ifndef WEIGHT_TYPES_H
#define WEIGHT_TYPES_H

#include <stdbool.h>
#include <stdint.h>

#define WEIGHT_SOURCE_SCALE_COUNT 8u
#define WEIGHT_SCALE_COUNT 9u
#define WEIGHT_MAIN_SCALE_ID 8u
#define WEIGHT_RAW_MIN (-8388608)
#define WEIGHT_RAW_MAX 8388607

typedef struct {
    uint8_t scale_id;             // 0..8; 8 is the central vessel
    int32_t raw_count;            // signed 24-bit HX711 count, sign-extended
    int64_t mass_mg;              // calibrated mass; negative tare is allowed
    uint64_t timestamp_ms;       // monotonic sample time
    uint32_t calibration_version; // zero means no valid calibration
    bool valid;                   // measurement and calibration result valid
    bool stable;                  // stable window reported by the future service
    bool fault;                   // hardware/service fault attached to sample
} weight_snapshot_t;

typedef enum {
    WEIGHT_SNAPSHOT_OK = 0,
    WEIGHT_SNAPSHOT_NULL,
    WEIGHT_SNAPSHOT_BAD_SCALE,
    WEIGHT_SNAPSHOT_FAULT,
    WEIGHT_SNAPSHOT_INVALID,
    WEIGHT_SNAPSHOT_RAW_RANGE,
    WEIGHT_SNAPSHOT_UNCALIBRATED,
    WEIGHT_SNAPSHOT_BAD_MAX_AGE,
    WEIGHT_SNAPSHOT_FUTURE,
    WEIGHT_SNAPSHOT_STALE
} weight_snapshot_check_t;

/* Checks a stable snapshot copy for use by later control decisions.
 * A false stable flag does not make the measurement unavailable.
 * snapshot may be NULL; now_ms and max_age_ms are monotonic milliseconds.
 */
weight_snapshot_check_t weight_snapshot_check(const weight_snapshot_t *snapshot,
                                               uint64_t now_ms,
                                               uint64_t max_age_ms);

#endif
