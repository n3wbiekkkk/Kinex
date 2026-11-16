const fs = require('node:fs');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, protocol } = require('electron');

const outDir = process.argv[2] || path.join(os.tmpdir(), 'kinex-screenshots');
fs.mkdirSync(outDir, { recursive: true });
const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'kinex-ui-audit-'));
app.setPath('userData', tmpUserData);
const downloadDir = path.join(tmpUserData, 'downloads');
fs.mkdirSync(downloadDir);
app.setPath('downloads', downloadDir);
const captures = [];
const watchdog = setTimeout(() => {
  console.error('Screenshot audit exceeded its 4-minute deadline');
  app.exit(1);
}, 240_000);
watchdog.unref();

protocol.registerSchemesAsPrivileged([
  { scheme: 'kinex', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
  { scheme: 'nook', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

const { KinexWindowManager, ensureAppName, registerKinexProtocol } = require('../../dist-electron/main/windowManager');
const { registerKinexIpcHandlers } = require('../../dist-electron/main/ipcHandlers');

function waitMs(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function startLocalDemoServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === '/download') {
        res.writeHead(200, {
          'Content-Type': 'text/plain',
          'Content-Disposition': 'attachment; filename="kinex-design-notes.txt"',
        });
        res.end('Kinex design audit download fixture.\n');
        return;
      }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      if (req.url.startsWith('/docs')) {
        res.end(`<!doctype html><html><head><title>Kinex Architecture Docs</title><style>
          body{margin:0;font-family:-apple-system,sans-serif;background:#fafafa;color:#18181b;padding:48px;line-height:1.6}
          .card{max-width:720px;margin:0 auto;background:#fff;border:1px solid #e4e4e7;border-radius:12px;padding:32px}
          h1{margin:0 0 12px;font-size:28px;letter-spacing:-0.02em}
          code{background:#f4f4f5;padding:2px 6px;border-radius:6px;font-size:13px}
        </style></head><body><article class="card"><h1>Minimalist Browser Architecture</h1><p>Sandboxed <code>WebContentsView</code> tabs use Profile partitions to separate cookies and storage. Spaces organize work, while Memory Saver releases inactive page renderers without removing their tabs.</p><h2>A calmer workspace</h2><p>Clear focus, familiar shortcuts, and a restrained interface let people move between reading, writing, and research. Keyboard access should remain available across both browser controls and native website views.</p><p>Stable geometry keeps Split View aligned with its native content. Short opacity and transform transitions provide feedback while allowing input immediately.</p></article></body></html>`);
        return;
      }
      if (req.url.startsWith('/notes')) {
        res.end(`<!doctype html><html><head><title>Design Notes — Workspace</title><style>
          body{margin:0;font-family:-apple-system,sans-serif;background:#111216;color:#f4f4f7;padding:48px;line-height:1.6}
          .card{max-width:720px;margin:0 auto;background:#191b22;border:1px solid rgba(255,255,255,0.09);border-radius:12px;padding:32px}
          h1{margin:0 0 12px;font-size:28px;letter-spacing:-0.02em}
        </style></head><body><div class="card"><h1>Split View Workspace</h1><p>Side-by-side layout comparing two independent pages cleanly.</p></div></body></html>`);
        return;
      }
      if (req.url === '/history') {
        res.end('<!doctype html><html><head><title>History Fixture</title></head><body><h1>Recently visited design notes</h1></body></html>');
        return;
      }
      res.end(`<!doctype html><html><head><title>Sample Page ${req.url}</title></head><body style="font-family:-apple-system,sans-serif;padding:40px;background:#14151a;color:#eee;"><h1>Loaded ${req.url}</h1></body></html>`);
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` }));
  });
}

async function saveShot(win, filename, focus = true) {
  app.dock?.show();
  if (focus) {
    app.focus({ steal: true });
    win.show();
    win.focus();
    win.moveTop();
  }
  await waitMs(220);

  const outFile = path.join(outDir, filename);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const mediaId = win.getMediaSourceId(); // format: "window:<cgWindowId>:0"
  const cgWindowId = mediaId && mediaId.startsWith('window:') ? mediaId.split(':')[1] : null;
  if (cgWindowId && focus) {
    try {
      execFileSync('screencapture', ['-x', '-o', '-l', cgWindowId, outFile], { stdio: 'ignore' });
    } catch {
      const b = win.getBounds();
      execFileSync('screencapture', ['-x', '-R', `${b.x},${b.y},${b.width},${b.height}`, outFile], { stdio: 'ignore' });
    }
  } else {
    const b = win.getBounds();
    execFileSync('screencapture', ['-x', '-R', `${b.x},${b.y},${b.width},${b.height}`, outFile], { stdio: 'ignore' });
  }
  const stat = fs.statSync(outFile);
  if (stat.size < 1024) {
    throw new Error(`Screenshot ${filename} too small (${stat.size} bytes)`);
  }
  const image = nativeImage.createFromPath(outFile);
  assert.equal(image.isEmpty(), false, `${filename} must decode as an image`);
  captures.push({ filename, bounds: win.getBounds(), pixels: image.getSize() });
}

async function waitFor(predicate, label, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await waitMs(40);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function focusedTab(mgr) {
  const state = mgr.getSnapshot();
  const split = state.splitsBySpace[state.activeSpaceId];
  return state.tabs.find((tab) => tab.id === split.tabIds[split.focusedIndex]);
}

async function navigate(mgr, url) {
  await mgr.handleIntent({ type: 'open-url', url, target: 'new-tab', duplicatePolicy: 'allow' });
  const tab = focusedTab(mgr);
  assert.ok(tab, 'Navigation must create a focused tab');
  await waitFor(() => !mgr.getSnapshot().tabs.find((t) => t.id === tab.id)?.isLoading, url);
  return tab.id;
}

async function setOverlay(mgr, overlay) {
  await mgr.handleIntent({ type: 'set-overlay', overlay });
  await waitMs(180);
}

async function captureNativeControls(mgr, win, prefix, tabId) {
  let popup;
  const originalPopup = Menu.prototype.popup;
  try {
    Menu.prototype.popup = function (options) {
      popup = this;
      return originalPopup.call(this, { ...options, x: 40, y: 56 });
    };
    mgr.showTabContextMenu(tabId);
    await saveShot(win, `${prefix}-context-menu.png`, false);
  } finally {
    popup?.closePopup(win);
    Menu.prototype.popup = originalPopup;
  }

  const controller = new AbortController();
  const closed = dialog.showMessageBox(win, {
    type: 'question',
    title: 'Kinex',
    message: 'Keep this workspace?',
    detail: 'This native dialog is an isolated visual audit fixture. No browsing data will change.',
    buttons: ['Cancel', 'Keep Workspace'],
    defaultId: 1,
    cancelId: 0,
    signal: controller.signal,
  });
  try {
    await saveShot(win, `${prefix}-native-dialog.png`, false);
  } finally {
    controller.abort();
    await closed;
  }
}

async function captureMatrix(mgr, win, baseUrl) {
  for (const [width, height] of [[880, 680], [1360, 860], [1720, 960]]) {
    win.setSize(width, height);
    win.center();
    for (const [theme, spaceId] of [['dark', 'space-personal'], ['light', 'space-work']]) {
      const prefix = `matrix/${width}-${theme}`;
      await mgr.handleIntent({ type: 'select-space', spaceId });
      await navigate(mgr, 'kinex://newtab');
      await saveShot(win, `${prefix}-newtab.png`);

      const docsId = await navigate(mgr, `${baseUrl}/docs?audit=${width}-${theme}`);
      await mgr.handleIntent({ type: 'set-tab-location', tabId: docsId, location: 'topApp' });
      await saveShot(win, `${prefix}-favorites.png`);
      await mgr.handleIntent({ type: 'set-tab-location', tabId: docsId, location: 'pinned' });
      const notesId = await navigate(mgr, `${baseUrl}/notes?audit=${width}-${theme}`);
      await saveShot(win, `${prefix}-sidebar.png`);
      mgr.shellView.webContents.focus();
      mgr.shellView.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' });
      mgr.shellView.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' });
      await saveShot(win, `${prefix}-keyboard-focus.png`);

      await setOverlay(mgr, { mode: 'space-editor', spaceId });
      await saveShot(win, `${prefix}-spaces.png`);
      await setOverlay(mgr, { mode: 'none' });
      await mgr.handleIntent({ type: 'select-tab', tabId: docsId });
      await mgr.handleIntent({ type: 'toggle-split', tabId: notesId });
      await saveShot(win, `${prefix}-split.png`);
      await mgr.handleIntent({ type: 'toggle-split' });

      await setOverlay(mgr, { mode: 'command-bar', initialQuery: 'reader', targetMode: 'new-tab' });
      await saveShot(win, `${prefix}-command.png`);
      await setOverlay(mgr, { mode: 'settings', section: 'general' });
      await saveShot(win, `${prefix}-settings.png`);
      await setOverlay(mgr, { mode: 'settings', section: 'shortcuts' });
      await saveShot(win, `${prefix}-shortcuts.png`);
      await setOverlay(mgr, { mode: 'downloads' });
      await saveShot(win, `${prefix}-downloads.png`);
      await setOverlay(mgr, { mode: 'none' });

      const historyId = await navigate(mgr, `${baseUrl}/history`);
      await mgr.handleIntent({ type: 'close-tab', tabId: historyId });
      await setOverlay(mgr, { mode: 'command-bar', initialQuery: 'History Fixture', targetMode: 'new-tab' });
      await saveShot(win, `${prefix}-history-search.png`);
      if (process.argv.includes('--history-overlay')) {
        await setOverlay(mgr, { mode: 'history' });
        await saveShot(win, `${prefix}-history.png`);
      }
      await setOverlay(mgr, { mode: 'archive' });
      await saveShot(win, `${prefix}-archive.png`);
      await setOverlay(mgr, { mode: 'none' });

      await mgr.handleIntent({ type: 'select-tab', tabId: docsId });
      await mgr.handleIntent({ type: 'set-reader-options', options: { theme } });
      await mgr.handleIntent({ type: 'toggle-reader-mode', tabId: docsId });
      await waitFor(() => mgr.getSnapshot().readerTabIds.includes(docsId), 'Reader Mode');
      await saveShot(win, `${prefix}-reader.png`);
      await mgr.handleIntent({ type: 'toggle-reader-mode', tabId: docsId });

      await captureNativeControls(mgr, win, prefix, docsId);
      await mgr.handleIntent({ type: 'open-incognito' });
      const privateWindow = BrowserWindow.getAllWindows().find((w) => w !== win && !w.isDestroyed());
      assert.ok(privateWindow, 'Private window must open');
      privateWindow.setSize(width, height);
      privateWindow.center();
      await saveShot(privateWindow, `${prefix}-private.png`);
      privateWindow.close();
    }
  }
}

async function run() {
  process.env.KINEX_DISABLE_AUTO_UPDATER = '1';
  app.on('window-all-closed', (e) => e.preventDefault());
  ensureAppName();
  const { server, baseUrl } = await startLocalDemoServer();
  await app.whenReady();
  registerKinexProtocol(protocol);

  const mgr = new KinexWindowManager(tmpUserData);
  registerKinexIpcHandlers(ipcMain, () => mgr);
  const win = mgr.createWindow();
  win.setSize(1360, 860);
  win.center();
  win.show();

  try {
    await mgr.handleIntent({ type: 'set-https-only', enabled: false });
    await waitMs(700);

    // 1. New Tab — Dark Mode (Personal Space default dark theme)
    await mgr.handleIntent({ type: 'select-space', spaceId: 'space-personal' });
    await mgr.handleIntent({ type: 'open-url', url: 'kinex://newtab', target: 'new-tab' });
    await waitMs(500);
    await saveShot(win, '01-newtab-dark-1360.png');

    // 2. New Tab — Light Mode (Work Space light theme)
    await mgr.handleIntent({ type: 'select-space', spaceId: 'space-work' });
    await mgr.handleIntent({ type: 'open-url', url: 'kinex://newtab', target: 'new-tab', spaceId: 'space-work' });
    await waitMs(500);
    await saveShot(win, '02-newtab-light-1360.png');

    // 3. Multiple Tabs + Memory Saver Sleeping Indicator + Multiple Spaces
    await mgr.handleIntent({ type: 'select-space', spaceId: 'space-personal' });
    await mgr.handleIntent({ type: 'open-url', url: `${baseUrl}/docs`, target: 'new-tab' });
    await mgr.handleIntent({ type: 'open-url', url: `${baseUrl}/notes`, target: 'new-tab' });
    await mgr.handleIntent({ type: 'open-url', url: `${baseUrl}/guide`, target: 'new-tab' });
    await waitMs(450);
    const snap = mgr.getSnapshot();
    const docsTab = snap.tabs.find((t) => t.url.endsWith('/docs'));
    const notesTab = snap.tabs.find((t) => t.url.endsWith('/notes'));
    if (notesTab) {
      await mgr.handleIntent({ type: 'discard-tab', tabId: notesTab.id });
    }
    await waitMs(350);
    await saveShot(win, '03-sidebar-tabs-sleeping-1360.png');

    // 4. Split View
    if (docsTab) {
      await mgr.handleIntent({ type: 'select-tab', tabId: docsTab.id });
      await mgr.handleIntent({ type: 'toggle-split', tabId: notesTab?.id });
    }
    await waitMs(500);
    await saveShot(win, '04-split-view-1360.png');

    // Close split for overlays & width tests
    await mgr.handleIntent({ type: 'toggle-split' });
    await waitMs(300);

    // 5. Command Bar
    await mgr.handleIntent({
      type: 'set-overlay',
      overlay: { mode: 'command-bar', initialQuery: 'github', targetMode: 'new-tab' },
    });
    await waitMs(450);
    await saveShot(win, '05-command-bar-1360.png');

    // 6. Settings
    await mgr.handleIntent({ type: 'set-overlay', overlay: { mode: 'settings', section: 'general' } });
    await waitMs(350);
    await saveShot(win, '06-settings-1360.png');

    // 7. Downloads
    await mgr.handleIntent({ type: 'set-overlay', overlay: { mode: 'downloads' } });
    await waitMs(350);
    await saveShot(win, '07-downloads-1360.png');

    // Close overlay cleanly
    await mgr.handleIntent({ type: 'set-overlay', overlay: { mode: 'none' } });
    await waitMs(250);

    // 8. Responsive window widths (880px & 1720px)
    win.setSize(880, 680);
    win.center();
    await saveShot(win, '08-width-880.png');

    win.setSize(1720, 960);
    win.center();
    await saveShot(win, '09-width-1720.png');

    // 9. Private Window
    await mgr.handleIntent({ type: 'open-incognito' });
    await waitMs(650);
    const privWin = BrowserWindow.getAllWindows().find((w) => w !== win && !w.isDestroyed());
    if (privWin) {
      await saveShot(privWin, '10-private-window.png');
      privWin.close();
    }

    await setOverlay(mgr, { mode: 'none' });
    const downloadTabId = await navigate(mgr, `${baseUrl}/docs`);
    mgr.tabManager.getView(downloadTabId).webContents.downloadURL(`${baseUrl}/download`);
    await waitFor(() => mgr.getSnapshot().downloads.some((d) => d.state === 'completed'), 'completed local download');
    await captureMatrix(mgr, win, baseUrl);
    fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify({
      capturedAt: new Date().toISOString(),
      note: 'Private windows retain their own private appearance. History is inspected through Command Bar results. Native dialog is a safe visual fixture.',
      captures,
    }, null, 2));

    console.log('SCREENSHOTS_CAPTURED', { outDir, files: fs.readdirSync(outDir).sort() });
  } finally {
    for (const bw of BrowserWindow.getAllWindows()) {
      if (!bw.isDestroyed()) bw.close();
    }
    mgr.dispose();
    server.close();
    fs.rmSync(tmpUserData, { recursive: true, force: true });
    clearTimeout(watchdog);
  }
  app.exit(0);
}

run().catch((err) => {
  console.error(err);
  app.exit(1);
});
