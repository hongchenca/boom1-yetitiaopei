const { spawn } = require('node:child_process');

// 通过 Windows 默认 URL 关联打开网页，失败时保留可手动访问的地址。
function openBrowser(url) {
  const browser = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    'Start-Process -FilePath $env:YETI_BROWSER_URL'], {
    detached: true, stdio: 'ignore', windowsHide: true,
    env: { ...process.env, YETI_BROWSER_URL: url },
  });
  browser.on('error', () => console.error(`Open your browser: ${url}`));
  browser.on('exit', code => { if (code) console.error(`Open your browser: ${url}`); });
  browser.unref();
}

// 启动本机网页：沿用服务配置及数据目录，监听成功后打开默认浏览器。
function main() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major !== 24 || minor < 14) throw new Error('Please use Node.js >=24.14.0 <25.');
  require('node:sqlite');
  const { loadConfig } = require('./config');
  const { createServer } = require('./server');
  const config = loadConfig();
  const gateway = createServer(config, { deferStorage: true });
  gateway.server.once('error', async error => {
    gateway.close();
    process.exitCode = 1;
    if (error.code === 'EADDRINUSE') {
      const url = `http://127.0.0.1:${config.port}${config.basePath}/`;
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
        if (response.ok && (await response.text()).includes('<title>液体定量调配 · YETI</title>')) {
          console.log(`Already running: ${url}`);
          openBrowser(url);
          process.exitCode = 0;
        }
      } catch { /* 保留服务原有的端口错误信息。 */ }
    }
  });
  gateway.server.once('listening', () => {
    // 存储初始化在服务自身的 listening 回调完成后再确认。
    setImmediate(() => {
      if (!gateway.server.listening || !gateway.store) return;
      const host = ['0.0.0.0', '::'].includes(config.host) ? '127.0.0.1'
        : config.host.includes(':') ? `[${config.host}]` : config.host;
      const url = `http://${host}:${gateway.server.address().port}${config.basePath}/`;
      openBrowser(url);
    });
  });
  gateway.listen();
  process.once('SIGINT', () => gateway.close());
  process.once('SIGTERM', () => gateway.close());
}

try { main(); } catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
