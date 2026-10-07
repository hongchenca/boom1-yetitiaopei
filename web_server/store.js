const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { ApiError } = require('./protocol');
const decode = row => row ? JSON.parse(row.payload) : null;

/**
 * Store：单进程拥有数据库写权限；内存保留实时状态，SQLite 每秒最多一条历史/设备。
 * 参数 directory：独立数据目录；identities：已注册设备。示例 new Store(config.dataDir, config.devices)。
 */
class Store {
  constructor(directory, identities) {
    this.db = new DatabaseSync(path.join(directory, 'telemetry-v1.db'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=2000;
      CREATE TABLE IF NOT EXISTS snapshots(device_id TEXT PRIMARY KEY, received_at INTEGER, payload TEXT);
      CREATE TABLE IF NOT EXISTS history(device_id TEXT, boot_id TEXT, sequence INTEGER, received_at INTEGER, payload TEXT,
        UNIQUE(device_id,boot_id,sequence));
      CREATE INDEX IF NOT EXISTS history_time ON history(received_at);
      CREATE TABLE IF NOT EXISTS boots(device_id TEXT, boot_id TEXT, PRIMARY KEY(device_id,boot_id));
      CREATE TABLE IF NOT EXISTS command_log(id TEXT PRIMARY KEY, device_id TEXT, request_id TEXT, state TEXT,
        expires_at INTEGER, created_at INTEGER, payload TEXT, UNIQUE(device_id,request_id));
      CREATE INDEX IF NOT EXISTS command_time ON command_log(created_at);
      CREATE TABLE IF NOT EXISTS control_counters(device_id TEXT PRIMARY KEY, value INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS event_log(device_id TEXT, event_id TEXT, received_at INTEGER, payload TEXT,
        PRIMARY KEY(device_id,event_id));`);
    this.states = new Map(); this.saved = new Map(); this.identities = identities; this.fresh = new Set();
    for (const row of this.db.prepare('SELECT * FROM snapshots').all()) {
      if (identities.some(d => d.id === row.device_id)) this.states.set(row.device_id, { ...decode(row), received_at: row.received_at });
    }
    // 重启时旧指令不可自动重放。UI 显示结果未确认，遥测重新建立设备事实。
    for (const row of this.db.prepare("SELECT * FROM command_log WHERE state IN ('queued','delivered')").all()) {
      const c = decode(row); c.state = 'unknown'; c.reason = 'server_restarted'; this.saveCommand(c);
    }
  }
  device(id) {
    const identity = this.identities.find(d => d.id === id);
    if (!identity) return null;
    const s = this.states.get(id);
    const age = s ? Date.now() - s.received_at + s.sample_age_ms : null;
    const staleAfter = Math.max(5000, (s?.status.upload_interval_ms || 1000) * 3);
    return {
      id, name: identity.name, simulation: identity.simulation, actuator_enabled: identity.actuator === true,
      weight_enabled: identity.weight === true,
      online: this.fresh.has(id) && age !== null && age < staleAfter,
      received_at: s?.received_at || null, age_ms: age, boot_id: s?.boot_id || null, sequence: s?.sequence ?? null,
      uptime_ms: s?.uptime_ms ?? null, firmware: s?.firmware || '等待连接',
      capabilities: s?.capabilities || {}, status: s?.status || null
    };
  }
  devices() { return this.identities.map(d => this.device(d.id)); }
  /** ingest：校验后的同一 boot/sequence 只入库一次；旧启动/乱序包不刷新在线时间。 */
  ingest(body) {
    const previous = this.states.get(body.device_id);
    if (previous?.boot_id === body.boot_id && body.sequence <= previous.sequence) return { accepted: true, duplicate: true };
    if (previous?.boot_id === body.boot_id && body.uptime_ms < previous.uptime_ms) throw new ApiError(409, 'uptime_regressed');
    if (previous?.boot_id !== body.boot_id) {
      const known = this.db.prepare('SELECT 1 FROM boots WHERE device_id=? AND boot_id=?').get(body.device_id, body.boot_id);
      if (known) throw new ApiError(409, 'old_boot');
      this.db.prepare('INSERT INTO boots VALUES (?,?)').run(body.device_id, body.boot_id);
      for (const c of this.commands(body.device_id)) {
        if (['queued','delivered'].includes(c.state)) { c.state = 'unknown'; c.reason = 'device_restarted'; this.saveCommand(c); }
      }
    }
    const s = { ...body, received_at: Date.now() };
    this.states.set(body.device_id, structuredClone(s)); this.fresh.add(body.device_id);
    if (!previous || previous.boot_id !== body.boot_id || Date.now() - (this.saved.get(body.device_id) || 0) >= 1000) {
      this.db.prepare('INSERT OR REPLACE INTO snapshots VALUES (?,?,?)').run(body.device_id, s.received_at, JSON.stringify(body));
      this.db.prepare('INSERT OR IGNORE INTO history VALUES (?,?,?,?,?)').run(body.device_id, body.boot_id, body.sequence, s.received_at, JSON.stringify(body));
      this.saved.set(body.device_id, s.received_at);
    }
    return { accepted: true, duplicate: false, received_at: s.received_at };
  }
  history(id) {
    return this.db.prepare('SELECT received_at,payload FROM history WHERE device_id=? ORDER BY received_at DESC LIMIT 180').all(id).reverse()
      .map(row => ({ received_at: row.received_at, ...decode(row) }));
  }
  command(id) { return decode(this.db.prepare('SELECT payload FROM command_log WHERE id=?').get(id)); }
  byRequest(deviceId, requestId) { return decode(this.db.prepare('SELECT payload FROM command_log WHERE device_id=? AND request_id=?').get(deviceId, requestId)); }
  commands(deviceId) { return this.db.prepare('SELECT payload FROM command_log WHERE device_id=? ORDER BY created_at DESC,rowid DESC LIMIT 50').all(deviceId).map(decode); }
  saveCommand(c) {
    this.db.prepare('INSERT INTO command_log VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,payload=excluded.payload').run(c.id,c.device_id,c.request_id,c.state,c.expires_at,c.created_at,JSON.stringify(c));
    return c;
  }
  /** enqueue：并行泵按通道排队，停止只取消对应范围；debugUntil 为调试会话到期时间。 */
  enqueue(device, body, debugUntil = null) {
    const pending = this.db.prepare(`SELECT payload FROM command_log WHERE device_id=?
      AND state IN ('queued','delivered') AND expires_at>?`).all(device.id,Date.now()).map(decode);
    const channel = body.payload.channel;
    const independentPump = body.type === 'debug_apply' && device.status.actuator.parallel_supported === true &&
      pending.every(c => ['debug_apply','stop'].includes(c.type) && c.payload.channel !== undefined && c.payload.channel !== channel);
    if (pending.length && body.type !== 'stop' && !independentPump) throw new ApiError(409, 'command_pending');
    if (body.type === 'stop') for (const c of pending) {
      if (channel !== undefined && c.type!=='dosing_start' && (!['debug_apply','stop'].includes(c.type) || c.payload.channel !== channel)) continue;
      c.state = 'expired'; c.reason = 'stop_requested'; this.saveCommand(c);
    }
    const s = this.states.get(device.id);
    const created = Date.now();
    const debug = ['debug_apply','aux_apply'].includes(body.type);
    const hardware = debug || ['stop','outlet_configure','dosing_start'].includes(body.type);
    const expires = debug ? Math.min(created + 3000, debugUntil ?? created + 3000) : created + 15000;
    const deviceNow = s.uptime_ms + Math.max(0, created - s.received_at);
    const control = hardware ? this.db.prepare(`INSERT INTO control_counters VALUES (?,1)
      ON CONFLICT(device_id) DO UPDATE SET value=value+1 RETURNING value`).get(device.id).value : undefined;
    return this.saveCommand({
      schema_version: 1, id: crypto.randomUUID(), request_id: body.request_id, device_id: device.id,
      boot_id: device.boot_id, type: body.type, payload: body.payload, state: 'queued',
      created_at: created, expires_at: expires,
      deadline_uptime_ms: deviceNow + Math.max(0, expires - created),
      ...(hardware ? { control_sequence: control } : {}),
      ...(debug ? { lease_deadline_uptime_ms: deviceNow + Math.max(0, (debugUntil ?? created + 5000) - created) } : {})
    });
  }
  /** next：按入队顺序投递，保持固件全局 control_sequence 单调，重复轮询重发尚未回执的一条。 */
  next(deviceId, bootId) {
    const c = decode(this.db.prepare(`SELECT payload FROM command_log WHERE device_id=? AND state IN ('queued','delivered')
      AND expires_at>? AND json_extract(payload,'$.boot_id')=? ORDER BY rowid LIMIT 1`).get(deviceId,Date.now(),bootId));
    if (!c) return null;
    c.state = 'delivered'; c.delivered_at ??= Date.now(); return this.saveCommand(c);
  }
  ack(deviceId, commandId, body) {
    const c = this.command(commandId);
    if (!c || c.device_id !== deviceId) throw new ApiError(404, 'command_not_found');
    if (body.boot_id !== c.boot_id) throw new ApiError(409, 'boot_mismatch');
    if (['completed','rejected'].includes(c.state)) {
      if (c.state !== body.status || JSON.stringify(c.result) !== JSON.stringify(body.result)) throw new ApiError(409, 'ack_conflict');
      return c;
    }
    if (c.expires_at <= Date.now() || !['queued','delivered'].includes(c.state)) throw new ApiError(409, 'command_expired');
    if (c.state !== 'delivered') throw new ApiError(409, 'command_not_delivered');
    c.state = body.status; c.result = body.result; c.completed_at = Date.now();
    return this.saveCommand(c);
  }
  event(identity, body) {
    const old = this.db.prepare('SELECT payload FROM event_log WHERE device_id=? AND event_id=?').get(identity.id,body.event_id);
    if (old) return { accepted: true, duplicate: true };
    const event = { ...body, received_at: Date.now() };
    this.db.prepare('INSERT INTO event_log VALUES (?,?,?,?)').run(identity.id,body.event_id,event.received_at,JSON.stringify(event));
    return { accepted: true, duplicate: false };
  }
  events(id) { return this.db.prepare('SELECT payload FROM event_log WHERE device_id=? ORDER BY received_at DESC LIMIT 50').all(id).map(decode); }
  prune() {
    for (const d of this.identities) for (const c of this.commands(d.id)) {
      if (['queued','delivered'].includes(c.state) && c.expires_at <= Date.now()) {
        c.state = c.state === 'delivered' ? 'unknown' : 'expired'; c.reason = 'deadline_elapsed'; this.saveCommand(c);
      }
    }
    const cutoff = Date.now() - 86400000;
    this.db.prepare('DELETE FROM history WHERE received_at < ?').run(cutoff);
    this.db.prepare('DELETE FROM event_log WHERE received_at < ?').run(cutoff - 6 * 86400000);
    this.db.prepare('DELETE FROM command_log WHERE created_at < ?').run(cutoff - 6 * 86400000);
  }
  close() { this.db.close(); }
}
module.exports = { Store };
