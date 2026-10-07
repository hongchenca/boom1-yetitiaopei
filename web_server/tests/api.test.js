const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { once } = require('node:events');
const { setTimeout: sleep } = require('node:timers/promises');
const { DatabaseSync } = require('node:sqlite');
const { createServer } = require('../server');
const { Store } = require('../store');
const {defaults:doseConfig}=require('../public/dosing-config');

const real = { id: 'esp32-001', name: 'test ESP', token: 'test-token-only', simulation: false };
function outletTelemetry(sequence=1) {
  const b=nineTelemetry(sequence);
  b.capabilities.actuator=true;
  b.status.actuator={...pumpTelemetry().status.actuator,pwm_hz:50,minimum_percent:40,auxiliaries_supported:true,
    air_percent:0,servo_pulse_us:0,air_remaining_ms:0,servo_remaining_ms:0};
  for(const w of b.status.channels)Object.assign(w,{valid:true,stable:true,calibrated:true,tare_ready:true,age_ms:0,mass_mg:200000,filtered_mg:200000});
  b.status.channels[8].mass_mg=b.status.channels[8].filtered_mg=0;
  b.status.dosing={supported:true,active:false,positions_saved:true,vessel_us:1000,waste_us:2000,position_version:2,run_id:0,
    state:'idle',error:'ok',step:0,step_count:0,jogs:0,delivered_mg:0,source_loss_mg:0,flow_mg_s:0,dose_mg:[]};
  return b;
}
test('outlet and dosing: lease, deadzone, position version, local batch acceptance, stop and authoritative final state', async t=>{
  const c=await fixture(t,{devices:[{...real,actuator:true,weight:true}]});
  const b=outletTelemetry();assert.equal((await c.upload(b)).status,200);
  const session=(await c.req(`/devices/${real.id}/debug-sessions`,{})).data;
  assert.equal((await c.queue('debug_apply',{channel:0,value_percent:39,expected_config_version:1,session_id:session.channel_session_ids[0]})).data.error,'duty_below_deadzone');
  const servo={channel:9,pulse_us:1500,expected_config_version:1,session_id:session.session_id};
  assert.equal((await c.queue('aux_apply',{...servo,pulse_us:2501})).status,400);
  assert.equal((await c.queue('aux_apply',{...servo,session_id:'wrong'})).data.error,'debug_session_expired');
  const queued=await c.queue('aux_apply',servo);assert.equal(queued.status,202);
  const command=(await c.poll()).data.command;assert.equal(command.type,'aux_apply');assert.ok(command.lease_deadline_uptime_ms>0);
  const ack=async(command,result={})=>c.req(`/device/commands/${command.id}/ack`,{schema_version:1,device_id:real.id,boot_id:'boot-a',status:'completed',result},true);
  await ack(command,{applied_pulse_us:1500});
  b.sequence++;b.status.actuator.servo_pulse_us=1500;b.status.actuator.servo_remaining_ms=1000;await c.upload(b);
  assert.equal((await c.queue('outlet_configure',{vessel_us:1000,waste_us:2000,expected_position_version:2})).data.error,'pump_busy');
  const stop=(await c.queue('stop')).data.command;await c.poll();await ack(stop);
  b.sequence++;b.status.actuator.servo_pulse_us=0;b.status.actuator.servo_remaining_ms=0;await c.upload(b);
  const payload={steps:[{channel:0,target_mg:10000,tolerance_mg:500}],config:{...doseConfig},expected_position_version:2};
  assert.equal((await c.queue('dosing_start',{...payload,expected_position_version:1})).data.error,'position_version_conflict');
  assert.equal((await c.queue('dosing_start',{...payload,config:{...doseConfig,fine_percent:39}})).data.error,'invalid_dosing_config');
  const start=(await c.queue('dosing_start',payload)).data.command;assert.ok(start.control_sequence>stop.control_sequence);
  assert.equal((await c.poll()).data.command.id,start.id);await ack(start,{accepted:true,run_id:1});
  assert.equal(c.gateway.store.device(real.id).status.dosing.state,'idle','acceptance is not completion');
  Object.assign(b.status.dosing,{active:true,state:'settling',run_id:1,step_count:1,dose_mg:[0]});b.sequence++;await c.upload(b);
  assert.equal((await c.queue('dosing_start',payload)).data.error,'dosing_busy');
  assert.equal((await c.queue('weight_reset',{channel:0,expected_calibration_version:1})).data.error,'dosing_busy');
  assert.equal((await c.req(`/devices/${real.id}/debug-sessions`,{})).data.error,'dosing_busy');
  const cancelled=(await c.queue('stop')).data.command;await c.poll();await ack(cancelled);
  Object.assign(b.status.dosing,{active:false,state:'aborted',error:'cancelled'});b.sequence++;await c.upload(b);
  const next=(await c.queue('dosing_start',payload)).data.command;
  assert.equal((await c.queue('stop',{channel:0})).status,202);
  assert.equal(c.gateway.store.command(next.id).state,'expired','single-channel stop also cancels pending batch');
  Object.assign(b.status.dosing,{state:'done',error:'ok',delivered_mg:9980,source_loss_mg:10300,dose_mg:[9980]});b.sequence++;await c.upload(b);
  assert.deepEqual(c.gateway.store.device(real.id).status.dosing.dose_mg,[9980]);
});
const sim = { id: 'sim-001', name: 'test simulator', token: 'sim-token-only', simulation: true };
function telemetry(sequence = 1, boot = 'boot-a') {
  return { schema_version: 1, device_id: real.id, boot_id: boot, sequence, uptime_ms: sequence * 1000,
    sample_age_ms: 0, firmware: 'web-client-0.2.0',
    capabilities: { telemetry: true, events: true, command_poll: true, test_input: false, weight: false, actuator: false, simulation: false },
    status: { upload_interval_ms: 1000, config_version: 1, free_heap_bytes: 180000, wifi_rssi: -46,
      channels: Array.from({ length: 9 }, (_, channel) => ({ channel, mass_mg: null, filtered_mg: null, valid: false, stable: false, age_ms: 0 })),
      actuator: { channel: 0, requested_percent: 0, applied_percent: 0, output: 'hardware_pending' }, task_state: 'idle' } };
}
async function fixture(t, overrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yeti-api-'));
  const config = { dataDir, host: '127.0.0.1', port: 0, basePath: '', username: 'admin', password: crypto.randomUUID(),
    devices: [real, sim], simulate: false, simDevice: sim, credentialFile: '(test only)', ...overrides };
  const gateway = createServer(config); gateway.listen(); await once(gateway.server, 'listening');
  const origin = 'http://127.0.0.1:' + gateway.server.address().port;
  let cookie;
  const raw = async (p, body, headers = {}) => fetch(origin + config.basePath + '/api/v1' + p, {
    method: body === undefined ? 'GET' : 'POST', headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) });
  const req = async (p, body, device = false) => {
    const r = await raw(p, body, device ? { 'X-Device-Id': real.id, 'X-Device-Token': real.token } : { Cookie: cookie });
    return { status: r.status, data: await r.json() };
  };
  const login = await raw('/auth/login', { username: config.username, password: config.password });
  assert.equal(login.status, 200); cookie = login.headers.get('set-cookie').split(';')[0]; await login.json();
  t.after(async () => { gateway.close(); await sleep(50); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return { gateway, config, origin, cookie, raw, req,
    upload: body => req('/device/telemetry', body, true),
    poll: (boot = 'boot-a', wait_ms = 0) => req('/device/commands/poll', { schema_version: 1, device_id: real.id, boot_id: boot, wait_ms }, true),
    queue: (type, payload = {}, id = crypto.randomUUID(), deviceId = real.id) => req('/devices/' + deviceId + '/commands', { schema_version: 1, request_id: id, type, payload }) };
}
async function until(read, check, timeout = 8000) {
  const deadline = Date.now() + timeout;
  do { const value = await read(); if (check(value)) return value; await sleep(50); } while (Date.now() < deadline);
  assert.fail('condition did not become true within ' + timeout + ' ms');
}

test('authentication, schema, real hardware exclusion and duplicate telemetry', async t => {
  const c = await fixture(t);
  assert.equal((await c.raw('/devices')).status, 401);
  assert.equal((await c.raw('/device/telemetry', telemetry(), { 'X-Device-Id': real.id, 'X-Device-Token': 'wrong' })).status, 401);
  for (const change of [b => b.schema_version = 2, b => b.device_id = sim.id, b => b.capabilities.actuator = true,
    b => b.status.channels.pop(), b => b.status.channels[0].mass_mg = 100]) {
    const b = telemetry(); change(b); assert.equal((await c.upload(b)).status, 400);
  }
  assert.equal((await c.upload(telemetry())).status, 200);
  const before = (await c.req('/devices/' + real.id)).data;
  assert.equal(before.online, true); assert.equal(before.status.channels[0].filtered_mg, null);
  await sleep(20);
  assert.equal((await c.upload(telemetry())).data.duplicate, true);
  assert.equal((await c.req('/devices/' + real.id)).data.received_at, before.received_at);
  assert.equal((await c.queue('stop')).status, 409);
  assert.equal((await c.queue('ping', { unexpected: 'x'.repeat(2500) })).status, 400);
  assert.equal((await c.queue('set_upload_interval', { interval_ms: 100, expected_config_version: 1 })).status, 400);
  assert.equal((await c.queue('set_upload_interval', { interval_ms: 500, expected_config_version: 2 })).status, 409);
});

test('serial and demonstration inputs are rejected by the real gateway', async t => {
  const c = await fixture(t, {devices:[{...real,serial_test:true}, sim]});
  const body=telemetry(); body.capabilities.test_input=true;
  assert.equal((await c.upload(body)).status,400);
  body.capabilities.test_input=false; body.capabilities.simulation=true;
  assert.equal((await c.upload(body)).status,400);
  assert.deepEqual((await c.req('/devices')).data.devices.map(d=>d.id),[real.id]);
});

function weightTelemetry(sequence = 1, boot = 'boot-a') {
  const body = telemetry(sequence, boot);
  body.capabilities.weight = true;
  Object.assign(body.status.channels[0], {raw_count:12000, average_raw:12010, samples:16,
    calibrated:false, tare_ready:false, calibration_version:1, last_error:'ESP_OK'});
  return body;
}

test('first HX711 raw and calibrated telemetry reaches persisted device state', async t => {
  const c = await fixture(t, {devices:[{...real, weight:true}, sim]});
  const body = weightTelemetry();
  assert.equal((await c.upload(body)).status, 200);
  let device = (await c.req('/devices/' + real.id)).data;
  assert.equal(device.weight_enabled, true);
  assert.equal(device.status.channels[0].raw_count, 12000);
  assert.equal(device.status.channels[0].mass_mg, null);
  const mass = weightTelemetry(2);
  Object.assign(mass.status.channels[0], {calibrated:true, tare_ready:true, calibration_version:3,
    mass_mg:100001, filtered_mg:100000, valid:true});
  assert.equal((await c.upload(mass)).status, 200);
  device = (await c.req('/devices/' + real.id)).data;
  assert.equal(device.status.channels[0].filtered_mg, 100000);
  for (const mutate of [b=>b.status.channels[0].calibrated=false,
    b=>b.status.channels[0].age_ms=501, b=>b.status.channels[0].raw_count=null,
    b=>Object.assign(b.status.channels[1], {mass_mg:100, filtered_mg:100, valid:true}),
    b=>b.capabilities.test_input=true]) {
    const invalid = structuredClone(mass); invalid.sequence++;
    mutate(invalid); assert.equal((await c.upload(invalid)).status, 400);
  }
  const disconnected = weightTelemetry(3);
  Object.assign(disconnected.status.channels[0], {raw_count:null, average_raw:null, samples:0,
    age_ms:60000, last_error:'ESP_ERR_TIMEOUT'});
  assert.equal((await c.upload(disconnected)).status, 200);
  device = (await c.req('/devices/' + real.id)).data;
  assert.equal(device.status.channels[0].valid, false);
  assert.equal(device.status.channels[0].filtered_mg, null);
  assert.equal((await c.queue('weight_tare', {channel:0, expected_calibration_version:1})).status, 409);
  // 第一个快照已经保存，读回历史确认 raw 单位和未校准空值不被替换。
  const history = (await c.req('/devices/' + real.id + '/history')).data;
  assert.equal(history[0].status.channels[0].raw_count, 12000);
  assert.equal(history[0].status.channels[0].mass_mg, null);
});

test('HX711 requires device authorization and calibration command round trip', async t => {
  const unauthorized = await fixture(t);
  assert.equal((await unauthorized.upload(weightTelemetry())).status, 400);
  const c = await fixture(t, {devices:[{...real, weight:true}, sim]});
  await c.upload(weightTelemetry());
  assert.equal((await c.queue('weight_calibrate', {channel:0, expected_calibration_version:1, reference_mg:100000})).status, 409);
  assert.equal((await c.queue('weight_tare', {channel:1, expected_calibration_version:1})).status, 409);
  assert.equal((await c.queue('weight_tare', {channel:0, expected_calibration_version:2})).status, 409);
  const request = crypto.randomUUID();
  const queued = await c.queue('weight_tare', {channel:0, expected_calibration_version:1}, request);
  assert.equal(queued.status, 202);
  const command = (await c.poll()).data.command;
  assert.equal(command.id, queued.data.command.id);
  const ack = {schema_version:1, device_id:real.id, boot_id:'boot-a', status:'completed',
    result:{calibration_version:2, calibrated:false}};
  assert.equal((await c.req(`/device/commands/${command.id}/ack`, ack, true)).status, 200);
  assert.equal((await c.req(`/device/commands/${command.id}/ack`, ack, true)).status, 200);
  assert.equal((await c.queue('weight_tare', {channel:0, expected_calibration_version:1}, request)).data.command.id, command.id);
  const afterTare = weightTelemetry(2);
  Object.assign(afterTare.status.channels[0], {tare_ready:true, calibration_version:2});
  assert.equal((await c.upload(afterTare)).status, 200);
  for (const value of [0, -1, 1.1, 1000000001])
    assert.equal((await c.queue('weight_calibrate', {channel:0, expected_calibration_version:2, reference_mg:value})).status, 400);
  const calibration = await c.queue('weight_calibrate', {channel:0, expected_calibration_version:2, reference_mg:100000});
  assert.equal(calibration.status, 202);
  assert.equal((await c.poll()).data.command.type, 'weight_calibrate');
  await c.upload(weightTelemetry(1, 'boot-b'));
  assert.equal((await c.req('/commands/' + calibration.data.command.id)).data.command.status, 'unknown');
  assert.equal((await c.req('/devices/' + real.id)).data.status.channels[0].calibrated, false);
});

test('wire command round trip, authoritative telemetry, request and ack idempotency', async t => {
  const c = await fixture(t); await c.upload(telemetry());
  const payload = { interval_ms: 500, expected_config_version: 1 }, requestId = crypto.randomUUID();
  const queued = await c.queue('set_upload_interval', payload, requestId);
  assert.equal(queued.status, 202);
  const command = queued.data.command;
  const ack = { schema_version: 1, device_id: real.id, boot_id: 'boot-a', status: 'completed', result: { applied_interval_ms: 500, applied_config_version: 2 } };
  const ackPath = '/device/commands/' + command.id + '/ack';
  assert.equal((await c.req(ackPath, ack, true)).status, 409);
  assert.equal((await c.queue('set_upload_interval', payload, requestId)).data.command.id, command.id);
  assert.equal((await c.queue('ping', {}, requestId)).status, 409);
  const polled = (await c.poll()).data.command;
  assert.equal(polled.id, command.id); assert.equal(polled.boot_id, 'boot-a'); assert.equal(polled.schema_version, 1);
  assert.equal(polled.type, 'set_upload_interval'); assert.deepEqual(polled.payload, payload); assert.ok(polled.deadline_uptime_ms > 1000);
  assert.equal((await c.poll()).data.command.id, command.id);
  assert.equal((await c.req(ackPath, ack, true)).status, 200);
  assert.equal((await c.req(ackPath, ack, true)).status, 200);
  assert.equal((await c.req(ackPath, { ...ack, result: { ok: false } }, true)).status, 409);
  assert.equal((await c.req('/commands/' + command.id)).data.command.status, 'completed');
  assert.equal((await c.req('/devices/' + real.id)).data.status.config_version, 1);
  const next = telemetry(2); next.status.upload_interval_ms = 500; next.status.config_version = 2; await c.upload(next);
  assert.equal((await c.req('/devices/' + real.id)).data.status.upload_interval_ms, 500);
  assert.equal((await c.poll()).data.command, null);
});

test('long poll wakes for commands without blocking telemetry and disallows concurrent poll', async t => {
  const c = await fixture(t); await c.upload(telemetry());
  const waiting = c.poll('boot-a', 2000); await sleep(100);
  assert.equal((await c.poll('boot-a', 100)).status, 409);
  assert.equal((await c.upload(telemetry(2))).status, 200);
  const queued = await c.queue('ping'); assert.equal(queued.status, 202);
  assert.equal((await waiting).data.command.id, queued.data.command.id);
});

test('device reboot cancels pending commands, rejects old boot, deduplicates events', async t => {
  const c = await fixture(t); await c.upload(telemetry());
  const queued = await c.queue('ping'); await c.upload(telemetry(1, 'boot-b'));
  assert.equal((await c.req('/commands/' + queued.data.command.id)).data.command.state, 'unknown');
  assert.equal((await c.upload(telemetry(2))).status, 409);
  assert.equal((await c.poll()).status, 409);
  const event = { schema_version: 1, device_id: real.id, boot_id: 'boot-b', event_id: 'event-1', type: 'boot', payload: {} };
  assert.equal((await c.req('/device/events', event, true)).data.duplicate, false);
  assert.equal((await c.req('/device/events', event, true)).data.duplicate, true);
  assert.equal((await c.req('/devices/' + real.id + '/events')).data.events.length, 1);
});

test('SQLite restart invalidates pending state; expiry and consistent backup', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yeti-store-')); let store;
  t.after(() => { store?.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  store = new Store(dir, [real]); store.ingest(telemetry());
  const cmd = store.enqueue(store.device(real.id), { type: 'ping', payload: {}, request_id: 'restart-test' });
  store.close(); store = new Store(dir, [real]);
  assert.equal(store.device(real.id).online, false); assert.equal(store.command(cmd.id).state, 'unknown');
  store.ingest(telemetry()); assert.equal(store.device(real.id).online, false);
  store.ingest(telemetry(2)); assert.equal(store.device(real.id).online, true);
  const expired = store.enqueue(store.device(real.id), { type: 'ping', payload: {}, request_id: 'expire-test' });
  expired.expires_at = Date.now() - 1; store.saveCommand(expired); store.prune();
  assert.equal(store.next(real.id, 'boot-a'), null); assert.equal(store.command(expired.id).state, 'expired');
  const backup = path.join(dir, 'backup.db'); store.db.prepare('VACUUM INTO ?').run(backup);
  const copy = new DatabaseSync(backup); assert.equal(Object.values(copy.prepare('PRAGMA integrity_check').get())[0], 'ok');
  assert.equal(copy.prepare('SELECT count(*) AS n FROM snapshots').get().n, 1); copy.close();
});

test('base path assets, SSE framing, origin guard and logout', async t => {
  const c = await fixture(t, { basePath: '/console' });
  assert.equal((await fetch(c.origin + '/')).status, 404);
  assert.equal((await fetch(c.origin + '/console', { redirect: 'manual' })).headers.get('location'), '/console/');
  assert.equal((await fetch(c.origin + '/console/')).status, 200);
  assert.equal((await fetch(c.origin + '/console/app.js')).status, 200);
  assert.equal((await fetch(c.origin + '/console/weight-filter.js')).status, 200);
  assert.equal((await c.raw('/devices', undefined, { Cookie: c.cookie, Origin: 'http://unrelated.invalid' })).status, 403);
  const abort = new AbortController();
  const stream = await fetch(c.origin + '/console/api/v1/stream', { headers: { Cookie: c.cookie }, signal: abort.signal });
  assert.equal(stream.status, 200);
  const reader = stream.body.getReader(); const { value } = await reader.read();
  const frame = new TextDecoder().decode(value);
  assert.ok(frame.includes('event: snapshot' + String.fromCharCode(10) + 'data: '));
  assert.ok(frame.includes('retry: 1000'));
  assert.ok(frame.includes('"devices"')); await reader.cancel(); abort.abort();
  assert.equal((await c.req('/auth/logout', {})).status, 200);
  assert.equal((await c.req('/devices')).status, 401);
});

test('CLI duplicate start leaves queued commands and the existing database untouched',async t=>{
  const c=await fixture(t);await c.upload(telemetry());
  const queued=(await c.queue('ping')).data.command;
  fs.writeFileSync(path.join(c.config.dataDir,'connection.json'),JSON.stringify({username:'admin',password:'duplicate-test-password',devices:[{...real,token:'duplicate-device-token-1234567890'}]}));
  const {spawn}=require('node:child_process');
  const child=spawn(process.execPath,[path.resolve(__dirname,'../server.js')],{windowsHide:true,env:{...process.env,APP_HOST:'127.0.0.1',APP_PORT:String(c.gateway.server.address().port),APP_DATA_DIR:c.config.dataDir},stdio:['ignore','pipe','pipe']});
  let log='';child.stderr.on('data',b=>log+=b);child.stdout.on('data',b=>log+=b);
  const [code]=await once(child,'exit');assert.equal(code,1);assert.ok(log.includes('已有服务运行'));
  assert.equal(c.gateway.store.command(queued.id).state,'queued','failed listener must not invalidate real pending work');
  assert.equal((await c.poll()).data.command.id,queued.id);
});

test('revoked web sessions receive an explicit SSE expiry event',async t=>{
 const c=await fixture(t);const abort=new AbortController();
 const response=await fetch(c.origin+'/api/v1/stream',{headers:{Cookie:c.cookie},signal:abort.signal});const reader=response.body.getReader();await reader.read();
 await c.req('/auth/logout',{});
 let frames='';await Promise.race([(async()=>{while(true){const r=await reader.read();if(r.done)break;frames+=new TextDecoder().decode(r.value);}})(),sleep(2000).then(()=>{throw Error('session stream not closed');})]);
 assert.ok(frames.includes('event: session-expired'));await reader.cancel();abort.abort();
});

function nineTelemetry(sequence=1) {
  const body=weightTelemetry(sequence);
  body.status.weight_service_version=2;
  body.status.upload_interval_ms=200;
  for(const channel of body.status.channels) Object.assign(channel, {
    enabled:true,initialized:true,raw_count:12000+channel.channel,average_raw:12000+channel.channel,
    samples:16,calibrated:false,tare_ready:false,calibration_version:1,last_error:'ESP_OK',storage_error:'ESP_OK',
    saved:false,calibration_ready:true,stable:false,raw_band:200,noise_band_mg:50,noise_mg:0,sample_period_ms:100,sample_sequence:20});
  return body;
}

test('nine scales: independent commands, stable gate, maintenance and disabled channels',async t=>{
  const c=await fixture(t,{devices:[{...real,weight:true}]});
  const body=nineTelemetry(); assert.equal((await c.upload(body)).status,200);
  for(const ch of [0,4,8]) {
    const command=(await c.queue('weight_tare',{channel:ch,expected_calibration_version:1})).data.command;
    assert.equal((await c.poll()).data.command.payload.channel,ch);
    assert.equal((await c.req(`/device/commands/${command.id}/ack`,{schema_version:1,device_id:real.id,boot_id:'boot-a',status:'completed',result:{calibration_version:2,calibrated:false}},true)).status,200);
  }
  body.sequence++; body.uptime_ms+=1000; body.status.channels[8].calibration_ready=false;
  assert.equal((await c.upload(body)).status,200);
  assert.equal((await c.queue('weight_tare',{channel:8,expected_calibration_version:1})).status,409);
  assert.equal((await c.queue('weight_configure',{channel:8,expected_calibration_version:1,raw_band:0,noise_band_mg:50})).status,400);
  const config=await c.queue('weight_configure',{channel:8,expected_calibration_version:1,raw_band:300,noise_band_mg:100});
  assert.equal(config.status,202); await c.poll();
  await c.req(`/device/commands/${config.data.command.id}/ack`,{schema_version:1,device_id:real.id,boot_id:'boot-a',status:'completed',result:{calibration_version:2}},true);
  const disabled=nineTelemetry(3); Object.assign(disabled.status.channels[7],{enabled:false});
  assert.equal((await c.upload(disabled)).status,200);
  assert.equal((await c.queue('weight_reset',{channel:7,expected_calibration_version:1})).status,409);
  assert.equal((await c.queue('weight_reset',{channel:8,expected_calibration_version:1})).status,202);
});

test('telemetry is pushed through SSE on receipt, without waiting for the 1 second heartbeat',async t=>{
  const c=await fixture(t,{devices:[{...real,weight:true}]});
  const abort=new AbortController();
  const response=await fetch(c.origin+'/api/v1/stream',{headers:{Cookie:c.cookie},signal:abort.signal});
  const reader=response.body.getReader(); await reader.read();
  const delays=[];
  for(let i=1;i<=5;i++) {
    const start=performance.now();
    const reading=(async()=>{let frames=''; while(!frames.includes(`"sequence":${i},`)) {
      const result=await reader.read(); if(result.done) throw new Error('SSE ended');
      frames+=new TextDecoder().decode(result.value);
    } return performance.now()-start;})();
    assert.equal((await c.upload(nineTelemetry(i))).status,200);
    const elapsed=await Promise.race([reading,sleep(450).then(()=>{throw new Error('SSE push exceeded 450ms');})]);
    delays.push(Math.round(elapsed));
  }
  console.log('SSE receipt latency ms:',delays.join(','));
  await reader.cancel(); abort.abort();
});

function pumpTelemetry(sequence = 1, parallel = true) {
  const body = telemetry(sequence);
  body.capabilities.actuator = true;
  Object.assign(body.status.actuator, {config_version:1,pwm_hz:1000,maximum_percent:80,remaining_ms:0,
    fault_latched:false,shutdown_failed:false,registers_verified:true,duty_percent:Array(8).fill(0),
    parallel_supported:parallel,remaining_ms_by_channel:Array(8).fill(0)});
  return body;
}

test('eight pump commands queue independently, single stop cancels only its channel and invalidates its token', async t => {
  const c = await fixture(t,{devices:[{...real,actuator:true}]});
  const body = pumpTelemetry(); assert.equal((await c.upload(body)).status,200);
  const session = (await c.req(`/devices/${real.id}/debug-sessions`,{})).data;
  assert.equal(new Set(session.channel_session_ids).size,8);
  const payload = channel => ({channel,value_percent:20+channel,expected_config_version:1,session_id:session.channel_session_ids[channel]});
  const starts = await Promise.all(Array.from({length:8},(_,channel)=>c.queue('debug_apply',payload(channel))));
  assert.deepEqual(starts.map(r=>r.status),Array(8).fill(202));
  assert.equal((await c.queue('debug_apply',payload(0))).data.error,'command_pending');
  assert.equal((await c.queue('ping')).data.error,'command_pending');
  assert.equal((await c.queue('debug_apply',{...payload(1),session_id:session.session_id})).data.error,'debug_session_expired');
  const stopped = await c.queue('stop',{channel:1}); assert.equal(stopped.status,202);
  assert.equal(c.gateway.store.command(starts[1].data.command.id).state,'expired');
  for (const channel of [0,2,3,4,5,6,7]) assert.equal(c.gateway.store.command(starts[channel].data.command.id).state,'queued');
  assert.equal((await c.queue('debug_apply',payload(1))).data.error,'debug_session_expired');
  const renewed = (await c.req(`/devices/${real.id}/debug-sessions`,{})).data;
  assert.notEqual(renewed.channel_session_ids[1],session.channel_session_ids[1]);
  assert.equal(renewed.channel_session_ids[2],session.channel_session_ids[2]);
  const delivered = []; let control = 0;
  for (let i=0;i<8;i++) {
    const command = (await c.poll()).data.command;
    assert.ok(command.control_sequence > control,'FIFO keeps hardware control sequences increasing'); control = command.control_sequence;
    delivered.push([command.type,command.payload.channel]);
    if (command.type === 'debug_apply') body.status.actuator.duty_percent[command.payload.channel] = command.payload.value_percent;
    else body.status.actuator.duty_percent[command.payload.channel] = 0;
    assert.equal((await c.req(`/device/commands/${command.id}/ack`,{schema_version:1,device_id:real.id,boot_id:'boot-a',status:'completed',result:{applied_value_percent:body.status.actuator.duty_percent[command.payload.channel]}},true)).status,200);
  }
  assert.deepEqual(delivered.map(([type,ch])=>`${type}:${ch}`).sort(),['debug_apply:0','debug_apply:2','debug_apply:3','debug_apply:4','debug_apply:5','debug_apply:6','debug_apply:7','stop:1'].sort());
  assert.equal((await c.poll()).data.command,null);
  Object.assign(body,{sequence:2,uptime_ms:2000});
  Object.assign(body.status.actuator,{channel:7,applied_percent:27,remaining_ms:4500,remaining_ms_by_channel:[4100,0,4200,4300,4400,4500,4600,4700]});
  assert.equal((await c.upload(body)).status,200);
  const state = (await c.req(`/devices/${real.id}`)).data.status.actuator;
  assert.deepEqual(state.duty_percent,[20,0,22,23,24,25,26,27]);
  assert.deepEqual(state.remaining_ms_by_channel,body.status.actuator.remaining_ms_by_channel);
});

test('all-pump stop supersedes pending work and lease, while old firmware preserves single-pump control', async t => {
  const c = await fixture(t,{devices:[{...real,actuator:true}]});
  assert.equal((await c.upload(pumpTelemetry())).status,200);
  const session = (await c.req(`/devices/${real.id}/debug-sessions`,{})).data;
  const starts = await Promise.all([0,3].map(channel=>c.queue('debug_apply',{channel,value_percent:30,expected_config_version:1,session_id:session.channel_session_ids[channel]})));
  assert.deepEqual(starts.map(r=>r.status),[202,202]);
  const delivered = (await c.poll()).data.command;
  const stop = await c.queue('stop'); assert.equal(stop.status,202);
  assert.equal(c.gateway.store.command(delivered.id).state,'expired');
  assert.ok(starts.every(r=>c.gateway.store.command(r.data.command.id).state==='expired'));
  assert.equal((await c.queue('debug_apply',{channel:3,value_percent:30,expected_config_version:1,session_id:session.channel_session_ids[3]})).data.error,'debug_session_expired');
  assert.equal((await c.poll()).data.command.id,stop.data.command.id);
  assert.equal((await c.req(`/device/commands/${stop.data.command.id}/ack`,{schema_version:1,device_id:real.id,boot_id:'boot-a',status:'completed',result:{}},true)).status,200);
  const legacy = pumpTelemetry(2,false); assert.equal((await c.upload(legacy)).status,200);
  assert.equal((await c.queue('stop',{channel:0})).data.error,'firmware_upgrade_required');
  const oldSession = (await c.req(`/devices/${real.id}/debug-sessions`,{})).data;
  assert.equal(oldSession.channel_session_ids,undefined);
  assert.equal((await c.queue('debug_apply',{channel:0,value_percent:30,expected_config_version:1,session_id:oldSession.session_id})).status,202);
  assert.equal((await c.queue('debug_apply',{channel:1,value_percent:30,expected_config_version:1,session_id:oldSession.session_id})).data.error,'command_pending');
  const invalid = pumpTelemetry(3,false); invalid.status.actuator.duty_percent=[20,30,0,0,0,0,0,0]; invalid.status.actuator.applied_percent=20;
  assert.equal((await c.upload(invalid)).status,400,'legacy firmware cannot claim simultaneous pump output');
});
