'use strict';
const $ = selector => document.querySelector(selector);
const apiRoot = new URL('./api/v1/', location.href);
const state = { devices: [], selected: null, device: null, history: [], stream: null, connected: false, busy: false, stopBusy: false, stopGeneration: 0, selectionVersion: 0, weightChannel: 0,
  pumpRequests: new Map(),
  active: false, epoch: 0, snapshotAt: 0, streamAt: 0, streamStarted: 0, fallbackBusy: false, retryAt: 0, retryDelay: 1000, transport: 'connecting', role: null, display: [] };
const weightFilter = new WeightDisplayFilter();
try { weightFilter.setMode(localStorage.getItem('yeti.weightDisplay') || 'balanced'); } catch {}
window.yetiState = state;
const text = (selector, value) => { $(selector).textContent = value; };
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const time = value => value ? new Date(value).toLocaleTimeString('zh-CN', { hour12: false }) : '—';
const mass = value => Number.isFinite(value) ? `${(value / 1000).toFixed(2)} g` : '—';
const names = ['原液 01','原液 02','原液 03','原液 04','原液 05','原液 06','原液 07','原液 08','中央容器'];
const errors = { login_required:'登录已过期，请重新登录', device_offline:'设备离线', hardware_not_supported:'当前实机尚未接入硬件控制', command_pending:'已有命令等待回执', config_version_conflict:'配置版本已变化，请按设备新值重新提交', debug_session_expired:'调试会话已失效', device_busy:'设备由另一操作页面占用', invalid_payload:'输入内容或范围无效', request_id_conflict:'请求编号发生冲突' };
const explain = error => error.name==='TimeoutError' ? '连接超时，请检查网络后重试' : error instanceof TypeError && /fetch/i.test(error.message) ? '暂时无法连接服务，请检查网络' : errors[error.message] || error.message;
Object.assign(errors, { duty_limit_exceeded:'超出设备允许的占空比', actuator_fault_latched:'执行器故障已锁存，请在设备端排除并确认', pump_busy:'另一通道正在运行，请先停止', stale_control_sequence:'控制命令已过期，请重新提交' });
Object.assign(errors, { weight_not_ready:'请等待读数稳定并核对砝码；砝码引起的计数变化需大于原始稳定范围的 5 倍', weight_tare_required:'请先空载去皮', calibration_version_conflict:'称重版本已变化，请等待新上报后重试', weight_not_enabled:'本路未启用或初始化失败', firmware_upgrade_required:'此操作需要烧录九路称重新固件' });
const uuid = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2,'0')).join('');

