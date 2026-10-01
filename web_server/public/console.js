'use strict';
const C = { recipes: [], selected: null, job: null, timer: null, booted: false };
const q = s => document.querySelector(s);
const put = (s, v) => { const n = q(s); if (n) n.textContent = v; };
const errText = e => ({ permission_denied: '当前账号无权执行此操作', recipe_version_conflict: '配方已更新，请刷新后重试', recipe_not_ready: '配方不存在或未启用', device_busy: '设备正在执行其他任务', insufficient_inventory: '模拟设备当前库存不足', sensor_not_ready: '中央称重样本尚未稳定', calibration_version_conflict: '标定已更新，请刷新后重试', invalid_payload: '输入内容或范围无效' }[e.message] || e.message);
const uid = () => crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2);
const steps = () => [...document.querySelectorAll('#recipe-steps .step-row')].map(r => ({ channel: Number(r.querySelector('.step-channel').value), target_mg: Number(r.querySelector('.step-target').value), tolerance_mg: Number(r.querySelector('.step-tolerance').value), settle_ms: Number(r.querySelector('.step-settle').value) }));
function renderSteps(list) {
  const host = q('#recipe-steps'); host.replaceChildren();
  list.forEach(item => {
    const row = document.createElement('div'); row.className = 'step-row';
    const c = document.createElement('select'); c.className = 'step-channel'; for (let i=0;i<8;i++) c.add(new Option('CH ' + String(i).padStart(2,'0'), i)); c.value = String(item.channel);
    const target = document.createElement('input'); target.className = 'step-target'; target.type = 'number'; target.min = '1'; target.required = true; target.value = item.target_mg;
    const tol = document.createElement('input'); tol.className = 'step-tolerance'; tol.type = 'number'; tol.min = '0'; tol.required = true; tol.value = item.tolerance_mg;
    const settle = document.createElement('input'); settle.className = 'step-settle'; settle.type = 'number'; settle.min = '0'; settle.max = '60000'; settle.required = true; settle.value = item.settle_ms;
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'ghost step-remove'; remove.textContent = '移除'; remove.onclick = () => { if (host.querySelectorAll('.step-row').length > 1) row.remove(); };
    row.append(c,target,tol,settle,remove); host.append(row);
  });
  const add = document.createElement('button'); add.type = 'button'; add.className = 'secondary step-add'; add.textContent = '增加步骤'; add.onclick = () => { const used = steps().map(x => x.channel); const channel = [0,1,2,3,4,5,6,7].find(x => !used.includes(x)); if (channel !== undefined && used.length < 8) renderSteps(steps().concat([{ channel, target_mg: 1000, tolerance_mg: 20, settle_ms: 500 }])); }; host.append(add);
}
function setRecipe(recipe) {
  const r = recipe || { id: uid(), version: 0, name: '新配方', enabled: true, notes: '', steps: [{ channel: 0, target_mg: 1000, tolerance_mg: 20, settle_ms: 500 }] };
  C.selected = r; q('#recipe-id').value = r.id; q('#recipe-id').dataset.version = r.version || 0; q('#recipe-name').value = r.name; q('#recipe-enabled').checked = r.enabled; q('#recipe-notes').value = r.notes || ''; put('#recipe-form-title', r.version ? '编辑配方' : '新建配方'); put('#recipe-version-label', '版本 ' + (r.version || 0) + ' · ' + (r.enabled ? '已启用' : '已停用')); renderSteps(r.steps);
}
async function loadRecipes() {
  const result = await window.yetiApi('recipes'); C.recipes = result.recipes; const list = q('#recipe-list'); list.replaceChildren();
  if (!C.recipes.length) { list.textContent = '暂无配方，请新建。'; }
  C.recipes.forEach(r => { const b = document.createElement('button'); b.type='button'; b.className='recipe-item' + (C.selected && C.selected.id === r.id ? ' selected' : ''); b.innerHTML = '<span><b></b><small></small></span><em></em>'; b.querySelector('b').textContent=r.name; b.querySelector('small').textContent='v'+r.version+' · '+(r.enabled?'已启用':'已停用'); b.querySelector('em').textContent=r.steps.length+' 路'; b.onclick=()=>setRecipe(r); list.append(b); });
  const select = q('#batch-recipe'); if (select) { select.replaceChildren(...C.recipes.map(r => new Option(r.name+' · v'+r.version, r.id))); if (C.selected) select.value=C.selected.id; }
  if (!C.selected && C.recipes[0]) setRecipe(C.recipes[0]);
}
async function saveRecipe(e) { e.preventDefault(); try { const payload={ id:q('#recipe-id').value || uid(), expected_version:Number(q('#recipe-id').dataset.version || 0), name:q('#recipe-name').value.trim(), enabled:q('#recipe-enabled').checked, notes:q('#recipe-notes').value, steps:steps() }; const result=await window.yetiApi('recipes',payload); put('#recipe-result','已保存 v'+result.recipe.version); setRecipe(result.recipe); await loadRecipes(); } catch (error) { put('#recipe-result','保存失败：'+errText(error)); } }
async function removeRecipe() { const r=C.selected; if (!r || !r.version || !window.confirm('确认删除配方“'+r.name+'”？')) return; try { await window.yetiApi('recipes/'+r.id+'/delete',{ expected_version:r.version }); C.selected=null; put('#recipe-result','已删除'); await loadRecipes(); setRecipe(null); } catch (error) { put('#recipe-result','删除失败：'+errText(error)); } }
function showJob(j) { C.job=j || null; if (!j) { put('#batch-tag','未运行'); put('#batch-status','暂无批次'); return; } put('#batch-tag',j.state+' · '+j.progress+'%'); const box=q('#batch-status'); box.replaceChildren(); const meta=document.createElement('div'); meta.className='batch-meta'; meta.textContent='模式 '+j.mode+' · 步骤 '+Math.min(j.step_index+1,j.results.length)+'/'+j.results.length; box.append(meta); const bar=document.createElement('div'); bar.className='progress'; const fill=document.createElement('i'); fill.style.width=j.progress+'%'; bar.append(fill); box.append(bar); j.results.forEach(r=>{ const row=document.createElement('div'); row.className='batch-row'; row.textContent='CH '+String(r.channel).padStart(2,'0')+' · 目标 '+(r.target_mg/1000).toFixed(2)+' g · 实际 '+(r.actual_mg/1000).toFixed(2)+' g · 误差 '+(r.error_mg===null?'—':(r.error_mg/1000).toFixed(2)+' g'); box.append(row); }); const note=document.createElement('p'); note.className='muted'; note.textContent=j.reason || '模拟流程只修改软件状态，不驱动真实泵。'; box.append(note); }
async function loadJobs() { const result=await window.yetiApi('jobs'); const active=result.jobs.find(j=>j.state==='running'||j.state==='settling'); showJob(active || result.jobs[0] || null); if (active && !C.timer) C.timer=setInterval(async()=>{ try { const r=await window.yetiApi('jobs/'+active.id); showJob(r.job); if (r.job.state!=='running' && r.job.state!=='settling') { clearInterval(C.timer); C.timer=null; } } catch { clearInterval(C.timer); C.timer=null; } },500); }
async function startJob() { const d=q('#batch-device').value; const id=q('#batch-recipe').value; const r=C.recipes.find(x=>x.id===id); if (!d || !r) return; try { const result=await window.yetiApi('jobs',{ device_id:d, recipe_id:r.id, recipe_version:r.version, request_id:uid() }); showJob(result.job); loadJobs().catch(()=>{}); } catch (error) { put('#batch-status','启动失败：'+errText(error)); } }
async function stopJob() { if (!C.job) return; try { const result=await window.yetiApi('jobs/'+C.job.id+'/stop',{}); showJob(result.job); } catch (error) { put('#batch-status','停止失败：'+errText(error)); } }
async function loadAudit() { const result=await window.yetiApi('audit?limit=50'); const host=q('#audit-list'); host.replaceChildren(); if (!result.audit.length) host.textContent='暂无审计记录'; result.audit.forEach(a=>{ const row=document.createElement('div'); row.className='event'; row.textContent=a.action+' · '+a.actor+' · '+a.target; host.append(row); }); }
async function loadCalibration() {
  const device = window.yetiState?.selected;
  if (!device) return;
  try {
    const result = await window.yetiApi('devices/'+device+'/calibration');
    const channel = Number(q('#cal-channel').value);
    const latest = (result.calibration || []).find(item => item.channel === channel);
    q('#cal-channel').dataset.version = String(latest?.version || 0);
    if (latest) put('#cal-result','当前版本 v'+latest.version+' · '+latest.mg_per_count.toFixed(6)+' mg/count');
  } catch (error) { put('#cal-result','读取标定记录失败：'+errText(error)); }
}
async function saveCalibration(e) { e.preventDefault(); try { const result=await window.yetiApi('devices/'+window.yetiState.selected+'/calibration',{ channel:Number(q('#cal-channel').value), zero_raw:Number(q('#cal-zero').value), loaded_raw:Number(q('#cal-loaded').value), known_mass_mg:Number(q('#cal-mass').value), source:q('#cal-source').value, notes:q('#cal-notes').value, expected_version:Number(q('#cal-channel').dataset.version || 0) }); q('#cal-channel').dataset.version = String(result.calibration.version); put('#cal-result','已保存通道 '+result.calibration.channel+' · 版本 v'+result.calibration.version+' · 系数 '+result.calibration.mg_per_count.toFixed(6)+' mg/count'); loadAudit().catch(()=>{}); } catch (error) { put('#cal-result','保存失败：'+errText(error)); loadCalibration().catch(()=>{}); } }
async function loadDiagnostics() { try { const result=await window.yetiApi('diagnostics'); q('#diagnostics').textContent=JSON.stringify(result,null,2); } catch (error) { put('#diagnostics','诊断失败：'+errText(error)); } }
async function exportRecords() { try { const response=await fetch(new URL('api/v1/export',location.href),{ credentials:'same-origin' }); if(!response.ok) throw new Error((await response.json()).error || '导出失败'); const link=document.createElement('a'); link.href=URL.createObjectURL(await response.blob()); link.download='yetitiaopei-records.json'; link.click(); } catch (error) { window.alert(errText(error)); } }
function bootConsole() {
  q('#recipe-form')?.addEventListener('submit',saveRecipe); q('#recipe-new')?.addEventListener('click',()=>setRecipe(null)); q('#recipe-refresh')?.addEventListener('click',()=>loadRecipes().catch(()=>{})); q('#recipe-delete')?.addEventListener('click',removeRecipe); q('#batch-start')?.addEventListener('click',startJob); q('#batch-stop')?.addEventListener('click',stopJob); q('#calibration-form')?.addEventListener('submit',saveCalibration); q('#export-records')?.addEventListener('click',exportRecords); q('#diagnostics-refresh')?.addEventListener('click',loadDiagnostics);
  document.querySelectorAll('.nav').forEach(n=>n.addEventListener('click',()=>{ if(n.dataset.tab==='recipes'){loadRecipes().catch(()=>{});loadJobs().catch(()=>{});} if(n.dataset.tab==='records'){loadAudit().catch(()=>{});loadCalibration().catch(()=>{});} if(n.dataset.tab==='settings')loadDiagnostics().catch(()=>{}); }));
  q('#cal-channel')?.addEventListener('change',()=>loadCalibration().catch(()=>{}));
  setInterval(()=>{ if(!q('#app') || q('#app').classList.contains('hidden') || !window.yetiState?.device || C.booted) return; C.booted=true; const select=q('#batch-device'); select.replaceChildren(...window.yetiState.devices.map(d=>new Option(d.name+' · '+(d.simulation?'模拟':'实机'),d.id))); select.value=window.yetiState.selected || window.yetiState.devices.find(d=>d.online)?.id || ''; loadRecipes().catch(()=>{}); loadJobs().catch(()=>{}); loadAudit().catch(()=>{}); loadCalibration().catch(()=>{}); loadDiagnostics().catch(()=>{}); },500);
}
bootConsole();
