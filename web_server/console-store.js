const crypto = require('node:crypto');
const { ApiError, requireValue, plain, integer, identifier } = require('./protocol');
const decode = row => row ? JSON.parse(row.payload) : null;
const ACTIVE = ['running', 'settling'];
const roles = ['viewer', 'operator', 'engineer', 'admin'];

/** validateRecipe：保存前统一校验八路剂量，内部单位为 mg；body 来自网页 JSON。 */
function validateRecipe(body) {
  requireValue(typeof body.name === 'string' && body.name.trim().length > 0 && body.name.trim().length <= 64);
  requireValue(typeof body.enabled === 'boolean' && typeof body.notes === 'string' && body.notes.length <= 500);
  requireValue(Array.isArray(body.steps) && body.steps.length > 0 && body.steps.length <= 8);
  const seen = new Set();
  const steps = body.steps.map(s => {
    requireValue(plain(s) && integer(s.channel, 0, 7) && !seen.has(s.channel)); seen.add(s.channel);
    requireValue(integer(s.target_mg, 1, 100000000) && integer(s.tolerance_mg, 0, s.target_mg) && integer(s.settle_ms, 0, 60000));
    return { channel: s.channel, target_mg: s.target_mg, tolerance_mg: s.tolerance_mg, settle_ms: s.settle_ms };
  });
  return { name: body.name.trim(), notes: body.notes, enabled: body.enabled, steps };
}

