const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, ipcMain, powerMonitor, protocol, session, webContents } = require('electron');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'kinex-experience-'));
app.setPath('userData', userData);
protocol.registerSchemesAsPrivileged(['kinex', 'nook'].map((scheme) => ({
  scheme, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
})));
const { KinexWindowManager, ensureAppName, registerKinexProtocol } = require('../../dist-electron/main/windowManager');
const { registerKinexIpcHandlers } = require('../../dist-electron/main/ipcHandlers');
const { getFocusedTab } = require('../../dist-electron/shared/domain');
const checks = [];
const requests = new Map();
const focusEvents = [];
const recordFocus = (event, id) => {
  focusEvents.push({ event, id, at: Date.now() });
  if (focusEvents.length > 30) focusEvents.shift();
};
app.on('browser-window-focus', (_event, win) => recordFocus('window-focus', win.id));
app.on('browser-window-blur', (_event, win) => recordFocus('window-blur', win.id));
app.on('web-contents-created', (_event, wc) => {
  wc.on('focus', () => recordFocus('contents-focus', wc.id));
  wc.on('blur', () => recordFocus('contents-blur', wc.id));
});
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, label, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await wait(25);
  }
  throw new Error(`Timed out: ${label}`);
}
async function key(wc, keyCode, modifiers = [], text) {
  await until(() => wc.isFocused(), `native keyboard focus before ${keyCode}`, 1500);
  assert.equal(wc.isFocused(), true, `Keyboard source must own native focus for ${keyCode}: ${JSON.stringify({ expected: wc.id, focused: webContents.getFocusedWebContents()?.id, focusedWindow: BrowserWindow.getFocusedWindow()?.id, focusEvents })}`);
  wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  if (text) wc.sendInputEvent({ type: 'char', keyCode: text, modifiers });
  wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  await wait(25);
}
async function run() {
  ensureAppName();
  app.on('window-all-closed', (event) => event.preventDefault());
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    requests.set(pathname, (requests.get(pathname) ?? 0) + 1);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><html><head><title>Experience ${pathname}</title></head><body><main><h1>Experience ${pathname}</h1><input id="typing" aria-label="Typing probe"><a id="leave" href="/plain">Leave article</a>${Array.from({ length: 8 }, () => '<p>Kinex article content describes browser navigation, safe isolated sessions, reliable keyboard interaction and comfortable reading. This paragraph is long enough to exercise real article extraction without loading any external resource.</p>').join('')}</main></body></html>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  await app.whenReady();
  registerKinexProtocol(protocol);
  const initialListeners = {
    speed: powerMonitor.listenerCount('speed-limit-change'),
    thermal: powerMonitor.listenerCount('thermal-state-change'),
  };
  const mgr = new KinexWindowManager(userData);
  registerKinexIpcHandlers(ipcMain, () => mgr);
  const focusedTab = () => getFocusedTab(mgr.getSnapshot());
  const page = () => mgr.tabManager.getView(focusedTab().id).webContents;
  const load = async (pathname) => {
    await mgr.handleIntent({ type: 'open-url', url: `${baseUrl}${pathname}`, target: 'new-tab' });
    await until(() => !focusedTab().isLoading && page().getURL() === `${baseUrl}${pathname}`, `load ${pathname}`);
    return focusedTab();
  };
  const palette = async (query) => {
    await key(page(), 'T', ['meta']);
    await until(async () => {
      const wc = mgr.overlayView?.webContents;
      return wc && !wc.isDestroyed() && wc.isFocused() && await wc.executeJavaScript("Boolean(document.querySelector('.command-input'))").catch(() => false);
    }, 'focused command input');
    const wc = mgr.overlayView.webContents;
    assert.equal(await wc.executeJavaScript("document.querySelector('.command-input').value"), '', 'Reopened palette starts with a fresh query');
    await wc.insertText(query);
    await key(wc, 'Enter');
  };
  let win;
  try {
    win = mgr.createWindow();
    await until(() => win.isVisible(), 'automatic startup presentation');
    app.focus({ steal: true });
    win.focus();
    await until(() => !mgr.shellView.webContents.isLoading(), 'shell load');
    checks.push('Startup presents the native window without test calling show');

    await load('/typing');
    const typingPage = page();
    await until(() => win.isFocused() && typingPage.isFocused(), 'typing page native focus');
    await typingPage.executeJavaScript("document.querySelector('#typing').focus()");
    await until(() => typingPage.executeJavaScript("document.hasFocus() && document.activeElement.id === 'typing'"), 'typing input DOM focus');
    const beforeTyping = mgr.getSnapshot().tabs.length;
    await key(typingPage, 'x', [], 'x');
    try {
      await until(async () => await typingPage.executeJavaScript("document.querySelector('#typing').value") === 'x', 'plain typing preserved');
    } catch (error) {
      const typing = await typingPage.executeJavaScript("({ value: document.querySelector('#typing')?.value, activeId: document.activeElement?.id, documentFocused: document.hasFocus() })");
      error.message += ` ${JSON.stringify({ typing, nativeFocused: typingPage.isFocused(), windowFocused: win.isFocused(), focusEvents })}`;
      throw error;
    }
    assert.equal(mgr.getSnapshot().tabs.length, beforeTyping);
    assert.equal(mgr.getSnapshot().overlay.mode, 'none');
    checks.push('Plain typing reaches the remote document without browser command dispatch');

    await key(page(), 'F6');
    const shell = mgr.shellView.webContents;
    await until(() => shell.isFocused(), 'F6 shell native focus');
    const origin = await shell.executeJavaScript("document.activeElement.getAttribute('data-sidebar-item')");
    assert.ok(origin, 'F6 focuses a Sidebar primary item');
    await key(shell, ',', ['meta']);
    await until(() => mgr.getSnapshot().overlay.mode === 'settings' && mgr.overlayView.webContents.isFocused(), 'Settings native focus');
    const overlay = mgr.overlayView.webContents;
    await until(async () => await overlay.executeJavaScript("Boolean(document.querySelector('.settings-window')?.contains(document.activeElement))"), 'Settings initial DOM focus');
    for (let i = 0; i < 16; i++) {
      await key(overlay, 'Tab', i % 2 ? ['shift'] : []);
      assert.equal(await overlay.executeJavaScript("document.querySelector('.settings-window').contains(document.activeElement)"), true);
    }
    await key(overlay, 'Escape');
    await until(async () => shell.isFocused() && await shell.executeJavaScript("document.activeElement.getAttribute('data-sidebar-item')") === origin, 'restore exact Sidebar focus');
    checks.push('F6 crosses WebContents; Settings traps Tab and restores the Sidebar origin');
    await mgr.handleIntent({ type: 'focus-region', region: 'content' });

    const first = await load('/first');
    const second = await load('/second');
    await mgr.handleIntent({ type: 'toggle-split', tabId: first.id });
    await mgr.handleIntent({ type: 'focus-pane', paneIndex: 1 });
    assert.equal(focusedTab().id, first.id);
    await key(page(), 'D', ['meta']);
    assert.equal(mgr.getSnapshot().tabs.find((tab) => tab.id === first.id).location, 'pinned');
    assert.equal(mgr.getSnapshot().tabs.find((tab) => tab.id === second.id).location, 'unpinned');
    await palette('Duplicate Tab');
    await until(() => focusedTab().id !== first.id && !focusedTab().isLoading, 'duplicate focused pane');
    assert.equal(focusedTab().url, first.url);
    checks.push('Pin and Duplicate commands resolve the focused split pane');

    const movedId = focusedTab().id;
    await palette('Move Tab to Work');
    await until(() => mgr.getSnapshot().activeSpaceId === 'space-work' && mgr.getSnapshot().overlay.mode === 'none', 'dynamic Space move closes palette');
    assert.equal(focusedTab().id, movedId);
    assert.equal(page().isFocused(), true);
    await mgr.handleIntent({ type: 'create-folder', spaceId: 'space-work', name: 'Reading' });
    await palette('Move Tab to Folder Reading');
    await until(() => Boolean(focusedTab().folderId) && mgr.getSnapshot().overlay.mode === 'none', 'dynamic folder move closes palette');
    checks.push('Dynamic Space/folder palette commands dismiss and preserve correct target');

    const oldWc = page();
    const oldWcId = oldWc.id;
    const oldSession = oldWc.session;
    await oldSession.cookies.set({ url: baseUrl, name: 'profile-proof', value: 'old-profile' });
    await mgr.handleIntent({ type: 'create-profile', name: 'Experience Isolation' });
    const newProfile = mgr.getSnapshot().profiles.at(-1);
    const work = mgr.getSnapshot().spaces.find((space) => space.id === 'space-work');
    await mgr.handleIntent({ type: 'update-space', spaceId: work.id, name: work.name, icon: work.icon, theme: work.theme, profilePartition: newProfile.partition });
    await until(() => oldWc.isDestroyed() && page().id !== oldWcId && !focusedTab().isLoading, 'live Profile reassignment');
    assert.equal(page().session, session.fromPartition(newProfile.partition));
    assert.equal((await page().session.cookies.get({ url: baseUrl, name: 'profile-proof' })).length, 0);
    assert.equal((await oldSession.cookies.get({ url: baseUrl, name: 'profile-proof' }))[0].value, 'old-profile');
    checks.push('Live Profile reassignment recreates views without deleting or exposing old cookies');

    const zoomA = await load('/zoom-a');
    await load('/zoom-b');
    await mgr.handleIntent({ type: 'set-zoom', delta: 'in' });
    await mgr.handleIntent({ type: 'select-tab', tabId: zoomA.id });
    await key(page(), 'R', ['meta']);
    await until(() => !focusedTab().isLoading && focusedTab().zoomFactor > 1 && mgr.tabManager.getView(zoomA.id).getBounds().y === 40, 'saved zoom toolbar native bounds');
    await key(page(), '0', ['meta']);
    await until(() => mgr.tabManager.getView(zoomA.id).getBounds().y === 10, 'zoom reset native bounds');
    await mgr.handleIntent({ type: 'toggle-reader-mode' });
    await until(() => page().getURL().startsWith('kinex://reader') && mgr.tabManager.getView(zoomA.id).getBounds().y === 40, 'Reader toolbar native bounds');
    await page().loadURL(`${baseUrl}/plain`);
    await until(() => !mgr.getSnapshot().readerTabIds.includes(zoomA.id) && mgr.tabManager.getView(zoomA.id).getBounds().y === 10, 'leaving Reader native bounds');
    checks.push('Saved zoom and Reader navigation keep native page bounds aligned with toolbar');

    async function popupCheck(opener, label) {
      const before = mgr.getSnapshot().tabs.map((tab) => `${tab.id}:${tab.url}`);
      const pathname = `/popup-${label}`;
      const created = new Promise((resolve) => opener.once('did-create-window', resolve));
      await opener.executeJavaScript(`window.open(${JSON.stringify(baseUrl + pathname)}, '_blank', 'width=420,height=320'); void 0`, true);
      const popup = await Promise.race([created, wait(8000).then(() => { throw new Error(`${label} popup did not open`); })]);
      await until(() => !popup.webContents.isLoading() && popup.webContents.getURL() === baseUrl + pathname, `${label} popup ready`);
      popup.focus();
      popup.webContents.focus();
      await until(() => popup.webContents.isFocused(), `${label} popup native focus`);
      assert.equal(await popup.webContents.executeJavaScript('typeof window.kinexAPI'), 'undefined');
      const hits = requests.get(pathname);
      await key(popup.webContents, 'R', ['meta']);
      await until(() => requests.get(pathname) > hits && !popup.webContents.isLoading(), `${label} popup local reload`);
      await key(popup.webContents, 'W', ['meta']);
      await until(() => popup.isDestroyed(), `${label} popup local close`);
      assert.deepEqual(mgr.getSnapshot().tabs.map((tab) => `${tab.id}:${tab.url}`), before);
    }
    await popupCheck(page(), 'regular');
    await mgr.handleIntent({ type: 'open-incognito', url: `${baseUrl}/private` });
    const privateState = [...mgr.auxiliaryWindows.privateWindows][0];
    await until(() => !privateState.webView.webContents.isLoading(), 'private page ready');
    await popupCheck(privateState.webView.webContents, 'private');
    privateState.win.close();
    checks.push('Regular/private popup shortcuts reload and close locally without regular tab mutation');

    assert.equal(powerMonitor.listenerCount('speed-limit-change'), initialListeners.speed + 1);
    powerMonitor.emit('speed-limit-change', { limit: 60 });
    assert.equal(mgr.getSnapshot().reducedEffects, true);
    powerMonitor.emit('thermal-state-change', { state: 'serious' });
    powerMonitor.emit('speed-limit-change', { limit: 100 });
    assert.equal(mgr.getSnapshot().reducedEffects, true);
    powerMonitor.emit('thermal-state-change', { state: 'nominal' });
    assert.equal(mgr.getSnapshot().reducedEffects, false);
    const fsTab = focusedTab();
    const fsView = mgr.tabManager.getView(fsTab.id);
    const fsBefore = fsView.getBounds();
    assert.ok(fsBefore.x >= 200, 'Normal layout reserves sidebar inset before HTML5 fullscreen');
    let nativeEntered = false;
    let nativeLeft = false;
    win.once('enter-full-screen', () => { nativeEntered = true; });
    win.once('leave-full-screen', () => { nativeLeft = true; });
    win.focus();
    fsView.webContents.focus();
    await until(() => win.isFocused() && fsView.webContents.isFocused(), 'fullscreen native focus after private window close');
    // Observe the real transition below instead of awaiting an unbounded page API promise over IPC.
    await fsView.webContents.executeJavaScript('void document.documentElement.requestFullscreen()', true);
    await until(async () => nativeEntered && !mgr.shellView.getVisible() && await fsView.webContents.executeJavaScript('Boolean(document.fullscreenElement)'), 'real HTML5 fullscreen entry');
    assert.equal(win.isFullScreen(), true);
    assert.equal(await fsView.webContents.executeJavaScript('Boolean(document.fullscreenElement)'), true);
    const contentBounds = win.getContentBounds();
    assert.deepEqual(fsView.getBounds(), { x: 0, y: 0, width: contentBounds.width, height: contentBounds.height });
    assert.equal(mgr.shellView.getVisible(), false);
    await fsView.webContents.executeJavaScript('void document.exitFullscreen()');
    await until(async () => nativeLeft && mgr.shellView.getVisible() && await fsView.webContents.executeJavaScript('!document.fullscreenElement'), 'real HTML5 fullscreen exit');
    assert.equal(win.isFullScreen(), false);
    assert.equal(await fsView.webContents.executeJavaScript('Boolean(document.fullscreenElement)'), false);
    assert.equal(mgr.shellView.getVisible(), true);
    assert.ok(fsView.getBounds().x >= 200, 'Leaving HTML5 fullscreen restores sidebar inset layout');
    checks.push('HTML5 fullscreen expands active WebContentsView edge-to-edge and hides shell chrome cleanly');

    win.close();
    await until(() => !mgr.hasWindow(), 'close main window');
    assert.equal(powerMonitor.listenerCount('speed-limit-change'), initialListeners.speed);
    assert.equal(powerMonitor.listenerCount('thermal-state-change'), initialListeners.thermal);
    win = mgr.createWindow();
    await until(() => win.isVisible(), 'reopen automatic presentation');
    assert.equal(powerMonitor.listenerCount('speed-limit-change'), initialListeners.speed + 1);
    assert.equal(powerMonitor.listenerCount('thermal-state-change'), initialListeners.thermal + 1);
    win.close();
    await until(() => !mgr.hasWindow(), 'close reopened window');
    assert.equal(powerMonitor.listenerCount('speed-limit-change'), initialListeners.speed);
    assert.equal(powerMonitor.listenerCount('thermal-state-change'), initialListeners.thermal);
    checks.push('Simulated power/thermal events reduce effects and listeners do not leak on reopen');
    const report = { ok: true, checksPassed: checks.length, checks, powerEvents: 'simulated Electron events, not hardware measurements' };
    if (process.env.KINEX_REPORT_PATH) fs.writeFileSync(process.env.KINEX_REPORT_PATH, JSON.stringify(report, null, 2));
    fs.writeSync(1, `EXPERIENCE_PASS ${JSON.stringify(report)}\n`);
  } finally {
    mgr.dispose();
    for (const window of BrowserWindow.getAllWindows()) window.destroy();
    server.closeAllConnections();
    server.close();
    fs.rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
  app.exit(0);
}
run().catch((error) => {
  const report = { ok: false, checksPassed: checks.length, checks, focusEvents, error: error.stack ?? String(error) };
  if (process.env.KINEX_REPORT_PATH) fs.writeFileSync(process.env.KINEX_REPORT_PATH, JSON.stringify(report, null, 2));
  console.error('Experience integration failed:', error);
  app.exit(1);
});
