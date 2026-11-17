const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, protocol } = require('electron');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kinex-security-'));
app.setPath('userData', scratch);
app.setPath('downloads', scratch);
protocol.registerSchemesAsPrivileged(['kinex', 'nook'].map((scheme) => ({
  scheme, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
})));
const { PermissionManager } = require('../../dist-electron/main/permissionManager');
const { SessionManager } = require('../../dist-electron/main/sessionManager');
const { DownloadManager } = require('../../dist-electron/main/downloadManager');
const { KinexWindowManager } = require('../../dist-electron/main/windowManager');

async function run() {
  await app.whenReady();
  const server = http.createServer((req, res) => {
    if (req.url === '/sw.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript' });
      res.end("self.addEventListener('install', () => self.skipWaiting()); self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));");
    } else res.end('<!doctype html><title>Isolation fixture</title><main>Content remains available</main><input type="file" id="upload"><canvas id="canvas">');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let decisions = [{ partition: 'persist:security-a', origin, permission: 'geolocation', decision: 'allow', updatedAt: Date.now() }];
  const permissions = new PermissionManager({
    getMainWindow: () => null, getDecisions: () => decisions,
    recordDecision: (partition, origin, permission, decision) => decisions.push({ partition, origin, permission, decision, updatedAt: Date.now() }),
    revokeDecision: (partition, origin, permission) => {
      decisions = decisions.filter((entry) => !(entry.partition === partition && entry.origin === origin && entry.permission === permission));
    },
  });
  const downloads = new DownloadManager(() => {});
  const sessions = new SessionManager(permissions, downloads);
  const privateSession = sessions.createPrivateSession();
  const windows = [];
  let manager;
  const probe = async (session) => {
    const win = new BrowserWindow({ show: false, webPreferences: { session, sandbox: true, contextIsolation: true, nodeIntegration: false } });
    windows.push(win);
    await win.loadURL(origin);
    return win.webContents;
  };
  const readStorage = `Promise.all([
    indexedDB.databases().then((databases) => databases.map((database) => database.name)),
    caches.keys(), navigator.serviceWorker.getRegistrations().then((registrations) => registrations.length)
  ]).then(([databases, caches, workers]) => ({ databases, caches, workers, local: localStorage.getItem('profile-secret'), cookie: document.cookie }))`;
  try {
    const a = await probe(sessions.getRegularSession('persist:security-a'));
    const b = await probe(sessions.getRegularSession('persist:security-b'));
    const priv = await probe(privateSession.sess);
    assert.deepEqual(await a.executeJavaScript(`({node: typeof process, require: typeof require, api: typeof kinexAPI})`), { node: 'undefined', require: 'undefined', api: 'undefined' });
    const graphics = await a.executeJavaScript(`(() => {
      const canvas = document.querySelector('#canvas');
      const context = canvas.getContext('2d');
      context.fillStyle = '#112233'; context.fillRect(0,0,1,1);
      const pixel = [...context.getImageData(0,0,1,1).data];
      const gl = document.createElement('canvas').getContext('webgl2');
      return { pixel, webgl2: Boolean(gl) };
    })()`);
    assert.deepEqual(graphics.pixel, [17, 34, 51, 255]);
    assert.equal(graphics.webgl2, true, 'real local WebGL2 context must be available');
    const upload = path.join(scratch, 'upload.txt');
    fs.writeFileSync(upload, 'isolated upload fixture');
    a.debugger.attach('1.3');
    try {
      const { root } = await a.debugger.sendCommand('DOM.getDocument');
      const { nodeId } = await a.debugger.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector: '#upload' });
      await a.debugger.sendCommand('DOM.setFileInputFiles', { nodeId, files: [upload] });
      assert.equal(await a.executeJavaScript(`document.querySelector('#upload').files[0].text()`), 'isolated upload fixture');
    } finally { a.debugger.detach(); }
    await a.executeJavaScript(`(async () => {
      localStorage.setItem('profile-secret', 'only-a'); document.cookie = 'profile_secret=only-a; SameSite=Lax';
      await new Promise((resolve, reject) => { const request = indexedDB.open('secret-db', 1); request.onupgradeneeded = () => request.result.createObjectStore('items'); request.onsuccess = () => { request.result.close(); resolve(); }; request.onerror = () => reject(request.error); });
      const cache = await caches.open('secret-cache'); await cache.put('/cached', new Response('only-a'));
      await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready;
    })()`);
    decisions.push({ partition: 'persist:security-a', origin, permission: 'mediaKeySystem', decision: 'allow', updatedAt: Date.now() });
    const drm = await a.executeJavaScript(`(async () => {
      if (!navigator.requestMediaKeySystemAccess) return { status: 'unavailable' };
      try {
        const access = await navigator.requestMediaKeySystemAccess('com.widevine.alpha', [{
          initDataTypes: ['cenc'], videoCapabilities: [{ contentType: 'video/mp4; codecs="avc1.42E01E"' }]
        }]);
        return { status: 'key-system-available', keySystem: access.keySystem, playback: 'NOT TESTED' };
      } catch (error) { return { status: 'rejected', error: error.name, message: error.message, playback: 'NOT TESTED' }; }
    })()`);
    const inA = await a.executeJavaScript(readStorage);
    assert.ok(inA.databases.includes('secret-db'));
    assert.ok(inA.caches.includes('secret-cache'));
    assert.equal(inA.workers, 1);
    for (const wc of [b, priv]) {
      assert.deepEqual(await wc.executeJavaScript(readStorage), { databases: [], caches: [], workers: 0, local: null, cookie: '' });
    }
    const permissionState = `navigator.permissions.query({ name: 'geolocation' }).then((permission) => permission.state)`;
    assert.equal(await a.executeJavaScript(permissionState), 'granted');
    assert.notEqual(await b.executeJavaScript(permissionState), 'granted');
    assert.notEqual(await priv.executeJavaScript(permissionState), 'granted');
    permissions.revoke('persist:security-a', origin, 'geolocation');
    assert.notEqual(await a.executeJavaScript(permissionState), 'granted');
    assert.equal(await priv.executeJavaScript(`new Promise((resolve) => navigator.geolocation.getCurrentPosition(() => resolve('granted'), (error) => resolve(error.code), {timeout: 3000}))`), 1);
    await priv.executeJavaScript(`localStorage.setItem('private-secret', 'temporary'); document.cookie='private_secret=temporary';`);
    await sessions.destroyPrivateSession(privateSession.sess);
    assert.equal((await privateSession.sess.cookies.get({ url: origin })).length, 0);
    await priv.loadURL(origin);
    assert.equal(await priv.executeJavaScript(`localStorage.getItem('private-secret')`), null);

    await a.loadURL('kinex://newtab');
    assert.ok(await a.executeJavaScript(`document.getElementById('clock').textContent.length > 0`), 'nonce-authorized clock must run');
    await a.executeJavaScript(`(() => { const script = document.createElement('script'); script.textContent='window.__injected=true'; document.body.append(script); })()`);
    assert.equal(await a.executeJavaScript(`window.__injected`), undefined, 'CSP must block scripts without a nonce');
    await a
      .executeJavaScript(`document.getElementById('q').value=${JSON.stringify(origin + '/search-target')}; document.querySelector('form').requestSubmit();`)
      .catch((error) => {
        // requestSubmit() starts a navigation, which can dispose the frame before the script result is delivered.
        if (!/Render frame was disposed|Execution context was destroyed|navigat/i.test(String(error && error.message ? error.message : error))) throw error;
      });
    const deadline = Date.now() + 5000;
    while (a.getURL() !== origin + '/search-target' && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(a.getURL(), origin + '/search-target', 'new tab search must work under strict CSP');

    manager = new KinexWindowManager(path.join(scratch, 'manager'));
    const main = manager.createWindow();
    await manager.handleIntent({ type: 'open-url', url: origin, target: 'new-tab' });
    const state = manager.getSnapshot();
    const tab = state.tabs.find((tab) => tab.url === origin);
    const wc = manager.tabManager.getView(tab.id).webContents;
    const prefs = wc.getLastWebPreferences();
    for (const name of ['nodeIntegration', 'nodeIntegrationInWorker', 'nodeIntegrationInSubFrames', 'webviewTag', 'allowRunningInsecureContent']) assert.equal(prefs[name], false, name);
    assert.equal(prefs.sandbox, true);
    assert.equal(prefs.contextIsolation, true);
    assert.equal(prefs.webSecurity, true);
    assert.equal(prefs.preload, undefined);
    const count = state.spaces.length;
    await manager.handleIntent({ type: 'create-space', name: 'Rejected', icon: 'X', theme: state.spaces[0].theme, profilePartition: 'persist:unknown' });
    assert.equal(manager.getSnapshot().spaces.length, count);
    const { clipboard } = require('electron');
    const writeText = clipboard.writeText;
    clipboard.writeText = async () => { throw new Error('Injected clipboard unavailability'); };
    try {
      await manager.handleIntent({ type: 'copy-current-url', tabId: tab.id });
      assert.equal(manager.getSnapshot().toastMessage, 'Unable to copy URL', 'failed async clipboard writes must not report success');
    } finally { clipboard.writeText = writeText; }
    const { autoUpdater } = require('electron-updater');
    manager.updater.init();
    assert.equal(autoUpdater.allowDowngrade, false, 'automatic downgrades remain disabled');
    const currentVersion = autoUpdater.currentVersion;
    try {
      autoUpdater.currentVersion = new currentVersion.constructor('0.7.0');
      assert.equal(await autoUpdater.isUpdateAvailable({ version: '0.7.3' }), true, 'real updater accepts 0.7.0 to 0.7.3');
      assert.equal(await autoUpdater.isUpdateAvailable({ version: '7.0.2' }), false, 'real updater rejects historical misnumbered releases');
      assert.equal(await autoUpdater.isUpdateAvailable({ version: '1.0.0' }), true, 'production upgrade remains available');
    } finally { autoUpdater.currentVersion = currentVersion; }
    autoUpdater.emit('update-not-available', { version: '7.0.2' });
    assert.equal(manager.getSnapshot().updateStatus.version, app.getVersion(), 'status reports the installed version');
    const updateListeners = autoUpdater.listenerCount('update-downloaded');
    autoUpdater.emit('update-available', { version: '99.0.0' });
    autoUpdater.emit('download-progress', { percent: 10 });
    main.close();
    assert.equal(autoUpdater.listenerCount('update-downloaded'), updateListeners, 'window close must retain application update listeners');
    autoUpdater.emit('update-downloaded', { version: '99.0.0' });
    assert.equal(manager.getSnapshot().updateStatus.state, 'downloaded', 'update status must advance after window close');
    manager.dispose();
    assert.equal(autoUpdater.listenerCount('update-downloaded'), updateListeners - 1, 'application disposal removes updater listener');
    console.log(JSON.stringify({ ok: true, electron: process.versions.electron, chromium: process.versions.chrome, node: process.versions.node, arch: process.arch, os: os.release(), drm, checks: ['remote isolation', 'Canvas/WebGL2/local file input', 'IndexedDB/cache/service-worker/profile isolation', 'private storage purge', 'scoped permission/revocation/private denial', 'CSP nonce/search', 'real tab preferences', 'unknown profile rejection', '0.7.x update version compatibility', 'updater event lifecycle across window close', 'async clipboard error handling'] }, null, 2));
  } finally {
    manager?.dispose();
    downloads.dispose();
    for (const win of windows) if (!win.isDestroyed()) win.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
}
run().then(() => app.exit(0)).catch((error) => { console.error(error); app.exit(1); });
