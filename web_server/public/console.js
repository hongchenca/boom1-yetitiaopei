'use strict';
const C = { recipes: [], selected: null, saving: false, baseline: '', role: null, calibrationRequest: 0 };
const q = s => document.querySelector(s);
const put = (s, v) => { const n = q(s); if (n) { n.textContent = v; if(n.classList.contains('result-line')) n.dataset.state=/失败|无权/.test(v)?'error':'success'; } };
const errText = e => ({ permission_denied: '当前账号无权执行此操作', recipe_version_conflict: '配方已更新，请刷新后重试', recipe_not_ready: '配方不存在或未启用', device_busy: '设备正在执行其他任务', sensor_not_ready: '中央称重样本尚未稳定', calibration_version_conflict: '标定已更新，请刷新后重试', invalid_payload: '输入内容或范围无效' }[e.message] || e.message);
const uid = () => crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2);
const steps = () => [...document.querySelectorAll('#recipe-steps .step-row')].map(r => ({ channel: Number(r.querySelector('.step-channel').value), target_mg: Number(r.querySelector('.step-target').value), tolerance_mg: Number(r.querySelector('.step-tolerance').value), settle_ms: Number(r.querySelector('.step-settle').value) }));
const recipeDraft = () => ({name:q('#recipe-name').value,enabled:q('#recipe-enabled').checked,notes:q('#recipe-notes').value,steps:steps()});
const recipeDirty = () => Boolean(C.selected && C.baseline!==JSON.stringify(recipeDraft()));
function confirmRecipeChange() { return !C.saving && (!recipeDirty() || window.confirm('配方有未保存的修改，放弃修改？')); }
function markRecipeDirty() {
  const dirty=recipeDirty();q('#recipe-version-label').classList.toggle('recipe-dirty',dirty);
  put('#recipe-version-label',dirty ? '有未保存的修改' : `版本 ${C.selected?.version || 0} · ${q('#recipe-enabled').checked ? '已启用' : '已停用'}`);
}
/** updatePermissions：与后台角色一致禁用编辑入口；只读账号不会误入不可执行操作。 */
function updatePermissions() {
  const editable=['admin','engineer'].includes(C.role);
  document.querySelectorAll('#recipe-form input,#recipe-form select,#recipe-form textarea,#recipe-form button,.recipe-item,#recipe-new,#recipe-refresh').forEach(node=>{
    node.disabled=C.saving || (!editable && !node.matches('.recipe-item,#recipe-refresh'));
  });
  q('#recipe-delete').disabled=!editable || C.saving || !C.selected?.version;
  const count=q('#recipe-steps').querySelectorAll('.step-row').length;
  document.querySelectorAll('.step-remove').forEach(node=>node.disabled=!editable || C.saving || count<=1);
  const add=q('.step-add');if(add)add.disabled=!editable || C.saving || count>=8;
  document.querySelectorAll('#calibration-form input,#calibration-form select,#calibration-form textarea,#calibration-form button,#export-records').forEach(node=>node.disabled=!editable);
}
function renderSteps(list) {
  const host = q('#recipe-steps'); host.replaceChildren();
  list.forEach((item, index) => {
    const row = document.createElement('div'); row.className = 'step-row';
    const c = document.createElement('select'); c.className = 'step-channel'; for (let i=0;i<8;i++) c.add(new Option('原液 ' + String(i+1).padStart(2,'0'), i)); c.value = String(item.channel);
    const target = document.createElement('input'); target.className = 'step-target'; target.type = 'number'; target.min = '1'; target.required = true; target.value = item.target_mg;
    const tol = document.createElement('input'); tol.className = 'step-tolerance'; tol.type = 'number'; tol.min = '0'; tol.required = true; tol.value = item.tolerance_mg;
    const settle = document.createElement('input'); settle.className = 'step-settle'; settle.type = 'number'; settle.min = '0'; settle.max = '60000'; settle.required = true; settle.value = item.settle_ms;
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'ghost step-remove'; remove.textContent = '移除'; remove.setAttribute('aria-label',`移除步骤 ${index+1}`); remove.disabled = list.length === 1;
    remove.onclick = () => { const next = steps(); next.splice(index,1); renderSteps(next); markRecipeDirty(); q('#recipe-steps .step-add').focus(); };
    // 显式标签在手机上直接显示，避免数字输入离开表头后失去含义。
    [[c,'原液通道'],[target,'目标 · mg'],[tol,'容差 · mg'],[settle,'稳定 · ms']].forEach(([input,label])=>{
      const field=document.createElement('label'); field.className='step-field';
      const caption=document.createElement('span'); caption.textContent=label;
      input.setAttribute('aria-label',`步骤 ${index+1} ${label}`); field.append(caption,input); row.append(field);
    });
    row.append(remove); host.append(row);
  });
  const add = document.createElement('button'); add.type = 'button'; add.className = 'secondary step-add'; add.textContent = '＋ 增加原液'; add.disabled = list.length >= 8;
  add.onclick = () => { const used = steps().map(x => x.channel); const channel = [0,1,2,3,4,5,6,7].find(x => !used.includes(x)); if (channel !== undefined && used.length < 8) { renderSteps(steps().concat([{ channel, target_mg: 1000, tolerance_mg: 20, settle_ms: 500 }])); markRecipeDirty(); q('#recipe-steps .step-row:last-of-type .step-channel')?.focus(); } }; host.append(add);
}
function setRecipe(recipe) {
  const r = recipe || { id: uid(), version: 0, name: '新配方', enabled: true, notes: '', steps: [{ channel: 0, target_mg: 1000, tolerance_mg: 20, settle_ms: 500 }] };
  C.selected = r; q('#recipe-id').value = r.id; q('#recipe-id').dataset.version = r.version || 0; q('#recipe-name').value = r.name; q('#recipe-enabled').checked = r.enabled; q('#recipe-notes').value = r.notes || ''; put('#recipe-form-title', r.version ? '编辑配方' : '新建配方'); put('#recipe-version-label', '版本 ' + (r.version || 0) + ' · ' + (r.enabled ? '已启用' : '已停用')); renderSteps(r.steps);
  C.baseline=JSON.stringify(recipeDraft()); markRecipeDirty();updatePermissions();
  document.querySelectorAll('.recipe-item').forEach(item=>{
    const selected=item.dataset.id===r.id; item.classList.toggle('selected',selected); item.setAttribute('aria-pressed',String(selected));
  });
}
async function loadRecipes() {
  const result = await window.yetiApi('recipes'); C.recipes = result.recipes; const list = q('#recipe-list'); list.replaceChildren();
  put('#recipe-count',String(C.recipes.length));
  if (!C.recipes.length) { list.innerHTML = '<div class="empty-state"><svg class="icon" aria-hidden="true"><use href="#i-recipe"/></svg><b>第一份配方，从这里开始</b><p>填写原液用量，保存即可复用。</p></div>'; }
  C.recipes.forEach(r => { const b = document.createElement('button'); b.type='button'; b.dataset.id=r.id; b.className='recipe-item' + (C.selected && C.selected.id === r.id ? ' selected' : ''); b.setAttribute('aria-pressed',String(C.selected?.id===r.id)); b.innerHTML = '<span><b></b><small></small></span><em></em>'; b.querySelector('b').textContent=r.name; b.querySelector('small').textContent='v'+r.version+' · '+(r.enabled?'已启用':'已停用'); b.querySelector('em').textContent=r.steps.length+' 路'; b.onclick=()=>{if(confirmRecipeChange()){setRecipe(r);put('#recipe-result','');}}; list.append(b); });
  const select = q('#batch-recipe'); if (select) { select.replaceChildren(...C.recipes.map(r => new Option(r.name+' · v'+r.version, r.id))); if (C.selected) select.value=C.selected.id; }
  if(C.selected?.version && !recipeDirty()) { const current=C.recipes.find(r=>r.id===C.selected.id); if(current && current.version!==C.selected.version)setRecipe(current); }
  if (!C.selected && C.recipes[0]) setRecipe(C.recipes[0]);
  if (!C.selected) setRecipe(null);
  updatePermissions();
}
/** saveRecipe：阻止重复保存，保存结果只更新当前配方；保留服务端版本校验。 */
async function saveRecipe(e) {
  e.preventDefault(); if(C.saving) return;
  C.saving=true; updatePermissions(); const epoch=window.yetiState.epoch; const submit=q('#recipe-form button[type=submit]'); submit.disabled=true; submit.textContent='保存中…';
  try {
    const payload={ id:q('#recipe-id').value || uid(), expected_version:Number(q('#recipe-id').dataset.version || 0), name:q('#recipe-name').value.trim(), enabled:q('#recipe-enabled').checked, notes:q('#recipe-notes').value, steps:steps() };
    const result=await window.yetiApi('recipes',payload);
    if(epoch!==window.yetiState.epoch)return;
    if(q('#recipe-id').value===payload.id) { setRecipe(result.recipe); put('#recipe-result','已保存 v'+result.recipe.version); }
    await loadRecipes();
  } catch (error) { if(epoch===window.yetiState.epoch)put('#recipe-result','保存失败：'+errText(error)); }
  finally { if(epoch===window.yetiState.epoch){C.saving=false; updatePermissions(); submit.textContent='保存配方';} }
}
async function removeRecipe() { const r=C.selected; if (!r || !r.version || !window.confirm('确认删除配方“'+r.name+'”？')) return; try { await window.yetiApi('recipes/'+r.id+'/delete',{ expected_version:r.version }); C.selected=null; put('#recipe-result','已删除'); await loadRecipes(); setRecipe(null); } catch (error) { put('#recipe-result','删除失败：'+errText(error)); } }
async function loadAudit() {
  const result=await window.yetiApi('audit?limit=50'); const host=q('#audit-list'); host.replaceChildren();
  const actions={recipe_created:'创建配方',recipe_updated:'更新配方',recipe_deleted:'删除配方',calibration_recorded:'保存标定记录',data_exported:'导出记录',user_saved:'更新账号',login:'登录工作台',logout:'退出工作台',login_success:'登录工作台',password_changed:'修改密码',command_queued:'提交设备操作',debug_session_created:'打开泵控制会话'};
  if (!result.audit.length) { host.classList.add('empty-state'); host.textContent='暂无操作记录'; } else host.classList.remove('empty-state');
  result.audit.forEach(a=>{
    const row=document.createElement('div'); row.className='event';
    const body=document.createElement('div'), title=document.createElement('b'), actor=document.createElement('small');
    title.textContent=actions[a.action] || a.action; actor.textContent=a.actor; body.append(title,document.createElement('br'),actor);
    const detail=document.createElement('details'), summary=document.createElement('summary'), payload=document.createElement('pre');
    summary.textContent='查看详情'; payload.textContent=JSON.stringify({target:a.target,...a.payload},null,2); detail.append(summary,payload); body.append(detail);
    const stamp=document.createElement('small'); stamp.textContent=a.created_at ? new Date(a.created_at).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}) : '';
    row.append(body,stamp); host.append(row);
  });
}
async function loadCalibration() {
  const device = window.yetiState?.selected, channel=Number(q('#cal-channel').value), request=++C.calibrationRequest;
  q('#cal-channel').dataset.version='0';put('#cal-result','');
  if (!device) return;
  try {
    const result = await window.yetiApi('devices/'+device+'/calibration');
    if(request!==C.calibrationRequest || device!==window.yetiState.selected || channel!==Number(q('#cal-channel').value))return;
    const latest = (result.calibration || []).find(item => item.channel === channel);
    q('#cal-channel').dataset.version = String(latest?.version || 0);
    if (latest) put('#cal-result','当前版本 v'+latest.version+' · '+latest.mg_per_count.toFixed(6)+' mg/count');
  } catch (error) { if(request===C.calibrationRequest)put('#cal-result','读取标定记录失败：'+errText(error)); }
}
/** saveCalibration：锁定本次记录身份，避免切通道/设备后迟到结果覆盖新表单。 */
async function saveCalibration(e) {
  e.preventDefault();const submit=q('#calibration-form button[type=submit]');if(submit.disabled)return;
  const device=window.yetiState.selected,channel=Number(q('#cal-channel').value),epoch=window.yetiState.epoch;
  const same=()=>epoch===window.yetiState.epoch && device===window.yetiState.selected && channel===Number(q('#cal-channel').value);
  submit.disabled=true;
  try {
    const result=await window.yetiApi('devices/'+device+'/calibration',{channel,zero_raw:Number(q('#cal-zero').value),loaded_raw:Number(q('#cal-loaded').value),known_mass_mg:Number(q('#cal-mass').value),source:q('#cal-source').value,notes:q('#cal-notes').value,expected_version:Number(q('#cal-channel').dataset.version || 0)});
    if(same()){q('#cal-channel').dataset.version=String(result.calibration.version);put('#cal-result','已保存通道 '+channel+' · 版本 v'+result.calibration.version+' · 系数 '+result.calibration.mg_per_count.toFixed(6)+' mg/count');}
    loadAudit().catch(()=>{});
  }catch(error){if(same())put('#cal-result','保存失败：'+errText(error));}
  finally{if(epoch===window.yetiState.epoch)submit.disabled=!['admin','engineer'].includes(C.role);}
}
async function loadDiagnostics() { try { const result=await window.yetiApi('diagnostics'); q('#diagnostics').textContent=JSON.stringify(result,null,2); } catch (error) { put('#diagnostics','诊断失败：'+errText(error)); } }
async function exportRecords() { try { const response=await fetch(new URL('api/v1/export',location.href),{ credentials:'same-origin' }); if(!response.ok) throw new Error((await response.json()).error || '导出失败'); const link=document.createElement('a'); link.href=URL.createObjectURL(await response.blob()); link.download='yetitiaopei-records.json'; link.click(); setTimeout(()=>URL.revokeObjectURL(link.href),1000); } catch (error) { window.alert(errText(error)); } }
function bootConsole() {
  q('#recipe-form')?.addEventListener('submit',saveRecipe); q('#recipe-new')?.addEventListener('click',()=>{if(!confirmRecipeChange())return;setRecipe(null);put('#recipe-result','');q('#recipe-name').focus();q('#recipe-name').select();}); q('#recipe-refresh')?.addEventListener('click',async()=>{if(!confirmRecipeChange())return;const id=C.selected?.id;C.selected=null;await loadRecipes().catch(e=>put('#recipe-result',errText(e)));const latest=C.recipes.find(r=>r.id===id);if(latest)setRecipe(latest);}); q('#recipe-delete')?.addEventListener('click',removeRecipe); q('#calibration-form')?.addEventListener('submit',saveCalibration); q('#export-records')?.addEventListener('click',exportRecords); q('#diagnostics-refresh')?.addEventListener('click',loadDiagnostics);
  document.querySelectorAll('.nav').forEach(n=>n.addEventListener('click',()=>{ if(n.dataset.tab==='recipes'){loadRecipes().catch(()=>{});} if(n.dataset.tab==='records'){loadAudit().catch(()=>{});loadCalibration().catch(()=>{});} if(n.dataset.tab==='settings')loadDiagnostics().catch(()=>{}); }));
  q('#cal-channel')?.addEventListener('change',()=>loadCalibration().catch(()=>{}));
  q('#reload-events').addEventListener('click',()=>{loadAudit().catch(()=>{});loadCalibration().catch(()=>{});});
  q('#recipe-form').addEventListener('input',markRecipeDirty);
  window.addEventListener('beforeunload',event=>{if(recipeDirty()){event.preventDefault();event.returnValue='';}});
  window.addEventListener('yeti:device',()=>loadCalibration().catch(()=>{}));
  window.addEventListener('yeti:session',event=>{
    C.role=event.detail.role || null;
    if(!event.detail.active){C.selected=null;C.recipes=[];C.saving=false;C.baseline='';++C.calibrationRequest;q('#recipe-form').reset();q('#recipe-steps').replaceChildren();q('#recipe-list').replaceChildren();q('#audit-list').replaceChildren();return;}
    updatePermissions();loadRecipes().catch(e=>put('#recipe-result',errText(e)));loadAudit().catch(()=>{});loadCalibration().catch(()=>{});loadDiagnostics().catch(()=>{});
  });
}
bootConsole();
