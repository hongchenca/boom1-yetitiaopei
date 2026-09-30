const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/**
 * loadConfig：加载本机配置，首次运行生成独立登录密码和设备密钥。
 * 参数：无；用于服务启动。示例：const config = loadConfig();
 * 凭据只写入本机 data/connection.json，不输出到日志。
 */
function loadConfig() {
  const dataDir = path.resolve(process.env.APP_DATA_DIR || path.join(__dirname, 'data'));
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'connection.json');
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, JSON.stringify({
      username: 'admin', password: crypto.randomBytes(15).toString('base64url'),
      devices: [{ id: 'esp32-001', name: 'ESP32-S3 · 联调设备', token: crypto.randomBytes(24).toString('hex') }]
    }, null, 2), { mode: 0o600, flag: 'wx' });
  }
  const local = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (typeof local.username !== 'string' || typeof local.password !== 'string' || local.password.length < 12 || !Array.isArray(local.devices)) {
    throw new Error('connection.json 必须配置用户名、至少 12 位密码和设备列表');
  }
  const identities = new Set();
  const tokens = new Set();
  for (const d of local.devices) {
    if (!/^[a-zA-Z0-9_-]{1,48}$/.test(d.id) || d.id === 'sim-001' || typeof d.name !== 'string' ||
        typeof d.token !== 'string' || !/^[A-Za-z0-9_-]{24,128}$/.test(d.token) ||
        (d.serial_test !== undefined && typeof d.serial_test !== 'boolean') ||
        identities.has(d.id) || tokens.has(d.token)) {
      throw new Error('设备 ID/密钥必须有效、唯一，sim-001 为模拟器保留');
    }
    identities.add(d.id); tokens.add(d.token);
  }
  const basePath = (process.env.APP_BASE_PATH || '').replace(/\/$/, '');
  if (basePath && !/^\/[a-zA-Z0-9_/-]+$/.test(basePath)) throw new Error('APP_BASE_PATH 必须为 /console 形式');
  const port = Number(process.env.APP_PORT || 8000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('APP_PORT 无效');
  const simulate = process.env.APP_SIMULATOR !== '0';
  const simDevice = { id: 'sim-001', name: '演示设备 · 模拟数据', token: crypto.randomBytes(24).toString('hex'), simulation: true };
  return {
    host: process.env.APP_HOST || '0.0.0.0', port, dataDir, basePath, credentialFile: file,
    username: local.username, password: local.password, secureCookie: process.env.APP_SECURE_COOKIE === '1',
    devices: [...local.devices.map(d => ({ ...d, simulation: false, serial_test: process.env.APP_SERIAL_TEST === '1' || d.serial_test === true })), ...(simulate ? [simDevice] : [])],
    simulate, simDevice
  };
}
module.exports = { loadConfig };
