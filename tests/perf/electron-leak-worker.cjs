const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { app, ipcMain, protocol, webContents } = require('electron');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kinex-leak-'));
app.setPath('userData', tmpDir);

protocol.registerSchemesAsPrivileged([
  { scheme: 'kinex', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
  { scheme: 'nook', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

const { KinexWindowManager, ensureAppName, registerKinexProtocol } = require('../../dist-electron/main/windowManager');
const { registerKinexIpcHandlers } = require('../../dist-electron/main/ipcHandlers');

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`<!doctype html><html><head><title>Stress ${req.url}</title></head><body><h1>Stress ${req.url}</h1><script>window.__arr = new Array(2000).fill('x');</script></body></html>`);
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}` });
    });
  });
}

function waitMs(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function sampleTreeRssMB(rootPid) {
  const out = execFileSync('ps', ['-ax', '-o', 'pid=,ppid=,rss=,args='], { encoding: 'utf8' });
  const rows = [];
  for (const line of out.split('\n')) {
    const m = /^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line.trim());
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), rssKB: Number(m[3]), args: m[4] });
  }
  const byPpid = new Map();
  for (const r of rows) {
    if (!byPpid.has(r.ppid)) byPpid.set(r.ppid, []);
    byPpid.get(r.ppid).push(r);
  }
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const seen = new Set();
  const q = byPid.has(rootPid) ? [byPid.get(rootPid)] : [];
  let sumKB = 0;
  let renderers = 0;
  while (q.length) {
    const cur = q.shift();
    if (!cur || seen.has(cur.pid)) continue;
    seen.add(cur.pid);
    sumKB += cur.rssKB;
    if (cur.args.includes('--type=renderer')) renderers += 1;
    for (const c of byPpid.get(cur.pid) || []) q.push(c);
  }
  return { totalRssMB: Number((sumKB / 1024).toFixed(1)), rendererCount: renderers };
}

function forceGcAndReadHeap() {
  if (typeof global.gc === 'function') {
    global.gc();
    global.gc();
  }
  const m = process.memoryUsage();
  return {
    heapUsedMB: Number((m.heapUsed / 1024 / 1024).toFixed(2)),
    rssMB: Number((m.rss / 1024 / 1024).toFixed(1)),
  };
}

async function run() {
  process.env.KINEX_DISABLE_AUTO_UPDATER = '1';
  app.on('window-all-closed', (e) => e.preventDefault());
  ensureAppName();

  const { server, baseUrl } = await startServer();
  await app.whenReady();
  registerKinexProtocol(protocol);

  const mgr = new KinexWindowManager(tmpDir);
  registerKinexIpcHandlers(ipcMain, () => mgr);
  const win = mgr.createWindow();
  await mgr.handleIntent({ type: 'set-https-only', enabled: false });
  await waitMs(400);

  const baselineMem = { ...forceGcAndReadHeap(), tree: sampleTreeRssMB(process.pid) };
  const stages = [];

  try {
    // 1. Open and close 100 tabs (in 5 batches of 20)
    let peakTreeRss = baselineMem.tree.totalRssMB;
    for (let batch = 0; batch < 5; batch++) {
      for (let i = 0; i < 20; i++) {
        await mgr.handleIntent({
          type: 'open-url',
          url: `${baseUrl}/tab-${batch}-${i}`,
          target: 'new-tab',
          spaceId: 'space-personal',
        });
      }
      await waitMs(200);
      const t = sampleTreeRssMB(process.pid);
      if (t.totalRssMB > peakTreeRss) peakTreeRss = t.totalRssMB;
      await mgr.handleIntent({ type: 'clear-today-tabs', spaceId: 'space-personal' });
      await waitMs(150);
    }
    await waitMs(300);
    const after100Tabs = { ...forceGcAndReadHeap(), tree: sampleTreeRssMB(process.pid), peakTreeRss };
    assert.ok(mgr.getMetricsSnapshot().activeViewCount <= 3, 'Closed tabs must not retain WebContentsViews');
    stages.push({ scenario: '100-tabs-open-close', ...after100Tabs });

    // 2. Switch Spaces 500 times
    for (let i = 0; i < 500; i++) {
      await mgr.handleIntent({
        type: 'select-space',
        spaceId: i % 2 === 0 ? 'space-work' : 'space-personal',
      });
    }
    await waitMs(200);
    const after500Spaces = { ...forceGcAndReadHeap(), tree: sampleTreeRssMB(process.pid) };
    stages.push({ scenario: '500-space-switches', ...after500Spaces });

    // 3. Toggle Split View 50 times
    await mgr.handleIntent({ type: 'select-space', spaceId: 'space-personal' });
    for (let i = 0; i < 50; i++) {
      await mgr.handleIntent({ type: 'toggle-split' });
    }
    await waitMs(150);
    const after50Splits = { ...forceGcAndReadHeap(), tree: sampleTreeRssMB(process.pid) };
    stages.push({ scenario: '50-split-toggles', ...after50Splits });

    // 4. Open and close Private Windows 10 cycles
    for (let i = 0; i < 10; i++) {
      await mgr.handleIntent({ type: 'open-incognito', url: `${baseUrl}/priv-${i}` });
      await waitMs(120);
      mgr.auxiliaryWindows?.disposeAll?.();
      // Close private windows cleanly via disposeAll or iterating BrowserWindows except main
      for (const bw of require('electron').BrowserWindow.getAllWindows()) {
        if (bw !== win && !bw.isDestroyed()) bw.close();
      }
      await waitMs(100);
    }
    assert.equal(mgr.getMetricsSnapshot().privateWindowCount, 0, 'Private windows must all dispose cleanly');
    const after10Private = { ...forceGcAndReadHeap(), tree: sampleTreeRssMB(process.pid) };
    stages.push({ scenario: '10-private-windows', ...after10Private });

    // 5. Repeatedly navigate 50 times in active tab
    for (let i = 0; i < 50; i++) {
      await mgr.handleIntent({
        type: 'open-url',
        url: `${baseUrl}/nav-${i}`,
        target: 'current',
        spaceId: 'space-personal',
      });
      if (i % 10 === 0) await waitMs(60);
    }
    await waitMs(250);
    const after50Navs = { ...forceGcAndReadHeap(), tree: sampleTreeRssMB(process.pid) };
    stages.push({ scenario: '50-repeated-navs', ...after50Navs });

    // 6. Open and close Little Kinex 10 cycles
    for (let i = 0; i < 10; i++) {
      await mgr.handleIntent({ type: 'open-url', url: `${baseUrl}/little-${i}`, target: 'little-kinex' });
      await waitMs(100);
      for (const bw of require('electron').BrowserWindow.getAllWindows()) {
        if (bw !== win && !bw.isDestroyed()) bw.close();
      }
      await waitMs(80);
    }
    assert.equal(mgr.getMetricsSnapshot().hasLittleWindow, false, 'Little Kinex must close cleanly');
    const after10Little = { ...forceGcAndReadHeap(), tree: sampleTreeRssMB(process.pid) };
    stages.push({ scenario: '10-little-kinex', ...after10Little });

    // Final cleanup check
    await mgr.handleIntent({ type: 'clear-today-tabs', spaceId: 'space-personal' });
    win.close();
    await waitMs(350);
    const liveWebContentsCount = webContents.getAllWebContents().length;
    const finalPostClose = {
      ...forceGcAndReadHeap(),
      tree: sampleTreeRssMB(process.pid),
      liveWebContentsCount,
    };
    assert.equal(mgr.getMetricsSnapshot().activeViewCount, 0);
    assert.equal(liveWebContentsCount, 0, 'All WebContents objects must be destroyed after window close');

    const report = {
      ok: true,
      baseline: baselineMem,
      stages,
      finalPostClose,
      mainHeapGrowthMB: Number((finalPostClose.heapUsedMB - baselineMem.heapUsedMB).toFixed(2)),
    };
    if (process.env.KINEX_LEAK_REPORT_PATH) {
      fs.writeFileSync(process.env.KINEX_LEAK_REPORT_PATH, JSON.stringify(report, null, 2), 'utf8');
    }
    console.log('LEAK_STRESS_PASS', JSON.stringify(report));
  } finally {
    server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  app.exit(0);
}

run().catch((err) => {
  if (process.env.KINEX_LEAK_REPORT_PATH) {
    fs.writeFileSync(
      process.env.KINEX_LEAK_REPORT_PATH,
      JSON.stringify({ ok: false, error: err && err.stack ? err.stack : String(err) }, null, 2),
      'utf8'
    );
  }
  console.error(err);
  app.exit(1);
});
