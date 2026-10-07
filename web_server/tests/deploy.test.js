const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { once } = require('node:events');
const { setTimeout: sleep } = require('node:timers/promises');
const { DatabaseSync } = require('node:sqlite');
const execute = promisify(execFile);
const release = process.env.YETI_RELEASE_DIR;
assert.ok(release, 'Set YETI_RELEASE_DIR to the freshly extracted customer package');

async function port() {
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const value = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  return value;
}

async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yeti-client-package-'));
  const app = path.join(directory, 'app');
  fs.cpSync(release, app, { recursive: true });
  const config = { APP_HOST: '127.0.0.1', APP_PORT: await port(), APP_BASE_PATH: '/console',
    APP_DATA_DIR: path.join(directory, 'customer data'), APP_SECURE_COOKIE: true };
  const settingsFile = path.join(app, 'deploy', 'settings.json');
  const save = () => fs.writeFileSync(settingsFile, JSON.stringify(config));
  save();
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('APP_') || key === 'YETI_SETTINGS_FILE') delete env[key];
  const entry = path.join(app, 'deploy', 'manage.cjs');
  const run = (action, ...args) => execute(process.execPath, [entry, action, ...args], { cwd: os.tmpdir(), env, windowsHide: true, timeout: 15000 });
  const children = [];
  const stop = async child => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const done = once(child, 'exit'); child.kill(); await done;
  };
  const start = async () => {
    const child = spawn(process.execPath, [entry, 'start'], { cwd: os.tmpdir(), env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    let logs = '';
    child.stdout.on('data', chunk => { logs += chunk; });
    child.stderr.on('data', chunk => { logs += chunk; });
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) throw new Error(`Isolated server failed: ${logs}`);
      try {
        const response = await fetch(url() + '/api/v1/healthz', { signal: AbortSignal.timeout(300) });
        if (response.ok) return { child, logs: () => logs };
      } catch {}
      await sleep(50);
    }
    throw new Error('Isolated server startup timed out');
  };
  const url = () => `http://127.0.0.1:${config.APP_PORT}${config.APP_BASE_PATH}`;
  t.after(async () => {
    for (const child of children) await stop(child);
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return { directory, app, config, run, save, start, stop, url,
    credentials: () => JSON.parse(fs.readFileSync(path.join(config.APP_DATA_DIR, 'connection.json'), 'utf8')) };
}

test('customer archive: integrity, independent paths, idempotent identity, tamper rejection', async t => {
  const c = await fixture(t);
  assert.equal(fs.existsSync(path.join(c.app, 'data')), false);
  assert.equal(fs.existsSync(path.join(c.app, 'artifacts')), false);
  assert.equal(fs.existsSync(path.join(c.app, 'deploy', '.env')), false);
  await c.run('verify');
  await c.run('init');
  const identity = c.credentials();
  assert.ok(identity.password.length >= 20);
  assert.equal(identity.devices[0].weight, true);
  assert.equal(identity.devices[0].actuator, true);
  const again = await c.run('init');
  assert.deepEqual(c.credentials(), identity);
  assert.equal((again.stdout + again.stderr).includes(identity.password), false);
  assert.equal((again.stdout + again.stderr).includes(identity.devices[0].token), false);
  assert.equal(fs.existsSync(path.join(c.config.APP_DATA_DIR, 'telemetry-v1.db')), false);
  fs.appendFileSync(path.join(c.app, 'public', 'app.js'), '\n// changed\n');
  await assert.rejects(c.run('verify'), /文件校验失败/);
  await assert.rejects(c.run('start'), /文件校验失败/);
});

test('occupied port / invalid settings fail before writing customer data', async t => {
  const c = await fixture(t);
  const occupied = net.createServer();
  occupied.listen(c.config.APP_PORT, '127.0.0.1'); await once(occupied, 'listening');
  try { await assert.rejects(c.run('init'), /已占用/); }
  finally { await new Promise(resolve => occupied.close(resolve)); }
  assert.equal(fs.existsSync(c.config.APP_DATA_DIR), false);
  c.config.APP_PORT = 70000; c.save();
  await assert.rejects(c.run('start'), /APP_PORT/);
  assert.equal(fs.existsSync(c.config.APP_DATA_DIR), false);
  c.config.APP_PORT = await port(); c.config.APP_DATA_DIR = path.join(c.app, 'public', 'data'); c.save();
  await assert.rejects(c.run('init'), /数据目录/);
});

test('fresh package serves subpath, login, SSE, online backup and restored business data', { timeout: 40000 }, async t => {
  const c = await fixture(t);
  const service = await c.start();
  await c.run('check'); await c.run('check', c.url());
  const identity = c.credentials();
  const login = await fetch(c.url() + '/api/v1/auth/login', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: identity.username, password: identity.password }) });
  assert.equal(login.status, 200);
  assert.match(login.headers.get('set-cookie'), /Secure/);
  const cookie = login.headers.get('set-cookie').split(';')[0]; await login.json();
  for (const asset of ['', 'app.js', 'app.css', 'console.js', 'weight-filter.js']) {
    const response = await fetch(c.url() + '/' + asset);
    assert.equal(response.status, 200, asset); await response.arrayBuffer();
  }
  const api = async (pathname, body) => {
    const response = await fetch(c.url() + '/api/v1' + pathname, { method: body ? 'POST' : 'GET',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    assert.equal(response.status, 200, pathname); return response.json();
  };
  assert.equal((await api('/auth/me')).role, 'admin');
  const streamAbort = new AbortController();
  const stream = await fetch(c.url() + '/api/v1/stream', { headers: { Cookie: cookie }, signal: streamAbort.signal });
  assert.equal(stream.status, 200);
  assert.match(stream.headers.get('content-type'), /text\/event-stream/);
  await stream.body.getReader().read(); streamAbort.abort();
  const recipe = { id: 'customer-recipe', expected_version: 0, name: '客户恢复验证', enabled: true, notes: '',
    steps: [{ channel: 0, target_mg: 500, tolerance_mg: 20, settle_ms: 50 }] };
  await api('/recipes', recipe);
  await assert.rejects(c.run('start'), /已占用/);
  await c.run('backup');
  const backups = path.join(c.config.APP_DATA_DIR, 'backups');
  const destination = path.join(backups, fs.readdirSync(backups)[0]);
  const completed = JSON.parse(fs.readFileSync(path.join(destination, 'COMPLETE.json'), 'utf8'));
  for (const [name, hash] of Object.entries(completed.files)) {
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(destination, name))).digest('hex'), hash);
  }
  const read = new DatabaseSync(path.join(destination, 'telemetry-v1.db'), { readOnly: true });
  assert.equal(read.prepare('PRAGMA quick_check').get().quick_check, 'ok'); read.close();
  await api('/recipes', { ...recipe, expected_version: 1, name: '修改后的配方' });
  await c.stop(service.child);
  c.config.APP_DATA_DIR = path.join(c.directory, 'restored');
  fs.mkdirSync(c.config.APP_DATA_DIR);
  for (const name of ['telemetry-v1.db', 'connection.json']) fs.copyFileSync(path.join(destination, name), path.join(c.config.APP_DATA_DIR, name));
  c.save();
  const restored = await c.start();
  const restoredLogin = await fetch(c.url() + '/api/v1/auth/login', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: identity.username, password: identity.password }) });
  assert.equal(restoredLogin.status, 200);
  const restoredCookie = restoredLogin.headers.get('set-cookie').split(';')[0]; await restoredLogin.json();
  const recipesResponse = await fetch(c.url() + '/api/v1/recipes', { headers: { Cookie: restoredCookie } });
  const recipes = await recipesResponse.json();
  assert.equal(recipes.recipes.find(item => item.id === recipe.id).name, recipe.name);
  assert.deepEqual(c.credentials(), identity);
  for (const running of [service, restored]) {
    assert.equal(running.logs().includes(identity.password), false);
    assert.equal(running.logs().includes(identity.devices[0].token), false);
  }
});
