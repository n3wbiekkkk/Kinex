import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const electronBinary = require('electron');
const root = path.resolve(import.meta.dirname, '..', '..');

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close((e) => (e ? reject(e) : resolve(port)));
    });
  });
}

function waitMs(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function connectCdp(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let nextId = 1;
    const pending = new Map();
    ws.addEventListener('open', () => {
      resolve({
        call(method, params = {}) {
          const id = nextId++;
          return new Promise((res, rej) => {
            pending.set(id, { res, rej });
            ws.send(JSON.stringify({ id, method, params }));
          });
        },
        async evalJs(expression) {
          const out = await this.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
          if (out.exceptionDetails) {
            throw new Error(out.exceptionDetails.exception?.description || out.exceptionDetails.text);
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
    ws.addEventListener('error', reject);
  });
}

async function run() {
  const cdpPort = await getFreePort();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kinex-yt-'));
  const proc = spawn(electronBinary, [root, `--remote-debugging-port=${cdpPort}`], {
    cwd: root,
    env: { ...process.env, KINEX_TEST_MODE: '1', KINEX_DISABLE_AUTO_UPDATER: '1', KINEX_USER_DATA_DIR: userDataDir },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  let shellCdp;
  try {
    let shellTarget;
    for (let i = 0; i < 60; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
        shellTarget = list.find((t) => t.type === 'page' && t.url.includes('?view=shell'));
        if (shellTarget) break;
      } catch {}
      await waitMs(50);
    }
    shellCdp = await connectCdp(shellTarget.webSocketDebuggerUrl);
    for (let i = 0; i < 60; i++) {
      if (await shellCdp.evalJs(`Boolean(document.querySelector('.kinex-shell'))`).catch(() => false)) break;
      await waitMs(30);
    }

    await shellCdp.evalJs(`window.kinexAPI.dispatch({ type: 'open-url', url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ', target: 'new-tab' })`);
    let tab;
    for (let i = 0; i < 120; i++) {
      tab = await shellCdp.evalJs(`window.kinexAPI.getState().then(s => s.tabs.find(t => t.url.includes('youtube.com/watch')))`);
      if (tab && !tab.isLoading) break;
      await waitMs(100);
    }

    const checks = [];
    for (let attempt = 0; attempt < 4; attempt++) {
      await waitMs(attempt === 0 ? 500 : 1000);
      const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
      const ytTarget = list.find((t) => t.type === 'page' && t.url.includes('youtube.com/watch'));
      if (!ytTarget) {
        checks.push({ attempt, error: 'no target' });
        continue;
      }
      try {
        const pCdp = await connectCdp(ytTarget.webSocketDebuggerUrl);
        const info = await pCdp.evalJs(`(() => {
          const before = window.scrollY;
          window.scrollTo(0, 300);
          const after = window.scrollY;
          return {
            url: location.href,
            readyState: document.readyState,
            scrollHeight: document.documentElement.scrollHeight,
            clientHeight: document.documentElement.clientHeight,
            overflow: getComputedStyle(document.documentElement).overflowY,
            bodyOverflow: document.body ? getComputedStyle(document.body).overflowY : null,
            before,
            after,
          };
        })()`);
        pCdp.close();
        checks.push({ attempt, ...info });
      } catch (err) {
        checks.push({ attempt, error: err.message });
      }
    }
    console.log(JSON.stringify({ tabUrl: tab?.url, checks }, null, 2));
  } finally {
    try { shellCdp?.close(); } catch {}
    if (proc.exitCode === null) {
      proc.kill('SIGTERM');
      await waitMs(600);
      if (proc.exitCode === null) proc.kill('SIGKILL');
    }
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

run().catch((e) => { console.error(e); process.exit(1); });
