'use strict';
const $ = selector => document.querySelector(selector);
const apiRoot = new URL('./api/v1/', location.href);
const state = { devices: [], selected: null, device: null, history: [], stream: null, connected: false, busy: false, selectionVersion: 0 };
window.yetiState = state;
const text = (selector, value) => { $(selector).textContent = value; };
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const time = value => value ? new Date(value).toLocaleTimeString('zh-CN', { hour12: false }) : '—';
const mass = value => Number.isFinite(value) ? `${(value / 1000).toFixed(2)} g` : '—';
const names = ['原液 01','原液 02','原液 03','原液 04','原液 05','原液 06','原液 07','原液 08','中央容器'];
const errors = { login_required:'登录已过期，请重新登录', device_offline:'设备离线', hardware_not_supported:'当前实机尚未接入硬件控制', command_pending:'已有命令等待回执', config_version_conflict:'配置版本已变化，请按设备新值重新提交', debug_session_expired:'调试会话已失效', device_busy:'设备由另一操作页面占用', invalid_payload:'输入内容或范围无效', simulation_only:'仅模拟设备可点动', request_id_conflict:'请求编号发生冲突' };
const explain = error => errors[error.message] || error.message;
const uuid = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2,'0')).join('');

/** api：同源请求；path 为相对 API 路径，body 非空时 POST；用于页面读写，示例 api('devices')。 */
async function api(path, body) {
  const response = await fetch(new URL(path, apiRoot), { method: body === undefined ? 'GET':'POST', credentials:'same-origin',
    headers: body === undefined ? {} : { 'Content-Type':'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(8000) });
  const data = await response.json();
  if (!response.ok) { if (response.status === 401 && path !== 'auth/login') showLogin(); throw new Error(data.error || `HTTP ${response.status}`); }
  return data;
}
window.yetiApi = api;
function showLogin() { state.stream?.close(); state.stream = null; state.connected = false; $('#app').classList.add('hidden'); $('#login').classList.remove('hidden'); }

/** enter：登录后读取快照并订阅状态；无参数，用于登录/页面恢复，示例 await enter()。 */
async function enter() {
  const { devices } = await api('devices');
  state.devices = devices; $('#login').classList.add('hidden'); $('#app').classList.remove('hidden'); $('#password').value = '';
  $('#device-select').replaceChildren(...devices.map(d => new Option(`${d.name} · ${d.simulation ? '模拟':'实机'}`, d.id)));
  state.selected = devices.find(d => d.online)?.id || devices.find(d => d.simulation)?.id || devices[0]?.id;
  $('#device-select').value = state.selected;
  state.connected = true; await selectDevice(); connectStream();
}

/** selectDevice：切换时单独加载历史，版本号隔离旧请求；无参数，由设备选择器调用。 */
async function selectDevice() {
  const id = state.selected, version = ++state.selectionVersion;
  state.history = []; state.device = state.devices.find(d => d.id === id); render();
  const [d, history] = await Promise.all([api(`devices/${id}`), api(`devices/${id}/history`)]);
  if (version !== state.selectionVersion) return;
  state.device = d;
  state.history = history.map(h => ({ received_at:h.received_at, boot_id:h.boot_id, sequence:h.sequence, status:h.status }));
  $('#interval-input').value = d.status?.upload_interval_ms || 1000;
  text('#interval-result',''); text('#debug-result',''); text('#overview-result',''); render(); await loadEvents();
}

/** connectStream：维护一个 SSE 订阅；快照不重复生成曲线点，断线立即禁用写操作。 */
function connectStream() {
  state.stream?.close();
  const stream = new EventSource(new URL('stream', apiRoot)); state.stream = stream;
  stream.addEventListener('snapshot', event => {
    const { devices } = JSON.parse(event.data); state.connected = true; state.devices = devices;
    const d = devices.find(d => d.id === state.selected); if (!d) return;
    state.device = d;
    const last = state.history.at(-1);
    if (d.status && d.online && (!last || last.sequence !== d.sequence || last.boot_id !== d.boot_id)) {
      state.history.push({ received_at:d.received_at, boot_id:d.boot_id, sequence:d.sequence, status:d.status });
      if (state.history.length > 180) state.history.shift();
    }
    render();
  });
  stream.onerror = () => { state.connected = false; render(); };
}

/** render：只更新设备事实，不覆盖输入草稿；无参数，用于每个状态快照。 */
function render() {
  const d = state.device; if (!d) return;
  const online = d.online && state.connected, s = d.status;
  $('#server-state').className = `connection-dot ${state.connected ? 'online':'offline'}`;
  text('#server-state', state.connected ? '后台已连接':'后台重连中');
  text('#summary-online', `${state.devices.filter(d => d.online).length} / ${state.devices.length}`);
  const serialTest = !d.simulation && d.capabilities?.test_input;
  text('#summary-mode', d.simulation ? '模拟设备' : serialTest ? 'ESP 串口测试' : '实机网络'); text('#summary-firmware', d.firmware);
  text('#summary-task', !online ? '离线' : s?.task_state === 'debug' ? '模拟点动' : '待机');
  text('#summary-updated', `最后上报 ${time(d.received_at)}`);
  text('#summary-capability', d.simulation ? '模拟演示' : serialTest ? '串口样本' : '网络就绪');
  text('#sample-age', d.age_ms == null ? '尚无上报' : `${Math.max(0, Math.round(d.age_ms))} ms 前`);
  text('#access-url', new URL('./', location.href).href);
  $('#notice').className = `notice ${online ? 'info':'warn'}`;
  text('#notice', !online ? '设备或后台已离线：显示最后记录，当前不能确认命令执行。' : d.simulation ? '演示模式 · 所有称重和输出均为模拟数据，点动最长 5 秒。' : serialTest ? 'ESP 串口测试 · 样本来自手工串口输入，不代表真实称重；泵控制仍关闭。' : '实机网络已连接 · 可验证上报和回执，称重与泵控制尚未接入。');
  $('#channel-grid').innerHTML = names.slice(0,8).map((label,i) => {
    const c = s?.channels[i], valid = c?.valid, value = valid ? c.filtered_mg : null;
    return `<div class="channel ${!online ? 'stale':''}"><div class="channel-main"><span class="channel-name">${label}</span><span class="channel-value">${mass(value)}</span></div><div class="channel-main"><span class="channel-unit">${!valid ? '硬件待接入' : !online ? '最后记录 · 已过期' : `${d.simulation ? '模拟 · ':''}${c.stable ? '稳定':'变化中'}`}</span><span class="channel-unit">CH ${String(i).padStart(2,'0')}</span></div><div class="bar"><i style="width:${value == null ? 0:Math.min(100,Math.max(0,value/6000))}%"></i></div></div>`;
  }).join('');
  const center = s?.channels[8]; text('#center-mass', center?.valid ? mass(center.filtered_mg):'—');
  text('#center-quality', !center?.valid ? (serialTest ? '等待串口样本' : '硬件待接入') : !online ? '最后记录' : serialTest ? '串口测试样本' : d.simulation ? '模拟称重' : '有效样本');
  const a = s?.actuator;
  text('#actuator-state', !a || !d.simulation ? '当前未接入真实执行器，页面不提供实机开泵或停止确认。' : `模拟通道 ${a.channel} · 设备报告 ${a.applied_percent}%${!online ? '（最后记录）':''}`);
  text('#reported-interval', s ? `设备当前 ${s.upload_interval_ms} ms · 配置版本 ${s.config_version}`:'等待设备上报');
  const labels = { telemetry:'遥测上传', events:'启动事件', command_poll:'命令回执', test_input:'串口测试', weight:'称重', actuator:'输出', simulation:'模拟器' };
  $('#capabilities').innerHTML = Object.entries(labels).map(([key,label]) => `<span class="capability ${d.capabilities[key] ? 'yes':''}"><i></i>${label} · ${d.capabilities[key] ? (d.simulation && ['weight','actuator'].includes(key) ? '模拟':'支持'):'未接入'}</span>`).join('');
  for (const id of ['apply-debug','stop-debug','stop-top','stop-panel']) $(`#${id}`).disabled = !online || !d.simulation || state.busy;
  $('#apply-interval').disabled = $('#ping').disabled = !online || !d.capabilities.command_poll || state.busy;
  drawChart();
}

/** execute：发送一次幂等命令并等待终态；type/payload 为命令，target 为结果元素。 */
async function execute(type, payload, target) {
  if (state.busy) return;
  const selected = state.selected;
  state.busy = true; render(); target.textContent = '正在提交…';
  try {
    const { command } = await api(`devices/${selected}/commands`, { schema_version:1, request_id:uuid(), type, payload });
    target.textContent = '后台已接收，等待设备确认…';
    for (let i = 0; i < 34; i++) {
      await new Promise(resolve => setTimeout(resolve, 500));
      const { command:c } = await api(`commands/${command.id}`);
      if (c.status === 'completed') {
        const result = c.result || {};
        target.textContent = `设备已确认 · ${result.applied_interval_ms ? `上报周期 ${result.applied_interval_ms} ms / 版本 ${result.applied_config_version}` : result.applied_value_percent !== undefined ? `模拟输出 ${result.applied_value_percent}%` : `往返 ${c.completed_at-c.created_at} ms`}`;
        if (state.selected === selected) await loadEvents(); return;
      }
      if (['rejected','expired','unknown'].includes(c.status)) { target.textContent = `执行未确认：${c.result?.reason || c.reason || c.status}`; return; }
    }
    target.textContent = '仍未收到回执，请在记录中查询；未自动重发操作。';
  } catch (error) { target.textContent = `未确认：${explain(error)}`; }
  finally { state.busy = false; render(); }
}

async function loadEvents() {
  if (!state.selected) return;
  const id = state.selected, data = await api(`devices/${id}/events`); if (id !== state.selected) return;
  const events = [...data.events.map(e => ({ type:e.type, at:e.received_at, detail:e.payload })),
    ...data.commands.map(c => ({ type:`${c.type} · ${c.status}`, at:c.completed_at || c.created_at, detail:c.result || { request_id:c.request_id } }))].sort((a,b) => b.at-a.at);
  $('#events').innerHTML = events.length ? events.map(e => `<div class="event"><div><b>${escapeHtml(e.type)}</b><br><small>${escapeHtml(JSON.stringify(e.detail))}</small></div><small>${time(e.at)}</small></div>`).join(''):'<p class="muted">暂无设备事件或命令记录</p>';
}

/** drawChart：原始/滤波折线与真实 g 刻度；缺失、旧 boot 或长时间断线处分段。 */
function drawChart() {
  const canvas = $('#chart'); if (!canvas.clientWidth) return;
  const ctx = canvas.getContext('2d'), width = canvas.clientWidth, height = 220, ratio = devicePixelRatio || 1;
  canvas.width = width*ratio; canvas.height = height*ratio; ctx.scale(ratio,ratio);
  const selected = Number($('#chart-channel').value), series = state.history.slice(-180);
  const values = series.flatMap(h => { const c = h.status?.channels[selected]; return c?.valid ? [c.mass_mg/1000,c.filtered_mg/1000] : []; }).filter(Number.isFinite);
  ctx.font = '11px Segoe UI'; ctx.fillStyle = '#8193a6';
  if (!values.length) { ctx.fillText('等待有效称重样本 · 当前硬件尚未接入',16,40); return; }
  let min = Math.min(...values), max = Math.max(...values); const pad = Math.max((max-min)*.1,.05); min-=pad; max+=pad;
  const left=60,right=width-12,top=15,bottom=192;
  for(let i=0;i<5;i++){const y=top+(bottom-top)*i/4;ctx.strokeStyle='#e7edf4';ctx.beginPath();ctx.moveTo(left,y);ctx.lineTo(right,y);ctx.stroke();ctx.fillText((max-(max-min)*i/4).toFixed(2),2,y+4);}
  const first=series[0]?.received_at,last=series.at(-1)?.received_at;
  for (const [key,color] of [['mass_mg','#9ab9df'],['filtered_mg','#2d6cdf']]) {
    ctx.strokeStyle=color;ctx.lineWidth=key==='mass_mg'?1:2;ctx.beginPath();let previous;
    for(const h of series){const c=h.status?.channels[selected];if(!c?.valid){previous=null;continue;}const x=left+(h.received_at-first)/Math.max(1,last-first)*(right-left),y=bottom-(c[key]/1000-min)/(max-min)*(bottom-top);
      if(!previous||previous.boot_id!==h.boot_id||h.received_at-previous.received_at>Math.max(5000,h.status.upload_interval_ms*3))ctx.moveTo(x,y);else ctx.lineTo(x,y);previous=h;}
    ctx.stroke();
  }
  ctx.fillText(time(first),left,213);ctx.fillText(time(last),Math.max(left,right-52),213);
}
for (const id of ['chart-channel','debug-channel']) $( `#${id}`).replaceChildren(...names.slice(0,id==='debug-channel'?8:9).map((name,i)=>new Option(name,i)));
$('#login-form').addEventListener('submit', async event => { event.preventDefault(); try { await api('auth/login',{ username:$('#username').value,password:$('#password').value }); text('#login-error',''); await enter(); } catch(error){text('#login-error',error.message==='invalid_credentials'?'用户名或密码错误':explain(error));} });
$('#logout').onclick=async()=>{await api('auth/logout',{}).catch(()=>{});showLogin();};
$('#device-select').onchange=event=>{state.selected=event.target.value;selectDevice().catch(e=>text('#notice',explain(e)));};
$('#refresh').onclick=()=>selectDevice().catch(e=>text('#notice',explain(e)));
$('#apply-interval').onclick=()=>{if(!$('#interval-input').reportValidity())return;execute('set_upload_interval',{interval_ms:Number($('#interval-input').value),expected_config_version:state.device.status.config_version},$('#interval-result'));};
$('#ping').onclick=()=>execute('ping',{},$('#interval-result'));
$('#apply-debug').onclick=async()=>{try{const s=await api(`devices/${state.selected}/debug-sessions`,{});await execute('debug_apply',{channel:Number($('#debug-channel').value),value_percent:Number($('#debug-slider').value),session_id:s.session_id},$('#debug-result'));}catch(e){text('#debug-result',explain(e));}};
for(const id of ['stop-top','stop-panel','stop-debug']) $(`#${id}`).onclick=()=>execute('stop',{},$(id==='stop-debug'?'#debug-result':'#overview-result'));
$('#debug-slider').oninput=event=>text('#debug-value',`${event.target.value}%`);
$('#chart-channel').onchange=drawChart;
$('#reload-events').onclick=()=>loadEvents().catch(e=>text('#events',explain(e)));
document.querySelectorAll('.nav').forEach(button=>button.onclick=()=>{document.querySelectorAll('.nav,.tab').forEach(el=>el.classList.remove('active'));button.classList.add('active');$(`#${button.dataset.tab}`).classList.add('active');drawChart();if(button.dataset.tab==='records')loadEvents().catch(e=>text('#events',explain(e)));});
window.addEventListener('resize',drawChart);
enter().catch(()=>showLogin());
