const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { loadConfig } = require('./config');
const { Store } = require('./store');
const { ApiError, requireValue, plain, integer, identifier, validateTelemetry, validateCommand } = require('./protocol');

/**
 * createServer：构建单实例局域网网关，不启动硬件。
 * 参数 config：经校验的运行配置；用于 CLI 和集成测试；示例 createServer(loadConfig()).listen()。
 */
function createServer(config) {
  const store = new Store(config.dataDir, config.devices);
  const sessions = new Map(), streams = new Set(), waiters = new Map(), leases = new Map(), attempts = new Map();
  const base = config.basePath, publicDir = path.join(__dirname, 'public');
  let simulator, timer, closing = false;
  const secretHash = text => crypto.createHash('sha256').update(String(text || '')).digest();
  const equalSecret = (a, b) => crypto.timingSafeEqual(secretHash(a), secretHash(b));
  const send = (res, status, data, headers = {}) => {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
    res.end(JSON.stringify(data));
  };
  const cookie = req => /(?:^|;\s*)yt_session=([A-Za-z0-9_-]+)/.exec(req.headers.cookie || '')?.[1];
  const requireSession = req => {
    const token = cookie(req), s = sessions.get(token);
    if (!s || s.expires_at <= Date.now()) throw new ApiError(401, 'login_required');
    return { ...s, token };
  };
  const requireDevice = req => {
    const d = config.devices.find(d => d.id === req.headers['x-device-id']);
    if (!d || !equalSecret(d.token, req.headers['x-device-token'])) throw new ApiError(401, 'device_auth_failed');
    return d;
  };
  const commandView = c => ({ ...c, command_id: c.id, status: c.state });
  const notify = id => waiters.get(id)?.wake();
  const assertDevice = id => { const d = store.device(id); if (!d) throw new ApiError(404, 'device_not_found'); return d; };

  /** readBody：限制 JSON 为 32 KiB；req 为请求流，用于所有 POST。 */
  async function readBody(req) {
    if (!(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) throw new ApiError(415, 'json_required');
    let size = 0; const chunks = [];
    for await (const chunk of req) { size += chunk.length; if (size > 32768) throw new ApiError(413, 'payload_too_large'); chunks.push(chunk); }
    try { const body = JSON.parse(Buffer.concat(chunks).toString('utf8')); requireValue(plain(body)); return body; }
    catch { throw new ApiError(400, 'invalid_json'); }
  }

  /** poll：一个设备最多一个有界等待；res 断开即清理，遥测不经过此等待。 */
  async function poll(identity, body, res) {
    requireValue(body.schema_version === 1 && body.device_id === identity.id && identifier(body.boot_id));
    requireValue(integer(body.wait_ms, 0, 25000));
    if (store.device(identity.id).boot_id !== body.boot_id) throw new ApiError(409, 'boot_mismatch');
    if (waiters.has(identity.id)) throw new ApiError(409, 'poll_in_progress');
    const initial = store.next(identity.id, body.boot_id);
    if (initial || body.wait_ms === 0) return send(res, 200, { command: initial });
    await new Promise(resolve => {
      const cleanup = () => { clearTimeout(timeout); waiters.delete(identity.id); res.removeListener('close', cleanup); resolve(); };
      const timeout = setTimeout(cleanup, body.wait_ms);
      waiters.set(identity.id, { wake: cleanup }); res.once('close', cleanup);
    });
    if (!closing && !res.destroyed) send(res, 200, { command: store.next(identity.id, body.boot_id) });
  }

  /** route：HTTP 鉴权和协议边界；req/res 为 Node 请求响应对象。 */
  async function route(req, res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'");
    const url = new URL(req.url, 'http://local');
    if (base && url.pathname === base) { res.writeHead(302, { Location: base + '/' }); return res.end(); }
    if (base && !url.pathname.startsWith(base + '/')) throw new ApiError(404, 'not_found');
    const pathname = url.pathname.slice(base.length);
    if (!pathname.startsWith('/api/v1/')) {
      if (req.method !== 'GET') throw new ApiError(405, 'method_not_allowed');
      const files = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/app.css': ['app.css', 'text/css'] };
      const file = files[pathname]; if (!file) throw new ApiError(404, 'not_found');
      res.writeHead(200, { 'Content-Type': file[1] + '; charset=utf-8', 'Cache-Control': 'no-cache' });
      return res.end(fs.readFileSync(path.join(publicDir, file[0])));
    }
    const p = pathname.slice('/api/v1'.length);
    if (p === '/healthz' && req.method === 'GET') return send(res, 200, { ok: true, version: '0.2.0', schema_version: 1 });
    const deviceRoute = p.startsWith('/device/');
    if (!deviceRoute && req.headers.origin) {
      const origin = new URL(req.headers.origin);
      if (origin.host !== req.headers.host) throw new ApiError(403, 'origin_rejected');
    }
    let user, identity;
    if (deviceRoute) identity = requireDevice(req);
    else if (p !== '/auth/login') user = requireSession(req);
    const body = req.method === 'POST' ? await readBody(req) : {};
    if (closing) throw new ApiError(503, 'server_stopping');
    if (p === '/auth/login' && req.method === 'POST') {
      const key = req.socket.remoteAddress, previous = attempts.get(key);
      const rate = previous && previous.until > Date.now() ? previous : { count: 0, until: Date.now() + 60000 };
      if (rate.count >= 10 || sessions.size >= 64) throw new ApiError(429, 'login_rate_limit');
      rate.count++; attempts.set(key, rate);
      if (body.username !== config.username || !equalSecret(body.password, config.password)) throw new ApiError(401, 'invalid_credentials');
      attempts.delete(key);
      const token = crypto.randomBytes(32).toString('base64url');
      sessions.set(token, { username: config.username, expires_at: Date.now() + 8 * 3600000 });
      return send(res, 200, { username: config.username }, { 'Set-Cookie': `yt_session=${token}; Path=${base || '/'}; HttpOnly; SameSite=Strict${config.secureCookie ? '; Secure' : ''}` });
    }
    if (p === '/auth/logout' && req.method === 'POST') {
      sessions.delete(user.token);
      return send(res, 200, { ok: true }, { 'Set-Cookie': `yt_session=; Path=${base || '/'}; Max-Age=0; HttpOnly; SameSite=Strict` });
    }
    if (deviceRoute) {
      if (req.method !== 'POST') throw new ApiError(405, 'method_not_allowed');
      if (p === '/device/telemetry') return send(res, 200, store.ingest(validateTelemetry(body, identity)));
      if (p === '/device/events') {
        requireValue(body.schema_version === 1 && body.device_id === identity.id && identifier(body.event_id) && identifier(body.boot_id));
        requireValue(typeof body.type === 'string' && /^[a-z0-9_]{1,40}$/.test(body.type) && plain(body.payload));
        requireValue(JSON.stringify(body.payload).length <= 1024);
        return send(res, 200, store.event(identity, body));
      }
      if (p === '/device/commands/poll') return poll(identity, body, res);
      const ack = /^\/device\/commands\/([a-zA-Z0-9_-]+)\/ack$/.exec(p);
      if (ack) {
        requireValue(body.schema_version === 1 && body.device_id === identity.id && identifier(body.boot_id));
        requireValue(['completed','rejected'].includes(body.status) && plain(body.result) && JSON.stringify(body.result).length <= 1024);
        return send(res, 200, { accepted: true, command: commandView(store.ack(identity.id, ack[1], body)) });
      }
      throw new ApiError(404, 'route_not_found');
    }
    if (p === '/devices' && req.method === 'GET') return send(res, 200, { devices: store.devices() });
    if (p === '/stream' && req.method === 'GET') {
      if (streams.size >= 32) throw new ApiError(429, 'stream_limit');
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
      const stream = { res, token: user.token }; streams.add(stream);
      res.write(`event: snapshot\ndata: ${JSON.stringify({ devices: store.devices() })}\n\n`);
      res.once('close', () => streams.delete(stream)); return;
    }
    const device = /^\/devices\/([a-zA-Z0-9_-]+)(?:\/(status|history|events|commands|debug-sessions|stop))?$/.exec(p);
    if (device) {
      const d = assertDevice(device[1]), suffix = device[2];
      if (req.method === 'GET') {
        if (suffix === 'history') return send(res, 200, store.history(d.id));
        if (suffix === 'events') return send(res, 200, { events: store.events(d.id), commands: store.commands(d.id).map(commandView) });
        if (!suffix || suffix === 'status') return send(res, 200, d);
      }
      if (req.method === 'POST' && suffix === 'debug-sessions') {
        if (!d.simulation || !d.online) throw new ApiError(409, 'simulation_only');
        const existing = leases.get(d.id);
        if (existing && existing.until > Date.now() && existing.owner !== user.token) throw new ApiError(409, 'device_busy');
        const lease = { id: existing?.owner === user.token ? existing.id : crypto.randomUUID(), owner: user.token, until: Date.now() + 6000 };
        leases.set(d.id, lease); return send(res, 200, { session_id: lease.id, lease_ms: 6000 });
      }
      if (req.method === 'POST' && (suffix === 'commands' || suffix === 'stop')) {
        requireValue(body.schema_version === 1 && identifier(body.request_id), 'unsupported_schema');
        const old = store.byRequest(d.id, body.request_id);
        if (old) {
          if (old.type !== body.type || JSON.stringify(old.payload) !== JSON.stringify(body.payload)) throw new ApiError(409, 'request_id_conflict');
          return send(res, 200, { command: commandView(old), duplicate: true });
        }
        validateCommand(body, d);
        if (body.type === 'debug_apply') {
          const lease = leases.get(d.id);
          if (!lease || lease.until < Date.now() || lease.owner !== user.token || lease.id !== body.payload.session_id) throw new ApiError(409, 'debug_session_expired');
        }
        const c = store.enqueue(d, body); notify(d.id); return send(res, 202, { command: commandView(c) });
      }
    }
    const status = /^\/commands\/([a-zA-Z0-9_-]+)$/.exec(p);
    if (status && req.method === 'GET') { const c = store.command(status[1]); if (!c) throw new ApiError(404, 'command_not_found'); return send(res, 200, { command: commandView(c) }); }
    throw new ApiError(404, 'route_not_found');
  }
  const server = http.createServer((req, res) => {
    route(req, res).catch(error => {
      if (!(error instanceof ApiError)) console.error('request_failed', error.code || error.name);
      if (!res.headersSent) send(res, error.status || 500, { error: error.status ? error.message : 'internal_error' }); else res.end();
    });
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000;
  server.on('error', error => console.error('listen_failed', error.code));
  return {
    server, store,
    listen() {
      server.listen(config.port, config.host, () => {
        const port = server.address().port;
        const host = config.host === '0.0.0.0' ? '127.0.0.1' : config.host === '::' ? '[::1]' : config.host.includes(':') ? '[' + config.host + ']' : config.host;
        const origin = 'http://' + host + ':' + port + base;
        console.log('Yetitiaopei: ' + origin + '/');
        console.log(`Local credentials: ${config.credentialFile}`);
        if (config.simulate) simulator = require('./simulator').startSimulator(origin, config.simDevice);
      });
      let ticks = 0;
      timer = setInterval(() => {
        for (const [key, s] of sessions) if (s.expires_at <= Date.now()) sessions.delete(key);
        for (const [key, rate] of attempts) if (rate.until <= Date.now()) attempts.delete(key);
        for (const [key, lease] of leases) if (!sessions.has(lease.owner) || lease.until <= Date.now()) leases.delete(key);
        for (const stream of streams) {
          if (!sessions.has(stream.token) || stream.res.writableLength > 65536) { stream.res.end(); streams.delete(stream); continue; }
          stream.res.write(`event: snapshot\ndata: ${JSON.stringify({ devices: store.devices() })}\n\n`);
        }
        if (++ticks % 30 === 0) store.prune();
      }, 1000);
    },
    close() {
      if (closing) return;
      closing = true;
      clearInterval(timer); simulator?.stop();
      for (const waiter of waiters.values()) waiter.wake();
      for (const { res } of streams) res.end();
      server.close(); server.closeAllConnections(); store.close();
    }
  };
}
if (require.main === module) {
  const gateway = createServer(loadConfig());
  gateway.server.once('error', () => { gateway.close(); process.exitCode = 1; });
  gateway.listen();
  process.once('SIGINT', () => gateway.close()); process.once('SIGTERM', () => gateway.close());
}
module.exports = { createServer };
