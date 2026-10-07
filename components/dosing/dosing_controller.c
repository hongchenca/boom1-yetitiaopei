#include "dosing_controller.h"
#include <stddef.h>
#include <string.h>

static int64_t abs64(int64_t v) { return v < 0 ? -v : v; }
static void enter(dosing_controller_t *c, dosing_state_t state, int64_t now) {
    c->state = state; c->entered_ms = now;
    c->output.pump_percent = c->output.air_percent = 0;
}
static void finish(dosing_controller_t *c, dosing_state_t state, dosing_error_t error, int64_t now) {
    enter(c, state, now); c->error = error; c->active = false;
    c->output.route = DOSE_ROUTE_OFF;
}
bool dosing_config_valid(const dosing_config_t *p) {
    return p && p->version && p->version <= INT32_MAX && p->minimum_percent >= 40 && p->minimum_percent <= p->fine_percent &&
        p->fine_percent <= p->slow_percent && p->slow_percent <= p->fast_percent && p->fast_percent <= 100 &&
        p->air_percent >= 1 && p->air_percent <= 100 && p->route_ms >= 100 && p->route_ms <= 5000 &&
        p->purge_ms >= 100 && p->purge_ms <= 10000 && p->settle_min_ms >= 200 &&
        p->settle_timeout_ms > p->settle_min_ms && p->settle_timeout_ms <= 60000 &&
        p->step_timeout_ms > p->settle_timeout_ms && p->step_timeout_ms <= 600000 &&
        p->total_timeout_ms >= p->step_timeout_ms && p->total_timeout_ms <= 3600000 &&
        p->no_flow_ms >= 500 && p->no_flow_ms <= p->step_timeout_ms &&
        p->pulse_min_ms >= 60 && p->pulse_min_ms <= p->pulse_max_ms && p->pulse_max_ms <= 1000 &&
        p->max_jogs >= 1 && p->max_jogs <= 100 && p->tail_ms <= 5000 &&
        p->fine_margin_mg > 0 && p->slow_margin_mg >= p->fine_margin_mg && p->slow_margin_mg <= 10000000 &&
        p->compensation_mg >= 0 && p->compensation_mg <= p->fine_margin_mg &&
        p->max_flow_mg_s > 0 && p->max_flow_mg_s <= 10000000 && p->progress_mg > 0 && p->progress_mg <= 1000000 &&
        p->residual_limit_mg >= 0 && p->residual_limit_mg <= 10000000 &&
        p->balance_tolerance_mg > 0 && p->balance_tolerance_mg <= 1000000 &&
        p->vessel_capacity_mg > 0 && p->vessel_capacity_mg <= 1000000000 &&
        p->purge_leak_tolerance_mg > 0 && p->purge_leak_tolerance_mg <= 1000000;
}
bool dosing_controller_start(dosing_controller_t *c, const dosing_config_t *p,
                             const dosing_step_t *steps, unsigned count, int64_t now) {
    if (!c || c->active || !dosing_config_valid(p) || !steps || !count || count > DOSING_MAX_STEPS || now < 0) return false;
    int64_t total = 0;
    for (unsigned i = 0; i < count; ++i) {
        if (steps[i].channel >= 8 || steps[i].target_mg <= 0 || steps[i].target_mg > 100000000 ||
            steps[i].tolerance_mg <= 0 || steps[i].tolerance_mg > 10000000 ||
            steps[i].tolerance_mg >= steps[i].target_mg) return false;
        total += steps[i].target_mg + steps[i].tolerance_mg;
    }
    if (total > p->vessel_capacity_mg) return false;
    memset(c, 0, sizeof(*c)); c->config = *p;
    memcpy(c->steps, steps, count * sizeof(*steps)); c->count = count;
    c->started_ms = c->last_tick_ms = now; c->active = true;
    enter(c, DOSE_PRECHECK, now); return true;
}
static bool fresh(const dosing_weight_t *w, int64_t now) {
    return w->valid && w->version && w->sample_ms <= now && now - w->sample_ms <= 500 &&
        w->control_mg >= -1000000000 && w->control_mg <= 1000000000 &&
        w->stable_mg >= -1000000000 && w->stable_mg <= 1000000000;
}
static bool settled(const dosing_weight_t *w, int64_t since) {
    return w->stable && w->window_ms >= 100 && w->sample_ms - w->window_ms >= since;
}
static void begin_step(dosing_controller_t *c, const dosing_input_t *in) {
    const dosing_weight_t *src = &in->weights[c->steps[c->step].channel];
    c->source_start_mg = src->stable_mg; c->vessel_start_mg = in->weights[8].stable_mg;
    c->delivered_mg = c->source_loss_mg = c->flow_mg_s = c->flow_mass_mg = c->progress_mass_mg = 0;
    c->flow_ms = c->step_started_ms = in->now_ms;
    c->no_progress_on_ms = 0;
    c->flow_sequence = in->weights[8].sequence; c->jogs = 0;
    c->output.channel = c->steps[c->step].channel; c->output.route = DOSE_VESSEL;
    enter(c, DOSE_ROUTE_VESSEL, in->now_ms);
}
void dosing_controller_tick(dosing_controller_t *c, const dosing_input_t *in) {
    if (!c || !in || !c->active) return;
    int64_t now = in->now_ms;
    if (in->cancel) { finish(c, DOSE_ABORTED, DOSE_CANCELLED, now); return; }
    if (!in->actuator_ok) { finish(c, DOSE_ERROR, DOSE_ACTUATOR, now); return; }
    if (now < c->last_tick_ms || now - c->last_tick_ms > 300) {
        finish(c, DOSE_ERROR, DOSE_CONTROL_LATE, now); return;
    }
    // 按上一节拍发出的泵指令累计，短脉冲达到硬截止后不继续计时。
    if (c->output.pump_percent) {
        int64_t until = now;
        if ((c->state == DOSE_FINE || c->state == DOSE_JOG) && until > c->entered_ms + c->pulse_ms)
            until = c->entered_ms + c->pulse_ms;
        if (until > c->last_tick_ms) c->no_progress_on_ms += (uint32_t)(until - c->last_tick_ms);
    }
    c->last_tick_ms = now;
    if (now - c->started_ms >= c->config.total_timeout_ms ||
        (c->state != DOSE_PRECHECK && now - c->step_started_ms >= c->config.step_timeout_ms)) {
        finish(c, DOSE_ERROR, DOSE_TIMEOUT, now); return;
    }
    // 本批用到的源秤和中央秤持续检查；未参与配方的传感器不阻塞本批。
    bool used[9] = {false}; used[8] = true;
    for (unsigned i = 0; i < c->count; ++i) used[c->steps[i].channel] = true;
    for (unsigned i = 0; i < 9; ++i) if (used[i]) {
        if (!fresh(&in->weights[i], now)) { finish(c, DOSE_ERROR, DOSE_SENSOR, now); return; }
        if (c->versions[i] && c->versions[i] != in->weights[i].version) {
            finish(c, DOSE_ERROR, DOSE_CALIBRATION_CHANGED, now); return;
        }
    }
    const dosing_config_t *p = &c->config;
    const dosing_step_t *step = &c->steps[c->step];
    const dosing_weight_t *src = &in->weights[step->channel], *dst = &in->weights[8];
    if (dst->control_mg > p->vessel_capacity_mg) { finish(c, DOSE_ERROR, DOSE_OVERDOSE, now); return; }
    if (c->state == DOSE_PRECHECK) {
        if (!in->motors_off) { finish(c, DOSE_ERROR, DOSE_ACTUATOR, now); return; }
        bool stable = true;
        for (unsigned i = 0; i < 9; ++i) if (used[i]) stable &= in->weights[i].stable;
        for (unsigned i = 0; i < c->count; ++i)
            if (dst->noise_mg > (uint32_t)c->steps[i].tolerance_mg) stable = false;
        if (!stable) {
            if (now - c->entered_ms >= p->settle_timeout_ms) finish(c, DOSE_ERROR, DOSE_TIMEOUT, now);
            return;
        }
        int64_t total = dst->stable_mg;
        for (unsigned i = 0; i < 8; ++i) if (used[i]) {
            int64_t needed = 0;
            for (unsigned j = 0; j < c->count; ++j) if (c->steps[j].channel == i)
                needed += c->steps[j].target_mg + c->steps[j].tolerance_mg + p->residual_limit_mg;
            if (in->weights[i].stable_mg < needed) { finish(c, DOSE_ERROR, DOSE_INVENTORY, now); return; }
        }
        for (unsigned i = 0; i < c->count; ++i) total += c->steps[i].target_mg + c->steps[i].tolerance_mg;
        if (total > p->vessel_capacity_mg) { finish(c, DOSE_ERROR, DOSE_OVERDOSE, now); return; }
        for (unsigned i = 0; i < 9; ++i) if (used[i]) c->versions[i] = in->weights[i].version;
        c->batch_start_mg = dst->stable_mg; begin_step(c, in); return;
    }
    c->delivered_mg = dst->control_mg - c->vessel_start_mg;
    c->source_loss_mg = c->source_start_mg - src->control_mg;
    if (c->delivered_mg > step->target_mg + step->tolerance_mg) {
        finish(c, DOSE_ERROR, DOSE_OVERDOSE, now); return;
    }
    if (c->delivered_mg < -p->balance_tolerance_mg || c->source_loss_mg < -p->balance_tolerance_mg ||
        (int64_t)c->source_loss_mg > step->target_mg + (int64_t)step->tolerance_mg + p->residual_limit_mg + p->balance_tolerance_mg) {
        finish(c, DOSE_ERROR, DOSE_MASS_BALANCE, now); return;
    }
    if ((int64_t)c->delivered_mg - c->progress_mass_mg >= p->progress_mg) {
        c->progress_mass_mg = c->delivered_mg;
        c->no_progress_on_ms = 0;
    }
    if (c->no_progress_on_ms >= p->no_flow_ms) {
        finish(c, DOSE_ERROR, DOSE_NO_FLOW, now);
        return;
    }
    bool filling = c->state == DOSE_FAST || c->state == DOSE_SLOW || c->state == DOSE_FINE || c->state == DOSE_JOG;
    if (filling) {
        if (dst->sequence != c->flow_sequence && dst->sample_ms - c->flow_ms >= 200) {
            int64_t dt = dst->sample_ms - c->flow_ms;
            int64_t rate = ((int64_t)c->delivered_mg - c->flow_mass_mg) * 1000 / dt;
            if (rate > p->max_flow_mg_s) {
                finish(c, DOSE_ERROR, DOSE_FLOW_LIMIT, now);
                return;
            }
            if (rate >= 0)
                c->flow_mg_s = c->flow_mg_s ? (int32_t)((c->flow_mg_s + rate) / 2) : (int32_t)rate;
            c->flow_mass_mg = c->delivered_mg; c->flow_ms = dst->sample_ms; c->flow_sequence = dst->sequence;
        }
    }
    int64_t remaining = (int64_t)step->target_mg - c->delivered_mg;
    int64_t delay = p->tail_ms + (dst->filter_delay_ms > 500 ? 500 : dst->filter_delay_ms) +
                    (now - dst->sample_ms) + 20; // 样本年龄与下一控制节拍也属于预停预算。
    int64_t tail = (int64_t)c->flow_mg_s * delay / 1000 + p->compensation_mg;
    // 预测只能提前停机；最终完成必须由停机后的原始稳定窗口确定。
    // 慢速切换阈值不能裁掉实际预测尾流，否则高流速时会延后停止。
    if (tail > step->target_mg) tail = step->target_mg;
    switch (c->state) {
    case DOSE_ROUTE_VESSEL:
        if (now - c->entered_ms >= p->route_ms) {
            c->flow_ms = dst->sample_ms;
            c->flow_mass_mg = c->delivered_mg;
            c->flow_sequence = dst->sequence;
            enter(c, remaining <= p->fine_margin_mg ? DOSE_STOPPING : remaining <= p->slow_margin_mg ? DOSE_SLOW : DOSE_FAST, now);
        }
        break;
    case DOSE_FAST:
    case DOSE_SLOW:
        if (remaining <= tail || remaining <= p->fine_margin_mg) enter(c, DOSE_STOPPING, now);
        else {
            if (c->state == DOSE_FAST && remaining <= p->slow_margin_mg + tail) enter(c, DOSE_SLOW, now);
            c->output.pump_percent = c->state == DOSE_FAST ? p->fast_percent : p->slow_percent;
        }
        break;
    case DOSE_FINE:
    case DOSE_JOG:
        if (remaining <= step->tolerance_mg || now - c->entered_ms >= c->pulse_ms) enter(c, DOSE_STOPPING, now);
        else c->output.pump_percent = p->fine_percent;
        break;
    case DOSE_STOPPING:
        if (in->motors_off) { c->stopped_ms = now; enter(c, DOSE_SETTLING, now); }
        else if (now - c->entered_ms >= 500) finish(c, DOSE_ERROR, DOSE_ACTUATOR, now);
        break;
    case DOSE_SETTLING:
        if (now - c->entered_ms >= p->settle_timeout_ms) { finish(c, DOSE_ERROR, DOSE_TIMEOUT, now); break; }
        if (now - c->entered_ms < p->settle_min_ms || !settled(src, c->stopped_ms) || !settled(dst, c->stopped_ms) || dst->noise_mg > (uint32_t)step->tolerance_mg) break;
        c->delivered_mg = dst->stable_mg - c->vessel_start_mg;
        c->source_loss_mg = c->source_start_mg - src->stable_mg;
        remaining = (int64_t)step->target_mg - c->delivered_mg;
        if (remaining < -step->tolerance_mg) { finish(c, DOSE_ERROR, DOSE_OVERDOSE, now); break; }
        if (remaining > step->tolerance_mg) {
            if (c->jogs >= p->max_jogs) { finish(c, DOSE_ERROR, DOSE_UNDERDOSE, now); break; }
            int64_t pulse = c->flow_mg_s ? (remaining - step->tolerance_mg / 2) * 500 / c->flow_mg_s : p->pulse_min_ms;
            c->pulse_ms = pulse < p->pulse_min_ms ? p->pulse_min_ms : pulse > p->pulse_max_ms ? p->pulse_max_ms : (uint32_t)pulse;
            c->flow_ms = dst->sample_ms; c->flow_mass_mg = c->delivered_mg;
            c->flow_sequence = dst->sequence;
            enter(c, c->jogs ? DOSE_JOG : DOSE_FINE, now); c->jogs++;
            c->output.pump_percent = p->fine_percent;
        } else {
            int64_t residual = (int64_t)c->source_loss_mg - c->delivered_mg;
            if (residual < -p->balance_tolerance_mg || residual > p->residual_limit_mg + (int64_t)p->balance_tolerance_mg) {
                finish(c, DOSE_ERROR, DOSE_MASS_BALANCE, now); break;
            }
            c->dose_mg[c->step] = c->delivered_mg; c->loss_mg[c->step] = c->source_loss_mg;
            c->verified_mg = dst->stable_mg; c->purge_source_mg = src->stable_mg;
            c->output.route = DOSE_WASTE; enter(c, DOSE_ROUTE_WASTE, now);
        }
        break;
    case DOSE_ROUTE_WASTE:
        if (now - c->entered_ms >= p->route_ms) { enter(c, DOSE_PURGE, now); c->output.air_percent = p->air_percent; }
        break;
    case DOSE_PURGE:
        if (abs64((int64_t)dst->control_mg - c->verified_mg) > p->purge_leak_tolerance_mg) {
            finish(c, DOSE_ERROR, DOSE_WASTE_LEAK, now); break;
        }
        if (now - c->entered_ms >= p->purge_ms) { enter(c, DOSE_PURGE_SETTLE, now); c->stopped_ms = now; }
        break;
    case DOSE_PURGE_SETTLE:
        if (now - c->entered_ms >= p->settle_timeout_ms) { finish(c, DOSE_ERROR, DOSE_TIMEOUT, now); break; }
        if (!in->motors_off || now - c->entered_ms < p->settle_min_ms || !settled(src, c->stopped_ms) ||
            !settled(dst, c->stopped_ms) || dst->noise_mg > (uint32_t)step->tolerance_mg) break;
        if (abs64((int64_t)dst->stable_mg - c->verified_mg) > p->purge_leak_tolerance_mg ||
            abs64((int64_t)src->stable_mg - c->purge_source_mg) > p->balance_tolerance_mg) {
            finish(c, DOSE_ERROR, DOSE_WASTE_LEAK, now); break;
        }
        // 清液允许的重量变化不能覆盖配方容差；最终记录以清液后稳定重量为准。
        c->delivered_mg = dst->stable_mg - c->vessel_start_mg;
        c->source_loss_mg = c->source_start_mg - src->stable_mg;
        remaining = (int64_t)step->target_mg - c->delivered_mg;
        if (remaining > step->tolerance_mg || remaining < -step->tolerance_mg) {
            finish(c, DOSE_ERROR, remaining > 0 ? DOSE_UNDERDOSE : DOSE_OVERDOSE, now);
            break;
        }
        int64_t final_residual = (int64_t)c->source_loss_mg - c->delivered_mg;
        if (final_residual < -p->balance_tolerance_mg ||
            final_residual > (int64_t)p->residual_limit_mg + p->balance_tolerance_mg) {
            finish(c, DOSE_ERROR, DOSE_MASS_BALANCE, now);
            break;
        }
        c->dose_mg[c->step] = c->delivered_mg;
        c->loss_mg[c->step] = c->source_loss_mg;
        if (c->step + 1 < c->count) {
            if (!in->weights[c->steps[c->step + 1].channel].stable) break;
            ++c->step; begin_step(c, in);
        } else {
            int64_t expected = c->batch_start_mg, tolerance = 0;
            for (unsigned i = 0; i < c->count; ++i) { expected += c->steps[i].target_mg; tolerance += c->steps[i].tolerance_mg; }
            if (abs64((int64_t)dst->stable_mg - expected) > tolerance) finish(c, DOSE_ERROR, DOSE_MASS_BALANCE, now);
            else finish(c, DOSE_DONE, DOSE_OK, now);
        }
        break;
    default: break;
    }
}
const char *dosing_state_name(dosing_state_t s) {
    static const char *names[] = {"idle","precheck","route_vessel","fast","slow","fine","stopping","settling","jog","route_waste","purge","purge_settle","done","aborted","error"};
    return (unsigned)s < sizeof(names)/sizeof(names[0]) ? names[s] : "error";
}
const char *dosing_error_name(dosing_error_t e) {
    static const char *names[] = {"ok","bad_config","sensor_invalid","calibration_changed","timeout","no_flow","overdose","underdose","inventory_low","mass_balance","waste_leak","actuator_fault","cancelled","control_late","flow_limit"};
    return (unsigned)e < sizeof(names)/sizeof(names[0]) ? names[e] : "unknown";
}
