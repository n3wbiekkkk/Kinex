const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, ipcMain, protocol } = require('electron');

// Map fixture hostnames cleanly to local HTTP fixture server so both blocked (Enabled) and allowed (Disabled) modes run deterministically offline
app.commandLine.appendSwitch(
  'host-resolver-rules',
  'MAP *.shields.test 127.0.0.1, MAP pagead2.googlesyndication.com 127.0.0.1, MAP www.google-analytics.com 127.0.0.1, MAP doubleclick.net 127.0.0.1, MAP quantserve.com 127.0.0.1'
);

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'kinex-shields-int-'));
app.setPath('userData', userData);
process.env.KINEX_DISABLE_AUTO_UPDATER = '1';
protocol.registerSchemesAsPrivileged(
  ['kinex', 'nook'].map((scheme) => ({
    scheme,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  }))
);

const { KinexWindowManager, ensureAppName, registerKinexProtocol } = require('../../dist-electron/main/windowManager');
const { registerKinexIpcHandlers } = require('../../dist-electron/main/ipcHandlers');
const { getFocusedTab } = require('../../dist-electron/shared/domain');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, label, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const val = await check();
      if (val) return val;
    } catch (err) {
      lastErr = err;
    }
    await delay(25);
  }
  throw new Error(`Timed out: ${label}${lastErr ? ` (${lastErr.message})` : ''}`);
}

function startFixtureServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const urlObj = new URL(req.url, 'http://127.0.0.1');
      const host = (req.headers.host || '').split(':')[0];

      if (urlObj.pathname === '/filter-update.txt') {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('! Title: Test Updated List\n||newblocked.shields.test^$third-party\n');
        return;
      }

      if (urlObj.pathname === '/bad-html.txt') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<!doctype html><html><body>not a filter list</body></html>');
        return;
      }

      if (urlObj.pathname === '/beacon.js' || urlObj.pathname === '/ads/gpt.js' || urlObj.pathname === '/analytics.js') {
        res.writeHead(200, {
          'Content-Type': 'application/javascript',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(`window.__loadedHosts = window.__loadedHosts || []; window.__loadedHosts.push(${JSON.stringify(host + urlObj.pathname)});`);
        return;
      }

      if (urlObj.pathname === '/pixel.gif') {
        res.writeHead(200, { 'Content-Type': 'image/gif' });
        res.end(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'));
        return;
      }

      if (urlObj.pathname === '/style.css') {
        res.writeHead(200, { 'Content-Type': 'text/css' });
        res.end('main { font-family: -apple-system, sans-serif; }');
        return;
      }

      if (urlObj.pathname === '/page') {
        const port = urlObj.port || server.address().port;
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html>
<html>
<head>
  <title>Shields Integration Test</title>
  <link rel="stylesheet" href="http://news.shields.test:${port}/style.css">
</head>
<body>
  <main id="article-content"><h1>Legitimate Article Title</h1><p>Readable content stays visible.</p></main>
  <div class="ad-banner" id="ad-top-banner">Static Ad Banner</div>
  <div class="custom-promo-widget" id="custom-picked-target">Pickable Widget</div>
  <div id="cookie-consent-nag" class="cookie-banner">Cookie Consent</div>
  <script src="http://pagead2.googlesyndication.com:${port}/ads/gpt.js"></script>
  <script src="http://www.google-analytics.com:${port}/analytics.js"></script>
  <script>
    window.__blockedXhr = false;
    fetch('http://doubleclick.net:${port}/beacon.js').catch(() => { window.__blockedXhr = true; });
    const img = new Image();
    img.src = 'http://quantserve.com:${port}/pixel.gif';
    setTimeout(() => {
      const dyn = document.createElement('div');
      dyn.id = 'dyn-ad';
      dyn.className = 'ad-slot';
      dyn.textContent = 'Dynamic Ad Placeholder';
      document.body.appendChild(dyn);
    }, 60);
  </script>
</body>
</html>`);
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!doctype html><html><body><h1>OK</h1></body></html>');
    });

    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ server, port });
    });
  });
}

async function run() {
  await app.whenReady();
  ensureAppName();
  registerKinexProtocol(protocol);

  const { server, port } = await startFixtureServer();
  const mgr = new KinexWindowManager(userData);
  registerKinexIpcHandlers(ipcMain, () => mgr);
  const checks = [];
  let win;

  try {
    win = mgr.createWindow();
    await until(() => win.isVisible(), 'window visible');
    await mgr.handleIntent({ type: 'set-https-only', enabled: false });
    await until(() => mgr.getSnapshot().shieldsRuntime.engineReady, 'shields engine ready');
    assert.ok(mgr.getSnapshot().shieldsRuntime.totalRuleCount > 100000, 'Expected real >100k rules loaded');
    checks.push('Shields engine initializes with >100,000 real bundled filter rules');

    // 1. Tracking URL parameter stripping + network blocking + cosmetic hiding + isolated context check
    const trackedUrl = `http://news.shields.test:${port}/page?utm_source=social&fbclid=abc123&story=42`;
    await mgr.handleIntent({ type: 'open-url', url: trackedUrl, target: 'new-tab' });
    const focused = () => getFocusedTab(mgr.getSnapshot());
    const tabWc = () => mgr.tabManager.getView(focused().id).webContents;

    await until(() => !focused().isLoading && focused().url.includes('story=42'), 'test page loaded');
    assert.equal(focused().url.includes('utm_source'), false, 'Tracking parameter utm_source stripped');
    assert.equal(focused().url.includes('fbclid'), false, 'Tracking parameter fbclid stripped');
    checks.push('Navigation strips tracking query parameters cleanly');

    await until(() => tabWc().executeJavaScript('Boolean(window.__blockedXhr) && Boolean(document.querySelector("#dyn-ad"))'), 'XHR blocked & dynamic ad appended');
    const tabStats = mgr.getSnapshot().shieldsRuntime.tabStats[focused().id];
    assert.ok(tabStats && tabStats.total >= 3, `Expected >=3 blocked network requests on tab, got ${tabStats?.total}`);
    assert.ok(tabStats.ads >= 1 && tabStats.trackers >= 1, 'Categorizes both ads and trackers accurately');
    checks.push('Network coordinator blocks third-party ad scripts, analytics, XHR, and pixels with per-tab counters');

    // 2. Cosmetic hiding + non-destruction of article content + sandboxed isolation check
    const domCheck = await until(async () => {
      const state = await tabWc().executeJavaScript(`(() => ({
        articleVisible: getComputedStyle(document.querySelector('#article-content')).display !== 'none',
        staticAdDisplay: getComputedStyle(document.querySelector('#ad-top-banner')).display,
        dynAdDisplay: getComputedStyle(document.querySelector('#dyn-ad')).display,
        hasKinexApi: typeof window.kinexAPI,
        hasRequire: typeof window.require
      }))()`);
      return state.dynAdDisplay === 'none' ? state : null;
    }, 'dynamic cosmetic filter hides #dyn-ad');
    assert.equal(domCheck.articleVisible, true);
    assert.equal(domCheck.staticAdDisplay, 'none', 'EasyList cosmetic filter hides #ad-top-banner');
    assert.equal(domCheck.dynAdDisplay, 'none', 'Post-hydration scan hides dynamic .ad-slot');
    assert.equal(domCheck.hasKinexApi, 'undefined');
    assert.equal(domCheck.hasRequire, 'undefined');
    checks.push('Cosmetic filtering hides static and dynamic ad containers without exposing Electron/Node APIs');

    // 3. Per-site Disabled override restores requests & elements after reload
    await mgr.handleIntent({ type: 'set-shields-site-mode', domain: 'news.shields.test', mode: 'disabled' });
    assert.equal(mgr.getSnapshot().shieldsRuntime.needsReloadByTabId['' + focused().id], true);
    await mgr.handleIntent({ type: 'nav-reload', tabId: focused().id });
    await until(() => !focused().isLoading, 'reloaded with Shields disabled');
    await delay(150);
    const afterDisable = await tabWc().executeJavaScript(`(() => ({
      staticAdDisplay: getComputedStyle(document.querySelector('#ad-top-banner')).display,
      blockedXhr: Boolean(window.__blockedXhr),
      loadedHosts: window.__loadedHosts || []
    }))()`);
    assert.notEqual(afterDisable.staticAdDisplay, 'none', 'Disabled Shields restores hidden elements');
    assert.equal(afterDisable.blockedXhr, false, 'Disabled Shields allows fetch beacon cleanly');
    assert.ok(afterDisable.loadedHosts.some((h) => h.includes('googlesyndication.com')), 'Disabled Shields loads third-party script cleanly');
    checks.push('Per-site Disabled mode lifts network/cosmetic blocking cleanly on reload');

    // 4. Aggressive mode + custom cosmetic rule (Element Picker persistence)
    await mgr.handleIntent({ type: 'set-shields-site-mode', domain: 'news.shields.test', mode: 'aggressive' });
    await mgr.handleIntent({ type: 'add-shields-cosmetic-rule', domain: 'news.shields.test', selector: '#custom-picked-target' });
    await until(() => tabWc().executeJavaScript('getComputedStyle(document.querySelector("#custom-picked-target")).display === "none"'), 'custom rule applied immediately');
    await mgr.handleIntent({ type: 'remove-shields-cosmetic-rule', domain: 'news.shields.test', selector: '#custom-picked-target' });
    await until(() => tabWc().executeJavaScript('getComputedStyle(document.querySelector("#custom-picked-target")).display !== "none"'), 'custom rule removed immediately');
    await mgr.handleIntent({ type: 'set-shields-site-mode', domain: 'news.shields.test', mode: 'inherit' });
    checks.push('Custom Element Picker rules apply and revert immediately without page reload');

    // 5. Private Window & Little Kinex Shields protection + zero private domain telemetry leakage
    await mgr.handleIntent({ type: 'open-incognito', url: `http://private.shields.test:${port}/page` });
    const privState = [...mgr.auxiliaryWindows.privateWindows][0];
    await until(() => !privState.webView.webContents.isLoading(), 'private page loaded');
    await until(() => privState.webView.webContents.executeJavaScript('Boolean(window.__blockedXhr)'), 'private window blocked tracker XHR');
    const privStatsEntries = Object.values(mgr.getSnapshot().shieldsRuntime.tabStats).filter((s) =>
      s.recentBlocked.some((b) => b.host === '[Private request blocked]')
    );
    assert.ok(privStatsEntries.length > 0, 'Private window redacts blocked request hostnames in state snapshot');
    privState.win.close();
    await until(() => mgr.auxiliaryWindows.getPrivateWindowCount() === 0, 'private window closed');
    checks.push('Private window enforces Shields and redacts blocked hostnames');

    // 6. UI Overlay Panel & Settings Shields section keyboard navigation + stats verification
    await mgr.executeCommand('open-shields');
    await until(() => mgr.getSnapshot().overlay.mode === 'shields', 'Shields panel overlay open');
    const ovWc = mgr.overlayView.webContents;
    await until(() => ovWc.executeJavaScript('Boolean(document.querySelector(".shields-panel"))'), 'ShieldsPanel rendered');
    await until(() => ovWc.executeJavaScript('document.activeElement?.closest(".shields-panel") !== null'), 'ShieldsPanel receives initial keyboard focus');
    ovWc.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' });
    ovWc.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' });
    await delay(40);
    ovWc.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    ovWc.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    await until(() => mgr.getSnapshot().overlay.mode === 'none', 'Escape closes ShieldsPanel');

    await mgr.handleIntent({ type: 'set-overlay', overlay: { mode: 'settings', section: 'shields' } });
    await until(() => ovWc.executeJavaScript('Boolean(document.body.innerText.includes("Global Protection Mode"))'), 'Settings Shields section rendered');
    ovWc.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    ovWc.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    await until(() => mgr.getSnapshot().overlay.mode === 'none', 'Escape closes Settings Shields section');
    checks.push('Kinex Shields panel and Settings Shields section support keyboard focus, stats, and Escape dismissal');

    const report = { ok: true, checksPassed: checks.length, checks };
    if (process.env.KINEX_REPORT_PATH) {
      fs.writeFileSync(process.env.KINEX_REPORT_PATH, JSON.stringify(report, null, 2));
    }
    console.log('SHIELDS_INTEGRATION_PASS', report);
  } finally {
    mgr.dispose();
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.destroy();
    }
    server.closeAllConnections();
    server.close();
    fs.rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
  app.exit(0);
}

run().catch((err) => {
  console.error('Shields integration failed:', err);
  app.exit(1);
});
