const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { loadConfig } = require('./config');
const { Store } = require('./store');
const { ConsoleStore } = require('./console-store');
const { consoleRoute, requireRole } = require('./console-api');
const { ApiError, requireValue, plain, integer, identifier, validateTelemetry, validateCommand } = require('./protocol');

/**
 * createServer：构建单实例局域网网关，不启动硬件。
 * 参数 config：经校验的运行配置；用于 CLI 和集成测试；示例 createServer(loadConfig()).listen()。
 */
function createServer(config, { deferStorage = false } = {}) {
  config = {...config, devices:config.devices.filter(d => !d.simulation && d.id !== 'sim-001')};
  let store, business;
  const openStorage=()=>{store=new Store(config.dataDir,config.devices);business=new ConsoleStore(store,config);};
  if(!deferStorage)openStorage();
  const sessions = new Map(), streams = new Set(), waiters = new Map(), leases = new Map(), attempts = new Map();
  const base = config.basePath, publicDir = path.join(__dirname, 'public');
  let timer, closing = false;
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
    const current = business.user(s.username);
    if (!current?.enabled || current.revision !== s.revision) { sessions.delete(token); throw new ApiError(401,'login_required'); }
    return { ...s, ...current, token };
  };
  const requireDevice = req => {
    const d = config.devices.find(d => d.id === req.headers['x-device-id']);
    if (!d || !equalSecret(d.token, req.headers['x-device-token'])) throw new ApiError(401, 'device_auth_failed');
    return d;
  };
  const commandView = c => ({ ...c, command_id: c.id, status: c.state });
  const notify = id => waiters.get(id)?.wake();
  const assertDevice = id => { const d = store.device(id); if (!d) throw new ApiError(404, 'device_not_found'); return d; };

  /** broadcastSnapshot：遥测到达即推送，1 秒心跳只刷新在线/年龄；慢连接断开后由页面重连。 */
  function broadcastSnapshot() {
    const frame = `event: snapshot\ndata: ${JSON.stringify({devices:store.devices(),sent_at:Date.now()})}\n\n`;
    for (const stream of streams) {
      const session=sessions.get(stream.token), account=session && business.user(session.username);
      if (!account?.enabled || session.expires_at <= Date.now() || account.revision!==session.revision) {
        stream.res.end('event: session-expired\ndata: {}\n\n'); streams.delete(stream); continue;
      }
      if (stream.res.writableLength > 65536) {
        stream.res.end(); streams.delete(stream); continue;
      }
      stream.res.write(frame);
    }
  }

  /** readBody：限制 JSON 为 32 KiB；req 为请求流，用于所有 POST。 */
  async function readBody(req) {
    if (!(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) throw new ApiError(415, 'json_required');
    let size = 0; const chunks = [];
    for await (const chunk of req) { size += chunk.length; if (size > 32768) throw new ApiError(413, 'payload_too_large'); chunks.push(chunk); }
    try { const body = JSON.parse(Buffer.concat(chunks).toString('utf8')); requireValue(plain(body)); return body; }
    catch { throw new ApiError(400, 'invalid_json'); }
  }

  /** nextCommand：投递前重查逐路令牌和操作者，跳过失效点动后继续投递其他通道。 */
  function nextCommand(deviceId, bootId) {
    for (;;) {
      const command = store.next(deviceId, bootId);
      if (!command || !['debug_apply','aux_apply'].includes(command.type)) return command;
      const lease = leases.get(deviceId), session = lease && sessions.get(lease.owner);
      const account = session && business.user(session.username);
      const token = command.type==='debug_apply' && store.device(deviceId).status.actuator.parallel_supported === true ? lease?.channel_session_ids[command.payload.channel] : lease?.id;
      let authorized = Boolean(lease && token === command.payload.session_id && lease.until > Date.now() &&
        session && session.expires_at > Date.now() && account?.enabled && account.revision === session.revision);
      if (authorized) {
        try { requireRole(account, 'operate'); } catch { authorized = false; }
      }
      if (authorized) return command;
      command.state = 'expired'; command.reason = 'debug_session_expired';
      store.saveCommand(command);
    }
  }

  /** poll：一个设备最多一个有界等待；res 断开即清理，遥测不经过此等待。 */
  async function poll(identity, body, res) {
    requireValue(body.schema_version === 1 && body.device_id === identity.id && identifier(body.boot_id));
    requireValue(integer(body.wait_ms, 0, 25000));
    if (store.device(identity.id).boot_id !== body.boot_id) throw new ApiError(409, 'boot_mismatch');
    if (waiters.has(identity.id)) throw new ApiError(409, 'poll_in_progress');
    const initial = nextCommand(identity.id, body.boot_id);
    if (initial || body.wait_ms === 0) return send(res, 200, { command: initial });
    await new Promise(resolve => {
      const cleanup = () => { clearTimeout(timeout); waiters.delete(identity.id); res.removeListener('close', cleanup); resolve(); };
      const timeout = setTimeout(cleanup, body.wait_ms);
      waiters.set(identity.id, { wake: cleanup }); res.once('close', cleanup);
    });
    if (!closing && !res.destroyed) send(res, 200, { command: nextCommand(identity.id, body.boot_id) });
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
      const files = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/console.js': ['console.js', 'text/javascript'], '/weight-filter.js': ['weight-filter.js', 'text/javascript'], '/app.css': ['app.css', 'text/css'] };
      files['/dosing-config.js']=['dosing-config.js','text/javascript']; files['/outlet.js']=['outlet.js','text/javascript'];
      const file = files[pathname]; if (!file) throw new ApiError(404, 'not_found');
      res.writeHead(200, { 'Content-Type': file[1] + '; charset=utf-8', 'Cache-Control': 'no-cache' });
      return res.end(fs.readFileSync(path.join(publicDir, file[0])));
    }
    const p = pathname.slice('/api/v1'.length);
    if (p === '/healthz' && req.method === 'GET') return send(res, 200, { ok: true, version: '0.5.1', schema_version: 1 });
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
      const account = business.authenticate(body.username, body.password);
      if (!account) throw new ApiError(401, 'invalid_credentials');
      attempts.delete(key);
      const token = crypto.randomBytes(32).toString('base64url');
      sessions.set(token, { ...account, expires_at: Date.now() + 8 * 3600000 });
      business.audit(account.username,'login','session');
      return send(res, 200, account, { 'Set-Cookie': `yt_session=${token}; Path=${base || '/'}; HttpOnly; SameSite=Strict${config.secureCookie ? '; Secure' : ''}` });
    }
    if (p === '/auth/logout' && req.method === 'POST') {
      business.audit(user.username,'logout','session');
      sessions.delete(user.token);
      return send(res, 200, { ok: true }, { 'Set-Cookie': `yt_session=; Path=${base || '/'}; Max-Age=0; HttpOnly; SameSite=Strict` });
    }
    if (deviceRoute) {
      if (req.method !== 'POST') throw new ApiError(405, 'method_not_allowed');
      if (p === '/device/telemetry') {
        const result = store.ingest(validateTelemetry(body, identity));
        send(res, 200, result);
        if (!result.duplicate) broadcastSnapshot();
        return;
      }
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
    if (consoleRoute({p,req,res,url,body,user,send,business,store})) return;
    if (p === '/devices' && req.method === 'GET') return send(res, 200, { devices: store.devices() });
    if (p === '/stream' && req.method === 'GET') {
      if (streams.size >= 32) throw new ApiError(429, 'stream_limit');
      req.socket.setKeepAlive(true,15000); res.setTimeout(0);
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' });
      res.flushHeaders();
      const stream = { res, token: user.token }; streams.add(stream);
      res.write(`retry: 1000\nevent: snapshot\ndata: ${JSON.stringify({ devices: store.devices(), sent_at:Date.now() })}\n\n`);
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
        requireRole(user,'operate');
        if (business.activeJob(d.id)) throw new ApiError(409,'device_busy');
        if (d.status?.dosing?.active) throw new ApiError(409,'dosing_busy');
        if (!d.online) throw new ApiError(409, 'device_offline');
        if (!d.actuator_enabled || !d.capabilities.actuator) throw new ApiError(409, 'hardware_not_supported');
        const existing = leases.get(d.id);
        if (existing && existing.until > Date.now() && existing.owner !== user.token) throw new ApiError(409, 'device_busy');
        const lease = existing?.owner === user.token && existing.until > Date.now() ? existing :
          { id: crypto.randomUUID(), owner: user.token, channel_session_ids: Array.from({length:8},()=>crypto.randomUUID()) };
        lease.until = Date.now() + 6000;
        leases.set(d.id, lease); return send(res, 200, { session_id: lease.id, lease_ms: 6000,
          ...(d.status.actuator.parallel_supported === true ? {channel_session_ids:lease.channel_session_ids} : {}) });
      }
      if (req.method === 'POST' && (suffix === 'commands' || suffix === 'stop')) {
        requireRole(user,'operate');
        requireValue(body.schema_version === 1 && identifier(body.request_id), 'unsupported_schema');
        const old = store.byRequest(d.id, body.request_id);
        if (old) {
          if (old.type !== body.type || JSON.stringify(old.payload) !== JSON.stringify(body.payload)) throw new ApiError(409, 'request_id_conflict');
          return send(res, 200, { command: commandView(old), duplicate: true });
        }
        validateCommand(body, d);
        if (['debug_apply','aux_apply','dosing_start'].includes(body.type) && business.activeJob(d.id)) throw new ApiError(409,'device_busy');
        if (body.type === 'stop' && body.payload.channel === undefined && business.activeJob(d.id)) business.stopJob(business.activeJob(d.id).id,user.username);
        if (['debug_apply','aux_apply'].includes(body.type)) {
          const lease = leases.get(d.id);
          const token = body.type==='debug_apply' && d.status.actuator.parallel_supported === true ? lease?.channel_session_ids[body.payload.channel] : lease?.id;
          if (!lease || lease.until < Date.now() || lease.owner !== user.token || token !== body.payload.session_id) throw new ApiError(409, 'debug_session_expired');
        }
        // 单路停止只轮换本路令牌，挡住迟到的启动请求；全部停止撤销整台设备租约。
        if (body.type === 'stop') {
          if (body.payload.channel === undefined) leases.delete(d.id);
          else {
            const lease = leases.get(d.id);
            if (lease) lease.channel_session_ids[body.payload.channel] = crypto.randomUUID();
          }
        }
        const debugUntil = ['debug_apply','aux_apply'].includes(body.type) ? leases.get(d.id).until : null;
        const c = store.enqueue(d, body, debugUntil); business.audit(user.username,'command_queued',d.id,{id:c.id,type:c.type}); notify(d.id); return send(res, 202, { command: commandView(c) });
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
  server.on('error', error => console.error(error.code==='EADDRINUSE' ? `端口 ${config.port} 已有服务运行。请打开 http://127.0.0.1:${config.port}${base}/，或先退出原服务。` : `listen_failed ${error.code}`));
  return {
    server, get store(){return store;}, get business(){return business;},
    listen() {
      server.listen(config.port, config.host, () => {
        // CLI 先确认端口归属再打开数据库，重复启动不会把现有待执行命令标为重启失效。
        try { if(!store)openStorage(); } catch(error) { server.emit('error',error);return; }
        const port = server.address().port;
        const host = config.host === '0.0.0.0' ? '127.0.0.1' : config.host === '::' ? '[::1]' : config.host.includes(':') ? '[' + config.host + ']' : config.host;
        const origin = 'http://' + host + ':' + port + base;
        console.log('Yetitiaopei: ' + origin + '/');
        console.log(`Local credentials: ${config.credentialFile}`);
        let ticks = 0;
        timer = setInterval(() => {
        for (const [key, s] of sessions) if (s.expires_at <= Date.now()) sessions.delete(key);
        for (const [key, rate] of attempts) if (rate.until <= Date.now()) attempts.delete(key);
        for (const [key, lease] of leases) if (!sessions.has(lease.owner) || lease.until <= Date.now()) leases.delete(key);
        broadcastSnapshot();
        if (++ticks % 30 === 0) store.prune();
        }, 1000);
      });
    },
    close() {
      if (closing) return;
      closing = true;
      clearInterval(timer);
      for (const waiter of waiters.values()) waiter.wake();
      for (const { res } of streams) res.end();
      server.close(); server.closeAllConnections(); store?.close();
    }
  };
}
if (require.main === module) {
  const gateway = createServer(loadConfig(), {deferStorage:true});
  gateway.server.once('error', () => { gateway.close(); process.exitCode = 1; });
  gateway.listen();
  process.once('SIGINT', () => gateway.close()); process.once('SIGTERM', () => gateway.close());
}
module.exports = { createServer };
