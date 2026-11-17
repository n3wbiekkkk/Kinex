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

const WATCHDOG_MS = 240000;
let lastCheckpoint = 'startup';
let activeApp = null;

function checkpoint(label) {
  lastCheckpoint = label;
  console.log(`[e2e] ${label}`);
}

function installWatchdog() {
  const timer = setTimeout(() => {
    console.error(`E2E suite timed out after ${WATCHDOG_MS}ms at checkpoint: ${lastCheckpoint}`);
    if (activeApp && activeApp.proc.exitCode === null) activeApp.proc.kill('SIGKILL');
    process.exit(1);
  }, WATCHDOG_MS);
  timer.unref();
}

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

function startLocalWebsite() {
  let counterHits = 0;
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      if (u.pathname === '/page1') {
        res.end(
          `<!doctype html><html><head><title>Page One</title></head><body><h1>Page One</h1><a id="to-page2" href="/page2">Go Two</a><a id="bad-link" href="file:///etc/passwd">Bad Link</a></body></html>`
        );
        return;
      }
      if (u.pathname === '/page2') {
        res.end(
          `<!doctype html><html><head><title>Page Two</title></head><body><h1>Page Two</h1><a id="to-page3" href="/page3">Go Three</a><a id="bad-link" href="file:///etc/passwd">Bad File Link</a><a id="js-link" href="javascript:window.__kinexPwned=true;void(0);">Bad JS Link</a></body></html>`
        );
        return;
      }
      if (u.pathname === '/counter') {
        counterHits += 1;
        res.end(
          `<!doctype html><html><head><title>Counter ${counterHits}</title></head><body><h1 id="count">Reload Count: ${counterHits}</h1></body></html>`
        );
        return;
      }
      if (u.pathname === '/cookie-set') {
        const val = u.searchParams.get('val') || 'priv';
        res.setHeader('Set-Cookie', `kinex_e2e=${val}; Path=/; SameSite=Lax`);
        res.end(
          `<!doctype html><html><head><title>Private Cookie Set</title></head><body><h1 id="status">${val}</h1><script>localStorage.setItem('kinex_e2e_ls', ${JSON.stringify(val)});</script></body></html>`
        );
        return;
      }
      if (u.pathname === '/isolation-check') {
        res.end(
          `<!doctype html><html><head><title>Isolation Check</title></head><body><pre id="iso"></pre><script>document.getElementById('iso').textContent = JSON.stringify({ cookie: document.cookie, ls: localStorage.getItem('kinex_e2e_ls'), hasKinexApi: typeof window.kinexAPI });</script></body></html>`
        );
        return;
      }
      res.end('<!doctype html><html><head><title>Default</title></head><body><h1>OK</h1></body></html>');
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

async function listCdpTargets(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5000) });
  return res.json();
}

async function waitForTarget(port, predicate, label, timeoutMs = 10000) {
  checkpoint(`wait-for-target: ${label}`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const targets = await listCdpTargets(port);
      const found = targets.find((t) => t.type === 'page' && predicate(t));
      if (found) return found;
    } catch {
      // CDP endpoint still booting
    }
    await waitMs(80);
  }
  throw new Error(`Timed out waiting for CDP target: ${label}`);
}

async function waitUntil(fn, label, timeoutMs = 8000) {
  lastCheckpoint = label;
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const val = await fn();
      if (val) return val;
    } catch (err) {
      lastErr = err;
    }
    await waitMs(80);
  }
  throw new Error(`Timed out waiting for condition "${label}"${lastErr ? `: ${lastErr.message}` : ''}`);
}

