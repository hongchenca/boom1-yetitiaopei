'use strict';

// 表单保存草稿；遥测只更新状态和设备已保存的位置，不覆盖正在编辑的配方。
(() => {
  let preparing = false;
  const doseLabels = {
    idle:'待机', precheck:'检查称重和库存', route_vessel:'切配液位置', fast:'快速加液',
    slow:'慢速加液', fine:'精加脉冲', jog:'补液脉冲', stopping:'停泵', settling:'等待稳定核验',
    route_waste:'切废液位置', purge:'吹气至废液口', purge_settle:'清液后核验',
    done:'完成', aborted:'已取消', error:'故障停止'
  };
  const doseErrors = {
    bad_config:'参数无效', sensor_invalid:'称重无效或过期', calibration_changed:'称重校准版本变化',
    timeout:'阶段或任务超时', no_flow:'累计启泵后重量未增加', overdose:'加液过量',
    underdose:'补液后仍不足', inventory_low:'原液库存不足', mass_balance:'源液损失与容器增重不符',
    waste_leak:'清液时容器或源液重量异常变化', actuator_fault:'输出驱动或租约故障',
    cancelled:'用户取消', control_late:'控制节拍超时', flow_limit:'实测流速超过设定上限'
  };
  Object.assign(errors, {
    dosing_busy:'配液任务运行中，请先取消', dosing_not_ready:'请校准相关秤并保存两个舵机位置',
    position_version_conflict:'舵机位置版本已变化，请等待新上报',
    invalid_dosing_config:'闭环参数范围或相互关系无效', duty_below_deadzone:'输出低于泵的有效死区'
  });

  // 单位转换只在表单边界完成；下发仍使用整数 mg / ms。
  const settingGroups = [
    ['输出与动作时间', [
      ['minimum_percent','液泵死区下限','%',1], ['fast_percent','快速输出','%',1],
      ['slow_percent','慢速输出','%',1], ['fine_percent','精加输出','%',1],
      ['air_percent','清液气泵输出','%',1], ['route_ms','舵机到位等待','ms',1],
      ['purge_ms','每步吹气时长','ms',1], ['pulse_min_ms','最短补液脉冲','ms',1],
      ['pulse_max_ms','最长补液脉冲','ms',1]
    ]],
    ['预停与质量核验', [
      ['slow_margin_mg','进入慢速的剩余量','g',1000], ['fine_margin_mg','进入精加的剩余量','g',1000],
      ['compensation_mg','固定预停补偿','g',1000], ['tail_ms','泵与管路尾流时间','ms',1],
      ['max_flow_mg_s','允许最大流速','g/s',1000], ['progress_mg','有效增重量','g',1000],
      ['residual_limit_mg','允许管路滞留量','g',1000], ['balance_tolerance_mg','质量差核验容差','g',1000],
      ['vessel_capacity_mg','容器可装液体净重','g',1000], ['purge_leak_tolerance_mg','清液时容器允许变化','g',1000]
    ]],
    ['稳定与超时', [
      ['settle_min_ms','停泵后最少等待','ms',1], ['settle_timeout_ms','单次判稳超时','ms',1],
      ['no_flow_ms','无进展累计启泵时限','ms',1], ['max_jogs','最多补液次数','次',1],
      ['step_timeout_ms','每步总时限','ms',1], ['total_timeout_ms','整批总时限','ms',1]
    ]]
  ];

  function numberField(label, value, min, max, step = 1) {
    const field = document.createElement('label');
    field.textContent = label;
    const input = document.createElement('input');
    Object.assign(input, {type:'number', value, min, max, step, required:true});
    field.append(input);
    return field;
  }

  for (const [title, settings] of settingGroups) {
    const group = document.createElement('fieldset');
    group.className = 'dose-settings-group';
    const legend = document.createElement('legend');
    legend.textContent = title;
    const fields = document.createElement('div');
    fields.className = 'dose-settings-fields';
    for (const [key, label, unit, factor] of settings) {
      const [min, max] = DosingConfig.ranges[key];
      const field = numberField(`${label} · ${unit}`, DosingConfig.defaults[key] / factor,
        min / factor, max / factor, 1 / factor);
      field.querySelector('input').dataset.setting = key;
      fields.append(field);
    }
    group.append(legend, fields);
    $('#dose-settings').append(group);
  }

  function readConfig() {
    const config = {version:DosingConfig.defaults.version};
    for (const [, settings] of settingGroups) {
      for (const [key, , , factor] of settings) {
        config[key] = Math.round(Number($(`[data-setting="${key}"]`).value) * factor);
      }
    }
    return config;
  }

  function readSteps() {
    return [...document.querySelectorAll('#dose-steps .dose-step')].map(row => ({
      channel:Number(row.querySelector('select').value),
      target_mg:Math.round(Number(row.querySelector('[data-target]').value) * 1000),
      tolerance_mg:Math.round(Number(row.querySelector('[data-tolerance]').value) * 1000)
    }));
  }

  function appendStep(step) {
    const row = document.createElement('div');
    row.className = 'dose-step';
    const channelLabel = document.createElement('label');
    channelLabel.textContent = '原液通道';
    const channel = document.createElement('select');
    for (let i = 0; i < 8; i++) channel.add(new Option(`${names[i]} · CH${i}`, i));
    channel.value = step.channel;
    channelLabel.append(channel);
    const target = numberField('目标重量 · g', step.target_mg / 1000, 0.002, 100000, 0.001);
    const tolerance = numberField('允许误差 · ±g', step.tolerance_mg / 1000, 0.001, 10000, 0.001);
    target.querySelector('input').dataset.target = '';
    tolerance.querySelector('input').dataset.tolerance = '';
    const remove = document.createElement('button');
    remove.className = 'ghost';
    remove.textContent = '移除';
    remove.onclick = () => { row.remove(); markDraft(); };
    row.append(channelLabel, target, tolerance, remove);
    $('#dose-steps').append(row);
  }

  function markDraft() {
    $('#dose-confirm').checked = false;
    text('#dose-recipe-name', '临时配方 · 最多 8 步，按顺序逐路加液。');
    renderOutlet();
  }

  function formProblem() {
    const fields = document.querySelectorAll('#dose-steps input, #dose-settings input');
    if ([...fields].some(input => !input.validity.valid)) return '请填写完整，并核对各参数的允许范围。';
    const steps = readSteps(), config = readConfig();
    if (steps.some(step => step.tolerance_mg >= step.target_mg)) return '每步允许误差必须小于目标重量。';
    if (!DosingConfig.valid(config)) return '请核对：死区 ≤ 精加 ≤ 慢速 ≤ 快速；稳定与任务时限须递增，最短脉冲 ≤ 最长脉冲。';
    if (steps.reduce((sum, step) => sum + step.target_mg + step.tolerance_mg, 0) > config.vessel_capacity_mg)
      return '目标总量加容差超过容器容量。';
    const a = state.device?.status?.actuator;
    if (a && (config.minimum_percent < a.minimum_percent || config.fast_percent > a.maximum_percent || config.air_percent > a.maximum_percent))
      return '闭环输出超出设备上报的死区或最大输出限制。';
    return '';
  }

  function controlProblem() {
    const d = state.device;
    if (!state.active || !deviceOnline()) return '等待设备在线。';
    if (!['admin','engineer','operator'].includes(state.role)) return '当前账号仅可查看。';
    if (!d?.actuator_enabled || !d?.capabilities?.command_poll) return '此设备尚未启用输出控制。';
    if (!d.status?.actuator?.auxiliaries_supported) return '请烧录支持 CH8 / CH9 的 50 Hz 固件。';
    if (d.status.actuator.fault_latched) return '输出故障已锁存，请先排查设备。';
    if (d.status.dosing?.active) return '配液任务运行中。';
    if (state.busy || state.stopBusy || state.pumpRequests.size || preparing) return '正在等待设备确认…';
    return '';
  }

  function renderOutlet() {
    const d = state.device, a = d?.status?.actuator, dose = d?.status?.dosing;
    const identity = d ? `${d.id}:${d.boot_id}:${dose?.position_version}` : '';
    if ($('#outlet-panel').dataset.identity !== identity) {
      $('#outlet-panel').dataset.identity = identity;
      $('#servo-vessel').value = dose?.vessel_us || '';
      $('#servo-waste').value = dose?.waste_us || '';
      $('#dose-confirm').checked = false;
    }
    const reason = controlProblem(), locked = Boolean(reason);
    const motorsOn = Boolean(a?.air_percent || a?.duty_percent?.some(value => value > 0));
    for (const input of document.querySelectorAll('#outlet-panel input, #dosing-panel input, #dosing-panel select')) input.disabled = locked;
    for (const id of ['servo-test','servo-minus','servo-plus','servo-go-vessel','servo-go-waste'])
      $('#' + id).disabled = locked || motorsOn || (id.startsWith('servo-go') && !dose?.positions_saved);
    for (const id of ['servo-mark-vessel','servo-mark-waste']) $('#' + id).disabled = locked || motorsOn || !a?.servo_pulse_us;
    $('#air-test').disabled = locked || Boolean(a?.duty_percent?.some(value => value > 0));
    const vessel = Number($('#servo-vessel').value), waste = Number($('#servo-waste').value);
    const positionsValid = vessel >= 500 && vessel <= 2500 && waste >= 500 && waste <= 2500 && vessel !== waste;
    $('#outlet-save').disabled = locked || pumpsRunning() || !positionsValid;
    text('#outlet-save-hint', !positionsValid ? '请分别试好并记录两个不同的位置。' : pumpsRunning() ?
      '已记录到草稿。停止输出或等待测试结束后，可保存到设备。' : '可保存到设备；保存不会驱动舵机。');
    $('#dose-use-recipe').disabled = locked;
    const count = $('#dose-steps').children.length;
    $('#dose-add-step').disabled = locked || count >= 8;
    for (const button of document.querySelectorAll('#dose-steps button')) button.disabled = locked || count <= 1;

    let readiness = reason || (!dose?.supported ? '等待支持闭环的固件。' : !dose.positions_saved ? '请先保存两个舵机位置。' : pumpsRunning() ? '请先停止所有调试输出。' : formProblem());
    if (!readiness) {
      if (!d.weight_enabled || !d.capabilities.weight) readiness = '请先启用称重。';
      else {
        const pending = [...new Set([8, ...readSteps().map(step => step.channel)])]
          .filter(channel => {
            const weight = d.status.channels[channel];
            return !weight?.valid || !weight.stable || weight.age_ms + deviceAge() > 500;
          });
        if (pending.length) readiness = `${pending.map(channel => names[channel]).join('、')}：等待有效稳定读数。`;
      }
    }
    $('#dose-start').disabled = Boolean(readiness) || !$('#dose-confirm').checked;
    text('#dose-ready', readiness || ($('#dose-confirm').checked ? '条件就绪，可开始配液。' : '请核对配方、流路及称重后勾选下方确认。'));
    for (const id of ['outlet-stop','dose-stop']) $('#' + id).disabled = !state.active || !deviceOnline() ||
      !d?.actuator_enabled || !['admin','engineer','operator'].includes(state.role) || state.stopBusy;
    text('#outlet-status', reason || `气泵 ${a.air_percent}% · 舵机 ${a.servo_pulse_us ? a.servo_pulse_us + ' µs' : '无信号'} · ${dose?.positions_saved ? '位置已保存 v' + dose.position_version : '位置未保存'}`);
    text('#dosing-status', !dose?.supported ? '等待设备上报闭环状态' :
      `${deviceOnline() ? '当前' : '最后记录'}：${doseLabels[dose.state] || dose.state} · 步骤 ${dose.step_count ? dose.step + 1 : 0}/${dose.step_count}` +
      ` · 容器增重 ${mass(dose.delivered_mg)} · 源液减少 ${mass(dose.source_loss_mg)} · 补液 ${dose.jogs} 次` +
      (dose.error !== 'ok' ? ` · ${doseErrors[dose.error] || dose.error}` : '') +
      (dose.state === 'done' ? ` · 各步实配 ${dose.dose_mg.map(mass).join(' / ')}` : ''));
  }

  function setPulse(value) {
    const pulse = Math.max(500, Math.min(2500, Math.round(value)));
    if (!Number.isFinite(pulse)) return;
    $('#servo-pulse').value = pulse;
    $('#servo-slider').value = pulse;
  }

  async function testAux(channel, pulse) {
    const input = $(channel === 9 ? '#servo-pulse' : '#air-duty');
    if (controlProblem() || !input.reportValidity()) return;
    if (channel === 8 && !confirm('确认出口已通向废液口后，开始最多 5 秒吹气测试。')) return;
    const value = channel === 9 ? pulse ?? Number(input.value) : Number(input.value);
    const identity = {id:state.selected, boot:state.device.boot_id, epoch:state.epoch,
      stop:state.stopGeneration, selection:state.selectionVersion};
    const current = () => identity.id === state.selected && identity.boot === state.device?.boot_id &&
      identity.epoch === state.epoch && identity.stop === state.stopGeneration && identity.selection === state.selectionVersion;
    preparing = true;
    renderOutlet();
    try {
      const session = await api(`devices/${identity.id}/debug-sessions`, {});
      if (!current()) return;
      preparing = false;
      await execute('aux_apply', {channel, ...(channel === 9 ? {pulse_us:value} : {value_percent:value}),
        session_id:session.session_id, expected_config_version:state.device.status.actuator.config_version}, $('#outlet-result'));
    } catch (error) {
      if (current()) text('#outlet-result', '未确认：' + explain(error));
    } finally {
      preparing = false;
      renderOutlet();
    }
  }

  $('#servo-slider').oninput = event => setPulse(Number(event.target.value));
  $('#servo-pulse').oninput = event => { if (event.target.validity.valid) $('#servo-slider').value = event.target.value; };
  $('#servo-minus').onclick = () => setPulse(Number($('#servo-pulse').value) - 10);
  $('#servo-plus').onclick = () => setPulse(Number($('#servo-pulse').value) + 10);
  $('#servo-test').onclick = () => testAux(9);
  $('#air-test').onclick = () => testAux(8);
  for (const position of ['vessel','waste']) {
    $('#servo-mark-' + position).onclick = () => {
      // 记录设备实际上报的指令值，不把尚未发送的滑块草稿当成已测试位置。
      const pulse = state.device?.status?.actuator?.servo_pulse_us;
      if (!pulse || controlProblem()) return;
      $('#servo-' + position).value = pulse;
      renderOutlet();
    };
    $('#servo-go-' + position).onclick = () => {
      const pulse = state.device?.status?.dosing?.[position + '_us'];
      if (pulse) { setPulse(pulse); testAux(9, pulse); }
    };
  }
  $('#outlet-stop').onclick = () => execute('stop', {}, $('#outlet-result'));
  $('#dose-stop').onclick = () => execute('stop', {}, $('#dose-result'));
  $('#outlet-save').onclick = () => {
    if ($('#outlet-save').disabled) return;
    execute('outlet_configure', {vessel_us:Number($('#servo-vessel').value), waste_us:Number($('#servo-waste').value),
      expected_position_version:state.device.status.dosing.position_version}, $('#outlet-result'));
  };
  $('#dose-confirm').onchange = renderOutlet;
  $('#dose-steps').oninput = $('#dose-settings').oninput = markDraft;
  $('#dose-add-step').onclick = () => { appendStep({channel:0, target_mg:10000, tolerance_mg:500}); markDraft(); };
  $('#dose-use-recipe').onclick = () => {
    if (!C.selected?.version || !C.selected.enabled || recipeDirty()) {
      text('#dose-result', '请先在配方管理中选择并保存启用的配方。');
      return;
    }
    $('#dose-steps').replaceChildren();
    C.selected.steps.forEach(appendStep);
    const settle = $('[data-setting="settle_min_ms"]');
    settle.value = Math.max(Number(settle.value), ...C.selected.steps.map(step => step.settle_ms));
    markDraft();
    text('#dose-recipe-name', `已载入 ${C.selected.name} v${C.selected.version} · 后续编辑只影响本次配液。`);
  };
  $('#dose-start').onclick = () => {
    renderOutlet();
    if ($('#dose-start').disabled) return;
    if (!confirm('开始当前配方？断网后设备仍自主控制，取消请使用“取消并全停”。')) return;
    execute('dosing_start', {steps:readSteps(), config:readConfig(),
      expected_position_version:state.device.status.dosing.position_version}, $('#dose-result'));
    $('#dose-confirm').checked = false;
  };
  appendStep({channel:0, target_mg:10000, tolerance_mg:500});
  window.renderOutlet = renderOutlet;
  renderOutlet();
})();
