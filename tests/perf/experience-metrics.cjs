const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

if (!process.versions.electron) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kinex-experience-'));
  try {
    const result = spawnSync(require('electron'), [__filename, ...process.argv.slice(2)], {
      env: { ...process.env, KINEX_QUALITY_USER_DATA_DIR: scratch, KINEX_TEST_MODE: '1', KINEX_DISABLE_AUTO_UPDATER: '1' },
      stdio: 'inherit', timeout: 100000,
    });
    if (result.error) console.error(result.error);
    process.exitCode = result.status ?? 1;
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  process.exit(process.exitCode);
}
const { app, ipcMain, protocol } = require('electron');

const startedAt = performance.now();
const outFlag = process.argv.find((argument) => argument.startsWith('--out='));
const outDir = path.resolve(outFlag?.slice(6) || path.join(os.tmpdir(), 'kinex-experience-metrics'));
const userDataDir = process.env.KINEX_QUALITY_USER_DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'kinex-experience-'));
app.setPath('userData', userDataDir);
process.env.KINEX_DISABLE_AUTO_UPDATER = '1';
protocol.registerSchemesAsPrivileged(['kinex', 'nook'].map((scheme) => ({
  scheme, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
})));
const { KinexWindowManager, ensureAppName, registerKinexProtocol } = require('../../dist-electron/main/windowManager');
const { registerKinexIpcHandlers } = require('../../dist-electron/main/ipcHandlers');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, label, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  do {
    try { const value = await check(); if (value) return value; } catch (error) { lastError = error; }
    await delay(15);
  } while (Date.now() < deadline);
  throw new Error(`Timed out: ${label}${lastError ? ` (${lastError.message})` : ''}`);
}
const read = (wc, expression) => wc.executeJavaScript(expression);
function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return { count: values.length, median: sorted.length ? sorted[Math.floor(sorted.length / 2)] : null, min: sorted[0] ?? null, max: sorted.at(-1) ?? null, samples: values };
}
function processTree() {
  const rows = execFileSync('ps', ['-ax', '-o', 'pid=,ppid=,rss='], { encoding: 'utf8' })
    .trim().split('\n').map((line) => line.trim().split(/\s+/).map(Number));
  const ids = new Set([process.pid]);
  for (let size = -1; size !== ids.size;) {
    size = ids.size;
    for (const [pid, parent] of rows) if (ids.has(parent)) ids.add(pid);
  }
  return { count: ids.size, summedRssMB: rows.filter(([pid]) => ids.has(pid)).reduce((sum, [, , rss]) => sum + rss, 0) / 1024 };
}
function startFixture() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><head><title>Experience ${req.url}</title><style>body{font:16px system-ui;background:#eef1f4;color:#18202a}main{max-width:740px;margin:40px auto}p{line-height:1.65}</style></head><body><main><h1>Experience fixture ${req.url}</h1>${'<p>A stable local document for measuring Kinex application interaction without network variance.</p>'.repeat(30)}</main></body></html>`);
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}
async function paint(wc) {
  return read(wc, 'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))');
}
async function startFrameSample(wc) {
  await read(wc, `(() => {
    const sample = { frames: [], longTasks: [], last: null, running: true };
    window.__kinexExperienceSample = sample;
    try { sample.observer = new PerformanceObserver(list => { for (const entry of list.getEntries()) sample.longTasks.push(entry.duration); }); sample.observer.observe({ type: 'longtask', buffered: false }); } catch {}
    function tick(now) { if (!sample.running) return; if (sample.last !== null) sample.frames.push(now - sample.last); sample.last = now; requestAnimationFrame(tick); }
    requestAnimationFrame(tick);
  })()`);
}
async function finishFrameSample(wc) {
  return read(wc, `(() => {
    const sample = window.__kinexExperienceSample;
    sample.running = false;
    sample.observer?.disconnect();
    delete window.__kinexExperienceSample;
    return { frameIntervalsMs: sample.frames, longTasksMs: sample.longTasks, reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches };
  })()`);
}

