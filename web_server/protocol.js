class ApiError extends Error {
  constructor(status, code) { super(code); this.status = status; }
}
const requireValue = (condition, code = 'invalid_payload') => { if (!condition) throw new ApiError(400, code); };
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (v, min, max) => Number.isSafeInteger(v) && v >= min && v <= max;
const identifier = v => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(v);

/**
 * validateTelemetry：校验 schema 1 上报，不将缺失读数补成零。
 * 参数 body：解析后的 JSON；identity：凭据绑定身份。用于设备 POST；示例 validateTelemetry(body, device)。
 */
function validateTelemetry(body, identity) {
  requireValue(plain(body) && body.schema_version === 1, 'unsupported_schema');
  requireValue(body.device_id === identity.id, 'device_identity_mismatch');
  requireValue(identifier(body.boot_id) && integer(body.sequence, 0, Number.MAX_SAFE_INTEGER));
  requireValue(integer(body.uptime_ms, 0, Number.MAX_SAFE_INTEGER) && integer(body.sample_age_ms, 0, 60000));
  requireValue(typeof body.firmware === 'string' && body.firmware.length <= 64);
  requireValue(plain(body.capabilities) && plain(body.status));
  for (const key of ['telemetry', 'command_poll', 'weight', 'actuator', 'simulation', 'test_input']) requireValue(typeof body.capabilities[key] === 'boolean');
  requireValue(body.capabilities.simulation === identity.simulation, 'simulation_identity_mismatch');
  requireValue(body.capabilities.test_input === Boolean(identity.serial_test), 'serial_test_mode_mismatch');
  // 此阶段实机只有网络功能，阻止错误声明让页面开放硬件入口。
  requireValue(identity.simulation || (!body.capabilities.weight && !body.capabilities.actuator), 'hardware_not_supported');
  const s = body.status;
  requireValue(integer(s.upload_interval_ms, 200, 10000) && integer(s.config_version, 1, 2147483647));
  requireValue(integer(s.free_heap_bytes, 0, 100000000) && integer(s.wifi_rssi, -127, 0));
  requireValue(Array.isArray(s.channels) && s.channels.length === 9);
  s.channels.forEach((channel, index) => {
    requireValue(plain(channel) && channel.channel === index && typeof channel.valid === 'boolean');
    requireValue(integer(channel.age_ms, 0, 60000));
    for (const key of ['mass_mg', 'filtered_mg']) requireValue(channel[key] === null || integer(channel[key], -1000000000, 1000000000));
    requireValue(!channel.valid || (channel.mass_mg !== null && channel.filtered_mg !== null));
    requireValue(identity.simulation || identity.serial_test ||
      (!channel.valid && channel.mass_mg === null && channel.filtered_mg === null), 'hardware_data_not_supported');
  });
  requireValue(plain(s.actuator) && integer(s.actuator.channel, 0, 7) && Number.isFinite(s.actuator.applied_percent) && s.actuator.applied_percent >= 0 && s.actuator.applied_percent <= 100);
  requireValue(identity.simulation || s.actuator.applied_percent === 0, 'hardware_not_supported');
  return body;
}

/** validateCommand：将网页请求限制为网络诊断、上报周期和模拟控制；body 为请求，device 为服务快照。 */
function validateCommand(body, device) {
  requireValue(plain(body) && body.schema_version === 1 && identifier(body.request_id), 'unsupported_schema');
  requireValue(['ping', 'set_upload_interval', 'debug_apply', 'stop'].includes(body.type), 'unsupported_command');
  requireValue(plain(body.payload));
  // 设备轮询响应只有 2 KiB 缓冲；只接受已声明字段，避免未知大字段阻塞整个命令队列。
  const fields = { ping: [], stop: [], set_upload_interval: ['interval_ms', 'expected_config_version'], debug_apply: ['channel', 'value_percent', 'session_id'] };
  requireValue(Object.keys(body.payload).every(key => fields[body.type].includes(key)));
  if (!device.online) throw new ApiError(409, 'device_offline');
  if (!device.capabilities.command_poll) throw new ApiError(409, 'command_not_supported');
  if (body.type === 'set_upload_interval') {
    requireValue(integer(body.payload.interval_ms, 200, 10000));
    requireValue(integer(body.payload.expected_config_version, 1, 2147483647));
    if (body.payload.expected_config_version !== device.status.config_version) throw new ApiError(409, 'config_version_conflict');
  }
  if (body.type === 'debug_apply' || body.type === 'stop') {
    if (!device.simulation || !device.capabilities.actuator) throw new ApiError(409, 'hardware_not_supported');
    if (body.type === 'debug_apply') {
      requireValue(integer(body.payload.channel, 0, 7) && integer(body.payload.value_percent, 0, 100));
      requireValue(identifier(body.payload.session_id));
    }
  }
  return body;
}
module.exports = { ApiError, requireValue, plain, integer, identifier, validateTelemetry, validateCommand };
