const { ApiError, requireValue } = require('./protocol');

const permissions = { viewer:[], operator:['operate'], engineer:['operate','edit'], admin:['operate','edit','admin'] };
/** requireRole：后端权限入口；user 为当前数据库身份，permission 为操作等级。 */
function requireRole(user, permission) {
  if (!permissions[user.role]?.includes(permission)) throw new ApiError(403,'permission_denied');
}

/** consoleRoute：业务路由与原设备协议分离；返回 true 表示已响应，原有设备链路保持兼容。 */
function consoleRoute({p,req,res,url,body,user,send,business,store}) {
  const get=req.method==='GET', post=req.method==='POST';
  if (p==='/auth/me' && get) { send(res,200,{username:user.username,role:user.role,revision:user.revision}); return true; }
  if (p==='/users') {
    requireRole(user,'admin');
    if (get) { send(res,200,{users:business.users()}); return true; }
    if (post) { send(res,200,{user:business.saveUser(body,user.username)}); return true; }
  }
  if (p==='/auth/password' && post) {
    if (!business.authenticate(user.username,body.current_password)) throw new ApiError(400,'invalid_credentials');
    requireValue(typeof body.password==='string' && body.password.length>=12 && body.password.length<=128);
    // user() returns SQLite's 0/1 enabled value; saveUser deliberately accepts
    // a boolean so callers cannot accidentally persist arbitrary integers.
    business.saveUser({ username:user.username, role:user.role, enabled:true,
      password:body.password, expected_revision:user.revision },user.username);
    send(res,200,{ok:true,relogin:true}); return true;
  }
  if(p==='/recipes') {
    if(get) { send(res,200,{recipes:business.recipes()}); return true; }
    if(post) { requireRole(user,'edit'); send(res,200,{recipe:business.saveRecipe(body,user.username)}); return true; }
  }
  const recipe=/^\/recipes\/([a-zA-Z0-9_-]+)\/(versions|delete)$/.exec(p);
  if(recipe) {
    if(get && recipe[2]==='versions') {send(res,200,{versions:business.recipeVersions(recipe[1])}); return true;}
    if(post && recipe[2]==='delete') {requireRole(user,'edit');send(res,200,business.deleteRecipe(recipe[1],body.expected_version,user.username));return true;}
  }
  if(p==='/jobs') {
    if(get) {send(res,200,{jobs:business.jobs()});return true;}
    if(post) {requireRole(user,'operate');send(res,202,{job:business.startJob(body,user.username)});return true;}
  }
  const job=/^\/jobs\/([a-zA-Z0-9_-]+)(?:\/(stop))?$/.exec(p);
  if(job) {
    if(get && !job[2]) {const result=business.job(job[1]);if(!result) throw new ApiError(404,'job_not_found');send(res,200,{job:result});return true;}
    if(post && job[2]==='stop') {requireRole(user,'operate');send(res,200,{job:business.stopJob(job[1],user.username)});return true;}
  }
  const calibration=/^\/devices\/([a-zA-Z0-9_-]+)\/calibration$/.exec(p);
  if(calibration) {
    const device=store.device(calibration[1]);if(!device) throw new ApiError(404,'device_not_found');
    if(get) {send(res,200,{calibration:business.calibrations(device.id)});return true;}
    if(post) {requireRole(user,'edit');send(res,200,{calibration:business.saveCalibration(device,body,user.username)});return true;}
  }
  if(p==='/audit' && get) { send(res,200,{audit:business.audits(Object.fromEntries(url.searchParams))});return true; }
  if(p==='/export' && get) {
    requireRole(user,'edit'); business.audit(user.username,'data_exported','console');
    send(res,200,business.exportData(),{'Content-Disposition':'attachment; filename="yetitiaopei-records.json"'});return true;
  }
  if(p==='/diagnostics' && get) {
    send(res,200,{version:'0.5.1',node:process.version,hardware_control:true,telemetry_push:'on_receive',default_upload_ms:200,
      retention:{telemetry_hours:24,commands_days:7},devices:store.devices().map(d=>({id:d.id,online:d.online,age_ms:d.age_ms,firmware:d.firmware})),
      counts:{recipes:business.recipes().length,active_batches:business.activeJobs().length},base_path:url.pathname.slice(0,-'/api/v1/diagnostics'.length)});return true;
  }
  return false;
}
module.exports={consoleRoute,requireRole};
