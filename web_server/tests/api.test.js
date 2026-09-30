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

const real = { id: 'esp32-001', name: 'test ESP', token: 'test-token-only', simulation: false };
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

test('serial test identity may upload explicit samples only when enabled', async t => {
  const c = await fixture(t, { devices: [{ ...real, serial_test: true }, sim] });
  const body = telemetry();
  body.capabilities.test_input = true;
  body.status.channels[0] = { channel: 0, mass_mg: 12345, filtered_mg: 12300, valid: true, stable: true, age_ms: 0 };
  assert.equal((await c.upload(body)).status, 200);
  assert.equal((await c.req('/devices/' + real.id)).data.status.channels[0].filtered_mg, 12300);
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
  assert.equal((await c.raw('/devices', undefined, { Cookie: c.cookie, Origin: 'http://unrelated.invalid' })).status, 403);
  const abort = new AbortController();
  const stream = await fetch(c.origin + '/console/api/v1/stream', { headers: { Cookie: c.cookie }, signal: abort.signal });
  assert.equal(stream.status, 200);
  const reader = stream.body.getReader(); const { value } = await reader.read();
  const frame = new TextDecoder().decode(value);
  assert.ok(frame.startsWith('event: snapshot' + String.fromCharCode(10) + 'data: '));
  assert.ok(frame.includes('"devices"')); await reader.cancel(); abort.abort();
  assert.equal((await c.req('/auth/logout', {})).status, 200);
  assert.equal((await c.req('/devices')).status, 401);
});

test('HTTP simulator applies interval, acknowledges commands and stops output independently', { timeout: 16000 }, async t => {
  const c = await fixture(t, { simulate: true });
  const snapshot = () => c.req('/devices/' + sim.id).then(r => r.data);
  await until(snapshot, d => d.online);
  const interval = await c.queue('set_upload_interval', { interval_ms: 200, expected_config_version: 1 }, crypto.randomUUID(), sim.id);
  assert.equal(interval.status, 202);
  await until(snapshot, d => d.status?.config_version === 2 && d.status.upload_interval_ms === 200);
  assert.equal((await c.req('/commands/' + interval.data.command.id)).data.command.state, 'completed');
  const lease = await c.req('/devices/' + sim.id + '/debug-sessions', {}); assert.equal(lease.status, 200);
  const debug = await c.queue('debug_apply', { session_id: lease.data.session_id, channel: 3, value_percent: 35 }, crypto.randomUUID(), sim.id);
  assert.equal(debug.status, 202);
  await until(snapshot, d => d.status?.actuator.applied_percent === 35);
  await until(snapshot, d => d.status?.actuator.applied_percent === 0, 7000);
  assert.equal((await c.req('/devices/' + sim.id + '/events')).data.events[0].type, 'boot');
  assert.ok((await c.req('/devices/' + sim.id + '/history')).data.length > 0);
});
