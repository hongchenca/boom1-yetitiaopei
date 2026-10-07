class ApiError extends Error {
  constructor(status, code) { super(code); this.status = status; }
}
const dosingConfig = require('./public/dosing-config');
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
  requireValue(!body.capabilities.simulation && !body.capabilities.test_input, 'real_device_required');
  // 实机泵功能需服务端按设备显式开放，不能仅凭设备自报获得控制权限。
  requireValue(((!body.capabilities.weight || identity.weight === true) &&
    (!body.capabilities.actuator || identity.actuator === true)), 'hardware_not_supported');
  const s = body.status;
  requireValue(integer(s.upload_interval_ms, 200, 10000) && integer(s.config_version, 1, 2147483647));
  requireValue(integer(s.free_heap_bytes, 0, 100000000) && integer(s.wifi_rssi, -127, 0));
  if (s.weight_service_version !== undefined) requireValue(s.weight_service_version === 2, 'unsupported_weight_service');
  if (s.last_http_ms !== undefined) requireValue(integer(s.last_http_ms,0,4294967295));
  requireValue(Array.isArray(s.channels) && s.channels.length === 9);
  s.channels.forEach((channel, index) => {
    requireValue(plain(channel) && channel.channel === index && typeof channel.valid === 'boolean');
    requireValue(integer(channel.age_ms, 0, 60000));
    for (const key of ['mass_mg', 'filtered_mg']) requireValue(channel[key] === null || integer(channel[key], -1000000000, 1000000000));
    requireValue(!channel.valid || (channel.mass_mg !== null && channel.filtered_mg !== null));
    const modern = s.weight_service_version === 2;
    if (modern) requireValue(typeof channel.enabled === 'boolean');
    const hardwareWeight = identity.weight === true && body.capabilities.weight &&
      (modern ? channel.enabled === true : index === 0);
    requireValue(hardwareWeight ||
      (!channel.valid && channel.mass_mg === null && channel.filtered_mg === null), 'hardware_data_not_supported');
    if (hardwareWeight) {
      requireValue(typeof channel.calibrated === 'boolean' && typeof channel.tare_ready === 'boolean');
      requireValue(integer(channel.calibration_version, 1, 2147483647) && integer(channel.samples, 0, 16));
      requireValue(typeof channel.last_error === 'string' && channel.last_error.length <= 64);
      for (const key of ['raw_count', 'average_raw'])
        requireValue(channel[key] === null || integer(channel[key], -8388608, 8388607));
      requireValue(!channel.valid || (channel.calibrated && channel.raw_count !== null &&
        channel.average_raw !== null && channel.samples > 0 && channel.age_ms <= 500));
      requireValue(channel.valid || (channel.mass_mg === null && channel.filtered_mg === null));
      if (modern) {
        for (const key of ['initialized','calibration_ready','stable','saved']) requireValue(typeof channel[key] === 'boolean');
        requireValue(integer(channel.raw_band,1,100000) && integer(channel.noise_band_mg,1,10000));
        requireValue(integer(channel.noise_mg,0,4294967295) && integer(channel.sample_period_ms,0,4294967295) && integer(channel.sample_sequence,0,4294967295));
        requireValue(typeof channel.storage_error === 'string' && channel.storage_error.length <= 64);
        requireValue(!channel.valid || channel.initialized);
        requireValue(!channel.stable || channel.valid);
        requireValue(!channel.calibration_ready || (channel.raw_count !== null && channel.samples === 16 && channel.age_ms <= 500));
      }
    }
  });
  requireValue(plain(s.actuator) && integer(s.actuator.channel, 0, 7) && Number.isFinite(s.actuator.applied_percent) && s.actuator.applied_percent >= 0 && s.actuator.applied_percent <= 100);
  requireValue(body.capabilities.actuator || s.actuator.applied_percent === 0, 'hardware_not_supported');
  if (body.capabilities.actuator) {
    const a = s.actuator;
    requireValue(integer(a.config_version, 1, 2147483647) && integer(a.pwm_hz, 40, 1000));
    requireValue(integer(a.maximum_percent, 1, 100) && integer(a.remaining_ms, 0, 600000));
    if(a.minimum_percent!==undefined)requireValue(integer(a.minimum_percent,0,a.maximum_percent));
    if(a.auxiliaries_supported!==undefined)requireValue(typeof a.auxiliaries_supported==='boolean');
    if(a.auxiliaries_supported) {
      requireValue(a.pwm_hz===50 && integer(a.air_percent,0,a.maximum_percent));
      requireValue(a.servo_pulse_us===0 || integer(a.servo_pulse_us,500,2500));
      requireValue(integer(a.air_remaining_ms,0,600000) && integer(a.servo_remaining_ms,0,600000));
      requireValue(!(a.air_percent>0 && a.duty_percent?.some(v=>v>0)));
    }
    requireValue(typeof a.fault_latched === 'boolean' && typeof a.shutdown_failed === 'boolean' &&
      typeof a.registers_verified === 'boolean');
    requireValue(Array.isArray(a.duty_percent) && a.duty_percent.length === 8 &&
      a.duty_percent.every(v => integer(v, 0, a.maximum_percent)));
    if (a.parallel_supported !== undefined) requireValue(typeof a.parallel_supported === 'boolean');
    requireValue((a.parallel_supported === true || a.duty_percent.filter(v => v > 0).length <= 1) &&
      a.duty_percent[a.channel] === a.applied_percent);
    if (a.remaining_ms_by_channel !== undefined || a.parallel_supported === true)
      requireValue(Array.isArray(a.remaining_ms_by_channel) && a.remaining_ms_by_channel.length === 8 &&
        a.remaining_ms_by_channel.every(v => integer(v, 0, 600000)));
  }
  if(s.dosing!==undefined) {
    const d=s.dosing; requireValue(plain(d));
    for(const k of ['supported','active','positions_saved'])requireValue(typeof d[k]==='boolean');
    requireValue(!d.active || (d.supported && d.positions_saved && body.capabilities.actuator && body.capabilities.weight));
    requireValue(integer(d.position_version,0,2147483647) && integer(d.run_id,0,4294967295));
    requireValue(integer(d.vessel_us,0,2500) && integer(d.waste_us,0,2500));
    requireValue(!d.positions_saved || (d.position_version>0 && d.vessel_us>=500 && d.waste_us>=500 && d.vessel_us!==d.waste_us));
    requireValue(typeof d.state==='string' && d.state.length<=32 && typeof d.error==='string' && d.error.length<=64);
    requireValue(integer(d.step,0,7) && integer(d.step_count,0,8) && integer(d.jogs,0,100));
    requireValue(integer(d.delivered_mg,-2000000000,2000000000) && integer(d.source_loss_mg,-2000000000,2000000000) && integer(d.flow_mg_s,0,10000000));
    requireValue(Array.isArray(d.dose_mg) && d.dose_mg.length===d.step_count && d.dose_mg.every(v=>integer(v,-2000000000,2000000000)));
  }
  return body;
}