async function run() {
  let manager;
  let server;
  const result = {
    timestamp: new Date().toISOString(),
    runtime: { electron: process.versions.electron, chromium: process.versions.chrome, node: process.versions.node },
    hardware: { arch: os.arch(), cpu: os.cpus()[0]?.model, cores: os.cpus().length, memoryGB: os.totalmem() / 1024 ** 3, os: `${os.type()} ${os.release()}` },
    methodology: [
      'One disposable Electron process; production dist assets; local stable HTTP documents; no network timing.',
      'Startup starts at test harness entry and ends after real shell and initial page paint; excludes OS process spawn.',
      'Palette latency ends after input focus and two requestAnimationFrame callbacks, not IPC acknowledgement.',
      'Tab latency ends after target native view is visible and its document paints, not state acknowledgement.',
      'Frame intervals cover overlay open/close; polling and automation add overhead; samples are not an FPS guarantee.',
      'RSS is a sum over the process tree and includes shared pages. CPU uses Electron per-process interval metrics.',
      'Compare raw samples and run variation; this run alone cannot establish a performance regression or speedup.',
    ],
    errors: [],
  };
  const mainTimerGaps = [];
  let lastMainTick = performance.now();
  const mainTimer = setInterval(() => { const now = performance.now(); mainTimerGaps.push(now - lastMainTick); lastMainTick = now; }, 10);
  const watchdog = setTimeout(() => { console.error('Experience measurement exceeded 90 seconds'); app.exit(1); }, 90000);
  try {
    ensureAppName();
    ({ server, url: result.fixtureUrl } = await startFixture());
    await app.whenReady();
    registerKinexProtocol(protocol);
    manager = new KinexWindowManager(userDataDir);
    registerKinexIpcHandlers(ipcMain, () => manager);
    const win = manager.createWindow();
    win.setSize(1360, 860);
    win.show();
    win.focus();
    const shell = manager.shellView.webContents;
    await until(() => read(shell, 'Boolean(document.querySelector(".kinex-shell"))'), 'shell hydration');
    const initial = [...manager.tabManager.getAllViews().values()][0].webContents;
    await until(() => read(initial, 'document.readyState === "complete"'), 'initial page readiness');
    await paint(shell);
    await paint(initial);
    result.startupHarnessToPaintMs = performance.now() - startedAt;

    await manager.handleIntent({ type: 'open-url', url: `${result.fixtureUrl}/one`, target: 'new-tab' });
    await until(() => manager.getSnapshot().tabs.find((tab) => tab.url.endsWith('/one') && !tab.isLoading), 'first local page');
    await manager.handleIntent({ type: 'open-url', url: `${result.fixtureUrl}/two`, target: 'new-tab' });
    await until(() => manager.getSnapshot().tabs.find((tab) => tab.url.endsWith('/two') && !tab.isLoading), 'second local page');
    const tabIds = manager.getSnapshot().tabs.filter((tab) => tab.url.startsWith(result.fixtureUrl)).map((tab) => tab.id);
    assert.equal(tabIds.length, 2);
    const paletteLatencies = [];
    const frameSamples = [];
    for (let round = 0; round < 6; round++) {
      const t0 = performance.now();
      await manager.handleIntent({ type: 'set-overlay', overlay: { mode: 'command-bar', initialQuery: '', targetMode: 'new-tab' } });
      const overlay = manager.overlayView.webContents;
      await until(() => read(overlay, 'document.activeElement?.matches(".command-input")'), 'focused palette input');
      await paint(overlay);
      paletteLatencies.push(performance.now() - t0);
      await startFrameSample(overlay);
      await delay(300);
      await manager.handleIntent({ type: 'set-overlay', overlay: { mode: 'none' } });
      await delay(220);
      frameSamples.push(await finishFrameSample(overlay));
    }
    result.paletteFirstOpenMs = paletteLatencies[0];
    result.paletteWarmOpenMs = stats(paletteLatencies.slice(1));
    result.motion = {
      frames: stats(frameSamples.flatMap((sample) => sample.frameIntervalsMs)),
      longTasksMs: frameSamples.flatMap((sample) => sample.longTasksMs),
      over25ms: frameSamples.flatMap((sample) => sample.frameIntervalsMs).filter((ms) => ms > 25).length,
      over50ms: frameSamples.flatMap((sample) => sample.frameIntervalsMs).filter((ms) => ms > 50).length,
      reducedMotion: frameSamples[0]?.reducedMotion,
      note: 'Frame observer attaches after the opening paint and includes the close transition; initial entrance must be inspected separately.',
    };
    const switchLatencies = [];
    for (let round = 0; round < 6; round++) {
      const tabId = tabIds[round % tabIds.length];
      const t0 = performance.now();
      await manager.handleIntent({ type: 'select-tab', tabId });
      const view = manager.tabManager.getView(tabId);
      assert.ok(view && view.getVisible(), 'Target native view must be visible');
      await paint(view.webContents);
      switchLatencies.push(performance.now() - t0);
    }
    result.tabSwitchMs = stats(switchLatencies);
    await manager.handleIntent({ type: 'select-space', spaceId: 'space-work' });
    await manager.handleIntent({ type: 'open-url', url: `${result.fixtureUrl}/work`, target: 'new-tab' });
    await until(() => manager.getSnapshot().tabs.find((tab) => tab.url.endsWith('/work') && !tab.isLoading), 'work fixture');
    const spaceLatencies = [];
    for (let round = 0; round < 6; round++) {
      const spaceId = round % 2 ? 'space-work' : 'space-personal';
      const start = performance.now();
      await manager.handleIntent({ type: 'select-space', spaceId });
      const snapshot = manager.getSnapshot();
      assert.equal(snapshot.activeSpaceId, spaceId);
      const split = snapshot.splitsBySpace[spaceId];
      const view = manager.tabManager.getView(split.tabIds[split.focusedIndex]);
      assert.ok(view && view.getVisible(), 'Target Space native view must be visible');
      await paint(view.webContents);
      spaceLatencies.push(performance.now() - start);
    }
    result.spaceSwitchMs = stats(spaceLatencies);
    result.mainTimerGapMs = stats(mainTimerGaps);
    result.memory = processTree();
    app.getAppMetrics();
    await delay(1000);
    result.idleCpu = app.getAppMetrics().map(({ pid, type, cpu }) => ({ pid, type, percentCPUUsage: cpu.percentCPUUsage }));
    result.nativeViews = manager.getMetricsSnapshot();
    result.ok = true;
  } catch (error) {
    result.errors.push(error.stack ?? error.message);
    result.ok = false;
  } finally {
    clearTimeout(watchdog);
    clearInterval(mainTimer);
    manager?.dispose();
    server?.closeAllConnections();
    await new Promise((resolve) => server ? server.close(resolve) : resolve());
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'experience-metrics.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
    app.exit(result.ok ? 0 : 1);
  }
}
run().catch((error) => { console.error(error); app.exit(1); });
