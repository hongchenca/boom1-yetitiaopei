const crypto = require('node:crypto');
const { setTimeout: sleep } = require('node:timers/promises');

/**
 * startSimulator：经相同 HTTP 鉴权、遥测、轮询和回执接口模拟一台设备。
 * 参数 origin：后台根 URL（含子路径）；identity：只用于模拟器的凭据。
 * 用于本机页面联调；示例 startSimulator(origin, config.simDevice)。返回 stop()。
 */
function startSimulator(origin, identity, batchSnapshot = () => null) {
  const abort = new AbortController(), started = Date.now(), boot = crypto.randomUUID();
  let interval = 1000, version = 1, sequence = 0, duty = 0, channel = 0, outputDeadline = 0, stopTimer;
  const ackCache = new Map();
  const headers = { 'Content-Type': 'application/json', 'X-Device-Id': identity.id, 'X-Device-Token': identity.token };
  const uptime = () => Date.now() - started;
  const post = async (path, data, timeout = 5000) => {
    const response = await fetch(origin + '/api/v1/device' + path, { method: 'POST', headers, body: JSON.stringify(data), signal: AbortSignal.any([abort.signal, AbortSignal.timeout(timeout)]) });
    if (!response.ok) throw new Error(`sim_http_${response.status}`);
    return response.json();
  };
  const envelope = () => ({ schema_version: 1, device_id: identity.id, boot_id: boot });
  const delay = ms => sleep(ms, undefined, { signal: abort.signal });
  async function telemetry() {
    let announced = false;
    while (!abort.signal.aborted) {
      try {
        if (Date.now() >= outputDeadline) duty = 0;
        const batch = batchSnapshot();
        const channels = Array.from({ length: 9 }, (_, i) => {
          const offset = i === 8 ? 20000 : 400000 + i * 7500;
          const filtered = batch ? batch.masses[i] : Math.round(offset + Math.sin(uptime()/4000+i)*500);
          return { channel: i, mass_mg: filtered + (batch ? 0 : Math.round(Math.sin(uptime()/300)*70)), filtered_mg: filtered, valid: true, stable: duty === 0 && !batch?.active, age_ms: 0 };
        });
        await post('/telemetry', { ...envelope(), sequence: sequence++, uptime_ms: uptime(), firmware: 'simulator-0.2.0', sample_age_ms: 0,
          capabilities: { telemetry: true, events: true, command_poll: true, simulation: true, test_input: false, weight: true, actuator: true },
          status: { upload_interval_ms: interval, config_version: version, free_heap_bytes: 190000, wifi_rssi: -42, channels,
            actuator: { channel:batch?.active ? batch.channel:channel, requested_percent:batch?.active ? batch.duty:duty, applied_percent:batch?.active ? batch.duty:duty, output: 'simulated' }, task_state:batch?.active ? batch.state : duty ? 'debug' : 'idle' } });
        if (!announced) { await post('/events', { ...envelope(), event_id: `boot-${boot}`, type: 'boot', payload: { firmware: 'simulator-0.2.0' } }); announced = true; }
      } catch { if (!abort.signal.aborted) await delay(1000); }
      await delay(interval);
    }
  }
  async function commands() {
    while (!abort.signal.aborted) {
      try {
        const { command: c } = await post('/commands/poll', { ...envelope(), wait_ms: 25000 }, 30000);
        if (!c) continue;
        let ack = ackCache.get(c.id);
        if (!ack) {
          let status = 'completed', result = { ok: true };
          if (c.boot_id !== boot || c.deadline_uptime_ms < uptime()) { status = 'rejected'; result = { reason: 'expired_or_old_boot' }; }
          else if (c.type === 'set_upload_interval') {
            if (c.payload.expected_config_version !== version) { status = 'rejected'; result = { reason: 'config_version_conflict' }; }
            else { interval = c.payload.interval_ms; version++; result = { applied_interval_ms: interval, applied_config_version: version }; }
          } else if (c.type === 'debug_apply') {
            channel = c.payload.channel; duty = c.payload.value_percent;
            clearTimeout(stopTimer); stopTimer = setTimeout(() => { duty = 0; }, 5000);
            outputDeadline = Date.now() + 5000; result = { applied_value_percent: duty, maximum_run_ms: 5000 };
          } else if (c.type === 'stop') { clearTimeout(stopTimer); duty = 0; outputDeadline = 0; result = { applied_value_percent: 0 }; }
          else if (c.type !== 'ping') { status = 'rejected'; result = { reason: 'unsupported_command' }; }
          ack = { ...envelope(), status, result }; ackCache.set(c.id, ack);
          if (ackCache.size > 32) ackCache.delete(ackCache.keys().next().value);
        }
        await post(`/commands/${c.id}/ack`, ack);
      } catch { if (!abort.signal.aborted) await delay(1000); }
    }
  }
  telemetry().catch(() => {}); commands().catch(() => {});
  return { stop: () => { clearTimeout(stopTimer); abort.abort(); } };
}
module.exports = { startSimulator };
