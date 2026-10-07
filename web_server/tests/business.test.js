const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { once } = require("node:events");
const { setTimeout: sleep } = require("node:timers/promises");
const { createServer } = require("../server");

async function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "yeti-business-"));
  const sim = { id: "sim-001", name: "business simulator", token: "business-sim-token", simulation: true };
  const real = { id: "esp32-001", name: "business real", token: "business-real-token-12345678901234567890", simulation: false };
  const config = { dataDir, host: "127.0.0.1", port: 0, basePath: "", username: "admin", password: "business-admin-password", devices: [real, sim], simulate: true, simDevice: sim, credentialFile: "(business test)" };
  const gateway = createServer(config); gateway.listen(); await once(gateway.server, "listening");
  const origin = "http://127.0.0.1:" + gateway.server.address().port;
  let cookie = "";
  async function raw(pathname, body, session = cookie) {
    const response = await fetch(origin + "/api/v1" + pathname, { method: body === undefined ? "GET" : "POST", headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(session ? { Cookie: session } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) });
    return { status: response.status, headers: response.headers, data: await response.json() };
  }
  const login = await raw("/auth/login", { username: config.username, password: config.password }, "");
  assert.equal(login.status, 200); cookie = login.headers.get("set-cookie").split(";")[0];
  async function asUser(username, password) {
    const result = await raw("/auth/login", { username, password }, "");
    assert.equal(result.status, 200); return result.headers.get("set-cookie").split(";")[0];
  }
  t.after(async () => { gateway.close(); await sleep(80); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return { config, raw, asUser, setCookie: value => { cookie = value; }, gateway };
}

test("business console lifecycle and permission boundaries", { timeout: 30000 }, async t => {
  const c = await fixture(t);
  assert.deepEqual((await c.raw("/auth/me")).data.role, "admin");
  const passwordChange = await c.raw("/auth/password", { current_password: c.config.password, password: "business-admin-password-2" });
  assert.equal(passwordChange.status, 200);
  c.setCookie(await c.asUser("admin", "business-admin-password-2"));
  const recipeBody = { id: "recipe-001", expected_version: 0, name: "Smoke recipe", enabled: true, notes: "business regression", steps: [{ channel: 0, target_mg: 500, tolerance_mg: 20, settle_ms: 50 }] };
  const created = await c.raw("/recipes", recipeBody); assert.equal(created.status, 200); assert.equal(created.data.recipe.version, 1);
  assert.equal((await c.raw("/recipes/recipe-001/versions")).data.versions.length, 1);
  assert.equal((await c.raw("/recipes", { ...recipeBody, name: "stale" })).status, 409);
  const updated = await c.raw("/recipes", { ...recipeBody, expected_version: 1, name: "Smoke recipe v2" }); assert.equal(updated.data.recipe.version, 2);
  const realDevice = c.gateway.store.device("esp32-001");
  const calibration = await c.raw("/devices/esp32-001/calibration", { channel: 0, zero_raw: 100, loaded_raw: 1100, known_mass_mg: 10000, source: "manual", notes: "smoke", expected_version: 0 });
  assert.equal(calibration.status, 200); assert.equal(calibration.data.calibration.mg_per_count, 10);
  assert.equal((await c.raw("/devices/esp32-001/calibration", { channel: 0, zero_raw: 100, loaded_raw: 1200, known_mass_mg: 10000, source: "manual", notes: "stale", expected_version: 0 })).status, 409);
  // Keep the newest record for every channel discoverable even when history exceeds 200 rows.
  for (let i = 0; i < 205; i++) {
    const latest = c.gateway.business.calibrations("esp32-001").find(x => x.channel === 1);
    c.gateway.business.saveCalibration(realDevice, { channel: 1, zero_raw: i + 1, loaded_raw: i + 1001, known_mass_mg: 10000, source: "manual", notes: "bulk", expected_version: latest?.version || 0 }, "admin");
  }
  assert.ok(c.gateway.business.calibrations("esp32-001").some(x => x.channel === 0 && x.version === 1));
  assert.ok(c.gateway.business.calibrations("esp32-001").some(x => x.channel === 1 && x.version === 205));
  const denied=await c.raw('/jobs',{device_id:'esp32-001',recipe_id:'recipe-001',recipe_version:2,request_id:'real-batch'});
  assert.equal(denied.status,409); assert.equal(denied.data.error,'automatic_dosing_not_supported');
  assert.equal((await c.raw('/devices')).data.devices.length,1);
  const deleted = await c.raw("/recipes/recipe-001/delete", { expected_version: 2 });
  assert.equal(deleted.status, 200);
  const reused = await c.raw("/recipes", { ...recipeBody, expected_version: 0 });
  assert.equal(reused.status, 409); assert.equal(reused.data.error, "recipe_id_reused");
  assert.equal((await c.raw("/jobs", { device_id: "esp32-001", recipe_id: "recipe-001", recipe_version: 2, request_id: "batch-real" })).status, 409);
  const user = await c.raw("/users", { username: "viewer1", role: "viewer", enabled: true, password: "viewer-password-123" }); assert.equal(user.status, 200);
  const viewer = await c.asUser("viewer1", "viewer-password-123");
  const viewerRecipes = await c.raw("/recipes", undefined, viewer); assert.equal(viewerRecipes.status, 200);
  assert.equal((await c.raw("/recipes", { ...recipeBody, id: "viewer-write" }, viewer)).status, 403);
  assert.equal((await c.raw("/audit?limit=200")).data.audit.some(x => x.action === "calibration_recorded"), true);
  const exported = await c.raw("/export"); assert.equal(exported.status, 200); assert.equal(exported.data.schema_version, 1); assert.equal(exported.data.batches.length, 0);
  assert.equal((await c.raw("/diagnostics")).status, 200);
});