/** api：同源请求；path 为相对 API 路径，body 非空时 POST；用于页面读写，示例 api('devices')。 */
async function api(path, body) {
  const epoch = state.epoch;
  const response = await fetch(new URL(path, apiRoot), { method: body === undefined ? 'GET':'POST', credentials:'same-origin',
    headers: body === undefined ? {} : { 'Content-Type':'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(8000) });
  const data = await response.json();
  if (epoch !== state.epoch) throw new Error('session_changed');
  if (!response.ok) { if (response.status === 401 && path !== 'auth/login') showLogin(); throw new Error(data.error || `HTTP ${response.status}`); }
  return data;
}
window.yetiApi = api;
function showLogin() {
  ++state.epoch; ++state.selectionVersion; ++state.stopGeneration;
  state.active=false; state.busy=false; state.stopBusy=false;
  state.pumpRequests.clear();
  state.stream?.close(); state.stream = null; state.connected = false;
  state.device=null; state.devices=[]; state.history=[]; state.display=[]; weightFilter.reset();
  window.dispatchEvent(new CustomEvent('yeti:session',{detail:{active:false}}));
  $('#app').classList.add('hidden'); $('#login').classList.remove('hidden');
  $('#password').value = ''; $('#password').type = 'password';
  $('#password-toggle').textContent = '显示'; $('#password-toggle').setAttribute('aria-label', '显示密码'); $('#password-toggle').setAttribute('aria-pressed', 'false');
}

/** enter：登录后读取快照并订阅状态；无参数，用于登录/页面恢复，示例 await enter()。 */
async function enter() {
  const [{ devices }, account] = await Promise.all([api('devices'),api('auth/me')]);
  state.active=true; state.role=account.role; state.retryDelay=1000;
  state.devices = devices; $('#login').classList.add('hidden'); $('#app').classList.remove('hidden'); $('#password').value = '';
  $('#device-select').replaceChildren(...devices.map(d => new Option(d.name, d.id)));
  state.selected = devices.find(d => d.online)?.id || devices[0]?.id;
  $('#device-select').value = state.selected;
  state.connected = true; state.snapshotAt=performance.now();
  text('#account-state', `${account.username} · ${({admin:'管理员',engineer:'工程师',operator:'操作员',viewer:'只读'})[account.role] || account.role}`);
  connectStream();
  window.dispatchEvent(new CustomEvent('yeti:session',{detail:{active:true,role:account.role}}));
  await selectDevice().catch(error=>{if(state.active){text('#overview-result','历史记录暂不可用：'+explain(error));$('#overview-result').dataset.state='error';}});
}

/** selectDevice：切换时单独加载历史，版本号隔离旧请求；无参数，由设备选择器调用。 */
async function selectDevice() {
  const id = state.selected, version = ++state.selectionVersion;
  state.history = []; state.device = state.devices.find(d => d.id === id); weightFilter.reset(); state.display=[]; render();
  if (!id) return;
  const history = await api(`devices/${id}/history`);
  if (version !== state.selectionVersion) return;
  const merged = [...history,...state.history];
  state.history = [...new Map(merged.map(h=>[`${h.boot_id}:${h.sequence}`,h])).values()].sort((a,b)=>a.received_at-b.received_at).slice(-180);
  rebuildDisplay();
  $('#interval-input').value = state.device?.status?.upload_interval_ms || 200;
  text('#interval-result',''); text('#debug-result',''); text('#overview-result',''); text('#weight-result',''); render(); await loadEvents();
  window.dispatchEvent(new Event('yeti:device'));
}

/** acceptSnapshot：统一 SSE 和降级轮询入口；本地单调时间计算过期，不依赖两端时钟同步。 */
function acceptSnapshot(devices, transport) {
  // 断网前在途的 SSE/轮询响应不能重新开启页面控制。
  if (!state.active || navigator.onLine === false) return;
  state.connected=true; state.snapshotAt=performance.now(); state.transport=transport;
  state.devices=devices; state.retryDelay=1000;
  const d=devices.find(d=>d.id===state.selected);
  state.device=d || null;
  if (d?.status && d.online) {
    const last=state.history.at(-1);
    if (!last || last.boot_id!==d.boot_id || last.sequence!==d.sequence) {
      const h={received_at:d.received_at,boot_id:d.boot_id,sequence:d.sequence,status:d.status};
      h.display=filterSnapshot(h); state.display=h.display; state.history.push(h);
      if(state.history.length>180)state.history.shift();
    }
  }
  render();
}
function filterSnapshot(h) {
  return h.status.channels.map(c=>weightFilter.push(c,{device:state.selected,boot:h.boot_id,sequence:h.sequence,at:h.received_at,interval:h.status.upload_interval_ms}));
}
/** rebuildDisplay：加载历史或切换模式时重放原始快照，防止叠加滤波或跨设备混值。 */
function rebuildDisplay() {
  weightFilter.reset();
  for(const h of state.history)h.display=filterSnapshot(h);
  const d=state.device;
  state.display=d?.status ? filterSnapshot(d) : [];
}
function deviceAge() { return (state.device?.age_ms ?? Infinity)+Math.max(0,performance.now()-state.snapshotAt); }
function deviceOnline() { return Boolean(state.connected && state.device?.online && deviceAge()<Math.max(5000,(state.device.status?.upload_interval_ms || 200)*3)); }
function scaleFresh(scale) { return Boolean(deviceOnline() && scale && scale.age_ms+deviceAge()<=Math.max(1200,(state.device.status?.upload_interval_ms || 200)*3)); }
function pumpDuty(channel) {
  const a = state.device?.status?.actuator;
  return a?.duty_percent?.[channel] ?? (a?.channel === channel ? a.applied_percent : 0);
}
function pumpsRunning() { return Array.from({length:8}, (_, channel) => pumpDuty(channel)).some(value => value > 0) || state.device?.status?.actuator?.air_percent>0 || state.device?.status?.actuator?.servo_pulse_us>0 || state.device?.status?.dosing?.active; }

/** renderPumpCards：保留八路输入草稿；按设备遥测显示实际输出，每路独立禁用在途启动。 */
function renderPumpCards() {
  const grid = $('#pump-channel-grid'), d = state.device, a = d?.status?.actuator;
  const identity = `${d?.id || ''}:${d?.boot_id || ''}`;
  if (grid.children.length !== 8 || grid.dataset.identity !== identity) {
    state.pumpRequests.clear();
    grid.dataset.identity = identity;
    grid.innerHTML = Array.from({length:8}, (_, channel) => `<article class="pump-channel-card" data-channel="${channel}">
      <header><h4>泵 ${String(channel + 1).padStart(2, '0')}</h4><span class="pump-status">等待设备</span></header>
      <div class="pump-reading">—</div><div class="pump-timing">等待设备上报</div>
      <label class="pump-duty-label">设置输出 (%)<input type="number" min="0" max="100" step="1" value="${Math.min(Math.max(45,a?.minimum_percent||0), a?.maximum_percent ?? 100)}" required data-pump-duty></label>
      <label class="pump-slider-label"><input type="range" min="0" max="100" step="1" value="${Math.min(Math.max(45,a?.minimum_percent||0), a?.maximum_percent ?? 100)}" aria-label="泵 ${channel + 1} 输出百分比" data-pump-slider></label>
      <div class="pump-channel-actions"><button type="button" class="primary" data-pump-action="start">启动 / 更新</button><button type="button" class="danger" data-pump-action="stop">停止本路</button></div>
      <p class="pump-result result-line muted" role="status" aria-live="polite"></p></article>`).join('');
  }
  const available = Boolean(deviceOnline() && ['admin','engineer','operator'].includes(state.role) && d?.actuator_enabled && d.capabilities?.actuator && d.capabilities.command_poll);
  grid.querySelectorAll('.pump-channel-card').forEach(card => {
    const channel = Number(card.dataset.channel), duty = pumpDuty(channel), request = state.pumpRequests.get(channel);
    const pending = request?.selected === state.selected && request?.boot === d?.boot_id;
    const remaining = a?.remaining_ms_by_channel?.[channel] ?? (a?.channel === channel ? a.remaining_ms : 0);
    const secondsLeft = (Math.max(0, remaining - deviceAge()) / 1000).toFixed(1);
    card.dataset.state = a?.fault_latched ? 'fault' : !deviceOnline() ? 'offline' : duty > 0 ? 'running' : 'idle';
    card.querySelector('.pump-reading').textContent = a ? `${duty}%` : '—';
    card.querySelector('.pump-status').textContent = !available ? !deviceOnline() ? '设备离线' : '未接入 / 只读' : a?.fault_latched ? '故障锁存' : duty > 0 ? '运行中' : '已停止';
    card.querySelector('.pump-timing').textContent = !deviceOnline() ? '最后记录' : duty > 0 ? `剩余 ${secondsLeft} 秒` : `最大输出 ${a?.maximum_percent ?? 100}%`;
    card.querySelector('[data-pump-duty]').max = card.querySelector('[data-pump-slider]').max = a?.maximum_percent ?? 100;
    card.querySelector('[data-pump-duty]').min = card.querySelector('[data-pump-slider]').min = a?.minimum_percent || 0;
    card.querySelector('[data-pump-action="start"]').disabled = !available || state.busy || state.stopBusy || pending || Boolean(a?.fault_latched || d?.status?.dosing?.active || a?.air_percent>0);
    card.querySelector('[data-pump-action="stop"]').disabled = !available || state.stopBusy || (pending && request.stopping) || a?.parallel_supported !== true;
    card.querySelector('[data-pump-duty]').disabled = card.querySelector('[data-pump-slider]').disabled = !available;
  });
  text('#pump-control-hint', !d?.capabilities?.actuator ? '等待泵控制设备接入。' : a?.parallel_supported === true ? '可同时启动多路；停止本路不会影响其他泵。' : '当前设备为旧固件：烧录新版后可并发运行和逐路停止。');
}

// Calibration is intentionally rendered as one card per channel. The hidden select below
// remains only as a compatibility bridge for older automation and command handlers.
const calibrationNames = Array.from({length:9}, (_, i) => i === 8 ? 'CENTER 09' : `CH ${String(i + 1).padStart(2, '0')}`);
function calibrationStateLabel(scale, supported) {
  if (!supported) return '\u672a\u63a5\u5165';
  if (!scale) return '\u7b49\u5f85\u8bbe\u5907';
  if (scale.calibrated) return scale.saved ? '\u5df2\u6821\u51c6 \u00b7 \u5df2\u4fdd\u5b58' : '\u5df2\u6821\u51c6';
  if (scale.tare_ready) return '\u5df2\u53bb\u76ae \u00b7 \u653e\u781d\u7801';
  if (scale.raw_count == null) return '\u6682\u65e0\u8bfb\u6570';
  return scale.calibration_ready ? '\u8bfb\u6570\u7a33\u5b9a \u00b7 \u53ef\u53bb\u76ae' : '\u7b49\u5f85\u8bfb\u6570\u7a33\u5b9a';
}
function renderCalibrationCards() {
  const grid = $('#calibration-channel-grid');
  if (!grid) return;
  const d = state.device, status = d?.status, channels = status?.channels || [];
  const gridIdentity = `${d?.id || ''}:${d?.boot_id || ''}`;
  if (grid.children.length !== 9 || grid.dataset.identity !== gridIdentity) {
    grid.dataset.identity = gridIdentity;
    grid.innerHTML = calibrationNames.map((name, channel) => `<article class="calibration-channel-card" data-channel="${channel}">
      <header><strong>${name}</strong><span class="calibration-channel-status">\u7b49\u5f85\u8bbe\u5907</span></header>
      <div class="calibration-channel-reading">--</div><div class="calibration-channel-meta">--</div>
      <div class="calibration-channel-actions">
        <button type="button" class="secondary" data-calibration-action="tare">\u53bb\u76ae</button>
        <label class="calibration-reference">\u781d\u7801\u8d28\u91cf (g)<input type="number" min="0.001" max="1000000" step="0.001" placeholder="\u4f8b\u5982 100" data-calibration-reference required></label>
        <button type="button" class="primary" data-calibration-action="calibrate">\u781d\u7801\u6821\u51c6</button>
        <button type="button" class="danger" data-calibration-action="reset">\u6e05\u9664\u6821\u51c6</button>
        <p class="calibration-channel-result result-line muted" role="status"></p>
      </div></article>`).join('');
  }
  const online = deviceOnline(), canOperate = ['admin','engineer','operator'].includes(state.role), modern = status?.weight_service_version === 2;
  grid.querySelectorAll('.calibration-channel-card').forEach(card => {
    const channel = Number(card.dataset.channel), scale = channels[channel];
    const supported = Boolean(d?.capabilities?.weight && (modern ? scale?.enabled : channel === 0));
    const available = Boolean(online && canOperate && supported && d.weight_enabled && d.capabilities.command_poll && !state.busy && !state.stopBusy && !state.pumpRequests.size && !pumpsRunning() && scale?.initialized);
    const ready = Boolean(available && scale?.raw_count !== null && scale?.samples === 16 && scaleFresh(scale) && (!modern || scale.calibration_ready));
    const stateLabel = calibrationStateLabel(scale, supported);
    card.classList.toggle('selected', channel === state.weightChannel);
    card.dataset.state = !supported ? 'unsupported' : scale?.calibrated ? 'calibrated' : ready ? 'ready' : 'pending';
    card.querySelector('.calibration-channel-status').textContent = stateLabel;
    const reading = scale?.valid ? (state.display[channel] ?? scale.filtered_mg) : null;
    card.querySelector('.calibration-channel-reading').textContent = Number.isFinite(reading) ? `${(reading / 1000).toFixed(2)} g` : '--';
    card.querySelector('.calibration-channel-meta').textContent = !supported ? '\u56fa\u4ef6\u672a\u63a5\u5165\u6b64\u901a\u9053' : scale ? `${scale.saved ? '\u5df2\u4fdd\u5b58\u5230\u8bbe\u5907' : '\u5c1a\u672a\u4fdd\u5b58'} \u00b7 v${scale.calibration_version ?? 1}` : '\u7b49\u5f85\u9065\u6d4b\u6570\u636e';
    const tare = card.querySelector('[data-calibration-action="tare"]');
    const calibrate = card.querySelector('[data-calibration-action="calibrate"]');
    const reset = card.querySelector('[data-calibration-action="reset"]');
    tare.disabled = !ready; calibrate.disabled = !ready || !scale?.tare_ready; reset.disabled = !available || !modern;
    card.querySelector('[data-calibration-reference]').disabled = !ready || !scale?.tare_ready;
  });
}
function setWeightChannel(channel) {
  const value = Math.max(0, Math.min(8, Number(channel) || 0));
  state.weightChannel = value;
  const select = $('#weight-channel');
  if (select && select.value !== String(value)) { select.value = String(value); select.dispatchEvent(new Event('change')); }
  else render();
}

/** connectStream：单一实时连接；失败时仍以只读轮询恢复，写操作从不自动重放。 */
function connectStream() {
  if (!state.active) return;
  state.stream?.close();
  const epoch=state.epoch, stream = new EventSource(new URL('stream', apiRoot)); state.stream = stream;
  state.streamStarted=performance.now(); state.streamAt=0;
  stream.addEventListener('session-expired',()=>{if(epoch===state.epoch){showLogin();text('#login-error','登录已过期，请重新登录。');}});
  stream.addEventListener('snapshot', event => {
    if(epoch!==state.epoch || state.stream!==stream)return;
    try { const {devices}=JSON.parse(event.data); if(!Array.isArray(devices))throw new Error('invalid_snapshot');
      state.streamAt=performance.now(); acceptSnapshot(devices,'stream');
    } catch { stream.close(); state.connected=false; state.retryAt=0; render(); }
  });
  stream.onerror = () => {
    if(epoch!==state.epoch || state.stream!==stream)return;
    state.connected=false; state.transport='reconnecting'; state.retryAt=0; render(); recoverConnection();
  };
}

/** recoverConnection：串行只读回退，1～8 秒退避；401 结束会话，迟到响应不覆盖新 SSE。 */
async function recoverConnection() {
  if(!state.active || state.fallbackBusy || performance.now()<state.retryAt)return;
  // Chromium's offline emulation can leave localhost fetches available while
  // transport streams are already unusable. Respect the browser link state so
  // a successful local fallback cannot falsely report an online device.
  if (navigator.onLine === false) {
    state.connected = false; state.transport = 'reconnecting'; state.retryAt = performance.now() + 1000; render(); return;
  }
  state.fallbackBusy=true; const epoch=state.epoch, started=performance.now();
  try {
    const {devices}=await api('devices');
    if(epoch!==state.epoch || !state.active)return;
    if(state.streamAt<=started)acceptSnapshot(devices,'poll');
    if(!state.stream || state.stream.readyState===EventSource.CLOSED || performance.now()-Math.max(state.streamAt,state.streamStarted)>12000)connectStream();
    state.retryAt=performance.now()+2000;
  } catch(error) {
    if(epoch!==state.epoch)return;
    if(state.snapshotAt<=started) {state.connected=false;state.transport='reconnecting';render();}
    state.retryAt=performance.now()+state.retryDelay; state.retryDelay=Math.min(8000,state.retryDelay*2);
  } finally { state.fallbackBusy=false; }
}

/** render：只更新设备事实，不覆盖输入草稿；无参数，用于每个状态快照。 */
function render() {
  const d = state.device;
  renderCalibrationCards();
  renderPumpCards();
  if(typeof renderOutlet==='function')renderOutlet();
  const canOperate=['admin','engineer','operator'].includes(state.role);
  $('#server-state').className = `connection-dot ${state.connected ? 'online':'offline'}`;
  text('#server-state', state.connected ? state.transport==='poll' ? '轮询连接' : '服务已连接' : '正在重连');
  $('#reconnect').classList.toggle('hidden',state.connected);
  if (!d) {
    text('#notice', '尚未添加设备，请联系管理员连接设备。'); $('#notice').className = 'notice warn';
    for (const id of ['stop-top','stop-panel','stop-debug','apply-interval','ping','weight-tare','weight-calibrate','weight-configure','weight-reset']) $(`#${id}`).disabled = true;
    return;
  }
  const online = deviceOnline(), s = d.status, age=deviceAge();
  $('.device-picker').classList.toggle('online', online);
  text('#summary-online', `${state.connected ? state.devices.filter(d => d.online).length : '—'} / ${state.devices.length}`);
  const canControl = Boolean(d.capabilities?.actuator && d.actuator_enabled);
  text('#summary-mode', d.capabilities?.weight ? '实机称重' : canControl ? '八路泵控制' : '实机网络'); text('#summary-firmware', d.firmware);
  text('#summary-task', !online ? '离线' : s?.actuator?.fault_latched ? '执行器故障' :
    s?.dosing?.active ? '配液运行中' : s?.dosing?.state === 'error' ? '配液故障' :
    s?.actuator?.air_percent ? '清液气泵运行中' : s?.task_state === 'debug' ? '手动输出中' :
    s?.actuator?.servo_pulse_us ? '舵机输出中' : '待机');
  text('#summary-updated', `最后上报 ${time(d.received_at)}`);
  const scaleCount = s?.channels?.filter(c => c.enabled).length || (d.capabilities?.weight ? 1 : 0);
  text('#summary-capability', scaleCount ? `${scaleCount} 路称重` : canControl ? '8 路泵' : '网络通信');
  text('#summary-capability-note', canControl ? '八路泵控制已接入' : '泵控制未接入');
  text('#sample-age', d.age_ms == null ? '尚无上报' : age<1000 ? '实时更新' : `${(age/1000).toFixed(1)} 秒前`);
  text('#access-url', new URL('./', location.href).href);
  $('#notice').className = `notice ${online && state.transport!=='poll' ? 'info':'warn'}`;
  text('#notice', !state.connected ? '网页连接中断，正在自动重连。当前为最后记录。' : !online ? '设备上报中断，请检查设备供电与 Wi-Fi。当前为最后记录。' : state.transport==='poll' ? '实时连接恢复中，已切换为定时更新。' : '设备已连接');
  // 保留通道按钮节点，200 ms 遥测更新不打断键盘焦点与点击。
  if (!$('#channel-grid').children.length) {
    $('#channel-grid').innerHTML = names.slice(0,8).map((label,i) => `<button type="button" class="channel" data-channel="${i}"><span class="channel-main"><span class="channel-name">${label}</span><span class="channel-code">${String(i+1).padStart(2,'0')}</span></span><span class="channel-value">—</span><span class="channel-quality"></span><span class="channel-pump"></span></button>`).join('');
  }
  [...$('#channel-grid').children].forEach((node,i) => {
    const c = s?.channels[i], valid = c?.valid, fresh=scaleFresh(c), value = valid ? state.display[i] ?? c.filtered_mg : null;
    const duty = s?.actuator?.duty_percent?.[i] ?? (s?.actuator?.channel === i ? s.actuator.applied_percent : 0);
    const hardwareScale = d.capabilities.weight && (c?.enabled || (s?.weight_service_version !== 2 && i === 0));
    const measurement = !valid ? (hardwareScale ? c.raw_count == null ? '未收到称重信号' : '等待校准' : '未接入') : !fresh ? '最后记录 · 已过期' : c.stable ? '读数稳定' : '读数变化中';
    node.classList.toggle('stale', !fresh);
    node.dataset.quality = !valid ? hardwareScale && c.raw_count == null ? 'error' : 'pending' : c.stable ? 'stable' : 'changing';
    node.querySelector('.channel-value').textContent = value == null ? '—' : (value / 1000).toFixed(2);
    node.querySelector('.channel-quality').textContent = measurement;
    node.querySelector('.channel-pump').textContent = canControl ? `${online ? '泵输出' : '上次输出'} ${Number(duty)}%` : '泵未接入';
    node.setAttribute('aria-label', `${names[i]}，${mass(value)}，${measurement}，查看曲线`);
  });
  updateChartSelection();
  const center = s?.channels[8]; text('#center-mass', center?.valid ? mass(state.display[8] ?? center.filtered_mg):'—');
  text('#center-quality', !center?.valid ? '等待有效重量' : !scaleFresh(center) ? '最后记录' : center.stable ? '稳定' : '变化中');
  const a = s?.actuator;
  const activePumps = Array.from({length:8}, (_, channel) => pumpDuty(channel) > 0 ? `泵 ${String(channel + 1).padStart(2,'0')} ${pumpDuty(channel)}%` : null).filter(Boolean);
  if (a?.air_percent) activePumps.push(`气泵 ${a.air_percent}%`);
  if (a?.servo_pulse_us) activePumps.push(`舵机 ${a.servo_pulse_us} µs`);
  text('#actuator-state', a?.fault_latched ? `故障已锁存 · ${a.last_error}${a.shutdown_failed ? ' · 关断未确认' : ''}` : !a || !canControl ? '泵控制尚未接入' : `${activePumps.join(' · ') || '全部输出已停止'}${!online ? '（最后记录）':''}`);
  text('#debug-mode', canControl ? a?.parallel_supported ? '支持八路并发' : '实机输出' : '等待设备');
  text('#reported-interval', s ? `当前每 ${s.upload_interval_ms} ms 更新一次`:'等待设备上报');
  const labels = { telemetry:'遥测上传', events:'启动事件', command_poll:'命令回执', weight:'称重', actuator:'输出' };
  $('#capabilities').innerHTML = Object.entries(labels).map(([key,label]) => `<span class="capability ${d.capabilities[key] ? 'yes':''}"><i></i>${label} · ${d.capabilities[key] ? '支持':'未接入'}</span>`).join('');
  $('#device-select').disabled=state.busy || state.stopBusy || Boolean(state.pumpRequests.size);
  for (const id of ['stop-debug','stop-top','stop-panel']) $(`#${id}`).disabled = !online || !canOperate || !canControl || state.stopBusy;
  $('#apply-interval').disabled = $('#ping').disabled = !online || !canOperate || !d.capabilities.command_poll || state.busy || state.stopBusy || Boolean(state.pumpRequests.size);
  const channel = Number($('#weight-channel').value || state.weightChannel || 0);
  state.weightChannel = channel;
  const scale = s?.channels?.[channel];
  const formIdentity = `${d.id}:${d.boot_id}:${channel}`;
  if (scale && $('#weight-channel').dataset.formIdentity !== formIdentity) {
    $('#weight-channel').dataset.formIdentity = formIdentity;
    $('#weight-raw-band').value = scale.raw_band || 200;
    $('#weight-noise-band').value = scale.noise_band_mg || 50;
  }
  $('#weight-channel').disabled = state.busy || state.stopBusy;
  const modern = s?.weight_service_version === 2;
  const hasScale = d.capabilities.weight && (modern ? scale?.enabled : channel === 0);
  const sampleFresh = hasScale && scaleFresh(scale);
  text('#weight-raw', hasScale && scale.raw_count !== null ? `${scale.raw_count} counts · 校准平均 ${scale.average_raw} counts` : '等待称重数据');
  text('#weight-mass', hasScale && scale.valid ? `${mass(state.display[channel] ?? scale.filtered_mg)}${sampleFresh ? '' : '（最后记录）'}` : '—');
  text('#weight-device-reading', hasScale && scale.valid ? `原始重量 ${mass(scale.mass_mg)} · 设备显示 ${mass(scale.filtered_mg)}` +
    (scale.control_mg != null ? ` · 闭环快通道 ${mass(scale.control_mg)} · 稳定核验 ${scale.stable ? mass(scale.stable_mg) : '等待稳定'}` : '') : '暂无有效重量');
  text('#weight-state', !hasScale ? '本路未启用' : !online ? '设备离线' : scale.raw_count === null ? `读取失败 · ${scale.last_error}` : `${scale.calibrated ? '已校准' : scale.tare_ready ? '已去皮，等待砝码校准' : '未校准'} · ${scale.calibration_ready ? '可校准' : '等待稳定'}${scale.saved ? ' · 已保存到设备' : ''}${scale.storage_error && scale.storage_error !== 'ESP_OK' ? ' · 存储错误 ' + scale.storage_error : ''}`);
  text('#weight-latency', hasScale ? `采样间隔 ${scale.sample_period_ms ?? '—'} ms · 样本年龄 ${Math.min(60000, Math.round(scale.age_ms + age))} ms · 上次上传往返 ${s.last_http_ms ?? '—'} ms · Wi-Fi ${s.wifi_rssi} dBm${scale.calibrated ? ' · 窗口噪声 ' + (scale.noise_mg ?? '—') + ' mg' : ''}` : '');
  const available = online && canOperate && hasScale && d.weight_enabled && d.capabilities.command_poll &&
    !state.busy && !state.stopBusy && !state.pumpRequests.size && !pumpsRunning();
  const weightReady = available && scale.raw_count !== null && scale.samples === 16 &&
    scale.age_ms + age <= 500 && (!modern || scale.calibration_ready);
  $('#weight-tare').disabled = !weightReady;
  $('#weight-calibrate').disabled = !weightReady || !scale?.tare_ready;
  $('#weight-reset').disabled = $('#weight-configure').disabled = !available || !modern || !scale?.initialized;
  const hint=!canOperate ? '当前账号仅可查看。' : !online ? '连接恢复后可操作。' : !hasScale || scale.raw_count==null ? '请检查本路传感器供电和接线。' : pumpsRunning() ? '请先停止泵，再进行校准。' : state.busy || state.stopBusy || state.pumpRequests.size ? '正在等待设备确认…' : !weightReady ? `等待读数稳定${scale.noise_mg>scale.noise_band_mg ? `（当前波动 ${(scale.noise_mg/1000).toFixed(2)} g）` : ''}。` : !scale.tare_ready ? '空载稳定，可进行去皮。' : '读数稳定，可进行校准。';
  text('#weight-action-hint',hint);
  drawChart();
}

function currentPumpRequest(request) {
  return state.active && state.epoch === request.epoch && state.selected === request.selected && state.selectionVersion === request.selectionVersion && state.device?.boot_id === request.boot && state.stopGeneration === request.stopGeneration && state.pumpRequests.get(request.channel) === request;
}

/** execute：发送幂等命令并等回执；泵按路占位，全停撤销所有启动，旧回执不覆盖新停止。 */
async function execute(type, payload, target, pumpRequest = null) {
  const stopping = type === 'stop';
  const allStopping = stopping && !pumpRequest;
  if (pumpRequest ? !currentPumpRequest(pumpRequest) || state.stopBusy : stopping ? state.stopBusy : state.stopBusy || state.busy || state.pumpRequests.size) return;
  if(!state.active || !deviceOnline())return;
  const selected = state.selected, epoch=state.epoch;
  const current = () => state.selected === selected && state.epoch === epoch && (!pumpRequest || currentPumpRequest(pumpRequest));
  if (allStopping) {
    ++state.stopGeneration;
    state.pumpRequests.clear();
    document.querySelectorAll('.pump-result').forEach(result => { result.dataset.request=''; result.textContent='已请求全部停止，等待设备确认。'; result.dataset.state='pending'; });
    $('#debug-result').dataset.request = '';
    text('#debug-result', '已请求停止，等待设备确认。');
  }
  const token = uuid(); target.dataset.request = token;
  if (allStopping) $('#debug-result').dataset.request = token;
  const report = value => {
    if (!current()) return;
    const feedback = /未确认|失败|未收到/.test(value) ? 'error' : /等待|正在|已请求/.test(value) ? 'pending' : 'success';
    if (target.dataset.request === token) { target.textContent = value; target.dataset.state = feedback; }
    if (allStopping && $('#debug-result').dataset.request === token) {
      text('#debug-result', value); $('#debug-result').dataset.state = feedback;
      document.querySelectorAll('.pump-result').forEach(result => { result.textContent=value; result.dataset.state=feedback; });
    }
  };
  if (allStopping) state.stopBusy = true; else if (!pumpRequest) state.busy = true;
  render(); report('正在提交…');
  try {
    const { command } = await api(`devices/${selected}/commands`, { schema_version:1, request_id:uuid(), type, payload });
    report('后台已接收，等待设备确认…');
    const deadline=performance.now()+20000;
    while (performance.now()<deadline && current()) {
      await new Promise(resolve => setTimeout(resolve, 150));
      let c;
      try { ({command:c}=await api(`commands/${command.id}`)); }
      catch(error) {
        if(epoch!==state.epoch)return;
        if(error.message==='login_required')throw error;
        report('连接暂不可用，正在查询操作结果…'); await new Promise(resolve=>setTimeout(resolve,1000)); continue;
      }
      if (c.status === 'completed') {
        const result = c.result || {};
        if(type==='dosing_start') { report(`设备已接受批次 ${result.run_id}，尚未完成；请查看闭环状态和最终剂量。`); return; }
        if(type==='outlet_configure') { report(`两个位置已保存到设备 · v${result.position_version}`); return; }
        if(type==='aux_apply') { report(`设备已确认 · ${payload.channel===9 ? '舵机 '+result.applied_pulse_us+' µs' : '气泵 '+result.applied_value_percent+'%'}`); return; }
        report(`设备已确认 · ${pumpRequest && stopping ? '本路已停止' : result.calibration_version ? `${({weight_tare:'去皮',weight_calibrate:'砝码校准',weight_reset:'清除校准',weight_configure:'稳定阈值保存'})[type]}成功 / 版本 ${result.calibration_version}，等待新称重上报` : result.applied_interval_ms ? `上报周期 ${result.applied_interval_ms} ms / 版本 ${result.applied_config_version}` : result.applied_value_percent !== undefined ? `泵输出 ${result.applied_value_percent}%` : allStopping ? '全部泵已停止' : `往返 ${c.completed_at-c.created_at} ms`}`);
        if (state.selected === selected) loadEvents().catch(()=>{}); return;
      }
      if (['rejected','expired','unknown'].includes(c.status)) { report(`执行未确认：${c.result?.reason || c.reason || c.status}`); return; }
    }
    report('仍未收到回执，请在记录中查询；未自动重发操作。');
  } catch (error) { report(`未确认：${explain(error)}`); }
  finally { if(epoch===state.epoch) {if (allStopping) state.stopBusy = false; else if (!pumpRequest) state.busy = false; render();} }
}

/** runPump：每路独立提交；单停抢占本路，获取会话后的迟到启动必须再次核对停止代次。 */
async function runPump(channel, action, card) {
  const stopping = action === 'stop', d = state.device, previous = state.pumpRequests.get(channel);
  if (!deviceOnline() || !['admin','engineer','operator'].includes(state.role) || !d?.actuator_enabled || !d.capabilities?.actuator || !d.capabilities.command_poll || state.stopBusy) return;
  if (stopping ? previous?.stopping || d.status.actuator?.parallel_supported !== true : previous || state.busy || d.status.actuator?.fault_latched) return;
  const input = card.querySelector('[data-pump-duty]'), target = card.querySelector('.pump-result');
  if (!stopping && !input.reportValidity()) return;
  const value = Number(input.value);
  if (!stopping && value === 0) { target.textContent='请设置大于 0 的输出，或点击“停止本路”。'; target.dataset.state='error'; return; }
  const request = {channel, stopping, selected:state.selected, boot:d.boot_id, epoch:state.epoch, selectionVersion:state.selectionVersion, stopGeneration:state.stopGeneration};
  state.pumpRequests.set(channel, request);
  target.dataset.request=''; target.textContent=stopping ? '正在请求本路停止…' : '正在准备本路启动…'; target.dataset.state='pending'; render();
  try {
    if (stopping) await execute('stop', {channel}, target, request);
    else {
      const session = await api(`devices/${request.selected}/debug-sessions`, {});
      if (!currentPumpRequest(request)) return;
      await execute('debug_apply', {channel, value_percent:value, expected_config_version:d.status.actuator.config_version,
        session_id:session.channel_session_ids?.[channel] || session.session_id}, target, request);
    }
  } catch(error) {
    if (currentPumpRequest(request)) { target.textContent=`未确认：${explain(error)}`; target.dataset.state='error'; }
  } finally {
    if (state.pumpRequests.get(channel) === request) state.pumpRequests.delete(channel);
    if (state.epoch === request.epoch) render();
  }
}

async function loadEvents() {
  if (!state.selected) return;
  const id = state.selected, data = await api(`devices/${id}/events`); if (id !== state.selected) return;
  const events = [...data.events.map(e => ({ type:e.type, at:e.received_at, detail:e.payload })),
    ...data.commands.map(c => ({ type:`${c.type} · ${c.status}`, at:c.completed_at || c.created_at, detail:c.result || { request_id:c.request_id } }))].sort((a,b) => b.at-a.at);
  const eventNames = { boot:'设备启动', weight_tare:'空载去皮', weight_calibrate:'砝码校准', weight_configure:'更新稳定阈值', weight_reset:'清除校准', ping:'检测设备响应', stop:'停止全部泵', debug_apply:'手动泵控制', set_upload_interval:'更新上报周期' };
  const statuses = { completed:'已完成', queued:'等待执行', delivered:'等待确认', rejected:'未执行', expired:'已过期', unknown:'未确认' };
  $('#events').innerHTML = events.length ? events.map(e => {
    const [type, status] = e.type.split(' · ');
    return `<div class="event"><div><b>${escapeHtml(eventNames[type] || type)}${status ? ` · ${escapeHtml(statuses[status] || status)}` : ''}</b><details><summary>查看详情</summary><pre>${escapeHtml(JSON.stringify(e.detail,null,2))}</pre></details></div><small>${time(e.at)}</small></div>`;
  }).join(''):'<div class="empty-state"><b>暂无设备事件</b><p>设备连接和操作记录会显示在这里。</p></div>';
}

/** updateChartSelection：同步通道选择与可访问状态；不重建实时读数节点。 */
function updateChartSelection() {
  const selected = Number($('#chart-channel').value);
  document.querySelectorAll('.channel').forEach(node => {
    const active = Number(node.dataset.channel) === selected;
    node.classList.toggle('selected', active); node.setAttribute('aria-pressed', String(active));
  });
  document.querySelectorAll('#chart-channel-buttons button').forEach(node => {
    const active = Number(node.dataset.channel) === selected;
    node.classList.toggle('selected', active); node.setAttribute('aria-pressed', String(active));
  });
}

/** drawChart：原始/滤波折线与真实 g 刻度；缺失、旧 boot 或长时间断线处分段。 */
function drawChart() {
  const canvas = $('#chart'); if (!canvas.clientWidth || document.hidden) return;
  const ctx = canvas.getContext('2d'), width = canvas.clientWidth, height = 220, ratio = devicePixelRatio || 1;
  canvas.width = width*ratio; canvas.height = height*ratio; ctx.scale(ratio,ratio);
  const selected = Number($('#chart-channel').value), series = state.history.slice(-180);
  const showRaw=$('#chart-raw').checked;
  const values = series.flatMap(h => { const c = h.status?.channels[selected]; return c?.valid ? (showRaw ? [c.mass_mg/1000,(h.display?.[selected] ?? c.filtered_mg)/1000] : [(h.display?.[selected] ?? c.filtered_mg)/1000]) : []; }).filter(Number.isFinite);
  ctx.font = '11px "Segoe UI", "Microsoft YaHei", sans-serif'; ctx.fillStyle = '#6c7972';
  canvas.setAttribute('aria-label', `${names[selected]}重量趋势${values.length ? `，最新滤波值 ${values.at(-1).toFixed(2)} g` : '，暂无有效样本'}`);
  if (!values.length) {
    for (let i=0;i<4;i++) { const y=24+i*46; ctx.strokeStyle='#e9ede2'; ctx.setLineDash([3,5]); ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(width,y); ctx.stroke(); }
    ctx.setLineDash([]); ctx.textAlign='center'; ctx.fillStyle='#fff'; ctx.fillRect(Math.max(0,width/2-100),76,200,60);
    ctx.fillStyle='#56694c'; ctx.font='13px "Segoe UI", "Microsoft YaHei", sans-serif'; ctx.fillText('等待有效称重样本',width/2,100);
    ctx.font='11px "Segoe UI", "Microsoft YaHei", sans-serif'; ctx.fillStyle='#6c7972'; ctx.fillText('校准后可查看重量变化',width/2,123); return;
  }
  let min = Math.min(...values), max = Math.max(...values); const pad = Math.max((max-min)*.1,(1-(max-min))/2,.05); min-=pad; max+=pad;
  const left=60,right=width-12,top=15,bottom=192;
  for(let i=0;i<5;i++){const y=top+(bottom-top)*i/4;ctx.strokeStyle='#e9ede2';ctx.beginPath();ctx.moveTo(left,y);ctx.lineTo(right,y);ctx.stroke();ctx.fillText((max-(max-min)*i/4).toFixed(2),2,y+4);}
  const first=series[0]?.received_at,last=series.at(-1)?.received_at;
  for (const [key,color] of (showRaw ? [['mass_mg','#adbca3'],['display','#2d7050']] : [['display','#2d7050']])) {
    ctx.strokeStyle=color;ctx.lineWidth=key==='mass_mg'?1:2;ctx.beginPath();let previous;
    for(const h of series){const c=h.status?.channels[selected];if(!c?.valid){previous=null;continue;}const value=key==='display' ? h.display?.[selected] ?? c.filtered_mg : c[key]; const x=left+(h.received_at-first)/Math.max(1,last-first)*(right-left),y=bottom-(value/1000-min)/(max-min)*(bottom-top);
      if(!previous||previous.boot_id!==h.boot_id||previous.status.channels[selected].calibration_version!==c.calibration_version||h.received_at-previous.received_at>Math.max(1500,h.status.upload_interval_ms*3))ctx.moveTo(x,y);else ctx.lineTo(x,y);previous=h;}
    ctx.stroke();
  }
  ctx.fillText(time(first),left,213);ctx.fillText(time(last),Math.max(left,right-52),213);
}
for (const id of ['chart-channel','weight-channel']) $(`#${id}`).replaceChildren(...names.map((name,i)=>new Option(name,i)));
function fillChannelButtons(selector, count, prefix = 'CH') {
  const host = $(selector); if (!host) return;
  host.innerHTML = Array.from({length:count}, (_, i) => `<button type="button" data-channel="${i}" aria-pressed="false">${prefix}${String(i + 1).padStart(2,'0')}</button>`).join('');
}
fillChannelButtons('#chart-channel-buttons', 9);
$('#display-mode').replaceChildren(...Object.keys({ balanced: 1, steady: 1, device: 1 }).map(value => new Option(value, value)));
const displayLabels = { balanced: '\u5e73\u8861', steady: '\u7a33\u5b9a', device: '\u8bbe\u5907' };
$('#display-mode-buttons').innerHTML = Object.entries(displayLabels).map(([value,label]) => `<button type="button" data-display-mode="${value}">${label}</button>`).join('');
$('#login-form').addEventListener('submit', async event => {
  event.preventDefault(); const submit = $('#login-submit'); if (submit.disabled) return;
  submit.disabled = true; submit.setAttribute('aria-busy', 'true'); text('#login-error','');
  try { await api('auth/login',{ username:$('#username').value,password:$('#password').value }); await enter(); }
  catch(error){text('#login-error',error.message==='invalid_credentials'?'用户名或密码错误，请重试。':explain(error));}
  finally { submit.disabled = false; submit.removeAttribute('aria-busy'); }
});
$('#password-toggle').onclick = () => {
  const visible = $('#password').type === 'password'; $('#password').type = visible ? 'text' : 'password';
  text('#password-toggle', visible ? '隐藏' : '显示'); $('#password-toggle').setAttribute('aria-label', visible ? '隐藏密码' : '显示密码'); $('#password-toggle').setAttribute('aria-pressed', String(visible));
};
$('#logout').onclick=async()=>{await api('auth/logout',{}).catch(()=>{});showLogin();};
$('#dismiss-result').onclick=()=>text('#overview-result','');
$('#reconnect').onclick=()=>{state.retryAt=0;connectStream();recoverConnection();};
$('#device-select').onchange=event=>{state.selected=event.target.value;selectDevice().catch(e=>text('#notice',explain(e)));};
$('#refresh').onclick=async()=>{
  const button=$('#refresh');button.disabled=true;
  try {const {devices}=await api('devices');acceptSnapshot(devices,state.transport);await selectDevice();}
  catch(e){text('#notice',explain(e));$('#notice').className='notice warn';}
  finally{button.disabled=false;}
};
$('#apply-interval').onclick=()=>{if(!$('#interval-input').reportValidity())return;execute('set_upload_interval',{interval_ms:Number($('#interval-input').value),expected_config_version:state.device.status.config_version},$('#interval-result'));};
$('#ping').onclick=()=>execute('ping',{},$('#interval-result'));
function executeCalibration(channel, action, card) {
  const scale = state.device?.status?.channels?.[channel];
  if (!scale) return;
  setWeightChannel(channel);
  const result = card?.querySelector('.calibration-channel-result') || $('#weight-result');
  const expected_calibration_version = scale.calibration_version;
  if (action === 'tare') {
    execute('weight_tare', {channel, expected_calibration_version}, result);
    return;
  }
  if (action === 'reset') {
    if (!confirm(`Clear calibration for ${calibrationNames[channel]}?`)) return;
    execute('weight_reset', {channel, expected_calibration_version}, result);
    return;
  }
  const input = card?.querySelector('[data-calibration-reference]');
  if (!input?.reportValidity()) return;
  execute('weight_calibrate', {channel, expected_calibration_version, reference_mg:Math.round(Number(input.value) * 1000)}, result);
}
$('#calibration-channel-grid').onclick = event => {
  const button = event.target.closest('[data-calibration-action]');
  if (button) {
    const card = button.closest('.calibration-channel-card');
    executeCalibration(Number(card.dataset.channel), button.dataset.calibrationAction, card);
  } else {
    const card = event.target.closest('.calibration-channel-card');
    if (card) {
      const channel = Number(card.dataset.channel);
      setWeightChannel(channel);
      $('#chart-channel').value = String(channel); updateChartSelection(); drawChart();
    }
  }
};
$('#weight-tare').onclick=()=>execute('weight_tare', {channel:Number($('#weight-channel').value),expected_calibration_version:state.device.status.channels[Number($('#weight-channel').value)].calibration_version}, $('#weight-result'));
$('#weight-calibrate').onclick=()=>{
  if (!$('#weight-reference').reportValidity()) return;
  execute('weight_calibrate', {channel:Number($('#weight-channel').value),expected_calibration_version:state.device.status.channels[Number($('#weight-channel').value)].calibration_version,
    reference_mg:Math.round(Number($('#weight-reference').value)*1000)}, $('#weight-result'));
};
$('#weight-channel').onchange=()=>{
  state.weightChannel=Number($('#weight-channel').value) || 0;
  const c=state.device?.status?.channels[state.weightChannel];
  $('#weight-raw-band').value=c?.raw_band || 200; $('#weight-noise-band').value=c?.noise_band_mg || 50;
  text('#weight-result',''); render();
};
$('#weight-configure').onclick=()=>{
  if (!$('#weight-raw-band').reportValidity() || !$('#weight-noise-band').reportValidity()) return;
  const channel=Number($('#weight-channel').value);
  execute('weight_configure',{channel,expected_calibration_version:state.device.status.channels[channel].calibration_version,
    raw_band:Number($('#weight-raw-band').value),noise_band_mg:Number($('#weight-noise-band').value)},$('#weight-result'));
};
$('#weight-reset').onclick=()=>{
  const channel=Number($('#weight-channel').value);
  if (!confirm(`清除“${names[channel]}”的校准？之后需要重新去皮和砝码校准。`)) return;
  execute('weight_reset',{channel,expected_calibration_version:state.device.status.channels[channel].calibration_version},$('#weight-result'));
};
$('#pump-channel-grid').onclick=event=>{
  const button=event.target.closest('[data-pump-action]'); if(!button || button.disabled)return;
  const card=button.closest('.pump-channel-card');
  runPump(Number(card.dataset.channel), button.dataset.pumpAction, card);
};
$('#pump-channel-grid').oninput=event=>{
  const input=event.target, card=input.closest('.pump-channel-card'); if(!card)return;
  if (input.matches('[data-pump-duty]')) card.querySelector('[data-pump-slider]').value=input.value;
  if (input.matches('[data-pump-slider]')) card.querySelector('[data-pump-duty]').value=input.value;
};
for(const id of ['stop-top','stop-panel','stop-debug']) $(`#${id}`).onclick=()=>execute('stop',{},$(id==='stop-debug'?'#debug-result':'#overview-result'));
$('#chart-channel').onchange=()=>{updateChartSelection();drawChart();};
$('#chart-channel-buttons').onclick=event=>{
  const button=event.target.closest('[data-channel]'); if(!button)return;
  $('#chart-channel').value=button.dataset.channel; updateChartSelection(); drawChart();
};
$('#chart-raw').onchange=()=>{$('.chart-legend .raw').classList.toggle('hidden',!$('#chart-raw').checked);drawChart();};
$('#display-mode').value=weightFilter.mode;
function updateDisplayModeSelection() {
  document.querySelectorAll('#display-mode-buttons button').forEach(button=>button.classList.toggle('selected',button.dataset.displayMode===$('#display-mode').value));
}
$('#display-mode-buttons').onclick=event=>{
  const button=event.target.closest('[data-display-mode]'); if(!button)return;
  $('#display-mode').value=button.dataset.displayMode; $('#display-mode').dispatchEvent(new Event('change'));
};
$('#display-mode').onchange=event=>{
  weightFilter.setMode(event.target.value);
  try{localStorage.setItem('yeti.weightDisplay',weightFilter.mode);}catch{}
  updateDisplayModeSelection(); rebuildDisplay();render();
};
updateDisplayModeSelection(); updateChartSelection();
$('#channel-grid').onclick=event=>{
  const channel = event.target.closest('[data-channel]'); if (!channel) return;
  $('#chart-channel').value = channel.dataset.channel; updateChartSelection(); drawChart();
};
$('#reload-events').onclick=()=>loadEvents().catch(e=>text('#events',explain(e)));
/** openTab：统一导航和快捷入口；切换后定位页首，移动端保留底部导航。 */
function openTab(id) {
  document.querySelectorAll('.nav').forEach(button => {
    const active = button.dataset.tab === id; button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
  });
  document.querySelectorAll('.tab').forEach(tab => tab.classList.toggle('active', tab.id === id));
  window.scrollTo({top:0,behavior:'instant'}); $(`#${id}-title`).focus({preventScroll:true});
  drawChart(); if (id === 'records') loadEvents().catch(e=>text('#events',explain(e)));
}
document.querySelectorAll('.nav').forEach(button=>{
  button.title = button.querySelector('span').textContent;
  button.onclick=()=>openTab(button.dataset.tab);
});
document.querySelectorAll('[data-open-tab]').forEach(button=>button.onclick=()=>{
  if (button.dataset.weightChannel !== undefined) {
    $('#weight-channel').value = button.dataset.weightChannel; $('#weight-channel').dispatchEvent(new Event('change'));
  }
  $(`.nav[data-tab="${button.dataset.openTab}"]`).click();
});
window.addEventListener('resize',drawChart);
/** checkConnection：网页挂起恢复后按单调年龄失效；心跳 4 秒未到即恢复只读连接。 */
function checkConnection() {
  if(!state.active)return;
  if (navigator.onLine === false) {
    state.connected = false; state.transport = 'reconnecting'; render(); return;
  }
  const now=performance.now();
  if(now-state.snapshotAt>4000)state.connected=false;
  if(!state.connected || !state.streamAt || now-state.streamAt>4000)recoverConnection();
  render();
}
setInterval(checkConnection,500);
window.addEventListener('online',()=>{if(state.active){state.retryAt=0;connectStream();recoverConnection();}});
window.addEventListener('offline',()=>{if(state.active){state.connected=false;render();}});
document.addEventListener('visibilitychange',()=>{if(!document.hidden){state.retryAt=0;checkConnection();}});
enter().catch(()=>showLogin());
