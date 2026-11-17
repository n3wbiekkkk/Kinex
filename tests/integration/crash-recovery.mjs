// Deterministic crash-recovery test for Kinex.
//
// Runs the real Electron application against a disposable profile, builds a known
// browsing state across two Spaces (pinned + regular tabs, ordering, active Space and
// tab), kills the process with SIGKILL so no shutdown handler can run, then restarts
// and verifies the restored state.
//
// SIGKILL is deliberate: it is the only way to prove recovery works from state that
// was already on disk, rather than from a graceful flush during quit.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const electronBinary = require('electron');
const root = path.resolve(import.meta.dirname, '..', '..');

const waitMs = (ms) => new Promise((r) => setTimeout(r, ms));

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

function connectCdp(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let nextId = 1;
    const pending = new Map();
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error('CDP connection timed out'));
    }, 8000);
    ws.addEventListener('open', () => {
      clearTimeout(timer);
      resolve({
        call(method, params = {}) {
          const id = nextId++;
          return new Promise((res, rej) => {
            const t = setTimeout(() => {
              pending.delete(id);
              rej(new Error(`CDP ${method} timed out`));
            }, 8000);
            pending.set(id, { res, rej, t });
            ws.send(JSON.stringify({ id, method, params }));
          });
        },
        async evalJs(expression) {
          const out = await this.call('Runtime.evaluate', {
            expression, awaitPromise: true, returnByValue: true, userGesture: true,
          });
          if (out.exceptionDetails) {
            throw new Error(out.exceptionDetails.exception?.description ?? out.exceptionDetails.text);
          }
          return out.result?.value;
        },
        close() { ws.close(); },
      });
    });
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id && pending.has(msg.id)) {
        const r = pending.get(msg.id);
        pending.delete(msg.id);
        clearTimeout(r.t);
        if (msg.error) r.rej(new Error(msg.error.message)); else r.res(msg.result);
      }
    });
    ws.addEventListener('error', () => reject(new Error('CDP socket error')));
  });
}

function startFixtureServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`<!doctype html><html><head><title>Fixture ${u.pathname}</title></head><body><h1>${u.pathname}</h1></body></html>`);
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

async function launch(userDataDir, cdpPort) {
  const proc = spawn(electronBinary, [root, `--remote-debugging-port=${cdpPort}`], {
    cwd: root,
    env: {
      ...process.env,
      KINEX_TEST_MODE: '1',
      KINEX_DISABLE_AUTO_UPDATER: '1',
      KINEX_USER_DATA_DIR: userDataDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  proc.stdout.on('data', (d) => { logs += d.toString(); });
  proc.stderr.on('data', (d) => { logs += d.toString(); });
  return { proc, getLogs: () => logs };
}

async function connectShell(cdpPort, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  let shellTarget;
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
      shellTarget = list.find((t) => t.type === 'page' && t.url.includes('?view=shell'));
      if (shellTarget) break;
    } catch {}
    await waitMs(100);
  }
  if (!shellTarget) throw new Error('Timed out waiting for Kinex shell target');
  const cdp = await connectCdp(shellTarget.webSocketDebuggerUrl);
  while (Date.now() < deadline) {
    const ready = await cdp.evalJs('Boolean(window.kinexAPI && document.querySelector(".kinex-shell"))').catch(() => false);
    if (ready) return cdp;
    await waitMs(100);
  }
  throw new Error('Kinex shell did not become interactive');
}

async function waitForState(cdp, predicate, label, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await cdp.evalJs('window.kinexAPI.getState()').catch(() => null);
    if (last && predicate(last)) return last;
    await waitMs(100);
  }
  throw new Error(`Timed out waiting for ${label}. Last state: ${JSON.stringify({
    activeSpaceId: last?.activeSpaceId,
    tabs: last?.tabs?.map((t) => ({ id: t.id, spaceId: t.spaceId, location: t.location, url: t.url })),
    splitsBySpace: last?.splitsBySpace,
  })}`);
}

function killHard(proc) {
  // SIGKILL: no before-quit, no flush, no cleanup. The on-disk state is all that survives.
  return new Promise((resolve) => {
    if (proc.exitCode !== null) { resolve(); return; }
    proc.once('exit', () => resolve());
    proc.kill('SIGKILL');
  });
}

async function stopGracefully(proc) {
  if (proc.exitCode !== null) return;
  proc.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => proc.once('exit', resolve)),
    waitMs(4000),
  ]);
  if (proc.exitCode === null && proc.signalCode === null) {
    proc.kill('SIGKILL');
    await new Promise((resolve) => proc.once('exit', resolve));
  }
}

