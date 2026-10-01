// 无第三方依赖的 Edge/CDP 冒烟验证；使用独立临时配置，不读取个人浏览器资料。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: sleep } = require('node:timers/promises');
const { createServer } = require('../server');

async function until(read, check, ms = 12000) {
  const end = Date.now() + ms;
  do { const value = await read(); if (check(value)) return value; await sleep(100); } while (Date.now() < end);
  throw new Error('Browser condition timed out');
}

/** main：启动隔离网页及浏览器，验证实际交互并保存桌面/手机截图；无硬件或外网访问。 */
async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yeti-browser-'));
  const artifacts = path.resolve(__dirname, '../artifacts/browser'); fs.mkdirSync(artifacts, { recursive: true });
  const sim = { id: 'sim-001', name: '演示设备 · 模拟数据', token: 'browser-sim-token', simulation: true, serial_test: false };
  const gateway = createServer({ dataDir: directory, host: '127.0.0.1', port: 0, basePath: '/console', username: 'admin', password: 'browser-test-password',
    devices: [{ id: 'esp32-001', name: 'ESP32-S3 · 联调设备', token: 'browser-real-token', simulation: false }, sim], simulate: true, simDevice: sim, credentialFile: '(browser test only)' });
  let browser, socket, counter = 0; const pending = new Map(), exceptions = [];
  const command = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++counter, timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, 10000);
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject }); socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const waitFor = async (expression, label = expression) => {
    try { return await until(() => evaluate(expression), Boolean); }
    catch (error) { throw new Error('Browser check failed: ' + label, { cause: error }); }
  };
  const screenshot = async name => {
    const { data } = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    fs.writeFileSync(path.join(artifacts, name + '.png'), Buffer.from(data, 'base64'));
  };
  try {
    gateway.listen(); await once(gateway.server, 'listening');
    const origin = 'http://127.0.0.1:' + gateway.server.address().port + '/console/';
    browser = spawn(process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', [
      '--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
      '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', '--user-data-dir=' + path.join(directory, 'edge'), 'about:blank'
    ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let launchError, browserLog = ''; browser.on('error', e => { launchError = e; });
    browser.stderr.on('data', b => { browserLog = (browserLog + b.toString()).slice(-4000); });
    const portFile = path.join(directory, 'edge', 'DevToolsActivePort');
    await until(() => { if (launchError) throw launchError; return fs.existsSync(portFile); }, Boolean);
    const port = fs.readFileSync(portFile, 'utf8').split(String.fromCharCode(10))[0].trim();
    const tabs = await fetch('http://127.0.0.1:' + port + '/json/list').then(r => r.json());
    socket = new WebSocket(tabs.find(t => t.type === 'page').webSocketDebuggerUrl);
    socket.addEventListener('message', ({ data }) => {
      const message = JSON.parse(data);
      if (message.id) { const p = pending.get(message.id); pending.delete(message.id); if (p) message.error ? p.reject(new Error(JSON.stringify(message.error))) : p.resolve(message.result); }
      if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails);
    });
    await once(socket, 'open'); await command('Page.enable'); await command('Runtime.enable');
    await command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
    await command('Page.navigate', { url: origin });
    await waitFor('Boolean(document.querySelector("#login-form"))'); await screenshot('01-login-desktop');
    await evaluate('document.querySelector("#password").value="browser-test-password";document.querySelector("#login-form").requestSubmit()');
    await waitFor('!document.querySelector("#app").classList.contains("hidden") && state.device?.simulation && state.device?.online');
    assert.equal(await evaluate('document.querySelectorAll("#channel-grid .channel").length'), 8);
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
    await screenshot('02-overview-desktop');
    await evaluate('document.querySelector("[data-tab=debug]").click();document.querySelector("#interval-input").value="500";document.querySelector("#apply-interval").click()');
    await waitFor('!state.busy && document.querySelector("#interval-result").textContent.includes("设备已确认") && state.device.status.upload_interval_ms===500');
    await evaluate('document.querySelector("#interval-input").value="700"'); await sleep(1200);
    assert.equal(await evaluate('document.querySelector("#interval-input").value'), '700');
    await evaluate('document.querySelector("#ping").click()');
    await waitFor('!state.busy && document.querySelector("#interval-result").textContent.includes("往返")');
    await evaluate('document.querySelector("#debug-slider").value="35";document.querySelector("#debug-slider").dispatchEvent(new Event("input"));document.querySelector("#debug-channel").value="3";document.querySelector("#apply-debug").click()');
    await waitFor('!state.busy && state.device.status.actuator.applied_percent===35'); await screenshot('03-debug-desktop');
    await waitFor('state.device.status.actuator.applied_percent===0');
    await evaluate('document.querySelector("[data-tab=overview]").click();document.querySelector("#stop-top").click()');
    await waitFor('!state.busy && document.querySelector("#overview-result").textContent.includes("设备已确认")');
    await evaluate('document.querySelector("#device-select").value="esp32-001";document.querySelector("#device-select").dispatchEvent(new Event("change"))');
    await waitFor('state.device?.id==="esp32-001" && !state.device.online');
    assert.equal(await evaluate('document.querySelector("#apply-debug").disabled && document.querySelector("#apply-interval").disabled && document.querySelector("#stop-top").disabled'), true);
    assert.equal(await evaluate('document.querySelector("#center-mass").textContent'), '—');
    await screenshot('04-real-device-unconnected');
    await evaluate('document.querySelector("#device-select").value="sim-001";document.querySelector("#device-select").dispatchEvent(new Event("change"))');
    await waitFor('state.device?.simulation && state.device?.online');

    // 所有业务写入均通过真实表单或按钮触发；数据库只读核对最终状态，不替代页面操作。
    await evaluate('document.querySelector("[data-tab=recipes]").click()');
    await waitFor('Boolean(document.querySelector("#batch-device option[value=sim-001]"))', 'batch device options loaded');
    await evaluate('document.querySelector("#recipe-new").click()');
    await waitFor('document.querySelectorAll("#recipe-steps .step-row").length===1', 'new recipe editor ready');
    await evaluate('document.querySelector("#recipe-name").value="Browser recipe";document.querySelector("#recipe-notes").value="DOM regression";document.querySelector(".step-target").value="1000";document.querySelector(".step-tolerance").value="20";document.querySelector(".step-settle").value="2000";document.querySelector("#recipe-form").requestSubmit()');
    await waitFor('document.querySelector("#recipe-result").textContent.includes("已保存 v1") && document.querySelector("#recipe-id").dataset.version==="1"', 'recipe created as v1');
    const recipeId = await evaluate('document.querySelector("#recipe-id").value');
    await waitFor('document.querySelector("#recipe-list").textContent.includes("Browser recipe") && document.querySelector("#batch-recipe").options.length===1', 'saved recipe and batch options loaded');
    await evaluate('document.querySelector("#recipe-name").value="Browser recipe v2";document.querySelector(".step-target").value="2000";document.querySelector("#recipe-form").requestSubmit()');
    await waitFor('document.querySelector("#recipe-result").textContent.includes("已保存 v2") && document.querySelector("#recipe-id").dataset.version==="2"', 'recipe edited as v2');
    await waitFor('document.querySelector("#batch-recipe").selectedOptions[0]?.textContent.includes("Browser recipe v2")', 'updated recipe option ready');
    assert.equal(gateway.business.recipe(recipeId).version, 2);
    assert.equal(gateway.business.recipeVersions(recipeId).length, 2);
    assert.equal(gateway.business.recipe(recipeId).steps[0].target_mg, 2000);
    await screenshot('07-recipes-desktop');
    await evaluate('document.querySelector("#batch-device").value="sim-001"');
    await waitFor('state.device?.id==="sim-001" && state.device?.online && state.device.status.channels.every(c=>c.valid && c.stable) && !state.busy', 'simulated device idle and stable before batch');
    await evaluate('document.querySelector("#batch-start").click()');
    await waitFor('/running|settling/.test(document.querySelector("#batch-tag").textContent)', 'batch started through button');
    await waitFor('document.querySelector("#batch-tag").textContent.includes("completed") && document.querySelector("#batch-tag").textContent.includes("100%")', 'batch completed in page');
    assert.match(await evaluate('document.querySelector("#batch-status").textContent'), /实际 2\.00 g.*误差 0\.00 g/);
    const completedJob = gateway.business.jobs()[0];
    assert.equal(completedJob.state, 'completed'); assert.equal(completedJob.mode, 'simulation');
    assert.equal(completedJob.recipe.version, 2); assert.equal(completedJob.results[0].actual_mg, 2000);
    await screenshot('08-batch-completed-desktop');
    await waitFor('state.device.status.task_state==="idle" && state.device.status.channels.every(c=>c.stable)', 'simulator reported completion before next batch');
    await evaluate('document.querySelector("#batch-start").click()');
    await waitFor('/running|settling/.test(document.querySelector("#batch-tag").textContent)', 'second batch started');
    await evaluate('document.querySelector("#batch-stop").click()');
    await waitFor('document.querySelector("#batch-tag").textContent.includes("cancelled")', 'batch stopped through button');
    const stoppedJob = gateway.business.jobs()[0];
    assert.notEqual(stoppedJob.id, completedJob.id); assert.equal(stoppedJob.state, 'cancelled');
    assert.equal(stoppedJob.reason, 'user_cancelled');

    await evaluate('document.querySelector("[data-tab=records]").click()');
    await waitFor('document.querySelector("#cal-channel").dataset.version==="0"', 'calibration initial version loaded');
    await evaluate('document.querySelector("#cal-zero").value="100";document.querySelector("#cal-loaded").value="1100";document.querySelector("#cal-mass").value="10000";document.querySelector("#cal-source").value="simulation";document.querySelector("#calibration-form").requestSubmit()');
    await waitFor('document.querySelector("#cal-result").textContent.includes("版本 v1") && document.querySelector("#cal-channel").dataset.version==="1"', 'first calibration saved as v1');
    await evaluate('document.querySelector("#cal-loaded").value="2100";document.querySelector("#calibration-form").requestSubmit()');
    await waitFor('document.querySelector("#cal-result").textContent.includes("版本 v2") && document.querySelector("#cal-channel").dataset.version==="2"', 'same-channel calibration saved again as v2');
    const calibrations = gateway.business.calibrations('sim-001');
    assert.equal(calibrations.length, 2); assert.equal(calibrations[0].version, 2);
    assert.equal(calibrations[0].channel, 0); assert.equal(calibrations[0].mg_per_count, 5); assert.equal(calibrations[0].applied, false);
    await waitFor('document.querySelector("#audit-list").textContent.includes("calibration_recorded")', 'calibration audit visible');
    await screenshot('09-calibration-audit-desktop');
    await evaluate('document.querySelector("[data-tab=overview]").click()');
    await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await sleep(500); assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
    await screenshot('05-overview-mobile');
    await evaluate('document.querySelector("[data-tab=debug]").click()');
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true); await screenshot('06-debug-mobile');
    await evaluate('document.querySelector("[data-tab=records]").click()');
    await waitFor('document.querySelector("#events").textContent.includes("set_upload_interval")');
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, 'records/calibration/audit page overflows mobile viewport');
    await screenshot('10-records-mobile');
    await evaluate('document.querySelector("[data-tab=recipes]").click()');
    await waitFor('document.querySelector("#recipe-list").textContent.includes("Browser recipe v2")', 'mobile recipe list loaded');
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, 'recipes/batches page overflows mobile viewport');
    await screenshot('11-recipes-mobile');
    await evaluate('document.querySelector("[data-tab=settings]").click()');
    await waitFor('document.querySelector("#diagnostics").textContent.includes("hardware_control")', 'diagnostics loaded');
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, 'settings/diagnostics page overflows mobile viewport');
    await screenshot('12-settings-mobile');
    await evaluate('document.querySelector("#logout").click()');
    await waitFor('!document.querySelector("#login").classList.contains("hidden")');
    assert.deepEqual(exceptions, []);
    fs.writeFileSync(path.join(artifacts, 'result.json'), JSON.stringify({ passed: true, at: new Date().toISOString(), basePath: '/console', desktop: [1440, 1100], mobile: [390, 844], runtimeExceptions: exceptions, node: process.version }, null, 2));
    console.log('PASS browser: login, SSE, interval, draft, ping, simulated output timeout, stop feedback, real hardware lockout, recipe v1/v2, batch complete/cancel, calibration v1/v2, audit, diagnostics, all mobile pages, logout');
    console.log('Screenshots: ' + artifacts);
  } catch (error) {
    let pageState;
    if (socket?.readyState === WebSocket.OPEN) {
      pageState = await evaluate('({activeTab:document.querySelector(".tab.active")?.id,recipe:document.querySelector("#recipe-result")?.textContent,batch:document.querySelector("#batch-status")?.textContent,batchTag:document.querySelector("#batch-tag")?.textContent,calibration:document.querySelector("#cal-result")?.textContent,width:innerWidth,scrollWidth:document.documentElement.scrollWidth})').catch(() => null);
      await screenshot('failure').catch(() => {});
    }
    fs.writeFileSync(path.join(artifacts, 'result.json'), JSON.stringify({ passed: false, at: new Date().toISOString(), error: error.message, pageState, runtimeExceptions: exceptions, node: process.version }, null, 2));
    throw error;
  } finally {
    socket?.close(); if (browser && browser.exitCode === null) { browser.kill(); await Promise.race([once(browser, 'exit'), sleep(3000)]); }
    gateway.close();
    // Windows 下浏览器子进程可能稍后才释放文件；仅删除本测试创建的临时目录。
    try { fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { console.error('Temporary browser profile remains: ' + directory); }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
