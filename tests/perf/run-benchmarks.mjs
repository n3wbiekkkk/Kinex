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

function stats(values) {
  if (values.length === 0) return { mean: 0, median: 0, p95: 0, min: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  const p95Idx = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return {
    mean: Number((sum / sorted.length).toFixed(1)),
    median: Number(median.toFixed(1)),
    p95: Number(sorted[p95Idx].toFixed(1)),
    min: Number(sorted[0].toFixed(1)),
    max: Number(sorted[sorted.length - 1].toFixed(1)),
  };
}

function waitMs(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function sampleProcessTree(rootPid) {
  const out = execFileSync('ps', ['-ax', '-o', 'pid=,ppid=,rss=,%cpu=,args='], { encoding: 'utf8' });
  const rows = [];
  for (const line of out.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = /^(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(.*)$/.exec(trimmed);
    if (!match) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      rssKB: Number(match[3]),
      cpu: Number(match[4]),
      args: match[5],
    });
  }

  const childrenByPpid = new Map();
  for (const r of rows) {
    if (!childrenByPpid.has(r.ppid)) childrenByPpid.set(r.ppid, []);
    childrenByPpid.get(r.ppid).push(r);
  }

  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const visited = new Set();
  const queue = byPid.has(rootPid) ? [byPid.get(rootPid)] : [];
  const tree = [];

  while (queue.length > 0) {
    const cur = queue.shift();
    if (!cur || visited.has(cur.pid)) continue;
    visited.add(cur.pid);
    tree.push(cur);
    for (const child of childrenByPpid.get(cur.pid) || []) {
      queue.push(child);
    }
  }

  let mainRssKB = 0;
  let gpuRssKB = 0;
  let utilityRssKB = 0;
  const rendererRssKBs = [];
  let totalCpu = 0;

  for (const p of tree) {
    totalCpu += p.cpu;
    if (p.pid === rootPid) {
      mainRssKB += p.rssKB;
    } else if (p.args.includes('--type=renderer')) {
      rendererRssKBs.push(p.rssKB);
    } else if (p.args.includes('--type=gpu-process')) {
      gpuRssKB += p.rssKB;
    } else {
      utilityRssKB += p.rssKB;
    }
  }

  const totalRssKB = tree.reduce((acc, p) => acc + p.rssKB, 0);
  const rendererSumKB = rendererRssKBs.reduce((acc, k) => acc + k, 0);
  const toMB = (kb) => Number((kb / 1024).toFixed(1));

  return {
    processCount: tree.length,
    totalRssMB: toMB(totalRssKB),
    mainRssMB: toMB(mainRssKB),
    gpuRssMB: toMB(gpuRssKB),
    utilityRssMB: toMB(utilityRssKB),
    rendererCount: rendererRssKBs.length,
    rendererRssTotalMB: toMB(rendererSumKB),
    meanRendererRssMB:
      rendererRssKBs.length > 0 ? toMB(rendererSumKB / rendererRssKBs.length) : 0,
    totalCpuPercent: Number(totalCpu.toFixed(1)),
  };
}

function startBenchServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      const idx = u.searchParams.get('i') || '0';
      const activeMode = u.searchParams.get('active') === '1';
      // Realistic lightweight document with CSS grid, 60 list items, SVG icon, and optional background tick
      const items = Array.from({ length: 60 }, (_, k) => `<li>Card #${idx}-${k}: Kinex benchmark payload</li>`).join('');
      const ticker = activeMode
        ? `<script>setInterval(() => { const el = document.getElementById('tick'); if (el) el.textContent = String((Number(el.textContent) + 1) % 10000); }, 200);</script>`
        : '';
      res.end(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Bench Site ${idx}</title>
  <style>
    body { font-family: -apple-system, sans-serif; margin: 24px; background: #11131a; color: #eceef6; }
    ul { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; list-style: none; padding: 0; }
    li { padding: 10px; background: #1a1d28; border-radius: 8px; border: 1px solid rgba(255,255,255,0.08); }
  </style>
</head>
<body>
  <h1 id="title">Bench Page ${idx}</h1>
  <div id="tick">0</div>
  <ul>${items}</ul>
  ${ticker}
</body>
</html>`);
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ server, port: addr.port });
    });
  });
}

async function listCdpTargets(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  return res.json();
}

async function waitForTarget(port, predicate, label, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const targets = await listCdpTargets(port);
      const found = targets.find((t) => t.type === 'page' && predicate(t));
      if (found) return found;
    } catch {
      // CDP initializing
    }
    await waitMs(25);
  }
  throw new Error(`Timed out waiting for target ${label}`);
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
          const out = await this.call('Runtime.evaluate', {
            expression,
            awaitPromise: true,
            returnByValue: true,
            userGesture: true,
          });
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

async function launchTimed(userDataDir, serverPort, extraArgs = []) {
  const cdpPort = await getFreePort();
  const t0 = performance.now();
  const proc = spawn(
    electronBinary,
    [
      root,
      `--remote-debugging-port=${cdpPort}`,
      '--host-resolver-rules=MAP *.bench.test 127.0.0.1',
      ...extraArgs,
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        KINEX_TEST_MODE: '1',
        KINEX_DISABLE_AUTO_UPDATER: '1',
        KINEX_USER_DATA_DIR: userDataDir,
      },
      stdio: ['ignore', 'ignore', 'ignore'],
    }
  );

  const shellTarget = await waitForTarget(cdpPort, (t) => t.url.includes('?view=shell'), 'shell');
  const shellCdp = await connectCdp(shellTarget.webSocketDebuggerUrl);

  while (true) {
    const ready = await shellCdp.evalJs(`Boolean(document.querySelector('.kinex-shell'))`).catch(() => false);
    if (ready) break;
    await waitMs(15);
  }
  const shellHydratedMs = performance.now() - t0;

  // Wait until welcome tab is loaded and interactive
  const welcomeTarget = await waitForTarget(
    cdpPort,
    (t) => t.url.startsWith('kinex://welcome') || t.url.startsWith('kinex://newtab'),
    'initial tab'
  );
  const welcomeCdp = await connectCdp(welcomeTarget.webSocketDebuggerUrl);
  while (true) {
    const state = await welcomeCdp.evalJs(`document.readyState`).catch(() => '');
    if (state === 'complete') break;
    await waitMs(15);
  }
  const firstUsableMs = performance.now() - t0;

  return {
    proc,
    cdpPort,
    shellCdp,
    welcomeCdp,
    shellHydratedMs,
    firstUsableMs,
    async stop() {
      try {
        shellCdp.close();
        welcomeCdp.close();
      } catch {}
      if (proc.exitCode === null) {
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
      }
    },
  };
}

async function measureStartup(serverPort, runs = 5) {
  const coldShell = [];
  const coldUsable = [];
  const warmShell = [];
  const warmUsable = [];

  for (let r = 0; r < runs; r++) {
    const coldDir = fs.mkdtempSync(path.join(os.tmpdir(), `kinex-bench-cold-${r}-`));
    try {
      const c = await launchTimed(coldDir, serverPort);
      coldShell.push(c.shellHydratedMs);
      coldUsable.push(c.firstUsableMs);
      await c.stop();

      // Immediately launch warm against same initialized profile
      const w = await launchTimed(coldDir, serverPort);
      warmShell.push(w.shellHydratedMs);
      warmUsable.push(w.firstUsableMs);
      await w.stop();
    } finally {
      fs.rmSync(coldDir, { recursive: true, force: true });
    }
  }

  return {
    runs,
    coldShellHydratedMs: stats(coldShell),
    coldFirstUsableMs: stats(coldUsable),
    warmShellHydratedMs: stats(warmShell),
    warmFirstUsableMs: stats(warmUsable),
  };
}

async function measureTabScaling(serverPort, targetCount) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), `kinex-bench-${targetCount}-`));
  const inst = await launchTimed(userDataDir, serverPort);
  const { proc, shellCdp } = inst;

  try {
    // Disable HTTPS-only for local HTTP multi-domain *.bench.test routing
    await shellCdp.evalJs(`window.kinexAPI.dispatch({ type: 'set-https-only', enabled: false })`);

    const navLatencies = [];
    let peakRssMB = sampleProcessTree(proc.pid).totalRssMB;

    // Open targetCount distinct-origin tabs
    for (let i = 1; i <= targetCount; i++) {
      const url = `http://site${i}.bench.test:${serverPort}/page?i=${i}&active=1`;
      const tStart = performance.now();
      await shellCdp.evalJs(`(async () => {
        await window.kinexAPI.dispatch({ type: 'open-url', url: ${JSON.stringify(url)}, target: 'new-tab' });
      })()`);

      // Wait until the new tab finishes loading
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        const loaded = await shellCdp.evalJs(`window.kinexAPI.getState().then(s => {
          const t = s.tabs.find(x => x.url.includes(${JSON.stringify(`site${i}.bench.test`)}) && x.url.includes('i=${i}'));
          return Boolean(t && !t.isLoading);
        })`);
        if (loaded) break;
        await waitMs(20);
      }
      navLatencies.push(performance.now() - tStart);

      if (i % 5 === 0 || i === targetCount) {
        const snap = sampleProcessTree(proc.pid);
        if (snap.totalRssMB > peakRssMB) peakRssMB = snap.totalRssMB;
      }
    }

    // Measure tab switching latency across opened tabs (up to 15 switches)
    const tabIds = await shellCdp.evalJs(`window.kinexAPI.getState().then(s =>
      s.tabs.filter(t => t.url.includes('.bench.test')).map(t => t.id)
    )`);
    const switchLatencies = [];
    const switchCount = Math.min(15, Math.max(2, tabIds.length * 2));
    if (tabIds.length >= 2) {
      for (let sIdx = 0; sIdx < switchCount; sIdx++) {
        const targetId = tabIds[(sIdx * 3) % tabIds.length];
        const t0 = performance.now();
        await shellCdp.evalJs(`(async () => {
          await window.kinexAPI.dispatch({ type: 'select-tab', tabId: ${JSON.stringify(targetId)} });
        })()`);
        while (true) {
          const active = await shellCdp.evalJs(`window.kinexAPI.getState().then(st => {
            const sp = st.splitsBySpace[st.activeSpaceId];
            return sp && sp.tabIds[sp.focusedIndex] === ${JSON.stringify(targetId)};
          })`);
          if (active) break;
          await waitMs(10);
        }
        switchLatencies.push(performance.now() - t0);
      }
    }

    // Active browsing CPU sample across 1.5s
    await waitMs(500);
    const activeSample1 = sampleProcessTree(proc.pid);
    await waitMs(1000);
    const activeSample2 = sampleProcessTree(proc.pid);

    // Settled idle sample after 2.5s
    await waitMs(2500);
    const idleSample = sampleProcessTree(proc.pid);
    const peakFinal = Math.max(peakRssMB, activeSample1.totalRssMB, activeSample2.totalRssMB, idleSample.totalRssMB);

    return {
      tabs: targetCount,
      navLatencyMs: stats(navLatencies),
      switchLatencyMs: tabIds.length >= 2 ? stats(switchLatencies) : { mean: 0, median: 0, p95: 0, min: 0, max: 0 },
      memory: {
        peakTotalRssMB: peakFinal,
        settledTotalRssMB: idleSample.totalRssMB,
        mainRssMB: idleSample.mainRssMB,
        gpuRssMB: idleSample.gpuRssMB,
        utilityRssMB: idleSample.utilityRssMB,
        rendererCount: idleSample.rendererCount,
        rendererRssTotalMB: idleSample.rendererRssTotalMB,
        meanRendererRssMB: idleSample.meanRendererRssMB,
        processCount: idleSample.processCount,
      },
      cpu: {
        activeCpuPercent: Number(((activeSample1.totalCpuPercent + activeSample2.totalCpuPercent) / 2).toFixed(1)),
        idleCpuPercent: idleSample.totalCpuPercent,
      },
    };
  } finally {
    await inst.stop();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

async function main() {
  const counts = process.argv.includes('--quick') ? [1, 5, 10] : [1, 5, 10, 25, 50];
  const runs = process.argv.includes('--quick') ? 2 : 5;
  const { server, port } = await startBenchServer();
  const outPath = process.argv.find((a) => a.startsWith('--out='))?.slice(6);

  try {
    const startup = await measureStartup(port, runs);
    const scaling = [];
    for (const c of counts) {
      scaling.push(await measureTabScaling(port, c));
    }
    const result = {
      timestamp: new Date().toISOString(),
      hardware: {
        arch: os.arch(),
        cpus: os.cpus()[0]?.model,
        coreCount: os.cpus().length,
        totalMemGB: Number((os.totalmem() / 1024 ** 3).toFixed(1)),
        osVersion: `${os.type()} ${os.release()}`,
      },
      startup,
      scaling,
    };
    if (outPath) {
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, JSON.stringify(result, null, 2), 'utf8');
    }
    console.log(JSON.stringify(result, null, 2));
  } finally {
    server.close();
  }
}

main().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
