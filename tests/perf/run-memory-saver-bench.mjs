import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
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
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

function waitMs(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function sampleTree(rootPid) {
  const out = execFileSync('ps', ['-ax', '-o', 'pid=,ppid=,rss=,%cpu=,args='], { encoding: 'utf8' });
  const rows = [];
  for (const line of out.split('\n')) {
    const m = /^(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(.*)$/.exec(line.trim());
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), rssKB: Number(m[3]), cpu: Number(m[4]), args: m[5] });
  }
  const byPpid = new Map();
  for (const r of rows) {
    if (!byPpid.has(r.ppid)) byPpid.set(r.ppid, []);
    byPpid.get(r.ppid).push(r);
  }
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const seen = new Set();
  const q = byPid.has(rootPid) ? [byPid.get(rootPid)] : [];
  const tree = [];
  while (q.length) {
    const cur = q.shift();
    if (!cur || seen.has(cur.pid)) continue;
    seen.add(cur.pid);
    tree.push(cur);
    for (const c of byPpid.get(cur.pid) || []) q.push(c);
  }
  const totalRssMB = Number((tree.reduce((a, p) => a + p.rssKB, 0) / 1024).toFixed(1));
  const rendererCount = tree.filter((p) => p.args.includes('--type=renderer')).length;
  const totalCpu = Number(tree.reduce((a, p) => a + p.cpu, 0).toFixed(1));
  return { totalRssMB, rendererCount, processCount: tree.length, totalCpu };
}

function startBenchServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      const items = Array.from({ length: 60 }, (_, k) => `<li>Card #${k}: Kinex Memory Saver</li>`).join('');
      res.end(`<!doctype html><html><head><title>${req.url}</title></head><body><h1>${req.url}</h1><div id="tick">0</div><ul>${items}</ul><script>setInterval(()=>{document.getElementById('tick').textContent++;},200);</script></body></html>`);
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
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
          if (out.exceptionDetails) throw new Error(out.exceptionDetails.text);
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

async function runForTabCount(count, serverPort) {
  const cdpPort = await getFreePort();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), `kinex-ms-bench-${count}-`));
  const proc = spawn(
    electronBinary,
    [root, `--remote-debugging-port=${cdpPort}`, '--host-resolver-rules=MAP *.bench.test 127.0.0.1'],
    {
      cwd: root,
      env: { ...process.env, KINEX_TEST_MODE: '1', KINEX_DISABLE_AUTO_UPDATER: '1', KINEX_USER_DATA_DIR: userDataDir },
      stdio: ['ignore', 'ignore', 'ignore'],
    }
  );
  let shellCdp;
  try {
    let shellTarget;
    for (let i = 0; i < 80; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
        shellTarget = list.find((t) => t.type === 'page' && t.url.includes('?view=shell'));
        if (shellTarget) break;
      } catch {}
      await waitMs(40);
    }
    shellCdp = await connectCdp(shellTarget.webSocketDebuggerUrl);
    for (let i = 0; i < 80; i++) {
      const hydrated = await shellCdp.evalJs(`Boolean(document.querySelector('.kinex-shell'))`).catch(() => false);
      if (hydrated) break;
      await waitMs(25);
    }
    await shellCdp.evalJs(`window.kinexAPI.dispatch({ type: 'set-https-only', enabled: false })`);

    const openedIds = [];
    for (let i = 1; i <= count; i++) {
      const url = `http://ms${i}.bench.test:${serverPort}/doc?i=${i}`;
      await shellCdp.evalJs(`window.kinexAPI.dispatch({ type: 'open-url', url: ${JSON.stringify(url)}, target: 'new-tab' })`);
      for (let w = 0; w < 50; w++) {
        const found = await shellCdp.evalJs(`window.kinexAPI.getState().then(s => {
          const t = s.tabs.find(x => x.url.includes(${JSON.stringify(`ms${i}.bench.test`)}) && !x.isLoading);
          return t ? t.id : null;
        })`);
        if (found) {
          openedIds.push(found);
          break;
        }
        await waitMs(25);
      }
    }
    await waitMs(1000);
    const beforeSleep = sampleTree(proc.pid);

    // Discard all background opened tabs except the active last tab (openedIds[openedIds.length - 1])
    for (let i = 0; i < openedIds.length - 1; i++) {
      await shellCdp.evalJs(`window.kinexAPI.dispatch({ type: 'discard-tab', tabId: ${JSON.stringify(openedIds[i])} })`);
    }
    await waitMs(1500);
    const afterSleep = sampleTree(proc.pid);
    const sleepingCount = await shellCdp.evalJs(`window.kinexAPI.getState().then(s => s.tabs.filter(t => t.isDiscarded).length)`);

    // Measure wake/restore latency on first sleeping tab
    const tWake0 = performance.now();
    await shellCdp.evalJs(`window.kinexAPI.dispatch({ type: 'select-tab', tabId: ${JSON.stringify(openedIds[0])} })`);
    for (let w = 0; w < 100; w++) {
      const ok = await shellCdp.evalJs(`window.kinexAPI.getState().then(s => {
        const t = s.tabs.find(x => x.id === ${JSON.stringify(openedIds[0])});
        return Boolean(t && !t.isDiscarded && !t.isLoading);
      })`);
      if (ok) break;
      await waitMs(20);
    }
    const restoreMs = Number((performance.now() - tWake0).toFixed(1));

    return {
      tabs: count,
      beforeMemorySaver: beforeSleep,
      afterMemorySaver: afterSleep,
      sleepingTabs: sleepingCount,
      rssSavedMB: Number((beforeSleep.totalRssMB - afterSleep.totalRssMB).toFixed(1)),
      rssReductionPct: Number((((beforeSleep.totalRssMB - afterSleep.totalRssMB) / beforeSleep.totalRssMB) * 100).toFixed(1)),
      wakeRestoreMs: restoreMs,
    };
  } finally {
    try { shellCdp?.close(); } catch {}
    if (proc.exitCode === null) {
      proc.kill('SIGTERM');
      await waitMs(800);
      if (proc.exitCode === null) proc.kill('SIGKILL');
    }
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

async function main() {
  const { server, port } = await startBenchServer();
  try {
    const res25 = await runForTabCount(25, port);
    const res50 = await runForTabCount(50, port);
    const outPath = process.argv.find((a) => a.startsWith('--out='))?.slice(6);
    const report = { results: [res25, res50] };
    if (outPath) fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');
    console.log(JSON.stringify(report, null, 2));
  } finally {
    server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
