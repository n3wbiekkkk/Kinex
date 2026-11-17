const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, ipcMain, protocol } = require('electron');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'kinex-windows-'));
app.setPath('userData', userData);
protocol.registerSchemesAsPrivileged(['kinex', 'nook'].map((scheme) => ({
  scheme,
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
})));

const { KinexWindowManager, ensureAppName, registerKinexProtocol } = require('../../dist-electron/main/windowManager');
const { registerKinexIpcHandlers } = require('../../dist-electron/main/ipcHandlers');
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

async function run() {
  ensureAppName();
  app.on('window-all-closed', (event) => event.preventDefault());
  await app.whenReady();
  registerKinexProtocol(protocol);

  let mgr = new KinexWindowManager(userData);
  let mgrDisposed = false;
  registerKinexIpcHandlers(ipcMain, () => mgr);
  try {
    const first = mgr.createWindow();
    await until(() => first.isVisible(), 'first window visible');
    assert.equal(mgr.getWindowCount(), 1);
    await mgr.handleIntent({ type: 'run-command', commandId: 'new-window' });
    await until(() => mgr.getWindowCount() === 2, 'second window created');
    const second = [...mgr.contexts.values()].find((c) => c.win !== first).win;
    await until(() => second.isVisible(), 'second window visible');

    const states = mgr.getSnapshot().windows;
    assert.equal(states.length, 2);
    assert.equal(new Set(states.map((w) => w.spaceId)).size, 2, 'Each window claims a distinct Space');
    assert.equal(states.filter((w) => w.isFocused).length, 1);
    assert.equal(first.getBounds().width >= 880, true);
    assert.equal(second.getBounds().width >= 880, true);
    fs.writeFileSync(
      path.join(userData, 'kinex-state.json'),
      JSON.stringify({ ...mgr.getSnapshot(), windows: states.map((w) => ({ ...w, bounds: { ...w.bounds, x: w.bounds.x + 10 } })) })
    );
    const expectedBounds = states.map((w) => ({ ...w.bounds, spaceId: w.spaceId, x: w.bounds.x + 10 }));
    const expectedSpaces = states.map((w) => w.spaceId);
    mgr.dispose();
    mgrDisposed = true;
    for (const win of BrowserWindow.getAllWindows()) win.destroy();
    await wait(100);

    const restored = new KinexWindowManager(userData);
    mgr = restored;
    mgrDisposed = false;
    try {
      const windows = [restored.createWindow()];
      await until(() => restored.getWindowCount() === 2, 'two windows restored');
      const restoredStates = restored.getSnapshot().windows;
      assert.equal(restoredStates.length, 2);
      assert.deepEqual(restoredStates.map((w) => w.spaceId).sort(), [...expectedSpaces].sort());
      const restoredBySpace = new Map(restoredStates.map((w) => [w.spaceId, w]));
      for (const expected of expectedBounds) {
        const actual = restoredBySpace.get(expected.spaceId)?.bounds;
        assert.ok(actual, `Restored window for ${expected.spaceId}`);
        assert.equal(actual.width, expected.width);
        assert.equal(actual.height, expected.height);
        assert.ok(Number.isFinite(actual.x) && Number.isFinite(actual.y));
      }
      for (const context of restored.contexts.values()) {
        await until(() => context.shellView.webContents.getURL().endsWith('?view=shell'), 'shell view restored');
        const shellSnapshot = restored.getSnapshot(context.shellView.webContents.id);
        assert.equal(shellSnapshot.activeSpaceId, context.state.spaceId, 'Each shell view receives its own Space snapshot');
        const split = restored.getSnapshot().splitsBySpace[context.state.spaceId];
        assert.ok(split && split.tabIds.length > 0, 'Each restored Space keeps a split layout');
        for (const tabId of split.tabIds) {
          await until(() => Boolean(restored.tabManager.getView(tabId)), 'restored split tab view');
        }
      }
      const otherSpace = [...restored.contexts.values()].find((c) => c.state.id !== restored.currentWindowId).state.spaceId;
      await restored.handleIntent({ type: 'select-space', spaceId: otherSpace });
      assert.equal(restored.getSnapshot().activeSpaceId, otherSpace, 'Selecting a claimed Space activates its owning window');
      const ownSpaceBefore = restored.getSnapshot().activeSpaceId;
      restored.openUrl('kinex://newtab', 'new-tab', otherSpace);
      assert.equal(restored.getSnapshot().activeSpaceId, ownSpaceBefore, 'A window cannot switch to a Space claimed by another window');
      const claimed = new Set(restored.contexts.values().map((c) => c.state.spaceId));
      assert.equal(claimed.size, 2);
      for (const win of windows) assert.equal(win.isDestroyed(), false);
      const privateCount = restored.getMetricsSnapshot().privateWindowCount;
      assert.equal(privateCount, 0, 'Private windows are never restored');
      fs.writeSync(1, `MULTI_WINDOW_PASS ${JSON.stringify({ windows: restoredStates.length, spaces: [...claimed], privateCount })}\n`);
    } finally {
      restored.dispose();
      for (const win of BrowserWindow.getAllWindows()) win.destroy();
    }
  } finally {
    if (!mgrDisposed) mgr.dispose();
  }
}

run().then(() => app.quit()).catch((error) => {
  fs.writeSync(2, `MULTI_WINDOW_FAIL ${error.stack || error.message}\n`);
  app.exit(1);
});
