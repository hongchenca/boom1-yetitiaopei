#include "weight_types.h"

#include <stddef.h>

weight_snapshot_check_t weight_snapshot_check(const weight_snapshot_t *snapshot,
                                               uint64_t now_ms,
                                               uint64_t max_age_ms)
{
    if (snapshot == NULL) {
        return WEIGHT_SNAPSHOT_NULL;
    }
    if (snapshot->scale_id >= WEIGHT_SCALE_COUNT) {
        return WEIGHT_SNAPSHOT_BAD_SCALE;
    }
    if (snapshot->fault) {
        return WEIGHT_SNAPSHOT_FAULT;
    }
    if (!snapshot->valid) {
        return WEIGHT_SNAPSHOT_INVALID;
    }
    if (snapshot->raw_count < WEIGHT_RAW_MIN || snapshot->raw_count > WEIGHT_RAW_MAX) {
        return WEIGHT_SNAPSHOT_RAW_RANGE;
    }
    if (snapshot->calibration_version == 0) {
        return WEIGHT_SNAPSHOT_UNCALIBRATED;
    }
    if (max_age_ms == 0) {
        return WEIGHT_SNAPSHOT_BAD_MAX_AGE;
    }
    if (snapshot->timestamp_ms > now_ms) {
        return WEIGHT_SNAPSHOT_FUTURE;
    }
    if (now_ms - snapshot->timestamp_ms > max_age_ms) {
        return WEIGHT_SNAPSHOT_STALE;
    }
    return WEIGHT_SNAPSHOT_OK;
}
