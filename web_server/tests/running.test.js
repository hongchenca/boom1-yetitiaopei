// 只验证已运行的本机服务，不启动或修改真实设备，不输出登录密码和设备 token。
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

async function main() {
  const app = path.resolve(__dirname, '..');
  const directory = path.resolve(process.env.APP_DATA_DIR || path.join(app, 'data'));
  const credentials = JSON.parse(fs.readFileSync(path.join(directory, 'connection.json'), 'utf8'));
  const origin = 'http://127.0.0.1:' + (process.env.APP_PORT || 8000) + (process.env.APP_BASE_PATH || '');
  const request = (url, options = {}) => fetch(origin + url, { ...options, signal: AbortSignal.timeout(5000) });
  const healthResponse = await request('/api/v1/healthz'); assert.equal(healthResponse.status, 200);
  const health = await healthResponse.json(); assert.equal(health.ok, true);
  const login = await request('/api/v1/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: credentials.username, password: credentials.password }) });
  assert.equal(login.status, 200); await login.json();
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const response = await request('/api/v1/devices', { headers: { Cookie: cookie } }); assert.equal(response.status, 200);
  const { devices } = await response.json();
  const addresses = Object.entries(os.networkInterfaces()).flatMap(([name, list]) => list.filter(n => n.family === 'IPv4' && !n.internal).map(n => ({ name, address: n.address })));
  assert.ok(devices.every(d => !d.simulation && d.id !== 'sim-001'));
  const files = ['server.js','config.js','store.js','protocol.js','public/index.html','public/app.css','public/app.js','tests/api.test.js','tests/browser.test.js','../main/web_client.c','../scripts/configure_web_client.py'];
  const sources = Object.fromEntries(files.map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(app, file))).digest('hex')]));
  const report = { at: new Date().toISOString(), node: process.version, origin, health, devices: devices.map(d => ({ id: d.id, simulation: d.simulation, online: d.online, sequence: d.sequence })), addresses, sources };
  const output = path.join(app, 'artifacts', 'local-smoke.json'); fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(report, null, 2));
  const logout = await request('/api/v1/auth/logout', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(logout.status, 200); await logout.json();
  console.log(JSON.stringify({ ...report, sources: '(saved to artifacts/local-smoke.json)' }, null, 2));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