function connectCdp(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let nextId = 1;
    let settled = false;
    const pending = new Map();
    const openTimer = setTimeout(() => {
      settle(new Error('Timed out waiting for CDP WebSocket to open'));
    }, 10000);
    const settle = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(openTimer);
      for (const { rej } of pending.values()) rej(error);
      pending.clear();
      if (error) reject(error);
    };

    ws.addEventListener('open', () => {
      settled = true;
      clearTimeout(openTimer);
      resolve({
        call(method, params = {}) {
          const id = nextId++;
          return new Promise((res, rej) => {
            const timer = setTimeout(() => {
              pending.delete(id);
              rej(new Error(`CDP ${method} timed out`));
            }, 15000);
            pending.set(id, {
              res: (value) => { clearTimeout(timer); res(value); },
              rej: (error) => { clearTimeout(timer); rej(error); },
            });
            ws.send(JSON.stringify({ id, method, params }));
          });
        },
        async evalJs(expression) {
          const out = await this.call('Runtime.evaluate', {
            expression,
            awaitPromise: true,
            returnByValue: true,
            userGesture: true,
          });
          if (out.exceptionDetails) {
            throw new Error(
              out.exceptionDetails.exception?.description || out.exceptionDetails.text || 'CDP Runtime.evaluate error'
            );
          }
          return out.result?.value;
        },
        close() {
          ws.close();
        },
      });
    });
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message));
        else res(msg.result);
      }
    });
    const failPending = (error) => {
      for (const { rej } of pending.values()) rej(error);
      pending.clear();
    };
    ws.addEventListener('close', () => failPending(new Error('CDP WebSocket closed')));
    ws.addEventListener('error', (err) => {
      failPending(err instanceof Error ? err : new Error('CDP WebSocket error'));
      settle(err instanceof Error ? err : new Error('CDP WebSocket error'));
    });
  });
}

async function connectToTarget(port, predicate, label, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const target = await waitForTarget(port, predicate, label, Math.max(1000, deadline - Date.now()));
      return await connectCdp(target.webSocketDebuggerUrl);
    } catch (error) {
      lastErr = error;
      await waitMs(100);
    }
  }
  throw new Error(`Failed to connect to CDP target "${label}"${lastErr ? `: ${lastErr.message}` : ''}`);
}

async function launchKinexApp(userDataDir, cdpPort) {
  checkpoint(`launch Electron on port ${cdpPort}`);
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
  proc.stdout.on('data', (d) => {
    logs += d.toString();
  });
  proc.stderr.on('data', (d) => {
    logs += d.toString();
  });
  const handle = {
    proc,
    getLogs: () => logs,
    async stop() {
      if (proc.exitCode !== null) return;
      proc.kill('SIGTERM');
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          if (proc.exitCode === null) proc.kill('SIGKILL');
          resolve();
        }, 4000);
        proc.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
      if (activeApp === handle) activeApp = null;
    },
  };
  activeApp = handle;
  return handle;
}

async function openUrlViaCommandBar(shellCdp, overlayCdp, url, targetMode = 'new-tab') {
  if (targetMode === 'new-tab') {
    await shellCdp.evalJs(`document.querySelector('.new-tab-row')?.click()`);
  } else {
    await shellCdp.evalJs(`document.querySelector('.sidebar-url-main')?.click()`);
  }

  await waitUntil(
    () => overlayCdp.evalJs(`Boolean(document.querySelector('.command-input'))`),
    'command bar input open'
  );

  // Set controlled React input value properly using native value setter
  await overlayCdp.evalJs(`(() => {
    const input = document.querySelector('.command-input');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(url)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return input.value;
  })()`);

  await waitUntil(
    () => overlayCdp.evalJs(`document.querySelector('.command-item.selected .command-item-sub')?.textContent?.includes(${JSON.stringify(url)})`),
    `command result shows ${url}`
  );

  await overlayCdp.evalJs(`document.querySelector('.command-item.selected')?.click()`);
}