/** validateCommand：校验网络诊断与有界八路点动；body 为请求，device 含设备授权和上报快照。 */
function validateCommand(body, device) {
  requireValue(plain(body) && body.schema_version === 1 && identifier(body.request_id), 'unsupported_schema');
  requireValue(['ping', 'set_upload_interval', 'debug_apply', 'aux_apply', 'outlet_configure', 'dosing_start', 'stop', 'weight_tare', 'weight_calibrate', 'weight_reset', 'weight_configure'].includes(body.type), 'unsupported_command');
  requireValue(plain(body.payload));
  // 设备轮询响应只有 2 KiB 缓冲；只接受已声明字段，避免未知大字段阻塞整个命令队列。
  const fields = { ping: [], stop: ['channel'], set_upload_interval: ['interval_ms', 'expected_config_version'], debug_apply: ['channel', 'value_percent', 'session_id', 'expected_config_version'],
    weight_tare: ['channel', 'expected_calibration_version'], weight_calibrate: ['channel', 'expected_calibration_version', 'reference_mg'],
    weight_reset: ['channel','expected_calibration_version'], weight_configure: ['channel','expected_calibration_version','raw_band','noise_band_mg'],
    aux_apply:['channel','value_percent','pulse_us','session_id','expected_config_version'],
    outlet_configure:['vessel_us','waste_us','expected_position_version'], dosing_start:['steps','config','expected_position_version'] };
  requireValue(Object.keys(body.payload).every(key => fields[body.type].includes(key)));
  if (!device.online) throw new ApiError(409, 'device_offline');
  if (!device.capabilities.command_poll) throw new ApiError(409, 'command_not_supported');
  const a=device.status.actuator, dose=device.status.dosing;
  const moving=a.applied_percent>0 || a.duty_percent?.some(v=>v>0) || a.air_percent>0 || a.servo_pulse_us>0;
  if(dose?.active && !['stop','ping','set_upload_interval'].includes(body.type))throw new ApiError(409,'dosing_busy');
  if(['aux_apply','outlet_configure','dosing_start'].includes(body.type)) {
    if(!device.actuator_enabled || !device.capabilities.actuator || !a.auxiliaries_supported)throw new ApiError(409,'firmware_upgrade_required');
    if(a.fault_latched)throw new ApiError(409,'actuator_fault_latched');
    const p=body.payload;
    if(body.type==='aux_apply') {
      requireValue(integer(p.channel,8,9) && identifier(p.session_id) && p.expected_config_version===a.config_version);
      if(p.channel===8) {
        requireValue(integer(p.value_percent,0,a.maximum_percent) && p.pulse_us===undefined);
        if(p.value_percent && a.duty_percent.some(v=>v>0))throw new ApiError(409,'pump_busy');
      } else {
        requireValue(integer(p.pulse_us,500,2500) && p.value_percent===undefined);
        if(a.duty_percent.some(v=>v>0) || a.air_percent>0)throw new ApiError(409,'pump_busy');
      }
    } else {
      if(!dose?.supported)throw new ApiError(409,'firmware_upgrade_required');
      if(moving)throw new ApiError(409,'pump_busy');
      requireValue(integer(p.expected_position_version,1,2147483646));
      if(p.expected_position_version!==dose.position_version)throw new ApiError(409,'position_version_conflict');
      if(body.type==='outlet_configure')requireValue(integer(p.vessel_us,500,2500) && integer(p.waste_us,500,2500) && p.vessel_us!==p.waste_us);
      else {
        if(!device.weight_enabled || !device.capabilities.weight || !dose.positions_saved)throw new ApiError(409,'dosing_not_ready');
        requireValue(dosingConfig.valid(p.config),'invalid_dosing_config');
        requireValue(p.config.minimum_percent>=a.minimum_percent && p.config.fast_percent<=a.maximum_percent && p.config.air_percent<=a.maximum_percent,'duty_limit_exceeded');
        requireValue(Array.isArray(p.steps) && p.steps.length>=1 && p.steps.length<=8);
        let total=0;
        for(const step of p.steps) {
          requireValue(plain(step) && Object.keys(step).length===3 && integer(step.channel,0,7) && integer(step.target_mg,1,100000000) && integer(step.tolerance_mg,1,Math.min(10000000,step.target_mg-1)));
          total+=step.target_mg+step.tolerance_mg;
        }
        requireValue(total<=p.config.vessel_capacity_mg,'invalid_dosing_config');
        for(const ch of new Set([8,...p.steps.map(s=>s.channel)])) {
          const w=device.status.channels[ch];
          if(!w?.valid || !w.stable || w.age_ms+(device.age_ms||0)>500)throw new ApiError(409,'weight_not_ready');
        }
      }
    }
  }
  if (body.type.startsWith('weight_')) {
    if (device.simulation || !device.weight_enabled || !device.capabilities.weight) throw new ApiError(409, 'hardware_not_supported');
    requireValue(integer(body.payload.channel,0,8) && integer(body.payload.expected_calibration_version, 1, 2147483647));
    const modern = device.status.weight_service_version === 2;
    if (!modern && (body.payload.channel !== 0 || ['weight_reset','weight_configure'].includes(body.type))) throw new ApiError(409,'firmware_upgrade_required');
    const scale = device.status.channels[body.payload.channel];
    if (modern && (!scale.enabled || !scale.initialized)) throw new ApiError(409,'weight_not_enabled');
    if (body.payload.expected_calibration_version !== scale.calibration_version) throw new ApiError(409, 'calibration_version_conflict');
    if (['weight_tare','weight_calibrate'].includes(body.type) &&
        (scale.raw_count === null || scale.samples !== 16 || scale.age_ms + (device.age_ms || 0) > 500 || (modern && !scale.calibration_ready))) throw new ApiError(409, 'weight_not_ready');
    if (moving) throw new ApiError(409, 'pump_busy');
    if (body.type === 'weight_calibrate') {
      requireValue(integer(body.payload.reference_mg, 1, 1000000000));
      if (!scale.tare_ready) throw new ApiError(409, 'weight_tare_required');
    }
    if (body.type === 'weight_configure') requireValue(integer(body.payload.raw_band,1,100000) && integer(body.payload.noise_band_mg,1,10000));
  }
  if (body.type === 'set_upload_interval') {
    requireValue(integer(body.payload.interval_ms, 200, 10000));
    requireValue(integer(body.payload.expected_config_version, 1, 2147483647));
    if (body.payload.expected_config_version !== device.status.config_version) throw new ApiError(409, 'config_version_conflict');
  }
  if (body.type === 'debug_apply' || body.type === 'stop') {
    if (!device.actuator_enabled || !device.capabilities.actuator) throw new ApiError(409, 'hardware_not_supported');
    if (body.type === 'stop' && body.payload.channel !== undefined) {
      requireValue(integer(body.payload.channel, 0, 7));
      if (device.status.actuator.parallel_supported !== true) throw new ApiError(409, 'firmware_upgrade_required');
    }
    if (body.type === 'debug_apply') {
      requireValue(integer(body.payload.channel, 0, 7) && integer(body.payload.value_percent, 0, 100));
      requireValue(identifier(body.payload.session_id));
      {
        const a = device.status.actuator;
        requireValue(integer(body.payload.expected_config_version, 1, 2147483647));
        if (body.payload.expected_config_version !== a.config_version) throw new ApiError(409, 'config_version_conflict');
        requireValue(body.payload.value_percent <= a.maximum_percent, 'duty_limit_exceeded');
        requireValue(body.payload.value_percent===0 || body.payload.value_percent >= (a.minimum_percent||0),'duty_below_deadzone');
        if(body.payload.value_percent>0 && a.air_percent>0)throw new ApiError(409,'pump_busy');
        if (body.payload.value_percent > 0 && a.fault_latched) throw new ApiError(409, 'actuator_fault_latched');
        if (body.payload.value_percent > 0 && a.parallel_supported !== true && a.applied_percent > 0 && a.channel !== body.payload.channel)
          throw new ApiError(409, 'pump_busy');
      }
    }
  }
  return body;
}
module.exports = { ApiError, requireValue, plain, integer, identifier, validateTelemetry, validateCommand };
