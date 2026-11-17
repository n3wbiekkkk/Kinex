import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const script = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(script), '../..');
const { KinexShieldsEngine } = require(path.join(root, 'dist-electron/main/shields/engine.js'));
const { KinexShieldsCoordinator } = require(path.join(root, 'dist-electron/main/shields/coordinator.js'));
const { createDefaultShieldsSettings } = require(path.join(root, 'dist-electron/shared/domain.js'));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function withEngine(run, changeSettings = (settings) => settings) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kinex-shields-worker-integration-'));
  const engine = new KinexShieldsEngine(dir, changeSettings(createDefaultShieldsSettings()));
  try { return await run(engine, dir); }
  finally { engine.dispose(); fs.rmSync(dir, { recursive: true, force: true }); }
}

async function measure(mode) {
  return withEngine(async (engine) => {
    let ticksBeforeReady = 0;
    let ready = false;
    let last = performance.now();
    let maxGapMs = 0;
    const timer = setInterval(() => {
      const now = performance.now();
      maxGapMs = Math.max(maxGapMs, now - last);
      last = now;
      if (!ready) ticksBeforeReady += 1;
    }, 1);
    try {
      const start = performance.now();
      if (mode === 'sync') engine.initializeSync();
      else {
        const pending = engine.initialize();
        assert.equal(engine.initialize(), pending, 'concurrent startup coalesces');
        await pending;
      }
      const elapsedMs = performance.now() - start;
      ready = true;
      await delay(10);
      assert.equal(engine.isReady(), true, engine.getError());
      if (mode === 'worker') assert.ok(ticksBeforeReady > 1, 'Main timers must run while filters compile');
      assert.ok(engine.getTotalRuleCount() > 100000, 'real bundled filters loaded');
      const matched = engine.evaluateNetworkRequest({
        url: 'https://www.google-analytics.com/analytics.js', sourceUrl: 'https://example.org', resourceType: 'script',
      }).blocked;
      assert.equal(matched, true, 'initialization preserves native matching');
      return { mode, elapsedMs, maxGapMs, ticksBeforeReady, matched, rules: engine.getTotalRuleCount(),
        electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node };
    } finally { clearInterval(timer); }
  });
}

async function verifyStartupRequest(engine, expectedBlocked) {
  let listener;
  const coordinator = new KinexShieldsCoordinator(engine, {
    resolveTabIdByWebContentsId: () => 'tab', isPrivateWebContents: () => false, onStatsChanged: () => {},
  });
  coordinator.attachSession({ webRequest: { onBeforeRequest: (_filter, callback) => { listener = callback; } } });
  coordinator.updateTopPageUrl(123, 'https://example.org');
  let response;
  let calls = 0;
  const completed = new Promise((resolve) => listener({
    id: 1, webContentsId: 123, url: 'https://www.google-analytics.com/analytics.js',
    referrer: 'https://example.org', resourceType: 'script', method: 'GET',
  }, (result) => { calls += 1; response = result; resolve(); }));
  assert.equal(response, undefined, 'first request waits for startup initialization');
  await completed;
  await delay(10);
  assert.equal(calls, 1, 'startup request callback completes exactly once');
  assert.equal(Boolean(response.cancel === true || response.redirectURL), expectedBlocked);
}

async function verifyLifecycle() {
  await withEngine(async (engine) => { await verifyStartupRequest(engine, true); });
  await withEngine(async (engine) => {
    const pending = engine.initialize();
    engine.updateSettings({ ...engine.getSettings(), filterLists: engine.getSettings().filterLists.map((list) => ({ ...list, enabled: false })) });
    const result = await pending;
    assert.equal(result.updatedLists.every((list) => !list.enabled), true, 'stale worker does not restore changed settings');
    assert.equal(engine.getTotalRuleCount(), 0);
    assert.equal(engine.isReady(), true);
  });
  await withEngine(async (engine) => {
    const pending = engine.initialize();
    engine.dispose();
    await pending;
    assert.equal(engine.isReady(), false, 'disposed worker cannot revive the engine');
  });
  await withEngine(async (engine) => {
    const pending = engine.initialize();
    const update = engine.updateAllEnabledLists(async () => new Response('||updated.fixture.test^\n'));
    await pending;
    const result = await update;
    assert.ok(result.updatedCount > 0);
    assert.equal(engine.evaluateNetworkRequest({
      url: 'https://updated.fixture.test/pixel', sourceUrl: 'https://example.org', resourceType: 'image',
    }).blocked, true, 'an update queued during startup installs after the worker handoff');
  });
  await withEngine(async (engine) => {
    await verifyStartupRequest(engine, false);
    assert.equal(engine.isReady(), false);
    assert.match(engine.getError(), /Unable to load filter lists/);
  }, (settings) => ({ ...settings, filterLists: [{ ...settings.filterLists[0], bundledFile: 'missing-integration-filter.gz' }] }));
}

async function main() {
  const childMode = process.argv.find((arg) => arg.startsWith('--measure='))?.split('=')[1];
  if (childMode) {
    assert.ok(['sync', 'worker'].includes(childMode));
    console.log(JSON.stringify(await measure(childMode)));
    return;
  }
  await verifyLifecycle();
  const runs = [];
  for (let run = 1; run <= 5; run += 1) {
    for (const mode of ['sync', 'worker']) {
      const result = spawnSync(require('electron'), [script, `--measure=${mode}`], {
        cwd: root, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 30000,
      });
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      runs.push({ run, status: result.status, measurement: JSON.parse(result.stdout.trim()), stderr: result.stderr.trim() });
    }
  }
  const report = { ok: true, lifecycleChecks: 5, failures: 0, method: 'Five alternating fresh Electron processes per method; timer gaps during actual initialization and a 10ms drain; RUN_AS_NODE excludes renderer/UI startup.',
    platform: process.platform, arch: process.arch, os: os.release(), cpu: os.cpus()[0]?.model, cores: os.cpus().length,
    memoryBytes: os.totalmem(), runs };
  const output = path.join(root, 'artifacts/v7.0.3/shields-init-after.json');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
