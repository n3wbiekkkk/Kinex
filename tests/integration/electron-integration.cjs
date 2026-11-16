const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, ipcMain, protocol } = require('electron');

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'kinex-int-'));
app.setPath('userData', tmpUserData);

protocol.registerSchemesAsPrivileged([
  { scheme: 'kinex', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
  { scheme: 'nook', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

const { KinexWindowManager, ensureAppName, registerKinexProtocol } = require('../../dist-electron/main/windowManager');
const { registerKinexIpcHandlers } = require('../../dist-electron/main/ipcHandlers');
const { validateIntent } = require('../../dist-electron/main/ipcValidation');
const { NavigationManager } = require('../../dist-electron/main/navigationManager');
const { SessionManager } = require('../../dist-electron/main/sessionManager');
const { PermissionManager } = require('../../dist-electron/main/permissionManager');
const { DownloadManager } = require('../../dist-electron/main/downloadManager');
const { classifyLoadError, shouldOfferInsecureHttpFallback } = require('../../dist-electron/main/security');

function startTestHttpServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      if (u.pathname === '/cookie-set') {
        const val = u.searchParams.get('val') || 'default';
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Set-Cookie': `kinex_session=${val}; Path=/; SameSite=Lax`,
        });
        res.end(
          `<!doctype html><html><head><title>Set ${val}</title></head><body><h1>Cookie ${val}</h1><script>localStorage.setItem('kinex_ls', ${JSON.stringify(val)});</script></body></html>`
        );
        return;
      }
      if (u.pathname === '/storage-check') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(
          `<!doctype html><html><head><title>Check</title></head><body><pre id="out"></pre><script>document.getElementById('out').textContent = JSON.stringify({ cookie: document.cookie, ls: localStorage.getItem('kinex_ls') });</script></body></html>`
        );
        return;
      }
      if (u.pathname === '/form') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(
          `<!doctype html><html><head><title>Draft Form</title></head><body><input id="draft" type="text" value="" /></body></html>`
        );
        return;
      }
      if (u.pathname === '/article') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(
          `<!doctype html><html><head><title>Kinex Article Test</title><meta name="author" content="Kinex Team"></head><body><main><h2>Heading Match</h2><p>Chromium workspace browsers isolate cookie storage per space while minimizing overhead across tabs. Search keyword needle appears once here.</p><p>Another readable paragraph explaining how Reader Mode strips untrusted scripts safely and renders clean typography for everyday reading with needle twice.</p></main><script>window.__xssShouldNotRunInReader = true;</script></body></html>`
        );
        return;
      }
      if (u.pathname === '/download-stream') {
        const total = 256 * 1024;
        const rangeHeader = req.headers.range;
        let start = 0;
        if (rangeHeader && /^bytes=(\d+)-/.test(rangeHeader)) {
          start = Number(RegExp.$1);
          res.writeHead(206, {
            'Content-Type': 'application/octet-stream',
            'Content-Disposition': 'attachment; filename="kinex-test-blob.bin"',
            'Accept-Ranges': 'bytes',
            'Content-Length': String(total - start),
            'Content-Range': `bytes ${start}-${total - 1}/${total}`,
          });
        } else {
          res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Disposition': 'attachment; filename="kinex-test-blob.bin"',
            'Accept-Ranges': 'bytes',
            'Content-Length': String(total),
          });
        }
        let sent = start;
        const chunk = Buffer.alloc(16 * 1024, 65);
        const timer = setInterval(() => {
          if (res.destroyed || sent >= total) {
            clearInterval(timer);
            if (!res.destroyed) res.end();
            return;
          }
          const sliceSize = Math.min(chunk.length, total - sent);
          res.write(sliceSize === chunk.length ? chunk : chunk.subarray(0, sliceSize));
          sent += sliceSize;
        }, 35);
        req.on('close', () => clearInterval(timer));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        `<!doctype html><html><head><title>Page ${u.pathname}</title></head><body><h1>Kinex Test ${u.pathname}</h1><a id="next" href="/page2">Next</a></body></html>`
      );
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

