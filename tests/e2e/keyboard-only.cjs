const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { app, ipcMain, protocol, webContents, Menu } = require('electron');

const outDir = path.resolve(process.argv.find((argument) => argument.startsWith('--out='))?.slice(6) || path.join(os.tmpdir(), 'kinex-keyboard-results'));
const userDataDir = process.env.KINEX_QUALITY_USER_DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'kinex-keyboard-'));
app.setPath('userData', userDataDir);
process.env.KINEX_DISABLE_AUTO_UPDATER = '1';
protocol.registerSchemesAsPrivileged(['kinex', 'nook'].map((scheme) => ({
  scheme, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
})));
const { KinexWindowManager, ensureAppName, registerKinexProtocol } = require('../../dist-electron/main/windowManager');
const { registerKinexIpcHandlers } = require('../../dist-electron/main/ipcHandlers');
const { createDefaultPersistedData } = require('../../dist-electron/shared/domain');

const report = {
  timestamp: new Date().toISOString(),
  ok: false,
  steps: [],
  input: { keyboardEvents: 0, mouseEvents: 0, transcript: [] },
  methodology: 'Only focused WebContents.sendInputEvent keyDown/char/keyUp events mutate UI during acceptance. Snapshot and executeJavaScript reads assert outcomes. No clicks, scripted focus, hidden dispatch or test-only app commands.',
  limitations: [
    'Deterministic local article fixture and disposable profile; arbitrary website keyboard behavior is outside this acceptance.',
    'Native context menu opening is observed; OS-level native menu traversal is not simulated by Chromium input events.',
  ],
};
let manager;
let win;
let server;
let actionNumber = 0;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function bounded(promise, label, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), timeoutMs);
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}
async function until(check, label, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  do {
    try { const result = await check(); if (result) return result; } catch (error) { lastError = error; }
    await delay(20);
  } while (Date.now() < deadline);
  throw new Error(`Timed out: ${label}${lastError ? ` (${lastError.message})` : ''}`);
}
const read = (wc, expression) => bounded(wc.executeJavaScript(expression), 'read-only renderer assertion');
const snapshot = () => manager.getSnapshot();
function focusedTab() {
  const state = snapshot();
  const split = state.splitsBySpace[state.activeSpaceId];
  return state.tabs.find((tab) => tab.id === split.tabIds[split.focusedIndex]);
}
async function currentContents() {
  const current = await until(() => webContents.getFocusedWebContents(), 'native focus before inspection', 1500);
  assert.ok(current && !current.isDestroyed(), 'Keyboard input requires an actually focused WebContents');
  return current;
}
async function key(keyCode, modifiers = []) {
  keyCode = keyCode.replace(/^Arrow/, '');
  if (/^[a-z]$/i.test(keyCode)) keyCode = keyCode.toUpperCase();
  const waitingAt = performance.now();
  const current = await until(() => webContents.getFocusedWebContents(), 'native keyboard focus before input', 1500);
  report.input.transcript.push({ step: actionNumber, webContentsId: current.id, key: keyCode, modifiers, focusWaitMs: performance.now() - waitingAt });
  current.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  report.input.keyboardEvents++;
  if (keyCode === 'Enter') {
    current.sendInputEvent({ type: 'char', keyCode: '\r', modifiers });
    report.input.keyboardEvents++;
  }
  current.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  report.input.keyboardEvents++;
  await delay(20);
}
async function type(text) {
  for (const character of text) {
    const current = await currentContents();
    current.sendInputEvent({ type: 'keyDown', keyCode: character });
    current.sendInputEvent({ type: 'char', keyCode: character });
    current.sendInputEvent({ type: 'keyUp', keyCode: character });
    report.input.keyboardEvents += 3;
  }
  report.input.transcript.push({ step: actionNumber, type: text });
  await delay(35);
}
async function clearTextField() {
  const wc = await currentContents();
  const value = await read(wc, 'document.activeElement?.value');
  assert.equal(typeof value, 'string', 'Text replacement requires a focused text field');
  await key('End');
  for (let index = 0; index < value.length; index++) await key('Backspace');
  await until(() => read(wc, 'document.activeElement?.value === ""'), 'Backspace cleared text field');
}
async function activeMatches(wc, selector) {
  return read(wc, `Boolean(document.activeElement?.matches(${JSON.stringify(selector)}))`);
}
async function tabTo(selector, wc = manager.shellView.webContents) {
  for (let count = 0; count < 100; count++) {
    if ((await currentContents()).id === wc.id && await activeMatches(wc, selector)) return;
    await key('Tab');
  }
  throw new Error(`Could not reach ${selector} with Tab`);
}
async function palette(query, execute = true) {
  await key('t', ['meta']);
  await until(() => snapshot().overlay.mode === 'command-bar', 'Command Bar opened by Cmd+T');
  const wc = manager.overlayView.webContents;
  await until(async () => (await currentContents()).id === wc.id && await activeMatches(wc, '.command-input'), 'Command Bar native and DOM input focus');
  await clearTextField();
  await type(query);
  await until(() => read(wc, `document.querySelector('.command-input')?.value === ${JSON.stringify(query)}`), 'query typed');
  if (execute) {
    await until(() => read(wc, `Boolean(document.querySelector('.command-item.selected'))`), 'selected command result');
    await key('Enter');
  }
}
async function command(title) {
  await palette(title, false);
  const wc = manager.overlayView.webContents;
  await until(() => read(wc, `Boolean([...document.querySelectorAll('.command-item')].find(el => el.querySelector('.command-item-title')?.textContent?.trim() === ${JSON.stringify(title)}))`), `command ${title} exists`);
  const count = await read(wc, 'document.querySelectorAll(".command-item").length');
  for (let index = 0; index <= count; index++) {
    const selected = await read(wc, 'document.querySelector(".command-item.selected .command-item-title")?.textContent?.trim()');
    if (selected === title) { await key('Enter'); return; }
    await key('ArrowDown');
  }
  throw new Error(`Could not select command ${title} with arrow keys`);
}
async function closeOverlay() {
  await key('Escape');
  await until(() => snapshot().overlay.mode === 'none', 'Escape closed overlay');
  await until(async () => (await currentContents()).id !== manager.overlayView?.webContents.id, 'focus leaves closed overlay');
}
async function step(number, name, work) {
  actionNumber = number;
  const started = performance.now();
  try {
    const evidence = await work();
    report.steps.push({ number, name, status: 'passed', durationMs: performance.now() - started, evidence: evidence ?? null });
    console.log(`PASS ${number}: ${name}`);
  } catch (error) {
    const diagnostics = {};
    for (const [region, wc] of [['shell', manager?.shellView?.webContents], ['overlay', manager?.overlayView?.webContents]]) {
      if (!wc || wc.isDestroyed()) continue;
      diagnostics[region] = await read(wc, `(() => ({ focused: document.hasFocus(), active: document.activeElement?.outerHTML?.slice(0, 600), input: document.querySelector('.command-input')?.value, selection: [document.querySelector('.command-input')?.selectionStart, document.querySelector('.command-input')?.selectionEnd] }))()`).catch((cause) => cause.message);
    }
    report.steps.push({ number, name, status: 'failed', durationMs: performance.now() - started, error: error.stack ?? error.message, diagnostics });
    throw error;
  }
}
function startFixture() {
  return new Promise((resolve, reject) => {
    server = http.createServer((request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><html><head><title>Keyboard Article ${request.url}</title><meta name="author" content="Kinex QA"></head><body><main><h1>Keyboard-first browsing</h1>${'<p>A readable local article lets this acceptance test exercise real Chromium navigation, focus, and Reader Mode without relying on a remote service. Browser commands remain available while ordinary page typing reaches the website.</p>'.repeat(12)}<label for="draft">Article note</label><input id="draft" autocomplete="off"><a href="/article-next">Next article</a></main></body></html>`);
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

async function run() {
  const watchdog = setTimeout(() => { report.fatalError = 'Keyboard harness exceeded 140 seconds'; finish(1); }, 140000);
  try {
    ensureAppName();
    const baseUrl = await startFixture();
    const defaults = createDefaultPersistedData();
    defaults.tabs = defaults.tabs.filter((tab) => tab.url.startsWith('kinex://')).slice(0, 1);
    const initial = defaults.tabs[0];
    assert.ok(initial, 'Default data must provide an initial internal tab');
    defaults.spaces = defaults.spaces.slice(0, 2);
    defaults.activeSpaceId = initial.spaceId;
    defaults.splitsBySpace = Object.fromEntries(defaults.spaces.map((space) => [space.id, {
      tabIds: defaults.tabs.filter((tab) => tab.spaceId === space.id).map((tab) => tab.id), focusedIndex: 0, splitRatio: 0.5,
    }]));
    defaults.folders = [];
    fs.writeFileSync(path.join(userDataDir, 'kinex-state.json'), JSON.stringify(defaults));
    await app.whenReady();
    registerKinexProtocol(protocol);
    manager = new KinexWindowManager(userDataDir);
    registerKinexIpcHandlers(ipcMain, () => manager);
    let firstTabId;
    let secondTabId;
    let createdSpaceId;
    await step(1, 'Launch Kinex', async () => {
      win = manager.createWindow();
      win.setSize(1360, 860);
      await until(() => read(manager.shellView.webContents, 'Boolean(document.querySelector(".kinex-shell"))'), 'shell ready');
      await until(() => win.isVisible(), 'native window shown');
      app.focus({ steal: true });
      win.focus();
      await until(() => Boolean(webContents.getFocusedWebContents()), 'initial native focus');
      return { version: snapshot().appVersion, initialTabs: snapshot().tabs.length };
    });
    await step(2, 'Open a new tab through Cmd+T', async () => {
      await key('t', ['meta']);
      await until(() => snapshot().overlay.mode === 'command-bar', 'new-tab Command Bar');
      await until(() => activeMatches(manager.overlayView.webContents, '.command-input'), 'input ready during entrance');
    });
    await step(3, 'Navigate to a local article URL', async () => {
      await type(`${baseUrl}/article-one`);
      await key('Enter');
      const tab = await until(() => snapshot().tabs.find((tab) => tab.url === `${baseUrl}/article-one` && !tab.isLoading), 'first real navigation');
      firstTabId = tab.id;
      assert.equal(focusedTab().id, tab.id);
      return { url: tab.url };
    });
    await step(4, 'Open another tab', async () => {
      await palette(`${baseUrl}/article-two`);
      const tab = await until(() => snapshot().tabs.find((tab) => tab.url === `${baseUrl}/article-two` && !tab.isLoading), 'second real navigation');
      secondTabId = tab.id;
      return { url: tab.url };
    });
    await step(5, 'Switch tabs with Ctrl+Shift+Tab', async () => {
      await key('Tab', ['control', 'shift']);
      await until(() => focusedTab()?.id === firstTabId, 'previous tab selected');
      return { tabId: focusedTab().id };
    });
    await step(6, 'Pin a tab', async () => {
      await command('Pin / Unpin Tab');
      await until(() => snapshot().tabs.find((tab) => tab.id === firstTabId)?.location === 'pinned', 'tab pinned');
    });
    await step(7, 'Move the tab to Work', async () => {
      await command('Move Tab to Work');
      await until(() => snapshot().tabs.find((tab) => tab.id === firstTabId)?.spaceId === 'space-work', 'tab moved');
      assert.equal(snapshot().activeSpaceId, 'space-work');
    });
    await step(8, 'Create a Space', async () => {
      await command('New Space');
      await until(() => activeMatches(manager.overlayView.webContents, 'input[aria-label="Space Name"]'), 'new Space name focus');
      await type('Keyboard Lab');
      await key('Enter');
      const space = await until(() => snapshot().spaces.find((space) => space.name === 'Keyboard Lab'), 'Space creation');
      createdSpaceId = space.id;
      assert.equal(snapshot().activeSpaceId, space.id);
    });
    await step(9, 'Rename the Space', async () => {
      await command('Rename Space');
      await until(() => activeMatches(manager.overlayView.webContents, 'input[aria-label="Space Name"]'), 'edit Space name focus');
      await clearTextField();
      await type('Keyboard Studio');
      await key('Enter');
      await until(() => snapshot().spaces.find((space) => space.id === createdSpaceId)?.name === 'Keyboard Studio', 'Space rename');
    });
    await step(10, 'Open Split View', async () => {
      await command('Toggle Split View');
      await until(() => snapshot().splitsBySpace[createdSpaceId]?.tabIds.length === 2, 'two native panes');
    });
    await step(11, 'Adjust the split divider through keyboard', async () => {
      await command('Focus Toolbar');
      await tabTo('[role="separator"][aria-label="Resize Split View"]');
      const before = snapshot().splitsBySpace[createdSpaceId].splitRatio;
      await key('ArrowRight');
      await until(() => snapshot().splitsBySpace[createdSpaceId].splitRatio > before, 'split ratio changed');
      return { before, after: snapshot().splitsBySpace[createdSpaceId].splitRatio };
    });
    await step(12, 'Open the Command Bar from browser UI', async () => {
      await key('t', ['meta']);
      await until(() => activeMatches(manager.overlayView.webContents, '.command-input'), 'palette focus from shell');
    });
    await step(13, 'Find and select a command with keyboard', async () => {
      await type('Open Settings');
      await until(() => read(manager.overlayView.webContents, 'document.querySelector(".command-item.selected .command-item-title")?.textContent?.trim() === "Open Settings"'), 'Settings command selected');
    });
    await step(14, 'Open Settings', async () => {
      await key('Enter');
      await until(() => snapshot().overlay.mode === 'settings', 'Settings shown');
      assert.equal((await currentContents()).id, manager.overlayView.webContents.id);
    });
    await step(15, 'Change a setting without a mouse', async () => {
      const before = snapshot().cleanCopyUrl;
      await tabTo('input[aria-label="Clean Copy URL"]', manager.overlayView.webContents);
      await key('Space');
      await until(() => snapshot().cleanCopyUrl !== before, 'setting toggled with Space');
      return { setting: 'cleanCopyUrl', before, after: snapshot().cleanCopyUrl };
    });
    await step(16, 'Open Downloads', async () => {
      await closeOverlay();
      await command('Open Downloads');
      await until(() => snapshot().overlay.mode === 'downloads', 'Downloads opened');
      await closeOverlay();
    });
    await step(17, 'Open Reader Mode', async () => {
      await key('l', ['meta']);
      await until(() => activeMatches(manager.overlayView.webContents, '.command-input'), 'address editing focus');
      await clearTextField();
      await type(`${baseUrl}/article-reader`);
      await key('Enter');
      await until(() => focusedTab()?.url === `${baseUrl}/article-reader` && !focusedTab()?.isLoading, 'article in focused pane');
      const tabId = focusedTab().id;
      await command('Open / Close Reader Mode');
      await until(() => snapshot().readerTabIds.includes(tabId), 'Reader Mode active');
      const view = manager.tabManager.getView(tabId);
      await until(() => read(view.webContents, 'Boolean(document.querySelector("article"))'), 'Reader article painted');
      await command('Open / Close Reader Mode');
      await until(() => focusedTab()?.url === `${baseUrl}/article-reader` && !focusedTab()?.isLoading, 'Reader Mode exits to original URL');
      return { readerEntered: true, originalUrlRestored: true };
    });
    let closedId;
    await step(18, 'Close a tab', async () => {
      closedId = focusedTab().id;
      await key('w', ['meta']);
      await until(() => !snapshot().tabs.some((tab) => tab.id === closedId), 'tab closed');
    });
    await step(19, 'Restore the closed tab', async () => {
      await key('t', ['meta', 'shift']);
      await until(() => focusedTab()?.url === `${baseUrl}/article-reader` && !focusedTab()?.isLoading, 'tab restored');
    });
    await step(20, 'Return focus to website content', async () => {
      await command('Focus Website Content');
      const view = manager.tabManager.getView(focusedTab().id);
      await until(async () => (await currentContents()).id === view.webContents.id, 'real native website focus');
      await key('Tab');
      await until(() => activeMatches(view.webContents, '#draft'), 'website receives Tab');
      await type('ordinary typing');
      assert.equal(await read(view.webContents, 'document.querySelector("#draft").value'), 'ordinary typing');
      assert.equal(snapshot().overlay.mode, 'none', 'Plain website typing must not open an app overlay');
      return { webContentsId: view.webContents.id, websiteTypingPreserved: true };
    });

    await step(21, 'Modal focus traps forward and reverse Tab; Escape restores native focus', async () => {
      await command('Open Settings');
      const overlay = manager.overlayView.webContents;
      const selector = 'button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],[tabindex]:not([tabindex="-1"])';
      const count = await read(overlay, `Array.from(document.querySelector('[role="dialog"]').querySelectorAll(${JSON.stringify(selector)})).filter(el => el.tabIndex >= 0 && el.getClientRects().length && !el.closest('[inert]')).length`);
      assert.ok(count > 5, 'Settings must have real focusable controls');
      for (const modifiers of [[], ['shift']]) {
        for (let index = 0; index <= count; index++) {
          await key('Tab', modifiers);
          assert.equal(await read(overlay, 'Boolean(document.activeElement?.closest("[role=dialog]"))'), true, 'Tab focus stays inside Settings');
          assert.equal((await currentContents()).id, overlay.id);
        }
      }
      await closeOverlay();
      assert.notEqual((await currentContents()).id, overlay.id, 'Closed overlay must release native focus');
      return { forwardAndReverseCycles: 2, focusableControls: count };
    });
    await step(22, 'Sidebar roving arrows, reorder alternative and F6 return path', async () => {
      await key('F6');
      const shell = manager.shellView.webContents;
      await until(() => activeMatches(shell, '[data-sidebar-item]'), 'sidebar item focus');
      const before = await read(shell, 'document.activeElement.dataset.sidebarItem');
      await key('ArrowDown');
      const after = await read(shell, 'document.activeElement.dataset.sidebarItem');
      assert.notEqual(after, before, 'ArrowDown reaches the next sidebar item');
      const selectedId = await read(shell, 'document.activeElement.dataset.tabId');
      const selected = snapshot().tabs.find((tab) => tab.id === selectedId);
      const siblings = snapshot().tabs.filter((tab) => tab.spaceId === selected.spaceId && tab.location === selected.location && tab.folderId === selected.folderId);
      assert.ok(siblings.length > 1, 'Reorder check needs sibling tabs');
      const orderBefore = siblings.map((tab) => tab.id);
      await key(orderBefore.indexOf(selectedId) === 0 ? 'ArrowDown' : 'ArrowUp', ['alt']);
      await until(() => snapshot().tabs.filter((tab) => orderBefore.includes(tab.id)).map((tab) => tab.id).join() !== orderBefore.join(), 'keyboard reorder changes actual tab order');
      await key('Enter');
      await until(async () => (await currentContents()).id !== shell.id, 'Enter activates sidebar tab');
      await key('F6');
      await until(async () => (await currentContents()).id === shell.id, 'F6 returns from remote page to browser UI');
      assert.equal(await activeMatches(shell, '[data-sidebar-item]'), true);
      await command('Focus Website Content');
      return { before, after, orderBefore, orderAfter: snapshot().tabs.filter((tab) => orderBefore.includes(tab.id)).map((tab) => tab.id), f6FromWebsite: true };
    });
    await step(23, 'Reduced Motion disables overlay movement and completes closing lifecycle', async () => {
      await palette('', false);
      const overlay = manager.overlayView.webContents;
      overlay.debugger.attach('1.3');
      try {
        await overlay.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
        assert.equal(await read(overlay, 'matchMedia("(prefers-reduced-motion: reduce)").matches'), true);
        const motion = await read(overlay, `(() => { const el = document.querySelector('.command-bar'); const style = getComputedStyle(el); return { animationDuration: style.animationDuration, transitionDuration: style.transitionDuration }; })()`);
        assert.ok(motion.animationDuration.split(',').every(value => parseFloat(value) <= 0.01), 'Reduced Motion removes panel animations');
        await closeOverlay();
        await until(() => read(overlay, '!document.querySelector(".overlay-backdrop")'), 'closing overlay unmounted');
        return motion;
      } finally {
        if (overlay.debugger.isAttached()) overlay.debugger.detach();
      }
    });
    await step(24, 'Element Zapper selects, confirms and cancels through keyboard', async () => {
      await key('l', ['meta']);
      await until(() => activeMatches(manager.overlayView.webContents, '.command-input'), 'address editing for zapper fixture');
      await clearTextField();
      await type(`${baseUrl}/article-zapper`);
      await key('Enter');
      await until(() => focusedTab()?.url === `${baseUrl}/article-zapper` && !focusedTab()?.isLoading, 'zapper fixture loaded');
      const tabId = focusedTab().id;
      const page = manager.tabManager.getView(tabId).webContents;
      async function startZapper() {
        await command('Open Boosts Studio');
        await tabTo('.modal-header .btn-secondary', manager.overlayView.webContents);
        await key('Enter');
        await until(() => snapshot().zapperActiveTabId === tabId, 'zapper active');
        await until(async () => (await currentContents()).id === page.id, 'zapper receives native page focus');
      }
      await startZapper();
      await key('Tab');
      await key('ArrowDown');
      await key('Enter');
      const boost = await until(() => snapshot().boosts.find((boost) => boost.zappedSelectors.length > 0), 'keyboard selector persisted');
      await until(() => read(page, 'getComputedStyle(document.querySelector("h1")).display === "none"'), 'selected heading hidden by saved Boost');
      const count = boost.zappedSelectors.length;
      await startZapper();
      await key('Escape');
      await until(() => snapshot().zapperActiveTabId === null, 'Escape cancelled zapper');
      assert.equal(snapshot().boosts.find((item) => item.id === boost.id).zappedSelectors.length, count, 'Cancel must not add a selector');
      return { selector: boost.zappedSelectors[0], confirmedAndCancelled: true };
    });
    await step(25, 'Open the real native tab context menu from keyboard', async () => {
      await command('Focus Sidebar');
      const shell = manager.shellView.webContents;
      await until(() => activeMatches(shell, '[data-sidebar-item][data-tab-id]'), 'tab row context-menu focus');
      let menuShown = false;
      let shownMenu = null;
      const popup = Menu.prototype.popup;
      Menu.prototype.popup = function (...args) {
        shownMenu = this;
        this.once('menu-will-show', () => {
          menuShown = true;
          setImmediate(() => {
            try { shownMenu?.closePopup?.(win); } catch {}
          });
        });
        return popup.apply(this, args);
      };
      try {
        await key('F10', ['shift']);
        await until(() => menuShown, 'native menu-will-show from Shift+F10');
        return { nativeMenuShown: true, osMenuTraversal: 'not-tested' };
      } finally {
        try { shownMenu?.closePopup?.(win); } catch {}
        Menu.prototype.popup = popup;
      }
    });
    report.ok = true;
  } catch (error) {
    report.fatalError = error.stack ?? error.message;
  } finally {
    clearTimeout(watchdog);
    await finish(report.ok ? 0 : 1);
  }
}
let finishing = false;
async function finish(code) {
  if (finishing) return;
  finishing = true;
  if (manager) report.finalState = { tabs: snapshot().tabs.length, spaces: snapshot().spaces.map(({ id, name }) => ({ id, name })), overlay: snapshot().overlay.mode };
  manager?.dispose();
  if (win && !win.isDestroyed()) {
    try { win.destroy(); } catch {}
  }
  server?.closeAllConnections();
  await new Promise((resolve) => server ? server.close(resolve) : resolve());
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'keyboard-results.json'), JSON.stringify(report, null, 2));
  console.log(`Keyboard acceptance ${report.ok ? 'PASSED' : 'FAILED'}: ${report.steps.length} completed assertions, ${report.input.keyboardEvents} keyboard events, no mouse events.`);
  app.exit(code);
}
run().catch((error) => { report.fatalError = error.stack; finish(1); });
