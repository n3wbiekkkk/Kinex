const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, ipcMain, protocol } = require('electron');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'kinex-extensions-'));
app.setPath('userData', userData);
protocol.registerSchemesAsPrivileged(['kinex', 'nook'].map((scheme) => ({
  scheme,
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
})));

const { KinexWindowManager, ensureAppName, registerKinexProtocol } = require('../../dist-electron/main/windowManager');
const { registerKinexIpcHandlers } = require('../../dist-electron/main/ipcHandlers');
const fixture = path.resolve(__dirname, '..', 'fixtures', 'extensions', 'mv3-basic');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, label, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await wait(25);
  }
  throw new Error(`Timed out: ${label}`);
}

async function run() {
  ensureAppName();
  app.on('window-all-closed', (event) => event.preventDefault());
  await app.whenReady();
  registerKinexProtocol(protocol);

  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><body><h1>Extension target</h1></body></html>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const targetUrl = `http://127.0.0.1:${server.address().port}/`;

  let mgr = new KinexWindowManager(userData);
  let disposed = false;
  registerKinexIpcHandlers(ipcMain, () => mgr);
  try {
    const win = mgr.createWindow();
    await until(() => win.isVisible(), 'window visible');

    await mgr.handleIntent({ type: 'install-extension', sourcePath: fixture });
    await until(() => mgr.getSnapshot().extensions.length === 1, 'extension installed');
    let record = mgr.getSnapshot().extensions[0];
    assert.equal(record.enabled, false);
    assert.equal(record.consented, false);
    assert.equal(record.name, 'Kinex Test Extension');
    assert.ok(record.iconDataUrl.startsWith('data:image/png;base64,'));
    assert.throws(() => mgr.extensionManager.setEnabled(record.id, true), /Review and accept/);

    await mgr.handleIntent({ type: 'set-extension-enabled', extensionId: record.id, enabled: true, consent: true });
    await until(() => mgr.getSnapshot().extensions[0].loaded === true, 'extension loaded into session');
    record = mgr.getSnapshot().extensions[0];
    assert.match(record.runtimeId, /^[a-p]{32}$/);
    const defaultSession = mgr.sessionManager.getRegularSession('persist:nook-default');
    assert.ok(defaultSession.extensions.getAllExtensions().some((item) => item.id === record.runtimeId));

    // Content script injection in the Space whose Profile owns the extension.
    mgr.openUrl(targetUrl, 'new-tab');
    const tab = await until(() => mgr.getSnapshot().tabs.find((item) => item.url.startsWith(targetUrl)), 'target tab created');
    const view = await until(() => mgr.tabManager.getView(tab.id), 'target tab view created');
    await until(() => view.webContents.getURL().startsWith(targetUrl), 'target page loaded');
    await until(async () =>
      await view.webContents.executeJavaScript('document.documentElement.dataset.kinexExtension') === 'injected',
    'content script injected');

    // A different Space with a different Profile must not see the extension or its content script.
    const workPartition = mgr.persisted.spaces.find((space) => space.id === 'space-work').profilePartition;
    const workSession = mgr.sessionManager.getRegularSession(workPartition);
    assert.equal(workSession.extensions.getAllExtensions().some((item) => item.id === record.runtimeId), false);
    mgr.openUrl(targetUrl, 'new-tab', 'space-work');
    const workTab = await until(() => mgr.getSnapshot().tabs.find((item) => item.url.startsWith(targetUrl) && item.spaceId === 'space-work'), 'work tab created');
    const workView = await until(() => mgr.tabManager.getView(workTab.id), 'work tab view created');
    await until(() => workView.webContents.getURL().startsWith(targetUrl), 'work page loaded');
    await wait(200);
    assert.notEqual(
      await workView.webContents.executeJavaScript('document.documentElement.dataset.kinexExtension'),
      'injected',
      'Content scripts stay inside the owning Profile partition'
    );

    // Popup surface: chrome-extension origin, real extension APIs, no browser IPC trust.
    await mgr.handleIntent({ type: 'open-extension-popup', extensionId: record.id, anchor: { x: 120, y: 40, width: 28, height: 28 } });
    const popup = await until(() => mgr.extensionPopupView, 'popup view created');
    await until(() => popup.webContents.getURL().startsWith(`chrome-extension://${record.runtimeId}/`), 'popup URL uses extension origin');
    await until(async () =>
      await popup.webContents.executeJavaScript("document.getElementById('extension-name')?.textContent") === 'Kinex Test Extension',
    'popup chrome.runtime API works');
    await popup.webContents.executeJavaScript("chrome.storage.local.set({ kinexFixture: 'default-space' })");
    const stored = await popup.webContents.executeJavaScript(
      "new Promise((resolve) => chrome.storage.local.get('kinexFixture', resolve))"
    );
    assert.equal(stored.kinexFixture, 'default-space', 'chrome.storage.local works in the extension popup');
    assert.equal(workSession.extensions.getAllExtensions().length, 0, 'No extension storage area exists in another Space');
    assert.equal(mgr.ipcRegistry.isTrusted(popup.webContents.id, popup.webContents.getURL()), false);
    await popup.webContents.executeJavaScript("window.location.href = 'https://example.com/'").catch(() => {});
    await wait(200);
    assert.ok(popup.webContents.getURL().startsWith(`chrome-extension://${record.runtimeId}/`), 'popup page cannot navigate off its extension origin');
    await popup.webContents.loadURL('https://example.com/').catch(() => {});
    await wait(400);
    assert.ok(
      mgr.extensionPopupView?.webContents.getURL().startsWith(`chrome-extension://${record.runtimeId}/`),
      'popup returns to its extension origin after any off-origin navigation'
    );
    mgr.closeExtensionPopup();
    await until(() => mgr.extensionPopupView === null, 'popup closed');

    // Cold start reloads enabled extensions without a second install.
    mgr.persistence.save(mgr.persisted);
    mgr.dispose();
    disposed = true;
    for (const window of BrowserWindow.getAllWindows()) window.destroy();
    await wait(100);

    mgr = new KinexWindowManager(userData);
    disposed = false;
    mgr.createWindow();
    await mgr.handleIntent({ type: 'select-space', spaceId: 'space-personal' });
    await until(() => mgr.getSnapshot().extensions.length === 1 && mgr.getSnapshot().extensions[0].loaded, 'extension restored when its Space is activated');
    const restored = mgr.getSnapshot().extensions[0];
    assert.equal(restored.enabled, true);
    assert.equal(restored.consented, true);

    // Disabling removes the extension from its session and it is not reloaded.
    mgr.handleIntent({ type: 'set-extension-enabled', extensionId: restored.id, enabled: false });
    await until(() => mgr.sessionManager.getRegularSession('persist:nook-default').extensions.getAllExtensions().every((item) => item.id !== restored.runtimeId), 'extension unloaded');
    mgr.persistence.save(mgr.persisted);
    mgr.dispose();
    disposed = true;
    for (const window of BrowserWindow.getAllWindows()) window.destroy();
    await wait(100);

    mgr = new KinexWindowManager(userData);
    disposed = false;
    mgr.createWindow();
    await until(() => mgr.getSnapshot().extensions.length === 1, 'disabled extension record restored');
    await wait(200);
    assert.equal(mgr.getSnapshot().extensions[0].loaded, false, 'disabled extension is not loaded');
    await mgr.handleIntent({ type: 'uninstall-extension', extensionId: restored.id });
    await until(() => mgr.getSnapshot().extensions.length === 0, 'extension uninstalled');
    assert.equal(fs.existsSync(path.join(userData, 'Extensions', restored.id)), false, 'extension files removed');

    // Local .crx install: signed CRX3 wrapper around the same MV3 fixture.
    const { makeZip, makeCrx3 } = require('./crx-fixture.cjs');
    const crxEntries = fs.readdirSync(fixture).map((name) => ({
      name,
      content: fs.readFileSync(path.join(fixture, name)),
    }));
    const { buffer: crxBuffer, crxId } = makeCrx3(makeZip(crxEntries));
    const crxPath = path.join(userData, 'fixture.crx');
    fs.writeFileSync(crxPath, crxBuffer);
    await mgr.handleIntent({ type: 'install-extension-crx', sourcePath: crxPath });
    await until(() => mgr.getSnapshot().extensions.some((item) => item.source === 'crx'), 'CRX extension staged');
    const crxRecord = mgr.getSnapshot().extensions.find((item) => item.source === 'crx');
    assert.equal(crxRecord.crxId, crxId);
    assert.equal(crxRecord.enabled, false);
    assert.throws(() => mgr.extensionManager.setEnabled(crxRecord.id, true), /Review and accept/);
    await mgr.handleIntent({ type: 'set-extension-enabled', extensionId: crxRecord.id, enabled: true, consent: true });
    await until(() => mgr.getSnapshot().extensions.find((item) => item.id === crxRecord.id)?.loaded, 'CRX extension enabled');

    const corruptCrx = path.join(userData, 'corrupt.crx');
    fs.writeFileSync(corruptCrx, Buffer.concat([crxBuffer.subarray(0, crxBuffer.length - 8), Buffer.from('00000000')]));
    await mgr.handleIntent({ type: 'install-extension-crx', sourcePath: corruptCrx });
    await wait(200);
    assert.equal(mgr.getSnapshot().extensions.length, 1, 'corrupt CRX is rejected without staging');

    fs.writeSync(1, `EXTENSIONS_PASS ${JSON.stringify({ id: restored.id, crxId, contentScript: true, isolation: true, popup: true, coldStart: true, crx: true })}\n`);
  } finally {
    if (!disposed) mgr.dispose();
    server.close();
  }
}

run().then(() => app.quit()).catch((error) => {
  fs.writeSync(2, `EXTENSIONS_FAIL ${error.stack || error.message}\n`);
  app.exit(1);
});
