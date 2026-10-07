// 无第三方依赖的 Edge/CDP 冒烟验证；使用独立临时配置，不读取个人浏览器资料。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: sleep } = require('node:timers/promises');
const { createServer } = require('../server');

async function until(read, check, ms = 12000) {
  const end = Date.now() + ms;
  do { const value = await read(); if (check(value)) return value; await sleep(100); } while (Date.now() < end);
  throw new Error('Browser condition timed out');
}

/** main：启动隔离网页及浏览器，验证实际交互并保存桌面/手机截图；无硬件或外网访问。 */
async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yeti-browser-'));
  const artifacts = path.resolve(__dirname, '../artifacts/browser'); fs.mkdirSync(artifacts, { recursive: true });
  const sim = { id: 'sim-001', name: '演示设备 · 模拟数据', token: 'browser-sim-token', simulation: true, serial_test: false };
  const gateway = createServer({ dataDir: directory, host: '127.0.0.1', port: 0, basePath: '/console', username: 'admin', password: 'browser-test-password',
    devices: [{ id: 'esp32-001', name: 'ESP32-S3 · 联调设备', token: 'browser-real-token', simulation: false, weight:true, actuator:true }, sim], simulate: true, simDevice: sim, credentialFile: '(browser test only)' });
  let browser, socket, heartbeat, counter = 0; const pending = new Map(), exceptions = [];
  const command = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++counter, timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, 10000);
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject }); socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const waitFor = async (expression, label = expression) => {
    try { return await until(() => evaluate(expression), Boolean); }
    catch (error) { throw new Error('Browser check failed: ' + label, { cause: error }); }
  };
  const screenshot = async name => {
    // 截图等待真实入场/悬停动画完成，避免把中间帧当成最终视觉效果。
    await evaluate('Promise.all(document.getAnimations().map(a=>a.finished.catch(()=>{})))');
    await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    const { data } = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    fs.writeFileSync(path.join(artifacts, name + '.png'), Buffer.from(data, 'base64'));
  };
  const click = async selector => {
    const point = await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    await command('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1});
    await command('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',clickCount:1});
  };
  try {
    gateway.listen(); await once(gateway.server, 'listening');
    const origin = 'http://127.0.0.1:' + gateway.server.address().port + '/console/';
    browser = spawn(process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', [
      '--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
      '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', '--user-data-dir=' + path.join(directory, 'edge'), 'about:blank'
    ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let launchError, browserLog = ''; browser.on('error', e => { launchError = e; });
    browser.stderr.on('data', b => { browserLog = (browserLog + b.toString()).slice(-4000); });
    const portFile = path.join(directory, 'edge', 'DevToolsActivePort');
    await until(() => { if (launchError) throw launchError; return fs.existsSync(portFile); }, Boolean);
    const port = fs.readFileSync(portFile, 'utf8').split(String.fromCharCode(10))[0].trim();
    const tabs = await fetch('http://127.0.0.1:' + port + '/json/list').then(r => r.json());
    socket = new WebSocket(tabs.find(t => t.type === 'page').webSocketDebuggerUrl);
    socket.addEventListener('message', ({ data }) => {
      const message = JSON.parse(data);
      if (message.id) { const p = pending.get(message.id); pending.delete(message.id); if (p) message.error ? p.reject(new Error(JSON.stringify(message.error))) : p.resolve(message.result); }
      if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails);
    });
    await once(socket, 'open'); await command('Page.enable'); await command('Runtime.enable');
    await command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
    await command('Page.navigate', { url: origin });
    await waitFor('Boolean(document.querySelector("#login-form"))'); await screenshot('01-login-desktop');
    await click('#password-toggle');
    assert.equal(await evaluate('document.querySelector("#password").type'),'text');
    await click('#password-toggle');
    assert.equal(await evaluate('document.querySelector("#password").type'),'password');
    await evaluate('document.querySelector("#password").value="browser-test-password";document.querySelector("#login-form").requestSubmit()');
    await waitFor('!document.querySelector("#app").classList.contains("hidden") && state.device?.id==="esp32-001"');
    assert.equal(await evaluate('(()=>{const ids=[...document.querySelectorAll("[id]")].map(n=>n.id);return ids.length===new Set(ids).size;})()'),true,'unique element identities');
    assert.equal(await evaluate('document.querySelectorAll("#device-select option").length'),1);
    assert.equal(await evaluate('/模拟|演示/.test(document.body.innerText)'),false);
    assert.equal(await evaluate('document.querySelector("#batch-start")'),null);
    assert.equal(await evaluate('document.querySelector("#weight-tare").disabled'),true);
    await screenshot('overview-offline');
    const devicePost=async(route,body)=>{
      const r=await fetch(origin+'api/v1/device/'+route,{method:'POST',headers:{'Content-Type':'application/json','X-Device-Id':'esp32-001','X-Device-Token':'browser-real-token'},body:JSON.stringify(body)});
      assert.equal(r.status,200);return r.json();
    };
    const body={schema_version:1,device_id:'esp32-001',boot_id:'weight-browser',sequence:0,uptime_ms:0,sample_age_ms:0,firmware:'protocol-fixture-v2',
      capabilities:{telemetry:true,events:true,command_poll:true,test_input:false,weight:true,actuator:true,simulation:false},
      status:{upload_interval_ms:200,config_version:1,free_heap_bytes:150000,wifi_rssi:-45,task_state:'idle',last_http_ms:12,weight_service_version:2,
        channels:Array.from({length:9},(_,channel)=>({channel,enabled:true,initialized:true,raw_count:12000+channel,average_raw:12000+channel,
          mass_mg:null,filtered_mg:null,valid:false,stable:false,age_ms:10,samples:16,calibrated:false,tare_ready:false,calibration_version:1,
          saved:false,calibration_ready:true,raw_band:200,noise_band_mg:50,noise_mg:0,sample_period_ms:100,sample_sequence:20,last_error:'ESP_OK',storage_error:'ESP_OK'})),
        actuator:{channel:0,applied_percent:0,config_version:1,pwm_hz:1000,maximum_percent:80,remaining_ms:0,
          fault_latched:false,shutdown_failed:false,registers_verified:true,duty_percent:Array(8).fill(0),
          parallel_supported:true,remaining_ms_by_channel:Array(8).fill(0)}}};
    let pendingUpload=Promise.resolve();
    const upload=()=>{
      body.sequence++;body.uptime_ms+=200;body.status.channels.forEach(c=>{if(c.raw_count!==null)c.sample_sequence++;});
      const copy=structuredClone(body);
      pendingUpload=pendingUpload.then(()=>devicePost('telemetry',copy));
      return pendingUpload;
    };
    await upload(); heartbeat=setInterval(()=>upload().catch(()=>{}),200);
    await evaluate('document.querySelector("[data-tab=debug]").click()');
    await waitFor('state.device?.online && !document.querySelector("#weight-tare").disabled');
    assert.equal(await evaluate('document.querySelectorAll("#weight-channel option").length'),9);
    await evaluate('document.querySelector("#weight-channel").value="8";document.querySelector("#weight-channel").dispatchEvent(new Event("change"))');
    await waitFor('document.querySelector("#weight-raw").textContent.includes("12008")');
    async function complete(type,update) {
      await until(()=>gateway.store.commands('esp32-001').some(c=>c.type===type && c.state==='queued'),Boolean);
      const {command:c}=await devicePost('commands/poll',{schema_version:1,device_id:'esp32-001',boot_id:'weight-browser',wait_ms:0});
      assert.equal(c.type,type);assert.equal(c.payload.channel,8);
      if(type==='weight_calibrate') assert.equal(c.payload.reference_mg,100000);
      update(body.status.channels[8]);
      await devicePost(`commands/${c.id}/ack`,{schema_version:1,device_id:'esp32-001',boot_id:'weight-browser',status:'completed',result:{calibration_version:body.status.channels[8].calibration_version,calibrated:body.status.channels[8].calibrated}});
      await upload();await waitFor('!state.busy && document.querySelector("#weight-result").textContent.includes("设备已确认")');
    }
    await evaluate('document.querySelector("#weight-tare").click()');
    await complete('weight_tare',c=>Object.assign(c,{tare_ready:true,saved:true,calibration_version:2}));
    await evaluate('document.querySelector("#weight-reference").value="100";document.querySelector("#weight-calibrate").click()');
    await complete('weight_calibrate',c=>Object.assign(c,{calibrated:true,valid:true,stable:true,mass_mg:100000,filtered_mg:100000,calibration_version:3}));
    await waitFor('document.querySelector("#weight-mass").textContent==="100.00 g"');
    assert.equal(await evaluate('state.device.status.channels[0].calibrated'),false);
    await evaluate('document.querySelector(".weight-panel details").open=true;document.querySelector("#weight-raw-band").value="300";document.querySelector("#weight-noise-band").value="100";document.querySelector("#weight-configure").click()');
    await complete('weight_configure',c=>Object.assign(c,{raw_band:300,noise_band_mg:100,calibration_version:4}));
    await screenshot('13-nine-scales-calibrated');
    const pumpCard = channel => `#pump-channel-grid .pump-channel-card[data-channel="${channel}"]`;
    assert.equal(await evaluate('document.querySelectorAll("#pump-channel-grid .pump-channel-card").length'),8);
    await evaluate(`document.querySelector(${JSON.stringify(pumpCard(0)+' [data-pump-duty]')}).value='25';document.querySelector(${JSON.stringify(pumpCard(0)+' [data-pump-duty]')}).dispatchEvent(new Event('input',{bubbles:true}))`);
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(pumpCard(0)+' [data-pump-slider]')}).value`),'25');
    await evaluate(`document.querySelector(${JSON.stringify(pumpCard(1)+' [data-pump-slider]')}).value='35';document.querySelector(${JSON.stringify(pumpCard(1)+' [data-pump-slider]')}).dispatchEvent(new Event('input',{bubbles:true}))`);
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(pumpCard(1)+' [data-pump-duty]')}).value`),'35');
    await click(pumpCard(0)+' [data-pump-action=start]');
    await until(()=>gateway.store.commands('esp32-001').some(c=>c.type==='debug_apply' && c.payload.channel===0 && c.state==='queued'),Boolean);
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(pumpCard(1)+' [data-pump-action=start]')}).disabled`),false,'a pending pump leaves other start buttons available');
    await click(pumpCard(1)+' [data-pump-action=start]');
    await until(()=>gateway.store.commands('esp32-001').filter(c=>c.type==='debug_apply' && c.state==='queued').length, n=>n===2);
    async function completePump(type, channel) {
      const {command:c}=await devicePost('commands/poll',{schema_version:1,device_id:'esp32-001',boot_id:'weight-browser',wait_ms:0});
      assert.equal(c?.type,type); if(channel!==undefined)assert.equal(c.payload.channel,channel);
      const a=body.status.actuator;
      if(type==='debug_apply') { a.duty_percent[c.payload.channel]=c.payload.value_percent; a.remaining_ms_by_channel[c.payload.channel]=4500+c.payload.channel*50; }
      else if(c.payload.channel===undefined) { a.duty_percent.fill(0);a.remaining_ms_by_channel.fill(0); }
      else { a.duty_percent[c.payload.channel]=0;a.remaining_ms_by_channel[c.payload.channel]=0; }
      a.channel=c.payload.channel??0;a.applied_percent=a.duty_percent[a.channel];a.remaining_ms=a.remaining_ms_by_channel[a.channel];
      await devicePost(`commands/${c.id}/ack`,{schema_version:1,device_id:'esp32-001',boot_id:'weight-browser',status:'completed',result:{applied_value_percent:a.applied_percent}});
      await upload();return c;
    }
    await completePump('debug_apply',0);await completePump('debug_apply',1);
    await waitFor('state.pumpRequests.size===0 && state.device.status.actuator.duty_percent[0]===25 && state.device.status.actuator.duty_percent[1]===35');
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(pumpCard(0)+' .pump-status')}).textContent`),'运行中');
    // 同路停止抢占尚未投递的更新，其他正在运行的泵及其输入草稿保留。
    await click(pumpCard(0)+' [data-pump-action=start]');
    const cancelled = await until(()=>gateway.store.commands('esp32-001').find(c=>c.type==='debug_apply' && c.payload.channel===0 && c.state==='queued'),Boolean);
    await click(pumpCard(0)+' [data-pump-action=stop]');
    await until(()=>gateway.store.commands('esp32-001').some(c=>c.type==='stop' && c.payload.channel===0 && c.state==='queued'),Boolean);
    assert.equal(gateway.store.command(cancelled.id).state,'expired');
    await completePump('stop',0);
    await waitFor(`state.pumpRequests.size===0 && document.querySelector(${JSON.stringify(pumpCard(0)+' .pump-result')}).textContent.includes('本路已停止')`);
    assert.equal(await evaluate('state.device.status.actuator.duty_percent[1]'),35);
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(pumpCard(1)+' [data-pump-duty]')}).value`),'35');
    // 点动会话响应在途时点击停止，迟到的启动不能产生新的 debug_apply。
    const beforeDelayedStart=gateway.store.commands('esp32-001').filter(c=>c.type==='debug_apply').length;
    await evaluate('window.browserOriginalApi=api;api=async(...args)=>{const result=await window.browserOriginalApi(...args);if(args[0].endsWith("/debug-sessions"))await new Promise(resolve=>window.browserReleaseSession=resolve);return result;}');
    await click(pumpCard(0)+' [data-pump-action=start]');await waitFor('Boolean(window.browserReleaseSession)');
    await click(pumpCard(0)+' [data-pump-action=stop]');
    await until(()=>gateway.store.commands('esp32-001').some(c=>c.type==='stop' && c.payload.channel===0 && c.state==='queued'),Boolean);
    await completePump('stop',0);
    await evaluate('window.browserReleaseSession();api=window.browserOriginalApi;delete window.browserOriginalApi;delete window.browserReleaseSession');
    await waitFor('state.pumpRequests.size===0');await sleep(200);
    assert.equal(gateway.store.commands('esp32-001').filter(c=>c.type==='debug_apply').length,beforeDelayedStart);
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(pumpCard(0)+' .pump-result')}).textContent.includes('本路已停止')`),true,'a late start cannot replace stop feedback');
    // 同一事件循环点击八个独立按钮，全部在设备轮询之前进入队列。
    await evaluate('document.querySelectorAll("#pump-channel-grid [data-pump-action=start]").forEach(button=>button.click())');
    await until(()=>gateway.store.commands('esp32-001').filter(c=>c.type==='debug_apply' && c.state==='queued').length,n=>n===8);
    const channels=[];for(let i=0;i<8;i++)channels.push((await completePump('debug_apply')).payload.channel);
    assert.deepEqual(channels.slice().sort((a,b)=>a-b),[0,1,2,3,4,5,6,7]);
    await waitFor('state.pumpRequests.size===0 && state.device.status.actuator.duty_percent.every(v=>v>0)');
    await screenshot('14-eight-pumps-running');
    await click('#stop-debug');await until(()=>gateway.store.commands('esp32-001').some(c=>c.type==='stop' && c.payload.channel===undefined && c.state==='queued'),Boolean);
    await completePump('stop');await waitFor('!state.stopBusy && state.device.status.actuator.duty_percent.every(v=>v===0)');
    Object.assign(body.status.channels[8],{raw_count:null,average_raw:null,mass_mg:null,filtered_mg:null,valid:false,stable:false,calibration_ready:false,samples:0,age_ms:60000,last_error:'ESP_ERR_TIMEOUT'});
    await upload();await waitFor('document.querySelector("#weight-mass").textContent==="—" && document.querySelector("#weight-tare").disabled');
    Object.assign(body.status.channels[8],{raw_count:12008,average_raw:12008,mass_mg:100000,filtered_mg:100000,valid:true,stable:true,calibration_ready:true,samples:16,age_ms:10,last_error:'ESP_OK'});
    await upload();await waitFor('document.querySelector("#weight-mass").textContent==="100.00 g"');
    await evaluate('document.querySelector("[data-tab=overview]").click()');
    await waitFor('document.querySelector("#center-mass").textContent==="100.00 g"');
    await click('.channel[data-channel="3"]');
    assert.equal(await evaluate('document.querySelector("#chart-channel").value'),'3');
    await evaluate('document.querySelector(".channel[data-channel=\\"3\\"]").focus()');
    await upload(); await sleep(250);
    assert.equal(await evaluate('document.activeElement.dataset.channel'),'3','telemetry preserves channel keyboard focus');
    await click('[data-weight-channel="8"]');
    assert.equal(await evaluate('document.querySelector(".tab.active").id'),'debug');
    assert.equal(await evaluate('document.querySelector("#weight-channel").value'),'8');
    await evaluate('document.querySelector(".weight-panel details").open=false;document.querySelector("[data-tab=overview]").click();document.querySelector("#chart-channel").value="8";document.querySelector("#chart-channel").dispatchEvent(new Event("change"))');
    await evaluate('document.querySelector("#display-mode").value="steady";document.querySelector("#display-mode").dispatchEvent(new Event("change"))');
    assert.equal(await evaluate('localStorage.getItem("yeti.weightDisplay")'),'steady');
    assert.equal(await evaluate('document.querySelector("#chart-raw").checked'),false);
    await evaluate('document.querySelector("#display-mode").value="balanced";document.querySelector("#display-mode").dispatchEvent(new Event("change"))');
    await screenshot('02-nine-scales-overview');
    await evaluate('document.querySelector("[data-tab=recipes]").click();document.querySelector("#recipe-new").click()');
    await waitFor('document.querySelectorAll("#recipe-steps .step-row").length===1');
    await evaluate('document.querySelector("#recipe-name").value="Real recipe";document.querySelector("#recipe-form").requestSubmit()');
    await waitFor('document.querySelector("#recipe-result").textContent.includes("已保存 v1")');
    await waitFor('document.querySelector("#recipe-form button[type=submit]").disabled===false');
    await evaluate('document.querySelector("#recipe-name").value="Real recipe v2";document.querySelector("#recipe-form").requestSubmit()');
    await waitFor('document.querySelector("#recipe-result").textContent.includes("已保存 v2")');
    await waitFor('document.querySelector("#recipe-form button[type=submit]").disabled===false');
    await click('.step-add');
    assert.equal(await evaluate('document.querySelectorAll("#recipe-steps .step-row").length'),2);
    assert.equal(await evaluate('document.querySelectorAll(".step-channel")[1].value'),'1');
    await click('.step-row:last-of-type .step-remove');
    assert.equal(await evaluate('document.querySelectorAll("#recipe-steps .step-row").length'),1);
    await evaluate('document.querySelector("#recipe-notes").value="unsaved draft";document.querySelector("#recipe-notes").dispatchEvent(new Event("input",{bubbles:true}));window.confirm=()=>false;document.querySelector("#recipe-new").click()');
    assert.equal(await evaluate('document.querySelector("#recipe-notes").value'),'unsaved draft','new recipe preserves draft after cancel');
    await evaluate('document.querySelector("#recipe-notes").value="";document.querySelector("#recipe-notes").dispatchEvent(new Event("input",{bubbles:true}));delete window.confirm');
    await screenshot('desktop-recipes');
    await evaluate('document.querySelector("[data-tab=records]").click()');
    await waitFor('document.querySelector("#cal-channel").dataset.version==="0"');
    await click('.calibration-records summary');
    await evaluate('document.querySelector("#cal-zero").value="100";document.querySelector("#cal-loaded").value="1100";document.querySelector("#cal-mass").value="10000";document.querySelector("#calibration-form").requestSubmit()');
    await waitFor('document.querySelector("#cal-result").textContent.includes("版本 v1")');
    // 出口协议夹具：真正网页按钮 -> 鉴权队列 -> 设备回执 -> 遥测显示。
    Object.assign(body.status.actuator,{pwm_hz:50,minimum_percent:40,auxiliaries_supported:true,air_percent:0,servo_pulse_us:0,air_remaining_ms:0,servo_remaining_ms:0});
    body.status.dosing={supported:true,active:false,positions_saved:false,vessel_us:0,waste_us:0,position_version:1,run_id:0,
      state:'idle',error:'ok',step:0,step_count:0,jogs:0,delivered_mg:0,source_loss_mg:0,flow_mg_s:0,dose_mg:[]};
    await upload();await evaluate('document.querySelector("[data-tab=debug]").click()');
    await waitFor('!document.querySelector("#servo-test").disabled');
    async function completeOutlet(type,result,update) {
      await until(()=>gateway.store.commands('esp32-001').some(c=>c.type===type && c.state==='queued'),Boolean);
      const {command:c}=await devicePost('commands/poll',{schema_version:1,device_id:'esp32-001',boot_id:'weight-browser',wait_ms:0});
      assert.equal(c.type,type);update?.(c);
      await devicePost(`commands/${c.id}/ack`,{schema_version:1,device_id:'esp32-001',boot_id:'weight-browser',status:'completed',result});
      await upload();await waitFor('!state.busy && !state.stopBusy');return c;
    }
    const auxBefore=gateway.store.commands('esp32-001').filter(c=>c.type==='aux_apply').length;
    await evaluate('document.querySelector("#servo-slider").value="1690";document.querySelector("#servo-slider").dispatchEvent(new Event("input"));document.querySelector("#servo-plus").click()');
    assert.equal(await evaluate('document.querySelector("#servo-pulse").value'),'1700');
    assert.equal(gateway.store.commands('esp32-001').filter(c=>c.type==='aux_apply').length,auxBefore,'slider edits must not move hardware');
    await evaluate('document.querySelector("#servo-test").click()');
    await completeOutlet('aux_apply',{applied_pulse_us:1700},c=>{assert.equal(c.payload.channel,9);assert.equal(c.payload.pulse_us,1700);Object.assign(body.status.actuator,{servo_pulse_us:1700,servo_remaining_ms:4000});});
    await waitFor('document.querySelector("#outlet-result").textContent.includes("1700")');
    assert.equal(await evaluate('document.querySelector("#outlet-save").disabled'),true);
    await click('#servo-mark-vessel');
    assert.equal(await evaluate('document.querySelector("#servo-vessel").value'),'1700');
    await evaluate('document.querySelector("#servo-pulse").value="2000";document.querySelector("#servo-test").click()');
    await completeOutlet('aux_apply',{applied_pulse_us:2000},()=>Object.assign(body.status.actuator,{servo_pulse_us:2000,servo_remaining_ms:4000}));
    await click('#servo-mark-waste');
    assert.equal(await evaluate('document.querySelector("#servo-waste").value'),'2000');
    await evaluate('document.querySelector("#outlet-stop").click()');
    await completeOutlet('stop',{},()=>Object.assign(body.status.actuator,{servo_pulse_us:0,servo_remaining_ms:0}));
    await evaluate('window.confirm=()=>true;document.querySelector("#outlet-save").click()');
    await completeOutlet('outlet_configure',{position_version:2},c=>{assert.equal(c.payload.vessel_us,1700);Object.assign(body.status.dosing,{positions_saved:true,vessel_us:1700,waste_us:2000,position_version:2});});
    await waitFor('document.querySelector("#outlet-result").textContent.includes("已保存")');
    await click('#servo-go-waste');
    await completeOutlet('aux_apply',{applied_pulse_us:2000},c=>{assert.equal(c.payload.pulse_us,2000);Object.assign(body.status.actuator,{servo_pulse_us:2000,servo_remaining_ms:4000});});
    await click('#outlet-stop');
    await completeOutlet('stop',{},()=>Object.assign(body.status.actuator,{servo_pulse_us:0,servo_remaining_ms:0}));
    await click('#air-test');
    await completeOutlet('aux_apply',{applied_value_percent:60},c=>{assert.equal(c.payload.channel,8);Object.assign(body.status.actuator,{air_percent:60,air_remaining_ms:4000});});
    assert.equal(await evaluate('document.querySelector("#servo-test").disabled'),true,'air blocks route changes');
    assert.equal(await evaluate('document.querySelector("#summary-task").textContent'),'清液气泵运行中');
    await click('#outlet-stop');
    await completeOutlet('stop',{},()=>Object.assign(body.status.actuator,{air_percent:0,air_remaining_ms:0}));
    Object.assign(body.status.channels[0],{valid:true,stable:true,calibrated:true,tare_ready:true,mass_mg:200000,filtered_mg:200000});
    await upload();await waitFor('state.device.status.channels[0].valid');
    await evaluate('document.querySelector("#dose-steps [data-target]").value="12.345";document.querySelector("#dose-steps [data-target]").dispatchEvent(new Event("input",{bubbles:true}));document.querySelector("#dose-confirm").checked=true;document.querySelector("#dose-confirm").dispatchEvent(new Event("change"))');
    await evaluate('document.querySelector("#dose-steps [data-tolerance]").value="13";document.querySelector("#dose-steps [data-tolerance]").dispatchEvent(new Event("input",{bubbles:true}))');
    assert.equal(await evaluate('document.querySelector("#dose-confirm").checked'),false,'editing invalidates recipe confirmation');
    assert.equal(await evaluate('document.querySelector("#dose-start").disabled'),true);
    assert.equal(await evaluate('document.querySelector("#dose-ready").textContent.includes("误差必须小于")'),true);
    await evaluate('document.querySelector("#dose-steps [data-tolerance]").value="0.5";document.querySelector("#dose-steps [data-tolerance]").dispatchEvent(new Event("input",{bubbles:true}))');
    await evaluate('document.querySelector("#dose-confirm").checked=true;document.querySelector("#dose-confirm").dispatchEvent(new Event("change"));document.querySelector("#dose-start").click()');
    await completeOutlet('dosing_start',{accepted:true,run_id:1},c=>{assert.equal(c.payload.config.minimum_percent,40);assert.equal(c.payload.steps[0].target_mg,12345);assert.equal(c.payload.steps[0].tolerance_mg,500);Object.assign(body.status.dosing,{active:true,state:'settling',run_id:1,step_count:1,dose_mg:[0]});});
    await waitFor('document.querySelector("#dose-result").textContent.includes("尚未完成")');
    assert.equal(await evaluate('document.querySelector("#servo-test").disabled'),true);
    assert.equal(await evaluate('document.querySelector("#summary-task").textContent'),'配液运行中');
    assert.equal(await evaluate('document.querySelector("[data-pump-action=start]").disabled'),true);
    await evaluate('document.querySelector("#dose-stop").click()');
    await completeOutlet('stop',{},()=>Object.assign(body.status.dosing,{active:false,state:'aborted',error:'cancelled'}));
    await waitFor('document.querySelector("#dosing-status").textContent.includes("已取消")');
    await evaluate('delete window.confirm');
    await screenshot('15-outlet-dosing-desktop');
    // 仅隔离测试数据库中的设备协议夹具，用于核对真实格式的正/负/大读数。
    [428510,315200,1250750,86200,-1250,3125600].forEach((value,channel)=>Object.assign(body.status.channels[channel],{
      calibrated:true,tare_ready:true,saved:true,valid:true,stable:channel!==4,mass_mg:value,filtered_mg:value
    }));
    await upload();
    await waitFor('document.querySelector(".channel[data-channel=\\"4\\"] .channel-value").textContent==="-1.25"');
    const widths=[320,390,768,1024,1440];
    for(const width of widths) {
      await command('Emulation.setDeviceMetricsOverride',{width,height:width<761?844:1100,deviceScaleFactor:1,mobile:width<761});
      for(const tab of ['overview','debug','recipes','records','settings']) {
        await click(`[data-tab=${tab}]`);
        await waitFor(`document.querySelector('.tab.active').id==='${tab}'`);
        if(tab==='debug')await evaluate('document.querySelector("#dosing-panel details").open=true');
        assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'),true,`${tab} overflow at ${width}px`);
        assert.equal(await evaluate('document.querySelectorAll(".nav[aria-current=page]").length'),1);
        assert.equal(await evaluate('document.querySelector("#device-select").checkVisibility()'),true,'device switch always available');
        const unlabeled = await evaluate('Array.from(document.querySelectorAll(".tab.active input,.tab.active select,.tab.active textarea")).filter(e=>e.type!=="hidden" && !e.labels.length && !e.getAttribute("aria-label")).map(e=>e.id)');
        assert.deepEqual(unlabeled,[],`${tab} unlabeled inputs`);
        if(width===390) await screenshot('mobile-'+tab);
        if(width===1440) await screenshot('desktop-'+tab);
      }
    }
    await command('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
    await click('[data-tab=overview]');
    assert.equal(await evaluate('getComputedStyle(document.querySelector(".tab.active")).animationName'),'none');
    await command('Emulation.setEmulatedMedia',{features:[]});
    await evaluate('state.stream.close();state.connected=false;render()');
    assert.equal(await evaluate('document.querySelector("#weight-tare").disabled'),true,'disconnect disables calibration');
    assert.equal(await evaluate('[...document.querySelectorAll("#pump-channel-grid button,#pump-channel-grid input")].every(e=>e.disabled)'),true,'disconnect disables each pump control');
    assert.equal(await evaluate('document.querySelector("#notice").checkVisibility()'),true,'disconnect notice visible');
    assert.equal(await evaluate('document.querySelector(".channel").classList.contains("stale")'),true);
    await screenshot('desktop-disconnected');
    await evaluate('connectStream()'); await waitFor('state.connected');
    // 阻断 SSE，但 API 保持可用：验证自动只读回退，不依赖手动重连。
    await command('Network.enable');
    await command('Network.setBlockedURLs',{urls:['*api/v1/stream*']});
    await evaluate('state.stream.close()');
    await waitFor('state.connected && state.transport==="poll"');
    const fallbackSequence=await evaluate('state.device.sequence');
    await waitFor(`state.device.sequence>${fallbackSequence}`,'polling receives fresh telemetry');
    await command('Network.setBlockedURLs',{urls:[]});
    await evaluate('state.retryAt=0;connectStream()');
    await waitFor('state.transport==="stream" && state.connected');
    // 真实浏览器网络离线/恢复，以及在任何操作页呈现断连原因。
    await click('[data-tab=debug]');
    await command('Network.emulateNetworkConditions',{offline:true,latency:0,downloadThroughput:0,uploadThroughput:0});
    await waitFor('!navigator.onLine && !state.connected');
    await evaluate('acceptSnapshot(state.devices,"stream")');
    assert.equal(await evaluate('state.connected'),false,'late snapshots cannot revive offline controls');
    assert.equal(await evaluate('document.querySelector("#notice").checkVisibility()'),true);
    assert.equal(await evaluate('document.querySelector("#weight-tare").disabled'),true);
    await command('Network.emulateNetworkConditions',{offline:false,latency:0,downloadThroughput:-1,uploadThroughput:-1});
    await evaluate('window.dispatchEvent(new Event("online"))');
    await waitFor('state.connected && state.transport==="stream"');
    // 设备停止上传时 SSE 心跳仍存在，样本必须过期，恢复不需要刷新网页。
    clearInterval(heartbeat);await pendingUpload;
    await waitFor('!deviceOnline()','device offline despite healthy browser connection');
    assert.equal(await evaluate('state.connected'),true);
    assert.equal(await evaluate('document.querySelector("#weight-mass").textContent.includes("最后记录")'),true);
    await upload();await waitFor('deviceOnline()');
    heartbeat=setInterval(()=>upload().catch(()=>{}),200);
    // 从其他会话注销当前 Cookie 后，SSE 必须结束本页会话而不是无限重连。
    await evaluate('fetch(new URL("auth/logout",apiRoot),{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"})');
    await waitFor('!state.active && !document.querySelector("#login").classList.contains("hidden")');
    await evaluate('document.querySelector("#password").value="browser-test-password";document.querySelector("#login-form").requestSubmit()');
    await waitFor('state.active && state.connected && C.role==="admin"');
    await waitFor('document.querySelectorAll(".recipe-item").length===1');
    // 只读账号重新登录后不能继承管理员的编辑和设备操作状态。
    gateway.business.saveUser({username:'viewer-test',password:'viewer-browser-password',role:'viewer',enabled:true},'admin');
    await evaluate('document.querySelector("#logout").click()');await waitFor('!state.active');
    await evaluate('document.querySelector("#username").value="viewer-test";document.querySelector("#password").value="viewer-browser-password";document.querySelector("#login-form").requestSubmit()');
    await waitFor('state.active && C.role==="viewer"');
    await waitFor('document.querySelectorAll(".recipe-item").length===1');
    assert.equal(await evaluate('document.querySelector("#recipe-form button[type=submit]").disabled && document.querySelector("#weight-tare").disabled && document.querySelector("#export-records").disabled'),true);
    assert.equal(await evaluate('[...document.querySelectorAll("#pump-channel-grid button,#pump-channel-grid input")].every(e=>e.disabled)'),true,'viewer cannot operate any pump');
    assert.equal(await evaluate('/模拟|演示/.test(document.body.innerText)'),false);
    clearInterval(heartbeat); await pendingUpload;
    await evaluate('document.querySelector("#logout").click()');
    await waitFor('!document.querySelector("#login").classList.contains("hidden")');
    for(const width of [320,390]) {
      await command('Emulation.setDeviceMetricsOverride',{width,height:844,deviceScaleFactor:1,mobile:true});
      assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'),true,'login overflow');
      if(width===390) await screenshot('mobile-login');
    }
    assert.deepEqual(exceptions, []);
    fs.writeFileSync(path.join(artifacts, 'result.json'), JSON.stringify({ passed: true, at: new Date().toISOString(), basePath: '/console', desktop: [1440, 1100], mobile: [390, 844], responsiveWidths:widths, checks:['nine channels','calibration round trip','eight pump cards','eight simultaneous pump requests','pump slider/input sync','single-channel stop','stop supersedes pending start','late session does not restart stopped pump','stop all pumps','channel focus retention','recipe draft protection','filter preferences','SSE silence and polling fallback','network offline and recovery','device stops reporting','session expiration and relogin','read-only role','input labels','reduced motion','all pages overflow','logout'], runtimeExceptions: exceptions, node: process.version }, null, 2));
    console.log('PASS browser: calibration, eight parallel pump controls, single/all stop and late-start cancellation, filter preferences, drafts, SSE polling fallback, network recovery, stale samples, session expiration, viewer role, five responsive widths, logout');
    console.log('Screenshots: ' + artifacts);
  } catch (error) {
    let pageState;
    if (socket?.readyState === WebSocket.OPEN) {
      pageState = await evaluate('({activeTab:document.querySelector(".tab.active")?.id,recipe:document.querySelector("#recipe-result")?.textContent,batch:document.querySelector("#batch-status")?.textContent,batchTag:document.querySelector("#batch-tag")?.textContent,calibration:document.querySelector("#cal-result")?.textContent,width:innerWidth,scrollWidth:document.documentElement.scrollWidth})').catch(() => null);
      await screenshot('failure').catch(() => {});
    }
    fs.writeFileSync(path.join(artifacts, 'result.json'), JSON.stringify({ passed: false, at: new Date().toISOString(), error: error.message, pageState, runtimeExceptions: exceptions, node: process.version }, null, 2));
    throw error;
  } finally {
    clearInterval(heartbeat);
    socket?.close(); if (browser && browser.exitCode === null) { browser.kill(); await Promise.race([once(browser, 'exit'), sleep(3000)]); }
    gateway.close();
    // Windows 下浏览器子进程可能稍后才释放文件；仅删除本测试创建的临时目录。
    try { fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { console.error('Temporary browser profile remains: ' + directory); }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
