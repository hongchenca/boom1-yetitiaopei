const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');

const root = path.resolve(__dirname, '..');

/** runtimeCheck：在写入客户数据前检查 Node 与 SQLite；用于所有部署命令。 */
function runtimeCheck() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major !== 24 || minor < 14) throw new Error('需要 Node.js 24.14.0 或更新的 24.x；推荐已验证的 24.14.0。');
  require('node:sqlite');
}

/** settings：读取部署 JSON，环境变量优先；相对数据路径始终以应用目录为基准。 */
function settings() {
  const filename = path.resolve(process.env.YETI_SETTINGS_FILE || path.join(__dirname, 'settings.json'));
  const source = fs.existsSync(filename) ? filename : path.join(__dirname, 'settings.example.json');
  const config = JSON.parse(fs.readFileSync(source, 'utf8').replace(/^\uFEFF/, ''));
  for (const key of ['APP_HOST', 'APP_PORT', 'APP_BASE_PATH', 'APP_DATA_DIR', 'APP_SECURE_COOKIE']) {
    if (process.env[key] !== undefined) config[key] = process.env[key];
  }
  if (typeof config.APP_HOST !== 'string' || !config.APP_HOST.trim()) throw new Error('APP_HOST 不能为空。');
  config.APP_PORT = Number(config.APP_PORT);
  if (!Number.isInteger(config.APP_PORT) || config.APP_PORT < 1 || config.APP_PORT > 65535) throw new Error('APP_PORT 必须为 1～65535。');
  if (typeof config.APP_BASE_PATH !== 'string' || (config.APP_BASE_PATH && !/^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(config.APP_BASE_PATH))) {
    throw new Error('APP_BASE_PATH 请使用 /console 或空字符串，不带末尾斜杠。');
  }
  if (![true, false, '1', '0'].includes(config.APP_SECURE_COOKIE)) throw new Error('APP_SECURE_COOKIE 必须为 true/false 或环境变量 1/0。');
  if (typeof config.APP_DATA_DIR !== 'string' || !config.APP_DATA_DIR.trim()) throw new Error('APP_DATA_DIR 不能为空。');
  config.APP_DATA_DIR = path.resolve(root, config.APP_DATA_DIR);
  config.APP_SECURE_COOKIE = config.APP_SECURE_COOKIE === true || config.APP_SECURE_COOKIE === '1' ? '1' : '0';
  const publicDir = path.join(root, 'public');
  if (config.APP_DATA_DIR === root || config.APP_DATA_DIR === publicDir || config.APP_DATA_DIR.startsWith(publicDir + path.sep)) {
    throw new Error('数据目录必须独立，不能放在应用根目录或 public 中。');
  }
  for (const [key, value] of Object.entries(config)) {
    if (key.startsWith('APP_')) process.env[key] = String(value);
  }
  return config;
}

/** verify：校验交付清单，拒绝缺失/篡改文件；不读取客户数据和本机凭据。 */
function verify(required = true) {
  const filename = path.join(root, 'release-manifest.json');
  if (!required && !fs.existsSync(filename)) return;
  if (!fs.existsSync(filename)) throw new Error('交付清单不存在，请重新解压完整交付包。');
  const manifest = JSON.parse(fs.readFileSync(filename, 'utf8'));
  if (!manifest.files || !Object.keys(manifest.files).length) throw new Error('交付清单为空。');
  for (const [name, expected] of Object.entries(manifest.files)) {
    const filename = path.resolve(root, name);
    if (!filename.startsWith(root + path.sep)) throw new Error('交付清单包含无效路径。');
    const actual = crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
    if (actual !== expected) throw new Error(`文件校验失败：${name}；请重新解压原始交付包。`);
  }
  console.log(`文件校验通过：${manifest.version}，${Object.keys(manifest.files).length} 个文件。`);
}

/** availablePort：只探测分配的监听端口，冲突时不创建凭据、不打开数据库。 */
async function availablePort(config) {
  await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', error => reject(new Error(error.code === 'EADDRINUSE'
      ? `端口 ${config.APP_PORT} 已占用；请在 deploy/settings.json 分配其他端口，勿停止未知服务。`
      : `无法监听分配的地址：${error.code}`)));
    probe.listen(config.APP_PORT, config.APP_HOST, () => probe.close(resolve));
  });
}