/** ConsoleStore：业务数据与遥测共用独立 SQLite；保存配方、人工标定记录与审计；不代替设备控制。 */
class ConsoleStore {
  constructor(store, config) {
    this.store = store; this.db = store.db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS console_recipes(id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS recipe_versions(id TEXT, version INTEGER, payload TEXT NOT NULL, PRIMARY KEY(id,version));
      CREATE TABLE IF NOT EXISTS calibrations(id TEXT PRIMARY KEY, device_id TEXT, channel INTEGER, version INTEGER, payload TEXT NOT NULL, UNIQUE(device_id,channel,version));
      CREATE TABLE IF NOT EXISTS batches(id TEXT PRIMARY KEY, device_id TEXT, request_id TEXT UNIQUE, state TEXT, created_at INTEGER, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS audits(id INTEGER PRIMARY KEY AUTOINCREMENT, created_at INTEGER, actor TEXT, action TEXT, target TEXT, payload TEXT);
      CREATE INDEX IF NOT EXISTS audit_created ON audits(created_at);
      CREATE TABLE IF NOT EXISTS console_users(username TEXT PRIMARY KEY, role TEXT, enabled INTEGER, revision INTEGER, salt TEXT, hash TEXT);
    `);
    if (!this.user(config.username)) this.writeUser(config.username, 'admin', true, config.password);
    // 旧任务保留历史，重启不补跑。
    for (const job of this.activeJobs()) this.finish(job, 'interrupted', 'server_restarted');
  }
  /** transaction：业务更新与审计一起提交；fn 为同步 SQLite 操作。 */
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  audit(actor, action, target, payload = {}) {
    this.db.prepare('INSERT INTO audits(created_at,actor,action,target,payload) VALUES(?,?,?,?,?)')
      .run(Date.now(), actor, action, target || '', JSON.stringify(payload));
  }
  audits(query = {}) {
    const after = Number(query.after || 0), before = Number(query.before || Number.MAX_SAFE_INTEGER);
    const limit = Number(query.limit || 100), offset = Number(query.offset || 0);
    requireValue(integer(after,0,Number.MAX_SAFE_INTEGER) && integer(before,after,Number.MAX_SAFE_INTEGER) && integer(limit,1,500) && integer(offset,0,1000000));
    return this.db.prepare('SELECT * FROM audits WHERE created_at>=? AND created_at<=? AND (?=\'\' OR action=?) ORDER BY id DESC LIMIT ? OFFSET ?')
      .all(after,before,query.action || '',query.action || '',limit,offset).map(r => ({ ...r, payload: JSON.parse(r.payload) })).filter(r => r.target !== 'sim-001' && !r.action.startsWith('batch_') && r.payload.mode !== 'simulation');
  }
  user(username) {
    return this.db.prepare('SELECT username,role,enabled,revision FROM console_users WHERE username=?').get(username) || null;
  }
  users() { return this.db.prepare('SELECT username,role,enabled,revision FROM console_users ORDER BY username').all(); }
  /** authenticate：用加盐 scrypt 验证密码；返回值永不含 hash 或 salt。 */
  authenticate(username, password) {
    if (typeof username !== 'string' || typeof password !== 'string' || password.length > 128) return null;
    const row = this.db.prepare('SELECT * FROM console_users WHERE username=?').get(username);
    const hash = crypto.scryptSync(password, row?.salt || 'invalid-user-salt', 32);
    if (!row || !row.enabled || !crypto.timingSafeEqual(hash, Buffer.from(row.hash, 'hex'))) return null;
    return this.user(username);
  }
  writeUser(username, role, enabled, password) {
    const old = this.db.prepare('SELECT * FROM console_users WHERE username=?').get(username);
    const salt = password ? crypto.randomBytes(16).toString('hex') : old.salt;
    const hash = password ? crypto.scryptSync(password, salt, 32).toString('hex') : old.hash;
    this.db.prepare('INSERT INTO console_users VALUES(?,?,?,?,?,?) ON CONFLICT(username) DO UPDATE SET role=excluded.role,enabled=excluded.enabled,revision=excluded.revision,salt=excluded.salt,hash=excluded.hash')
      .run(username,role,enabled ? 1 : 0,(old?.revision || 0)+1,salt,hash);
    return this.user(username);
  }
  /** saveUser：修改角色/停用/重置密码会递增会话版本；保留至少一个启用管理员。 */
  saveUser(body, actor) {
    requireValue(typeof body.username === 'string' && /^[a-zA-Z0-9_-]{1,48}$/.test(body.username) && roles.includes(body.role) && typeof body.enabled === 'boolean');
    const old = this.user(body.username);
    requireValue((!body.password && old) || (typeof body.password === 'string' && body.password.length >= 12 && body.password.length <= 128));
    if (old && body.expected_revision !== old.revision) throw new ApiError(409,'user_version_conflict');
    if (old?.role === 'admin' && old.enabled && (body.role !== 'admin' || !body.enabled) && this.users().filter(u => u.role === 'admin' && u.enabled).length === 1) throw new ApiError(409,'last_admin');
    return this.transaction(() => {
      const user = this.writeUser(body.username,body.role,body.enabled,body.password);
      this.audit(actor,'user_saved',user.username,{ role:user.role, enabled:user.enabled }); return user;
    });
  }
  recipes() { return this.db.prepare('SELECT payload FROM console_recipes ORDER BY rowid DESC').all().map(decode); }
  recipe(id) { return decode(this.db.prepare('SELECT payload FROM console_recipes WHERE id=?').get(id)); }
  recipeVersions(id) { return this.db.prepare('SELECT payload FROM recipe_versions WHERE id=? ORDER BY version DESC').all(id).map(decode); }
  /** saveRecipe：版本快照与当前配方原子保存；客户端指定 id，使创建重试可识别。 */
  saveRecipe(body, actor) {
    requireValue(identifier(body.id)); const data = validateRecipe(body), old = this.recipe(body.id);
    // 删除后仍保留历史版本；同一 id 不能再从 version=1 开始写入，避免
    // recipe_versions 主键冲突被包装成 500 internal_error。
    if (!old) {
      const history = this.db.prepare('SELECT MAX(version) AS version FROM recipe_versions WHERE id=?').get(body.id);
      if (history?.version) throw new ApiError(409,'recipe_id_reused');
    }
    if (body.expected_version !== (old?.version || 0)) throw new ApiError(409,'recipe_version_conflict');
    const recipe = { ...data, id:body.id, version:(old?.version || 0)+1, updated_at:Date.now(), author:actor };
    return this.transaction(() => {
      this.db.prepare('INSERT INTO console_recipes VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(recipe.id,JSON.stringify(recipe));
      this.db.prepare('INSERT INTO recipe_versions VALUES(?,?,?)').run(recipe.id,recipe.version,JSON.stringify(recipe));
      this.audit(actor,old ? 'recipe_updated':'recipe_created',recipe.id,{version:recipe.version}); return recipe;
    });
  }
  deleteRecipe(id, version, actor) {
    const old = this.recipe(id); if (!old) throw new ApiError(404,'recipe_not_found');
    if (old.version !== version) throw new ApiError(409,'recipe_version_conflict');
    return this.transaction(() => { this.db.prepare('DELETE FROM console_recipes WHERE id=?').run(id); this.audit(actor,'recipe_deleted',id,{version}); return {deleted:true}; });
  }
  calibrations(deviceId) {
    // 页面需要每个通道的最新版本来填 expected_version。保留最近 200 条
    // 历史的同时，额外并入每个通道的最新记录，避免某一通道被其它通道的
    // 高频标定挤出窗口后，页面误显示 version=0 并得到冲突响应。
    return this.db.prepare(`
      SELECT payload FROM calibrations
      WHERE device_id=? AND (
        rowid >= COALESCE((SELECT rowid FROM calibrations WHERE device_id=? ORDER BY rowid DESC LIMIT 1 OFFSET 199), 0)
        OR rowid IN (SELECT MAX(rowid) FROM calibrations WHERE device_id=? GROUP BY channel)
      ) ORDER BY rowid DESC
    `).all(deviceId,deviceId,deviceId).map(decode).filter(r => r.source !== 'simulation');
  }
  /** saveCalibration：两点 ADC 标定计算及测量记录归档；不下发 ESP、不改变遥测。 */
  saveCalibration(device, body, actor) {
    requireValue(integer(body.channel,0,8) && integer(body.zero_raw,-8388608,8388607) && integer(body.loaded_raw,-8388608,8388607));
    requireValue(body.zero_raw !== body.loaded_raw && integer(body.known_mass_mg,1,100000000));
    requireValue(typeof body.notes === 'string' && body.notes.length <= 500 && body.source === 'manual');
    const old = decode(this.db.prepare('SELECT payload FROM calibrations WHERE device_id=? AND channel=? ORDER BY version DESC LIMIT 1').get(device.id,body.channel));
    if (body.expected_version !== (old?.version || 0)) throw new ApiError(409,'calibration_version_conflict');
    const record = { id:crypto.randomUUID(),device_id:device.id,channel:body.channel,version:(old?.version || 0)+1,
      zero_raw:body.zero_raw,loaded_raw:body.loaded_raw,known_mass_mg:body.known_mass_mg,
      mg_per_count:body.known_mass_mg/(body.loaded_raw-body.zero_raw),source:body.source,applied:false,
      notes:body.notes,created_at:Date.now(),author:actor };
    return this.transaction(() => { this.db.prepare('INSERT INTO calibrations VALUES(?,?,?,?,?)').run(record.id,device.id,record.channel,record.version,JSON.stringify(record)); this.audit(actor,'calibration_recorded',device.id,{channel:record.channel,version:record.version}); return record; });
  }
  jobs() { return this.db.prepare('SELECT payload FROM batches ORDER BY created_at DESC LIMIT 200').all().map(decode).filter(j => j.mode !== 'simulation' && this.store.device(j.device_id)); }
  job(id) { return this.jobs().find(j => j.id === id) || null; }
  activeJobs() { return this.jobs().filter(j => ACTIVE.includes(j.state)); }
  activeJob(deviceId) { return this.activeJobs().find(j => j.device_id === deviceId); }
  saveJob(job) { this.db.prepare('INSERT INTO batches VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,payload=excluded.payload').run(job.id,job.device_id,job.request_id,job.state,job.created_at,JSON.stringify(job)); return job; }
  /** startJob：真实闭环配液尚未实现，明确拒绝执行；不生成软件剂量。 */
  startJob() { throw new ApiError(409,'automatic_dosing_not_supported'); }
  finish(job, state, reason, actor = 'system') {
    return this.transaction(() => { job.state=state; job.reason=reason; job.updated_at=Date.now(); job.finished_at=job.updated_at; this.saveJob(job); this.audit(actor,'batch_'+state,job.id,{reason}); return job; });
  }
  stopJob(id, actor) { const job=this.job(id); if (!job) throw new ApiError(404,'job_not_found'); return ACTIVE.includes(job.state) ? this.finish(job,'cancelled','user_cancelled',actor) : job; }
  exportData() { return {schema_version:1,exported_at:Date.now(),recipes:this.recipes(),calibrations:this.store.identities.flatMap(d=>this.calibrations(d.id)),batches:this.jobs(),audit:this.audits({limit:500}),limits:{batches:200,calibrations_per_device:200,audit:500}}; }
}
module.exports={ConsoleStore,validateRecipe,roles};