async function run() {
  const { server, baseUrl } = await startFixtureServer();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kinex-crash-recovery-'));
  const statePath = path.join(userDataDir, 'kinex-state.json');
  const results = [];
  const record = (step, detail) => {
    results.push({ step, ...detail });
    console.log(`[recovery] ${step}: ${JSON.stringify(detail)}`);
  };

  let app = null;
  let shell = null;
  try {
    // ---------- Session 1: build state, then die unexpectedly ----------
    let port = await getFreePort();
    app = await launch(userDataDir, port);
    shell = await connectShell(port);
    record('session1 launched', { port });

    const initial = await shell.evalJs('window.kinexAPI.getState()');
    const personalSpace = initial.spaces[0];
    const workSpace = initial.spaces[1] ?? initial.spaces[0];
    assert.ok(personalSpace, 'a default Space must exist');
    assert.notEqual(personalSpace.id, workSpace.id, 'need two distinct Spaces');

    // Personal Space: three regular tabs in a known order.
    await shell.evalJs(`window.kinexAPI.dispatch({ type: 'select-space', spaceId: ${JSON.stringify(personalSpace.id)} })`);
    for (const name of ['p1', 'p2', 'p3']) {
      await shell.evalJs(`window.kinexAPI.dispatch({ type: 'open-url', url: ${JSON.stringify(`${baseUrl}/${name}`)}, target: 'new-tab', spaceId: ${JSON.stringify(personalSpace.id)} })`);
      await waitForState(shell, (s) => s.tabs.some((t) => t.url === `${baseUrl}/${name}` && !t.isLoading), `personal tab ${name}`);
    }

    // Work Space: one regular tab, then pin it.
    await shell.evalJs(`window.kinexAPI.dispatch({ type: 'select-space', spaceId: ${JSON.stringify(workSpace.id)} })`);
    await shell.evalJs(`window.kinexAPI.dispatch({ type: 'open-url', url: ${JSON.stringify(`${baseUrl}/w1`)}, target: 'new-tab', spaceId: ${JSON.stringify(workSpace.id)} })`);
    const workSnap = await waitForState(shell, (s) => s.tabs.some((t) => t.url === `${baseUrl}/w1` && !t.isLoading), 'work tab w1');
    const w1 = workSnap.tabs.find((t) => t.url === `${baseUrl}/w1`);

    // Pin it in the Work Space.
    await shell.evalJs(`window.kinexAPI.dispatch({ type: 'set-tab-location', tabId: ${JSON.stringify(w1.id)}, location: 'pinned' })`);
    await waitForState(shell, (s) => s.tabs.find((t) => t.id === w1.id)?.location === 'pinned', 'w1 pinned');

    // Leave the app on the Work Space, focused on the pinned tab.
    await shell.evalJs(`window.kinexAPI.dispatch({ type: 'select-space', spaceId: ${JSON.stringify(workSpace.id)} })`);
    await shell.evalJs(`window.kinexAPI.dispatch({ type: 'select-tab', tabId: ${JSON.stringify(w1.id)} })`);

    // Open a private window and navigate it, so there is private state that must not
    // survive the crash. Private windows live outside persisted.tabs by design.
    await shell.evalJs(`window.kinexAPI.dispatch({ type: 'open-incognito' })`);
    const privateDeadline = Date.now() + 15000;
    let privateTarget = null;
    while (Date.now() < privateDeadline) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        privateTarget = list.find((t) => t.type === 'page' && t.url.includes('view=private'));
        if (privateTarget) break;
      } catch {}
      await waitMs(100);
    }
    assert.ok(privateTarget, 'a private window must open for the isolation check');
    const privateCdp = await connectCdp(privateTarget.webSocketDebuggerUrl);
    await privateCdp.evalJs(`location.href = ${JSON.stringify(`${baseUrl}/private-secret`)}`).catch(() => {});
    await waitMs(600);
    privateCdp.close();
    record('private window opened', { url: `${baseUrl}/private-secret` });

    const before = await waitForState(
      shell,
      (s) => s.activeSpaceId === workSpace.id && s.splitsBySpace?.[workSpace.id]?.tabIds?.[0] === w1.id,
      'pre-crash focus'
    );

    // Wait until the state file on disk reflects the built state, so the crash
    // happens after a real save rather than mid-write.
    const expectedPersonal = ['p1', 'p2', 'p3'].map((n) => `${baseUrl}/${n}`);
    const diskDeadline = Date.now() + 10000;
    let diskState = null;
    while (Date.now() < diskDeadline) {
      try {
        diskState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
        const personalUrls = diskState.tabs.filter((t) => t.spaceId === personalSpace.id).map((t) => t.url);
        const hasAll = expectedPersonal.every((u) => personalUrls.includes(u));
        const pinnedOnDisk = diskState.tabs.find((t) => t.id === w1.id)?.location === 'pinned';
        if (hasAll && pinnedOnDisk && diskState.activeSpaceId === workSpace.id) break;
      } catch {}
      await waitMs(100);
    }
    assert.ok(diskState, 'state file must exist before the crash');
    record('state persisted before crash', {
      activeSpaceId: diskState.activeSpaceId,
      tabs: diskState.tabs.map((t) => ({ id: t.id, spaceId: t.spaceId, location: t.location, url: t.url })),
    });

    const snapshotBefore = {
      activeSpaceId: before.activeSpaceId,
      personalSpaceId: personalSpace.id,
      workSpaceId: workSpace.id,
      personalOrder: before.tabs.filter((t) => t.spaceId === personalSpace.id).map((t) => t.url),
      pinnedTabId: w1.id,
      pinnedUrl: w1.url,
    };

    // Unexpected termination.
    shell.close();
    shell = null;
    await killHard(app.proc);
    record('process killed', { signal: 'SIGKILL', exitCode: app.proc.exitCode, signalCode: app.proc.signalCode });
    app = null;

    // ---------- Session 2: restart and verify restoration ----------
    port = await getFreePort();
    app = await launch(userDataDir, port);
    shell = await connectShell(port);
    const restored = await waitForState(shell, (s) => s.spaces.length >= 2, 'restored state');
    record('session2 launched', { port });

    // Spaces preserved.
    const restoredSpaceIds = restored.spaces.map((s) => s.id);
    assert.ok(restoredSpaceIds.includes(snapshotBefore.personalSpaceId), 'personal Space must be restored');
    assert.ok(restoredSpaceIds.includes(snapshotBefore.workSpaceId), 'work Space must be restored');

    // Tabs restored into the correct Spaces, in order.
    const restoredPersonal = restored.tabs.filter((t) => t.spaceId === snapshotBefore.personalSpaceId).map((t) => t.url);
    for (const url of snapshotBefore.personalOrder) {
      assert.ok(restoredPersonal.includes(url), `personal tab ${url} must be restored`);
    }
    assert.deepEqual(
      restoredPersonal.filter((u) => snapshotBefore.personalOrder.includes(u)),
      snapshotBefore.personalOrder,
      'personal tab order must be preserved'
    );

    // Pinned stays pinned and keeps its Space.
    const restoredPinned = restored.tabs.find((t) => t.id === snapshotBefore.pinnedTabId);
    assert.ok(restoredPinned, 'pinned tab must be restored');
    assert.equal(restoredPinned.location, 'pinned', 'pinned tab must remain pinned');
    assert.equal(restoredPinned.spaceId, snapshotBefore.workSpaceId, 'pinned tab must stay in its Space');
    assert.equal(restoredPinned.url, snapshotBefore.pinnedUrl, 'pinned tab must keep its URL');

    // Active Space restored.
    assert.equal(restored.activeSpaceId, snapshotBefore.activeSpaceId, 'active Space must be restored');

    // No duplicate tabs.
    const ids = restored.tabs.map((t) => t.id);
    assert.equal(new Set(ids).size, ids.length, 'restored tabs must not contain duplicate ids');
    const urlsPerSpace = new Map();
    for (const tab of restored.tabs) {
      const key = `${tab.spaceId}::${tab.url}`;
      urlsPerSpace.set(key, (urlsPerSpace.get(key) ?? 0) + 1);
    }
    const duplicates = [...urlsPerSpace.entries()].filter(([, count]) => count > 1);
    assert.deepEqual(duplicates, [], 'no duplicate tab URLs within a Space');

    // Private browsing data must never be restored.
    assert.equal(
      restored.tabs.some((t) => t.url.includes('private-secret')),
      false,
      'private window URL must not appear in restored tabs'
    );
    assert.equal(
      JSON.stringify(restored).includes('private-secret'),
      false,
      'private window URL must not appear anywhere in restored state'
    );
    const diskAfterRecovery = fs.readFileSync(statePath, 'utf8');
    assert.equal(
      diskAfterRecovery.includes('private-secret'),
      false,
      'private window URL must never be written to the state file'
    );

    record('restored state verified', {
      spaces: restored.spaces.map((s) => s.name),
      activeSpaceId: restored.activeSpaceId,
      tabs: restored.tabs.map((t) => ({ spaceId: t.spaceId, location: t.location, url: t.url })),
    });

    // ---------- Corrupted state must not crash ----------
    shell.close();
    shell = null;
    await stopGracefully(app.proc);
    app = null;

    fs.writeFileSync(statePath, '{interrupted-json');
    port = await getFreePort();
    app = await launch(userDataDir, port);
    shell = await connectShell(port);
    const recovered = await waitForState(shell, (s) => s.spaces.length > 0, 'recovered from corrupt state');
    assert.ok(recovered.spaces.length > 0, 'corrupt state must fall back to usable defaults');
    // The damaged payload is preserved when the first save after load promotes its
    // replacement, which is debounced; wait for it rather than sampling too early.
    const backupDeadline = Date.now() + 10000;
    let backups = [];
    while (Date.now() < backupDeadline) {
      backups = fs.readdirSync(userDataDir).filter((n) => n.includes('.corrupt-'));
      if (backups.length >= 1) break;
      await waitMs(100);
    }
    assert.ok(backups.length >= 1, 'damaged payload must be preserved for inspection');
    assert.equal(fs.readFileSync(path.join(userDataDir, backups[0]), 'utf8'), '{interrupted-json', 'backup must hold the original damaged bytes');
    record('corrupt state recovered without crash', {
      spaces: recovered.spaces.length,
      backups: backups.length,
    });

    console.log(JSON.stringify({ ok: true, steps: results }, null, 2));
  } finally {
    try { shell?.close(); } catch {}
    if (app && app.proc.exitCode === null) await stopGracefully(app.proc);
    server.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

run().catch((err) => {
  console.error('RECOVERY TEST FAILED:', err && err.stack ? err.stack : String(err));
  process.exit(1);
});
