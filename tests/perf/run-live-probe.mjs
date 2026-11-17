import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  findScrollSurface,
  publicPageInfo,
  readProbeVisibility,
  readScrollSurface,
  selectProbeTarget,
  summarizeScroll,
  waitForPaint,
} from './compatibilityProbe.mjs';

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

function sampleProcessTree(rootPid) {
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
  const totalCpuPercent = Number(tree.reduce((a, p) => a + p.cpu, 0).toFixed(1));
  return { totalRssMB, rendererCount, processCount: tree.length, totalCpuPercent };
}

function connectCdp(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let nextId = 1;
    const pending = new Map();
    const connectionTimer = setTimeout(() => {
      ws.close();
      reject(new Error('CDP connection timed out'));
    }, 5000);
    function rejectPending(reason) {
      clearTimeout(connectionTimer);
      reject(reason);
      for (const request of pending.values()) {
        clearTimeout(request.timer);
        request.reject(reason);
      }
      pending.clear();
    }
    ws.addEventListener('open', () => {
      clearTimeout(connectionTimer);
      resolve({
        call(method, params = {}) {
          const id = nextId++;
          return new Promise((res, rej) => {
            const timer = setTimeout(() => {
              pending.delete(id);
              rej(new Error(`CDP ${method} timed out`));
            }, 5000);
            pending.set(id, { resolve: res, reject: rej, timer });
            ws.send(JSON.stringify({ id, method, params }));
          });
        },
        async evalJs(expression) {
          const out = await this.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
          if (out.exceptionDetails) throw new Error(out.exceptionDetails.exception?.description ?? out.exceptionDetails.text);
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
        const request = pending.get(msg.id);
        pending.delete(msg.id);
        clearTimeout(request.timer);
        if (msg.error) request.reject(new Error(msg.error.message));
        else request.resolve(msg.result);
      }
    });
    ws.addEventListener('error', () => rejectPending(new Error('CDP socket error')));
    ws.addEventListener('close', () => rejectPending(new Error('CDP socket closed')));
  });
}

async function listTargets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) });
  if (!response.ok) throw new Error(`CDP target listing returned ${response.status}`);
  return response.json();
}

async function checkScroll(cdp) {
  const remote = await cdp.call('Runtime.evaluate', { expression: `(${findScrollSurface.toString()})()`, returnByValue: false });
  const objectId = remote.result?.objectId;
  if (!objectId) return { status: 'inconclusive', ok: null, reason: 'No document scroller available' };
  try {
    const read = async () => (await cdp.call('Runtime.callFunctionOn', {
      objectId, functionDeclaration: readScrollSurface.toString(), returnByValue: true,
    })).result?.value;
    const before = await read();
    if (before?.maxScroll > 2) {
      await cdp.call('Input.dispatchMouseEvent', {
        type: 'mouseWheel', x: before.x, y: before.y, deltaX: 0,
        deltaY: before.top >= before.maxScroll - 2 ? -240 : 240,
      });
      await cdp.evalJs(`(${waitForPaint.toString()})()`);
      await waitMs(250);
      await cdp.evalJs(`(${waitForPaint.toString()})()`);
    }
    const after = await read();
    return { ...summarizeScroll(before, after), before, after, input: 'CDP mouseWheel' };
  } finally {
    await cdp.call('Runtime.releaseObject', { objectId }).catch(() => {});
  }
}
async function checkKeyboard(cdp) {
  const describeFocus = `(() => {
    const el = document.activeElement;
    return { tag: el?.tagName ?? '', id: el?.id ?? '', text: (el?.getAttribute('aria-label') || el?.textContent || '').trim().slice(0, 100) };
  })()`;
  const before = await cdp.evalJs(describeFocus);
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  await cdp.evalJs(`(${waitForPaint.toString()})()`);
  const after = await cdp.evalJs(describeFocus);
  return {
    status: after.tag && !['BODY', 'HTML'].includes(after.tag) ? 'passed' : 'inconclusive',
    before, after, input: 'CDP Tab keyDown/keyUp',
  };
}