async function run() {
  installWatchdog();
  checkpoint('start local website');
  const { server, baseUrl } = await startLocalWebsite();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kinex-e2e-'));
  let appHandle = null;

  try {
    // STEP 1: Launch Kinex
    checkpoint('STEP 1: launch');
    const port1 = await getFreePort();
    appHandle = await launchKinexApp(userDataDir, port1);

    const shellCdp = await connectToTarget(port1, (t) => t.url.includes('?view=shell'), 'shell view');

    await waitUntil(() => shellCdp.evalJs(`Boolean(document.querySelector('.kinex-shell'))`), 'shell hydrated');

    // Verify lazy overlay optimization: overlayView must NOT spawn at idle startup
    const startupTargets = await listCdpTargets(port1);
    assert.equal(
      startupTargets.some((t) => t.url.includes('?view=overlay')),
      false,
      'Overlay WebContentsView must be created lazily, not at startup'
    );

    // Phase 7 macOS UI layout & traffic-light spacing verification on live running shell
    checkpoint('Phase 7: live UI layout');
    const uiLayout = await shellCdp.evalJs(`(() => {
      const aside = document.querySelector('.sidebar');
      const dragTop = document.querySelector('.sidebar-drag-top');
      const resizer = document.querySelector('.sidebar-resizer');
      const urlBar = document.querySelector('.sidebar-url-bar');
      const asideRect = aside.getBoundingClientRect();
      const dragStyle = getComputedStyle(dragTop);
      return {
        sidebarWidth: asideRect.width,
        sidebarOverflowX: aside.scrollWidth > aside.clientWidth + 1,
        trafficLightClearancePx: parseFloat(dragStyle.paddingLeft),
        sidebarAppRegion: getComputedStyle(aside).webkitAppRegion,
        resizerAppRegion: getComputedStyle(resizer).webkitAppRegion,
        urlBarAppRegion: getComputedStyle(urlBar).webkitAppRegion,
        shellClass: document.querySelector('.kinex-shell')?.className,
      };
    })()`);
    assert.ok(uiLayout.sidebarWidth >= 200 && uiLayout.sidebarWidth <= 380, 'Valid sidebar width');
    assert.equal(uiLayout.sidebarOverflowX, false, 'Sidebar should not overflow horizontally');
    assert.ok(uiLayout.trafficLightClearancePx >= 68, 'macOS traffic light clearance preserved');
    assert.equal(uiLayout.sidebarAppRegion, 'drag', 'Empty space in left sidebar must be window-draggable');
    assert.equal(uiLayout.resizerAppRegion, 'no-drag', 'Sidebar resizer must remain non-draggable');
    assert.equal(uiLayout.urlBarAppRegion, 'no-drag', 'Sidebar URL bar must remain clickable');

    // Phase 7b: Collapsed sidebar & TopControls traffic-light clearance + overflow check
    checkpoint('Phase 7b: collapsed sidebar');
    await shellCdp.evalJs(`document.querySelector('button[aria-label="Toggle Sidebar"]').click()`);
    const collapsedLayout = await waitUntil(
      () =>
        shellCdp.evalJs(`(() => {
          const top = document.querySelector('.top-controls.sidebar-closed');
          if (!top) return null;
          const style = getComputedStyle(top);
          return {
            paddingLeft: parseFloat(style.paddingLeft),
            overflowX: top.scrollWidth > top.clientWidth + 1,
            width: top.getBoundingClientRect().width,
          };
        })()`),
      'collapsed TopControls visible'
    );
    assert.ok(collapsedLayout.paddingLeft >= 78, 'Collapsed TopControls clears macOS traffic lights');
    assert.equal(collapsedLayout.overflowX, false, 'Collapsed TopControls has zero horizontal overflow');

    // Re-open sidebar via TopControls button
    await shellCdp.evalJs(`document.querySelector('button[aria-label="Show Sidebar"]').click()`);
    await waitUntil(
      () => shellCdp.evalJs(`Boolean(document.querySelector('.sidebar'))`),
      'sidebar re-expanded'
    );

    // Phase 7c: Settings modal viewport fit check (also triggers lazy overlay creation)
    checkpoint('Phase 7c: settings overlay');
    await shellCdp.evalJs(`document.querySelector('button[title="Settings (⌘,)"]').click()`);
    const overlayCdp = await connectToTarget(port1, (t) => t.url.includes('?view=overlay'), 'lazy overlay view');
    const settingsLayout = await waitUntil(
      () =>
        overlayCdp.evalJs(`(() => {
          const card = document.querySelector('.settings-window');
          if (!card) return null;
          const rect = card.getBoundingClientRect();
          return {
            width: rect.width,
            height: rect.height,
            fitsViewport: rect.width <= window.innerWidth && rect.height <= window.innerHeight,
          };
        })()`),
      'Settings modal fits viewport'
    );
    assert.equal(settingsLayout.fitsViewport, true, 'Settings modal must fit cleanly inside viewport');
    await overlayCdp.evalJs(`document.querySelector('.overlay-backdrop')?.click()`);
    await waitUntil(
      () => overlayCdp.evalJs(`document.querySelector('.overlay-backdrop') === null`),
      'Settings overlay closed cleanly'
    );

    // STEP 2: Open a website (/page1 via Command Bar UI)
    checkpoint('STEP 2: open page1');
    await openUrlViaCommandBar(shellCdp, overlayCdp, `${baseUrl}/page1`, 'new-tab');
    const page1Cdp = await connectToTarget(port1, (t) => t.url === `${baseUrl}/page1`, '/page1 target');
    await waitUntil(
      async () => (await page1Cdp.evalJs(`document.querySelector('h1')?.textContent`)) === 'Page One',
      'Page One loaded'
    );

    // Click internal link #to-page2 to populate Chromium back/forward history
    await page1Cdp.evalJs(`document.getElementById('to-page2').click()`);
    await waitUntil(
      async () => (await page1Cdp.evalJs(`location.pathname + ':' + document.querySelector('h1')?.textContent`)) === '/page2:Page Two',
      'navigated in-tab from /page1 to /page2'
    );

    // STEP 3: Create a second tab (/counter)
    checkpoint('STEP 3: open counter');
    await openUrlViaCommandBar(shellCdp, overlayCdp, `${baseUrl}/counter`, 'new-tab');
    const counterCdp = await connectToTarget(port1, (t) => t.url === `${baseUrl}/counter`, '/counter target');
    await waitUntil(
      async () => (await counterCdp.evalJs(`document.getElementById('count')?.textContent`)) === 'Reload Count: 1',
      'Counter initial load = 1'
    );

    // STEP 4: Switch tabs (click /page2 tab row in Sidebar UI)
    checkpoint('STEP 4: switch tabs');
    await shellCdp.evalJs(`(() => {
      const rows = Array.from(document.querySelectorAll('.tab-row'));
      const p2 = rows.find((r) => r.textContent.includes('Page Two'));
      if (!p2) throw new Error('Page Two tab row not found');
      p2.click();
    })()`);
    await waitUntil(
      () => shellCdp.evalJs(`document.querySelector('.tab-row.active')?.textContent?.includes('Page Two')`),
      'switched back to Page Two tab'
    );
    await waitUntil(
      () => page1Cdp.evalJs(`document.hasFocus()`),
      'Page Two webview automatically receives focus after clicking sidebar tab'
    );

    // STEP 5: Navigate Backward (to /page1)
    checkpoint('STEP 5: navigate back');
    await waitUntil(
      () => shellCdp.evalJs(`!document.querySelector('button[title="Back (⌘[)"]').disabled`),
      'Back button enabled'
    ).catch(async (err) => {
      const st = await shellCdp.evalJs(`window.kinexAPI.getState().then(s => ({ split: s.splitsBySpace[s.activeSpaceId], tabs: s.tabs.map(t => ({ id: t.id, url: t.url, title: t.title, back: t.canGoBack, fwd: t.canGoForward })) }))`);
      console.error('DEBUG state at failure:', JSON.stringify(st, null, 2));
      throw err;
    });
    await shellCdp.evalJs(`document.querySelector('button[title="Back (⌘[)"]').click()`);
    await waitUntil(
      async () => (await page1Cdp.evalJs(`location.pathname + ':' + document.querySelector('h1')?.textContent`)) === '/page1:Page One',
      'Back button navigated to /page1'
    );

    // STEP 6: Navigate Forward (to /page2)
    checkpoint('STEP 6: navigate forward');
    await waitUntil(
      () => shellCdp.evalJs(`!document.querySelector('button[title="Forward (⌘])"]').disabled`),
      'Forward button enabled'
    );
    await shellCdp.evalJs(`document.querySelector('button[title="Forward (⌘])"]').click()`);
    await waitUntil(
      async () => (await page1Cdp.evalJs(`location.pathname + ':' + document.querySelector('h1')?.textContent`)) === '/page2:Page Two',
      'Forward button navigated to /page2'
    );

    // STEP 7: Reload (/counter -> Reload Count: 2)
    checkpoint('STEP 7: reload');
    await shellCdp.evalJs(`(() => {
      const rows = Array.from(document.querySelectorAll('.tab-row'));
      const c = rows.find((r) => r.textContent.includes('Counter'));
      c.click();
    })()`);
    await waitUntil(
      () => shellCdp.evalJs(`document.querySelector('.tab-row.active')?.textContent?.includes('Counter')`),
      'selected Counter tab'
    );
    await shellCdp.evalJs(`document.querySelector('button[title="Reload (⌘R)"]').click()`);
    await waitUntil(
      async () => (await counterCdp.evalJs(`document.getElementById('count')?.textContent`)) === 'Reload Count: 2',
      'Reload incremented counter to 2'
    );

    // STEP 8: Open Split View
    checkpoint('STEP 8: split view');
    await shellCdp.evalJs(`document.querySelector('button[title^="Toggle Split View"]').click()`);
    await waitUntil(
      () => shellCdp.evalJs(`document.querySelectorAll('.pane-pill').length === 2`),
      'Split view opened 2 panes'
    );
    // Toggle Split View back off so single-pane tests stay uncluttered
    await shellCdp.evalJs(`document.querySelector('button[title^="Toggle Split View"]').click()`);
    await waitUntil(
      () => shellCdp.evalJs(`document.querySelectorAll('.pane-pill').length <= 1`),
      'Split view toggled back cleanly'
    );

    // STEP 9: Switch Spaces (Personal -> Work -> Personal)
    checkpoint('STEP 9: switch spaces');
    await shellCdp.evalJs(`(() => {
      const pills = Array.from(document.querySelectorAll('.space-pill'));
      pills.find((p) => p.textContent.includes('Work'))?.click();
    })()`);
    await waitUntil(
      () => shellCdp.evalJs(`document.querySelector('.kinex-shell')?.classList.contains('theme-light')`),
      'Switched to Work space (light theme)'
    );
    await shellCdp.evalJs(`(() => {
      const pills = Array.from(document.querySelectorAll('.space-pill'));
      pills.find((p) => p.textContent.includes('Personal'))?.click();
    })()`);
    await waitUntil(
      () => shellCdp.evalJs(`document.querySelector('.kinex-shell')?.classList.contains('theme-dark')`),
      'Switched back to Personal space (dark theme)'
    );

    // STEP 10: Open a Private Window & verify private UI + cookie/localStorage isolation
    checkpoint('STEP 10: private window');
    await shellCdp.evalJs(`document.querySelector('button[title="New Private Window (⌘⇧N)"]').click()`);
    const privHeaderCdp = await connectToTarget(port1, (t) => t.url.includes('?view=private'), 'private header view');
    await waitUntil(
      () => privHeaderCdp.evalJs(`Boolean(document.querySelector('.private-badge'))`),
      'Private header badge rendered'
    );
    const hasPromoteBtn = await privHeaderCdp.evalJs(`document.body.textContent.includes('Open in Kinex')`);
    assert.equal(hasPromoteBtn, false, 'Private window must NOT show Open in Kinex promote button');

    // Navigate private window to /cookie-set?val=e2e_secret via address bar
    await privHeaderCdp.evalJs(`(() => {
      const input = document.querySelector('.little-url-input');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(`${baseUrl}/cookie-set?val=e2e_secret`)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    })()`);
    const privPageCdp = await connectToTarget(
      port1,
      (t) => t.url === `${baseUrl}/cookie-set?val=e2e_secret`,
      'private page loaded'
    );
    checkpoint('private: verify cookie and localStorage');
    await waitUntil(
      () => privPageCdp.evalJs(`document.readyState === 'complete' && localStorage.getItem('kinex_e2e_ls') === 'e2e_secret'`),
      'private page committed cookie & localStorage'
    );
    const privCookie = await privPageCdp.evalJs(`document.cookie`);
    assert.ok(privCookie.includes('kinex_e2e=e2e_secret'), 'Private page stores its own cookie');

    // Attempt promote from private header -> must be ignored cleanly
    await privHeaderCdp.evalJs(`window.kinexAPI.littleKinexAction('promote')`);
    await waitMs(120);
    const leakedPromote = await shellCdp.evalJs(`window.kinexAPI.getState().then(s => s.tabs.some(t => t.url.includes('e2e_secret')) || s.history.some(h => h.url.includes('e2e_secret')))`);
    assert.equal(leakedPromote, false, 'Private window must never promote or record URLs into regular state');

    // Close Private Window
    checkpoint('private: close window through its header IPC');
    // Keep the reply pending to exercise destruction before the close RPC can complete.
    try {
      await privHeaderCdp.evalJs(`window.kinexAPI.littleKinexAction('close').then(() => new Promise(() => {}))`);
    } catch (error) {
      if (!/^CDP WebSocket (closed|error)$/.test(error.message)) throw error;
    }
    privHeaderCdp.close();
    privPageCdp.close();
    await waitUntil(async () => {
      const targets = await listCdpTargets(port1);
      return !targets.some((t) => t.url.includes('?view=private') || t.url === `${baseUrl}/cookie-set?val=e2e_secret`);
    }, 'private window closed');

    // STEP 11: Close Counter tab
    checkpoint('STEP 11: close counter');
    await shellCdp.evalJs(`(() => {
      const rows = Array.from(document.querySelectorAll('.tab-row'));
      const counterRow = rows.find((r) => r.textContent.includes('Counter'));
      counterRow.querySelector('button[title="Close Tab"]').click();
    })()`);
    await waitUntil(
      () => shellCdp.evalJs(`!Array.from(document.querySelectorAll('.tab-row')).some(r => r.textContent.includes('Counter'))`),
      'Counter tab closed'
    );

    // STEP 12: Restore archived Counter tab via Archive UI
    checkpoint('STEP 12: restore archived tab');
    await shellCdp.evalJs(`document.querySelector('button[title="Archived Tabs"]').click()`);
    await waitUntil(
      () => overlayCdp.evalJs(`document.body.textContent.includes('Archived Today Tabs') && document.body.textContent.includes('Counter')`),
      'Archive overlay lists closed Counter tab'
    );
    await overlayCdp.evalJs(`(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const restoreBtn = buttons.find((b) => b.textContent.includes('Restore'));
      restoreBtn.click();
    })()`);
    await waitUntil(
      () => shellCdp.evalJs(`Array.from(document.querySelectorAll('.tab-row')).some(r => r.textContent.includes('Counter'))`),
      'Restored Counter tab back to Personal Space'
    );

    // STEP 15a (pre-restart): Security Isolation inside remote webpage + IPC rejection
    checkpoint('STEP 15a: isolation and IPC');
    await openUrlViaCommandBar(shellCdp, overlayCdp, `${baseUrl}/isolation-check`, 'new-tab');
    const isoCdp = await connectToTarget(port1, (t) => t.url === `${baseUrl}/isolation-check`, 'isolation-check target');
    const isoResult = await waitUntil(async () => {
      const txt = await isoCdp.evalJs(`document.getElementById('iso')?.textContent`);
      return txt ? JSON.parse(txt) : null;
    }, 'isolation-check script result');
    assert.equal(isoResult.hasKinexApi, 'undefined', 'Remote website must NEVER have access to window.kinexAPI');
    assert.equal(isoResult.cookie.includes('e2e_secret'), false, 'Private window cookie must NOT leak to regular profile');
    assert.equal(isoResult.ls, null, 'Private window localStorage must NOT leak to regular profile');

    // Attempt unsafe IPC intent from shell -> must reject with validation error
    const ipcBlocked = await shellCdp.evalJs(`
      window.kinexAPI.dispatch({ type: 'open-url', url: 'javascript:alert(1)', target: 'current' })
        .then(() => false)
        .catch((err) => String(err.message || err).includes('Blocked unsafe URL scheme'))
    `);
    assert.equal(ipcBlocked, true, 'IPC validator must reject javascript: URL intents');

    // Attempt whitespace-obfuscated unsafe IPC intent from shell -> must reject with validation error
    const obfIpcBlocked = await shellCdp.evalJs(`
      window.kinexAPI.dispatch({ type: 'open-url', url: 'java\\tscript:alert(1)', target: 'current' })
        .then(() => false)
        .catch((err) => String(err.message || err).includes('Blocked unsafe URL scheme'))
    `);
    assert.equal(obfIpcBlocked, true, 'IPC validator must reject whitespace-obfuscated javascript: URL intents');

    // Assert unsafe file:/// link and popup window.open('data:...') / window.open('file:///...') are blocked on /page2
    const badLinksPresent = await page1Cdp.evalJs(
      `Boolean(document.getElementById('bad-link'))`
    );
    assert.equal(badLinksPresent, true, 'Expected #bad-link on /page2');
    const popupHandles = await page1Cdp.evalJs(`(() => {
      const filePopup = window.open('file:///etc/passwd', '_blank', 'width=300,height=200');
      const dataPopup = window.open('data:text/html,<h1>bad</h1>', '_blank', 'width=300,height=200');
      const blankPopup = window.open('about:blank', '_blank', 'width=300,height=200');
      const blankHasApi = blankPopup ? typeof blankPopup.kinexAPI !== 'undefined' : false;
      if (blankPopup) blankPopup.close();
      return {
        filePopup: filePopup !== null,
        dataPopup: dataPopup !== null,
        blankHasApi,
      };
    })()`);
    assert.equal(popupHandles.filePopup, false, 'window.open(file://) must be denied by setWindowOpenHandler');
    assert.equal(popupHandles.dataPopup, false, 'window.open(data:) must be denied by setWindowOpenHandler');
    assert.equal(popupHandles.blankHasApi, false, 'Any allowed popup must remain sandboxed without kinexAPI');
    await page1Cdp.evalJs(`document.getElementById('bad-link').click()`);
    await waitMs(250);
    const page2HrefAfter = await page1Cdp.evalJs(`location.href`);
    assert.equal(page2HrefAfter, `${baseUrl}/page2`, 'Navigation guard must block file:// link navigation');

    // Close CDP sockets cleanly before restart
    isoCdp.close();
    page1Cdp.close();
    counterCdp.close();
    overlayCdp.close();
    shellCdp.close();

    // STEP 13: Restart the application cleanly
    checkpoint('STEP 13: restart');
    await appHandle.stop();
    const port2 = await getFreePort();
    appHandle = await launchKinexApp(userDataDir, port2);

    // STEP 14: Verify persistence across restart
    checkpoint('STEP 14: persistence');
    const shell2Cdp = await connectToTarget(port2, (t) => t.url.includes('?view=shell'), 'restarted shell view');
    await waitUntil(() => shell2Cdp.evalJs(`Boolean(document.querySelector('.kinex-shell'))`), 'restarted shell hydrated');

    const persistedSummary = await shell2Cdp.evalJs(`(async () => {
      const state = await window.kinexAPI.getState();
      return {
        urls: state.tabs.map((t) => t.url),
        activeSpaceId: state.activeSpaceId,
        historyCount: state.history.length,
      };
    })()`);
    assert.ok(
      persistedSummary.urls.some((u) => u.includes('/counter')),
      'Restored Counter tab persisted across restart'
    );
    assert.ok(
      persistedSummary.urls.some((u) => u.includes('/page2')),
      'Navigated Page Two tab persisted across restart'
    );
    assert.ok(
      persistedSummary.urls.some((u) => u.includes('/isolation-check')),
      'Isolation-check tab persisted across restart'
    );
    assert.equal(persistedSummary.urls.some((u) => u.includes('e2e_secret')), false, 'Private URLs must NOT persist across restart');

    shell2Cdp.close();
    await appHandle.stop();
    appHandle = null;

    console.log('E2E_ALL_15_WORKFLOWS_PASS', {
      stepsVerified: 15,
      uiLayout,
      persistedTabCount: persistedSummary.urls.length,
      historyCount: persistedSummary.historyCount,
    });
  } finally {
    if (appHandle) {
      await appHandle.stop();
    }
    server.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

run().catch((err) => {
  console.error('E2E suite failed:', err);
  process.exit(1);
});