/** initialize：只在全新目录生成客户独立身份；重跑保留原有密码、密钥与设备配置。 */
function initialize(config) {
  const directory = config.APP_DATA_DIR;
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const filename = path.join(directory, 'connection.json');
  if (!fs.existsSync(filename)) {
    if (fs.existsSync(path.join(directory, 'telemetry-v1.db'))) throw new Error('已有数据库但缺少 connection.json；请恢复匹配的凭据备份。');
    fs.writeFileSync(filename, JSON.stringify({
      username: 'admin', password: crypto.randomBytes(18).toString('base64url'),
      devices: [{ id: 'esp32-001', name: '调配设备 01', token: crypto.randomBytes(24).toString('hex'), weight: true, actuator: true }]
    }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  }
  // 使用应用本身的校验规则，避免安装脚本与运行时身份规则漂移。
  require('../config').loadConfig();
  console.log(`配置就绪；客户在服务器本机查看登录信息：${filename}`);
  console.log('密码与设备密钥不会输出到运行日志。');
}

/** check：通过真实健康接口验收本机或给定外部网址；不登录、不下发设备操作。 */
async function check(config, target) {
  const host = ['0.0.0.0', '::'].includes(config.APP_HOST) ? '127.0.0.1' : config.APP_HOST;
  const origin = target || `http://${host.includes(':') ? '[' + host + ']' : host}:${config.APP_PORT}${config.APP_BASE_PATH}`;
  const url = new URL(origin.replace(/\/$/, '') + '/api/v1/healthz');
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('验收地址必须为不含密码/查询参数的 http(s) 网址。');
  const response = await fetch(url, { signal: AbortSignal.timeout(8000), redirect: 'error' });
  const body = await response.json();
  const expectedVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  if (response.status !== 200 || body.ok !== true || body.version !== expectedVersion || body.schema_version !== 1) {
    throw new Error(`服务验收失败：状态 ${response.status}，或服务版本不是 ${expectedVersion}。`);
  }
  console.log(`服务正常：${body.version}；${url}`);
}

/** backup：在线生成一致性数据库和匹配的凭据副本；新建目录，永不覆盖旧备份。 */
function backup(config) {
  const { DatabaseSync } = require('node:sqlite');
  const source = path.join(config.APP_DATA_DIR, 'telemetry-v1.db');
  const credentials = path.join(config.APP_DATA_DIR, 'connection.json');
  if (!fs.existsSync(source) || !fs.existsSync(credentials)) throw new Error('数据库或身份文件缺失，请先检查数据目录。');
  const parent = path.join(config.APP_DATA_DIR, 'backups');
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const destination = fs.mkdtempSync(path.join(parent, new Date().toISOString().replace(/[:.]/g, '-') + '-'));
  fs.chmodSync(destination, 0o700);
  const output = path.join(destination, 'telemetry-v1.db');
  const db = new DatabaseSync(source, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout=5000');
    db.exec(`VACUUM INTO '${output.replace(/'/g, "''")}'`);
    fs.copyFileSync(credentials, path.join(destination, 'connection.json'), fs.constants.COPYFILE_EXCL);
    fs.chmodSync(output, 0o600);
    fs.chmodSync(path.join(destination, 'connection.json'), 0o600);
    const copy = new DatabaseSync(output, { readOnly: true });
    try {
      if (copy.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new Error('备份完整性校验失败。');
    } finally { copy.close(); }
    fs.writeFileSync(path.join(destination, 'COMPLETE.json'), JSON.stringify({
      created_at: new Date().toISOString(), version: JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version,
      files: Object.fromEntries(['telemetry-v1.db', 'connection.json'].map(name => [name,
        crypto.createHash('sha256').update(fs.readFileSync(path.join(destination, name))).digest('hex')]))
    }, null, 2), { flag: 'wx', mode: 0o600 });
  } finally { db.close(); }
  console.log(`备份完成（包含私密凭据，请单独保管）：${destination}`);
}

/** main：部署入口；start 保持单进程，信号直接关闭 HTTP/SSE 与 SQLite。 */
async function main() {
  runtimeCheck();
  const action = process.argv[2];
  if (action === 'verify') return verify();
  if (!['init', 'start', 'check', 'backup'].includes(action)) throw new Error('用法：node deploy/manage.cjs init|start|check [外部网址]|backup|verify');
  const config = settings();
  if (action === 'check') return check(config, process.argv[3]);
  if (action === 'backup') return backup(config);
  verify(false);
  await availablePort(config);
  initialize(config);
  if (action === 'init') return;
  const gateway = require('../server').createServer(require('../config').loadConfig(), { deferStorage: true });
  gateway.server.once('error', () => { gateway.close(); process.exitCode = 1; });
  process.once('SIGTERM', () => gateway.close());
  process.once('SIGINT', () => gateway.close());
  gateway.listen();
}

if (require.main === module) main().catch(error => {
  // 不输出配置正文、凭据或请求内容。
  console.error(`部署失败：${error instanceof SyntaxError ? 'JSON 格式不正确，请检查配置文件。' : error.message}`);
  process.exitCode = 1;
});