async function checkSearchInput(cdp) {
  const field = await cdp.evalJs(`(() => {
    const el = [...document.querySelectorAll('input[type="search"], input[name="q"], textarea[name="q"], input[role="combobox"]')]
      .find(el => !el.disabled && !el.readOnly && el.getBoundingClientRect().width > 0 && !['email', 'password'].includes(el.type));
    if (!el) return null;
    el.focus(); el.select();
    return { value: el.value, type: el.type || 'textarea' };
  })()`);
  if (!field) return { status: 'not-tested', reason: 'No visible public search field' };
  try {
    const text = 'kinex compatibility probe';
    await cdp.call('Input.insertText', { text });
    const value = await cdp.evalJs('document.activeElement?.value');
    return { status: value === text ? 'passed' : 'failed', input: 'CDP insertText', submitted: false };
  } finally {
    await cdp.evalJs(`(() => { const el = document.activeElement; if (typeof el?.select === 'function') el.select(); })()`);
    await cdp.call('Input.insertText', { text: field.value });
  }
}

async function run() {
  const cdpPort = await getFreePort();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kinex-live-'));
  const proc = spawn(electronBinary, [root, `--remote-debugging-port=${cdpPort}`], {
    cwd: root,
    env: {
      ...process.env,
      KINEX_TEST_MODE: '1',
      KINEX_DISABLE_AUTO_UPDATER: '1',
      KINEX_USER_DATA_DIR: userDataDir,
    },
    stdio: ['ignore', 'ignore', 'ignore'],
  });

  let shellCdp;
  try {
    let shellTarget;
    const startupDeadline = Date.now() + 15000;
    while (Date.now() < startupDeadline) {
      if (proc.exitCode !== null) throw new Error(`Electron exited during startup (${proc.exitCode})`);
      try {
        const list = await listTargets(cdpPort);
        shellTarget = list.find((target) => target.type === 'page' && target.url.includes('?view=shell'));
        if (shellTarget) break;
      } catch {}
      await waitMs(100);
    }
    if (!shellTarget) throw new Error('Timed out waiting for Kinex shell target');
    shellCdp = await connectCdp(shellTarget.webSocketDebuggerUrl);
    let shellReady = false;
    while (Date.now() < startupDeadline) {
      shellReady = await shellCdp.evalJs('Boolean(window.kinexAPI && document.querySelector(".kinex-shell"))').catch(() => false);
      if (shellReady) break;
      await waitMs(100);
    }
    if (!shellReady) throw new Error('Kinex shell did not become interactive');

    const sites = [
      { name: 'Wikipedia', url: 'https://en.wikipedia.org/wiki/Chromium_(web_browser)' },
      { name: 'GitHub', url: 'https://github.com/n3wbiekkkk/Kinex' },
      { name: 'Google Search', url: 'https://www.google.com/search?q=electron+browser' },
      { name: 'YouTube', url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ' },
      { name: 'Reddit', url: 'https://www.reddit.com/r/mac/' },
      { name: 'Google Docs (landing)', url: 'https://docs.google.com/' },
      { name: 'Gmail (landing)', url: 'https://mail.google.com/' },
      { name: 'Google Drive', url: 'https://drive.google.com/' },
      { name: 'Discord', url: 'https://discord.com/app' },
      { name: 'Twitch', url: 'https://www.twitch.tv/' },
      { name: 'Google Meet', url: 'https://meet.google.com/' },
      { name: 'Figma', url: 'https://www.figma.com/' },
      { name: 'Netflix', url: 'https://www.netflix.com/' },
    ];

    const runtime = JSON.parse(execFileSync(electronBinary, ['-p', 'JSON.stringify(process.versions)'], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8' }));
    const environment = { timestamp: new Date().toISOString(), electron: runtime.electron, chromium: runtime.chrome, node: runtime.node, os: `${os.type()} ${os.release()}`, arch: os.arch() };
    const results = [];
    for (const site of sites) {
      const t0 = performance.now();
      const previousTargets = new Set((await listTargets(cdpPort)).map((target) => target.id));
      const previousTabs = new Set(await shellCdp.evalJs('window.kinexAPI.getState().then(state => state.tabs.map(tab => tab.id))'));
      let tab;
      let pageTarget;
      let pageCdp;
      let page;
      let loadMs;
      let error = null;
      let scroll = { status: 'inconclusive', ok: null, reason: 'Document not ready' };
      let keyboard = { status: 'not-tested' };
      let searchInput = { status: 'not-tested' };
      let media = { status: 'not-tested', reason: 'No playable media observed' };
      let visibility = { visibilityState: 'unknown', hidden: null };
      const deadline = Date.now() + 20000;
      try {
        await shellCdp.evalJs(`window.kinexAPI.dispatch({ type: 'open-url', url: ${JSON.stringify(site.url)}, target: 'new-tab' })`);
        while (Date.now() < deadline) {
          const state = await shellCdp.evalJs('window.kinexAPI.getState()');
          tab = state.tabs.find((candidate) => !previousTabs.has(candidate.id));
          const targets = await listTargets(cdpPort);
          pageTarget = selectProbeTarget(targets, previousTargets, tab?.url, pageTarget?.id);
          if (pageTarget && !pageCdp) pageCdp = await connectCdp(pageTarget.webSocketDebuggerUrl);
          if (tab && !tab.isLoading && pageCdp) {
            page = await pageCdp.evalJs(`(${publicPageInfo.toString()})()`).catch(() => null);
            if (page?.ready && page.url !== 'about:blank' && page.url === tab.url) break;
          }
          await waitMs(150);
        }
        if (!tab) throw new Error('No new application tab observed');
        if (!pageTarget || !pageCdp) throw new Error('Could not identify a unique new page target');
        if (!page?.ready || tab.isLoading || page.url !== tab.url) throw new Error('Page did not settle at the application tab URL before deadline');
        loadMs = Math.round(performance.now() - t0);

        // A backgrounded tab stops producing compositor frames, so wheel input and
        // animation-frame waits never complete and surface as CDP timeouts. Focus the
        // tab under test before driving it, and record the visibility we actually got
        // so an infrastructure limitation is never reported as a website failure.
        await shellCdp.evalJs(`window.kinexAPI.dispatch({ type: 'select-tab', tabId: ${JSON.stringify(tab.id)} })`);
        const visibilityDeadline = Date.now() + 3000;
        while (Date.now() < visibilityDeadline) {
          visibility = await pageCdp.evalJs(`(${readProbeVisibility.toString()})()`).catch(() => visibility);
          if (visibility.visibilityState === 'visible') break;
          await waitMs(100);
        }
        const probeFocused = visibility.visibilityState === 'visible';

        if (!page.errorPage && !page.blocked && !probeFocused) {
          // Not a browser or website defect: the probe could not drive a hidden tab.
          error = `Probe could not focus the tab under test (visibilityState=${visibility.visibilityState}); scroll and paint checks cannot run on a backgrounded tab`;
        } else if (!page.errorPage && !page.blocked) {
          const scrollDeadline = Date.now() + 3500;
          do {
            scroll = await checkScroll(pageCdp);
            if (scroll.status === 'passed') break;
            await waitMs(350);
          } while (Date.now() < scrollDeadline);
          keyboard = await checkKeyboard(pageCdp);
          searchInput = await checkSearchInput(pageCdp);
          page = await pageCdp.evalJs(`(${publicPageInfo.toString()})()`);
          const firstMedia = page.media;
          if (firstMedia.some((item) => !item.paused && item.readyState >= 2)) {
            await waitMs(1000);
            const latest = await pageCdp.evalJs(`(${publicPageInfo.toString()})()`);
            media = {
              status: latest.media.some((item, index) => item.currentTime > (firstMedia[index]?.currentTime ?? Infinity)) ? 'passed' : 'failed',
              before: firstMedia,
              after: latest.media,
              reason: 'Observed playback clock progression; audio output/fullscreen/PiP not exercised',
            };
          } else if (firstMedia.length) {
            media = { status: 'not-tested', reason: 'Media present but not playing; autoplay, consent, or login may require interaction', elements: firstMedia };
          }
          page = await pageCdp.evalJs(`(${publicPageInfo.toString()})()`);
        }
      } catch (cause) {
        error = cause.message;
      } finally {
        pageCdp?.close();
      }
      if (tab) tab = await shellCdp.evalJs(`window.kinexAPI.getState().then(state => state.tabs.find(tab => tab.id === ${JSON.stringify(tab.id)}))`);
      const tree = sampleProcessTree(proc.pid);
      const loaded = Boolean(page?.ready && !page.errorPage && tab && !tab.isLoading && page.url === tab.url);
      // Separate a probe infrastructure limitation from a browser or website defect.
      // A CDP timeout or an un-focusable tab says nothing about the site's compatibility.
      // Keep every error inconclusive rather than failed: an unverified site is not a
      // proven failure, and failureClass carries the distinction.
      const infrastructureFailure = Boolean(error) && (
        /^CDP .* timed out/.test(error) ||
        /^CDP socket (closed|error)/.test(error) ||
        /Probe could not focus the tab under test/.test(error)
      );
      const verdict = error ? 'inconclusive'
        : page?.blocked ? 'blocked-by-site'
          : !loaded || scroll.status === 'failed' || searchInput.status === 'failed' || media.status === 'failed' ? 'failed'
            : page?.authWall ? 'partial' : scroll.status === 'passed' && keyboard.status === 'passed' ? 'public-checks-passed' : 'partial';
      results.push({
        environment,
        site: site.name,
        requestedUrl: site.url,
        finalUrl: page?.url ?? tab?.url ?? 'timeout',
        title: page?.title ?? tab?.title ?? '',
        loaded,
        loadMs: loadMs ?? Math.round(performance.now() - t0),
        probeMs: Math.round(performance.now() - t0),
        scrollOk: scroll.ok,
        verdict,
        error,
        failureClass: error ? (infrastructureFailure ? 'probe-infrastructure' : 'browser-or-site') : null,
        visibility,
        tabId: tab?.id ?? null,
        targetId: pageTarget?.id ?? null,
        redirected: Boolean(page?.url && page.url !== site.url),
        checks: { scroll, keyboard, searchInput, media },
        page,
        limitations: [
          'Fresh disposable profile; no account login or authenticated workflows attempted',
          'Search input is typed and restored without submission',
          'Uploads, downloads, clipboard, OAuth popups, audio output, fullscreen, PiP and permission prompts require separate controlled tests',
          'Navigation time is a single network-dependent observation, not a performance benchmark',
        ],
        ...tree,
      });
    }

    const outPath = process.argv.find((a) => a.startsWith('--out='))?.slice(6);
    if (outPath) {
      fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
      fs.writeFileSync(outPath, JSON.stringify(results, null, 2), 'utf8');
    }
    console.log(JSON.stringify(results, null, 2));
  } finally {
    try { shellCdp?.close(); } catch {}
    if (proc.exitCode === null) {
      proc.kill('SIGTERM');
      await Promise.race([
        new Promise((resolve) => proc.once('exit', resolve)),
        waitMs(3000),
      ]);
      if (proc.exitCode === null && proc.signalCode === null) {
        proc.kill('SIGKILL');
        await new Promise((resolve) => proc.once('exit', resolve));
      }
    }
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