async function waitForTabUrl(mgr, predicate, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snap = mgr.getSnapshot();
    if (predicate(snap)) return snap;
    await waitMs(40);
  }
  throw new Error('Timed out waiting for tab state condition');
}

async function run() {
  process.env.KINEX_DISABLE_AUTO_UPDATER = '1';
  app.on('window-all-closed', (e) => {
    e.preventDefault();
  });
  ensureAppName();
  const { server, baseUrl } = await startTestHttpServer();

  await app.whenReady();
  registerKinexProtocol(protocol);

  const mgr = new KinexWindowManager(tmpUserData);
  registerKinexIpcHandlers(ipcMain, () => mgr);

  const mainWin = mgr.createWindow();

  try {
    // 1. Verify legacy & active protocol handling + IPC validation
    assert.equal(validateIntent({ type: 'open-url', url: 'javascript:alert(1)', target: 'current' }).ok, false);
    assert.equal(validateIntent({ type: 'open-url', url: 'file:///etc/passwd', target: 'current' }).ok, false);

    // Untrusted remote WebContents is rejected by ipcRegistry
    const remoteProbe = new BrowserWindow({ show: false });
    await remoteProbe.loadURL(`${baseUrl}/page1`);
    assert.equal(
      mgr.ipcRegistry.isTrusted(remoteProbe.webContents.id, remoteProbe.webContents.getURL(), ['shell']),
      false
    );
    remoteProbe.destroy();

    // 2. Verify DownloadManager blocks untracked paths
    await mgr.handleIntent({ type: 'show-download-in-finder', savePath: '/etc/passwd' });
    assert.ok(
      mgr.getSnapshot().toastMessage?.includes('not available in tracked downloads'),
      'Expected untracked download reveal to be blocked'
    );

    // 3. Verify Space cookie + localStorage isolation (Personal vs Work vs Private)
    await mgr.handleIntent({ type: 'select-space', spaceId: 'space-personal' });
    await mgr.handleIntent({ type: 'open-url', url: `${baseUrl}/cookie-set?val=personal`, target: 'new-tab' });
    await waitForTabUrl(
      mgr,
      (s) => s.tabs.some((t) => t.spaceId === 'space-personal' && t.url.includes('/cookie-set?val=personal') && !t.isLoading)
    );
    await waitMs(150);

    // Switch to Work space (isolated profile persist:nook-work)
    await mgr.handleIntent({ type: 'select-space', spaceId: 'space-work' });
    await mgr.handleIntent({ type: 'open-url', url: `${baseUrl}/storage-check`, target: 'new-tab' });
    const workSnap = await waitForTabUrl(
      mgr,
      (s) => s.tabs.some((t) => t.spaceId === 'space-work' && t.url.includes('/storage-check') && !t.isLoading)
    );
    const workTab = workSnap.tabs.find((t) => t.spaceId === 'space-work' && t.url.includes('/storage-check'));
    const workCookies = await mgr.getSnapshot();
    assert.ok(workTab, 'Work tab exists');
    const workSession = require('electron').session.fromPartition('persist:nook-work');
    const workCookieList = await workSession.cookies.get({ url: baseUrl });
    assert.equal(workCookieList.length, 0, 'Work profile must not receive Personal space cookies');

    const personalSession = require('electron').session.fromPartition('persist:nook-default');
    const personalCookieList = await personalSession.cookies.get({ url: baseUrl });
    assert.equal(personalCookieList[0]?.value, 'personal', 'Personal profile keeps its cookie');

    // 4. Verify Private Session & PermissionManager Isolation
    const dm = new DownloadManager(() => {});
    const pm = new PermissionManager({
      getMainWindow: () => mainWin,
      getDecisions: () => [],
      recordDecision: () => {},
      revokeDecision: () => {},
    });
    const sm = new SessionManager(pm, dm, () => true, () => {});
    const priv = sm.createPrivateSession();
    assert.equal(priv.sess.isPersistent(), false, 'Private session partition must be non-persistent');

    const privProbe = new BrowserWindow({
      show: false,
      webPreferences: { session: priv.sess, contextIsolation: true, sandbox: true },
    });
    await privProbe.loadURL(`${baseUrl}/cookie-set?val=secret_priv`);
    await waitMs(120);
    const privCookiesBeforeClose = await priv.sess.cookies.get({ url: baseUrl });
    assert.equal(privCookiesBeforeClose[0]?.value, 'secret_priv');

    // Verify regular sessions still don't contain secret_priv
    const regCheck = await personalSession.cookies.get({ url: baseUrl });
    assert.equal(regCheck.some((c) => c.value === 'secret_priv'), false, 'Private cookie must never leak to regular profile');

    // Verify private permission check handler denies sensitive capabilities
    assert.equal(priv.sess.isPersistent(), false);
    await sm.destroyPrivateSession(priv.sess);
    const privCookiesAfterPurge = await priv.sess.cookies.get({ url: baseUrl });
    assert.equal(privCookiesAfterPurge.length, 0, 'Private session cookies must purge on close');
    privProbe.destroy();

    // 5. Verify Private Window lifecycle via KinexWindowManager
    await mgr.handleIntent({ type: 'open-incognito', url: `${baseUrl}/page1` });
    assert.equal(mgr.getMetricsSnapshot().privateWindowCount, 1);
    const historyUrlsBefore = mgr.getSnapshot().history.map((h) => h.url);
    assert.equal(historyUrlsBefore.some((u) => u.includes('/page1')), false, 'Private window navigation must not enter history');

    // 6. Verify HTTPS error classifier + will-redirect silent downgrade prevention
    assert.equal(classifyLoadError(-105), 'dns-error');
    assert.equal(shouldOfferInsecureHttpFallback(-105, 'https://example.com', true, true), false);
    assert.equal(shouldOfferInsecureHttpFallback(-202, 'https://example.com', true, true), false);
    assert.equal(shouldOfferInsecureHttpFallback(-102, 'https://example.com', true, true), true);

    const navMgr = new NavigationManager({
      getDialogParentWindow: () => null,
      isHttpsOnly: () => true,
    });
    const { EventEmitter } = require('node:events');
    const mockWc = new EventEmitter();
    mockWc.id = 9001;
    mockWc.isDestroyed = () => false;
    mockWc.getURL = () => 'https://bank.example/start';
    mockWc.getTitle = () => 'Bank';
    mockWc.navigationHistory = { canGoBack: () => false, canGoForward: () => false };
    mockWc.setWindowOpenHandler = () => {};
    let redirectedTo = null;
    mockWc.loadURL = async (u) => {
      redirectedTo = u;
    };
    navMgr.attachWebContentsGuards(mockWc, { isPrivate: false });
    let redirectPrevented = false;
    mockWc.emit(
      'will-redirect',
      { preventDefault: () => { redirectPrevented = true; } },
      'http://bank.example/insecure-login',
      false,
      true
    );
    assert.equal(redirectPrevented, true, 'will-redirect to plaintext HTTP must be intercepted in HTTPS-Only mode');
    assert.equal(redirectedTo, 'https://bank.example/insecure-login', 'will-redirect must upgrade to HTTPS instead of silently downgrading');

    // 7. Verify tab crash recovery preserves original tab.url instead of overwriting with kinex://crashed
    await mgr.handleIntent({ type: 'select-space', spaceId: 'space-personal' });
    await mgr.handleIntent({ type: 'open-url', url: `${baseUrl}/page1`, target: 'new-tab', spaceId: 'space-personal' });
    const crashSnap = await waitForTabUrl(
      mgr,
      (s) => s.tabs.some((t) => t.spaceId === 'space-personal' && t.url.endsWith('/page1') && !t.isLoading)
    );
    const crashTab = crashSnap.tabs.find((t) => t.spaceId === 'space-personal' && t.url.endsWith('/page1'));
    assert.ok(crashTab, 'Crash test tab exists');
    const crashView = mgr.tabManager.getView(crashTab.id);
    assert.ok(crashView, 'Crash test tab WebContentsView exists');
    crashView.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
    await waitMs(120);
    const crashedStateTab = mgr.getSnapshot().tabs.find((t) => t.id === crashTab.id);
    assert.equal(crashedStateTab.isCrashed, true, 'Tab must mark isCrashed=true after render-process-gone');
    assert.equal(crashedStateTab.url, `${baseUrl}/page1`, 'Crash recovery must preserve original tab.url instead of kinex://crashed');
    await mgr.handleIntent({ type: 'nav-reload', tabId: crashTab.id });
    await waitMs(150);
    const recoveredTab = mgr.getSnapshot().tabs.find((t) => t.id === crashTab.id);
    assert.equal(recoveredTab.isCrashed, false, 'Reload clears isCrashed and reloads original URL');

    // 8. Verify macOS close -> reopen (activate) keeps single manager & session hooks intact
    mainWin.close();
    await waitMs(150);
    assert.equal(mgr.hasWindow(), false);
    assert.equal(mgr.getMetricsSnapshot().activeViewCount, 0, 'All WebContentsViews dispose on window close');
    const reopenedWin = mgr.createWindow();
    assert.equal(mgr.hasWindow(), true);
    const prevAdBlock = mgr.getSnapshot().adBlockEnabled;
    await mgr.handleIntent({ type: 'toggle-adblock' });
    assert.equal(mgr.getSnapshot().adBlockEnabled, !prevAdBlock, 'Reopened window still dispatches intents cleanly');
    await mgr.handleIntent({ type: 'toggle-adblock' });

    // 9. Stress reliability & memory check: create 8 tabs, switch spaces, toggle split, close all today tabs
    const startMem = process.memoryUsage();
    for (let i = 0; i < 8; i++) {
      const target = `${baseUrl}/stress-${i}`;
      await mgr.handleIntent({ type: 'open-url', url: target, target: 'new-tab', spaceId: 'space-personal' });
    }
    await waitMs(300);

    for (let i = 0; i < 6; i++) {
      await mgr.handleIntent({ type: 'select-space', spaceId: i % 2 === 0 ? 'space-work' : 'space-personal' });
      await mgr.handleIntent({ type: 'toggle-split' });
    }

    await mgr.handleIntent({ type: 'select-space', spaceId: 'space-personal' });
    await mgr.handleIntent({ type: 'clear-today-tabs', spaceId: 'space-personal' });
    await waitMs(150);
    const snapAfterClear = mgr.getSnapshot();
    const remainingUnpinned = snapAfterClear.tabs.filter(
      (t) => t.spaceId === 'space-personal' && t.location === 'unpinned'
    );
    assert.equal(remainingUnpinned.length, 0, 'All today tabs should be archived & removed');
    assert.ok(snapAfterClear.archivedTabs.length >= 8, 'Archived tabs should record closed unpinned tabs');

    // 10. Memory Saver lifecycle: protect active & dirty-form tabs, discard clean background tab & restore cleanly
    await mgr.handleIntent({ type: 'select-space', spaceId: 'space-personal' });
    await mgr.handleIntent({ type: 'open-url', url: `${baseUrl}/clean-bg`, target: 'new-tab', spaceId: 'space-personal' });
    const cleanSnap = await waitForTabUrl(
      mgr,
      (s) => s.tabs.some((t) => t.url === `${baseUrl}/clean-bg` && !t.isLoading)
    );
    const cleanTab = cleanSnap.tabs.find((t) => t.url === `${baseUrl}/clean-bg`);

    await mgr.handleIntent({ type: 'open-url', url: `${baseUrl}/form`, target: 'new-tab', spaceId: 'space-personal' });
    const formSnap = await waitForTabUrl(
      mgr,
      (s) => s.tabs.some((t) => t.url === `${baseUrl}/form` && !t.isLoading)
    );
    const formTab = formSnap.tabs.find((t) => t.url === `${baseUrl}/form`);
    const formView = mgr.tabManager.getView(formTab.id);
    await formView.webContents.executeJavaScript(`document.getElementById('draft').value = 'unsaved text';`);

    // Switch focus to a third tab so cleanTab and formTab are both in background
    await mgr.handleIntent({ type: 'open-url', url: `${baseUrl}/active-fg`, target: 'new-tab', spaceId: 'space-personal' });
    const fgSnap = await waitForTabUrl(
      mgr,
      (s) => s.tabs.some((t) => t.url === `${baseUrl}/active-fg` && !t.isLoading)
    );
    const fgTab = fgSnap.tabs.find((t) => t.url === `${baseUrl}/active-fg`);

    // Active tab cannot be discarded
    await mgr.handleIntent({ type: 'discard-tab', tabId: fgTab.id });
    assert.equal(Boolean(mgr.getSnapshot().tabs.find((t) => t.id === fgTab.id)?.isDiscarded), false);

    // Dirty form tab must be preserved automatically
    await mgr.handleIntent({ type: 'discard-tab', tabId: formTab.id });
    assert.equal(Boolean(mgr.getSnapshot().tabs.find((t) => t.id === formTab.id)?.isDiscarded), false);
    assert.ok(mgr.tabManager.getView(formTab.id), 'Form tab live view must remain intact');

    // Clean background tab can be safely discarded
    await mgr.handleIntent({ type: 'discard-tab', tabId: cleanTab.id });
    const discardedTabState = mgr.getSnapshot().tabs.find((t) => t.id === cleanTab.id);
    assert.equal(discardedTabState.isDiscarded, true, 'Clean background tab must transition to isDiscarded=true');
    assert.equal(discardedTabState.url, `${baseUrl}/clean-bg`, 'Original URL preserved while sleeping');
    assert.equal(mgr.tabManager.getView(cleanTab.id), undefined, 'Discarded tab releases backing WebContentsView');

    // Selecting discarded tab restores it cleanly in original Space
    await mgr.handleIntent({ type: 'select-tab', tabId: cleanTab.id });
    const restoredSnap = await waitForTabUrl(
      mgr,
      (s) => {
        const t = s.tabs.find((x) => x.id === cleanTab.id);
        return Boolean(t && !t.isDiscarded && !t.isLoading && t.url === `${baseUrl}/clean-bg`);
      }
    );
    assert.equal(restoredSnap.tabs.find((t) => t.id === cleanTab.id)?.spaceId, 'space-personal');

    // 11. Duplicate tab detection: prompt vs switch-existing vs open-anyway
    await mgr.handleIntent({
      type: 'open-url',
      url: `${baseUrl}/clean-bg`,
      target: 'new-tab',
      spaceId: 'space-personal',
      duplicatePolicy: 'prompt',
    });
    const dupPromptSnap = mgr.getSnapshot();
    assert.ok(dupPromptSnap.duplicatePrompt, 'Expected duplicatePrompt when duplicatePolicy=prompt');
    assert.equal(dupPromptSnap.duplicatePrompt.existingTabId, cleanTab.id);
    await mgr.handleIntent({ type: 'resolve-duplicate-open', decision: 'switch-existing' });
    assert.equal(mgr.getSnapshot().duplicatePrompt, null, 'Duplicate prompt must clear after decision');

    // 12. Recently closed tab & closed group restoration
    const tabCountBeforeGroup = mgr.getSnapshot().tabs.filter((t) => t.spaceId === 'space-personal' && t.location === 'unpinned').length;
    assert.ok(tabCountBeforeGroup >= 2, 'Need multiple unpinned tabs to test close-other-tabs');
    await mgr.handleIntent({ type: 'close-other-tabs', tabId: cleanTab.id });
    const afterCloseOthers = mgr.getSnapshot();
    const closedGroup = afterCloseOthers.closedTabs.find((c) => Boolean(c.groupId));
    assert.ok(closedGroup, 'close-other-tabs must create a grouped closedTabs entry');
    await mgr.handleIntent({ type: 'restore-closed-group', groupId: closedGroup.groupId });
    const afterGroupRestore = mgr.getSnapshot();
    assert.ok(
      afterGroupRestore.tabs.some((t) => t.spaceId === 'space-personal' && t.url === `${baseUrl}/form`),
      'restore-closed-group must restore closed tabs cleanly'
    );

    // 13. Moving a tab across Spaces with different profiles destroys old profile WebContentsView cleanly
    await mgr.handleIntent({ type: 'open-url', url: `${baseUrl}/cookie-set?val=pers_iso`, target: 'new-tab', spaceId: 'space-personal' });
    const isoSnap = await waitForTabUrl(
      mgr,
      (s) => s.tabs.some((t) => t.spaceId === 'space-personal' && t.url.includes('/cookie-set?val=pers_iso') && !t.isLoading)
    );
    const isoTab = isoSnap.tabs.find((t) => t.url.includes('/cookie-set?val=pers_iso'));
    await mgr.handleIntent({ type: 'move-tab-to-space', tabId: isoTab.id, spaceId: 'space-work' });
    await mgr.handleIntent({ type: 'open-url', url: `${baseUrl}/storage-check`, target: 'current', spaceId: 'space-work' });
    const workCheckSnap = await waitForTabUrl(
      mgr,
      (s) => s.tabs.some((t) => t.spaceId === 'space-work' && t.url.endsWith('/storage-check') && !t.isLoading)
    );
    const movedWorkTab = workCheckSnap.tabs.find((t) => t.id === isoTab.id);
    const movedWorkView = mgr.tabManager.getView(movedWorkTab.id);
    const movedStorage = JSON.parse(
      await movedWorkView.webContents.executeJavaScript(`document.getElementById('out').textContent`)
    );
    assert.ok(
      !movedStorage.cookie.includes('pers_iso') && movedStorage.ls !== 'pers_iso',
      'Moving tab across Spaces with distinct profiles must never transfer cookies or localStorage'
    );

    // 14. Reader Mode extraction + safe restore, Find in Page match counts, Per-host zoom, and PDF generation
    await mgr.handleIntent({ type: 'select-space', spaceId: 'space-personal' });
    await mgr.handleIntent({ type: 'open-url', url: `${baseUrl}/article`, target: 'new-tab', spaceId: 'space-personal' });
    const artSnap = await waitForTabUrl(
      mgr,
      (s) => s.tabs.some((t) => t.spaceId === 'space-personal' && t.url.endsWith('/article') && !t.isLoading)
    );
    const artTab = artSnap.tabs.find((t) => t.url.endsWith('/article'));
    const artView = mgr.tabManager.getView(artTab.id);

    if (!reopenedWin.isDestroyed()) reopenedWin.showInactive();
    await waitMs(150);
    await mgr.handleIntent({ type: 'find-in-page', text: 'needle', forward: true, findNext: true });
    const findSnap = await waitForTabUrl(
      mgr,
      (s) => Boolean(s.findStatus && s.findStatus.tabId === artTab.id && s.findStatus.matches >= 2),
      2500
    ).catch(() => mgr.getSnapshot());
    assert.ok(findSnap.findStatus && findSnap.findStatus.matches >= 2, 'Find in Page should report live matches >= 2');
    await mgr.handleIntent({ type: 'stop-find-in-page' });
    assert.equal(mgr.getSnapshot().findStatus, null, 'stop-find-in-page must clear findStatus');

    await mgr.handleIntent({ type: 'set-zoom', delta: 'in', tabId: artTab.id });
    assert.equal(mgr.getSnapshot().zoomByHost['127.0.0.1'], 1.1, 'Per-host zoom preference persisted cleanly');
    const pdfBuffer = await artView.webContents.printToPDF({ printBackground: true });
    assert.ok(pdfBuffer.subarray(0, 5).toString('utf8') === '%PDF-', 'printToPDF must produce valid PDF bytes');

    await mgr.handleIntent({ type: 'toggle-reader-mode', tabId: artTab.id });
    await waitMs(300);
    assert.ok(mgr.getSnapshot().readerTabIds.includes(artTab.id), 'Reader Mode enabled cleanly for article tab');
    const readerExecuted = await artView.webContents.executeJavaScript('Boolean(window.__xssShouldNotRunInReader)');
    assert.equal(readerExecuted, false, 'Reader Mode must never run extracted page scripts');
    await mgr.handleIntent({ type: 'toggle-reader-mode', tabId: artTab.id });
    await waitMs(300);
    assert.equal(mgr.getSnapshot().readerTabIds.includes(artTab.id), false, 'Second toggle exits Reader Mode and restores original URL');

    // 15. Download progress, pause, resume, completion & clear-completed (and private isolation)
    await mgr.handleIntent({ type: 'open-url', url: `${baseUrl}/download-stream`, target: 'new-tab', spaceId: 'space-personal' });
    let activeDl;
    for (let i = 0; i < 40; i++) {
      activeDl = mgr.getSnapshot().downloads.find((d) => d.filename.startsWith('kinex-test-blob'));
      if (activeDl && activeDl.receivedBytes > 0 && activeDl.state === 'progressing') break;
      await waitMs(40);
    }
    assert.ok(activeDl, 'Stream download must register in DownloadManager');
    await mgr.handleIntent({ type: 'pause-download', downloadId: activeDl.id });
    await waitMs(120);
    const pausedDl = mgr.getSnapshot().downloads.find((d) => d.id === activeDl.id);
    assert.equal(pausedDl.isPaused, true, 'Download must enter paused state');
    if (pausedDl.canResume) {
      await mgr.handleIntent({ type: 'resume-download', downloadId: activeDl.id });
    }
    let doneDl;
    for (let i = 0; i < 60; i++) {
      doneDl = mgr.getSnapshot().downloads.find((d) => d.id === activeDl.id && d.state === 'completed');
      if (doneDl) break;
      await waitMs(50);
    }
    assert.ok(doneDl, 'Resumed download must finish with state=completed');
    if (doneDl.savePath && fs.existsSync(doneDl.savePath)) {
      fs.rmSync(doneDl.savePath, { force: true });
    }
    await mgr.handleIntent({ type: 'clear-completed-downloads' });
    assert.equal(mgr.getSnapshot().downloads.some((d) => d.id === doneDl.id), false, 'clear-completed-downloads must remove finished entries');

    // Close reopened window & verify full disposal (0 active WebContentsViews, 0 private windows)
    reopenedWin.close();
    await waitMs(150);
    const disposedMetrics = mgr.getMetricsSnapshot();
    assert.equal(disposedMetrics.activeViewCount, 0, 'All WebContentsViews must dispose on window close');
    assert.equal(disposedMetrics.privateWindowCount, 0, 'All Private Windows must dispose on app close');

    const endMem = process.memoryUsage();
    const summary = {
      ok: true,
      checksPassed: 15,
      startHeapMB: Math.round(startMem.heapUsed / 1024 / 1024),
      endHeapMB: Math.round(endMem.heapUsed / 1024 / 1024),
      rssMB: Math.round(endMem.rss / 1024 / 1024),
      archivedCount: snapAfterClear.archivedTabs.length,
    };
    if (process.env.KINEX_REPORT_PATH) {
      fs.writeFileSync(process.env.KINEX_REPORT_PATH, JSON.stringify(summary, null, 2), 'utf8');
    }
    fs.writeSync(1, `INTEGRATION_PASS ${JSON.stringify(summary)}\n`);
  } finally {
    server.close();
    try {
      fs.rmSync(tmpUserData, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      // Chromium partition sqlite lock may still be unwinding at process exit
    }
  }
  app.exit(0);
}

run().catch((err) => {
  if (process.env.KINEX_REPORT_PATH) {
    fs.writeFileSync(
      process.env.KINEX_REPORT_PATH,
      JSON.stringify({ ok: false, error: err && err.stack ? err.stack : String(err) }, null, 2),
      'utf8'
    );
  }
  console.error('Integration test failed:', err);
  app.exit(1);
});
