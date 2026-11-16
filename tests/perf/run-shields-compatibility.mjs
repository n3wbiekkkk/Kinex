import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '..', '..');

const workerCode = `
const fs = require('node:fs');
const { app, BrowserWindow, ipcMain, protocol } = require('electron');

const userData = process.env.KINEX_USER_DATA_DIR;
app.setPath('userData', userData);
process.env.KINEX_DISABLE_AUTO_UPDATER = '1';
protocol.registerSchemesAsPrivileged(['kinex', 'nook'].map((scheme) => ({
  scheme, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
})));

const { KinexWindowManager, ensureAppName, registerKinexProtocol } = require(${JSON.stringify(path.join(root, 'dist-electron/main/windowManager'))});
const { registerKinexIpcHandlers } = require(${JSON.stringify(path.join(root, 'dist-electron/main/ipcHandlers'))});
const { getFocusedTab } = require(${JSON.stringify(path.join(root, 'dist-electron/shared/domain'))});

const targets = [
  { name: 'YouTube', url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ' },
  { name: 'Twitch', url: 'https://www.twitch.tv/' },
  { name: 'Reddit', url: 'https://www.reddit.com/' },
  { name: 'GitHub', url: 'https://github.com/n3wbiekkkk/Kinex' },
  { name: 'Google Search', url: 'https://www.google.com/search?q=electron+browser' },
  { name: 'Gmail', url: 'https://mail.google.com/' },
  { name: 'Google Docs', url: 'https://docs.google.com/' },
  { name: 'Wikipedia', url: 'https://en.wikipedia.org/wiki/Ad_blocking' },
];

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitLoaded(mgr, targetUrl, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tab = getFocusedTab(mgr.getSnapshot());
    if (tab && !tab.isLoading && tab.url && !tab.url.startsWith('kinex://welcome')) {
      return tab;
    }
    await delay(100);
  }
  return getFocusedTab(mgr.getSnapshot());
}

app.whenReady().then(async () => {
  ensureAppName();
  registerKinexProtocol(protocol);
  const mgr = new KinexWindowManager(userData);
  registerKinexIpcHandlers(ipcMain, () => mgr);
  const win = mgr.createWindow();
  await delay(500);

  const report = [];
  for (const mode of ['disabled', 'standard', 'aggressive']) {
    await mgr.handleIntent({ type: 'set-shields-global-mode', mode });
    for (const site of targets) {
      const t0 = performance.now();
      await mgr.handleIntent({ type: 'open-url', url: site.url, target: 'new-tab' });
      const tab = await waitLoaded(mgr, site.url);
      await delay(900);
      const navMs = Math.round(performance.now() - t0);
      const view = tab ? mgr.tabManager.getView(tab.id) : null;
      let probe = { ok: false };
      if (view && !view.webContents.isDestroyed()) {
        try {
          probe = await view.webContents.executeJavaScript(\`(() => {
            const textLen = (document.body?.innerText || '').trim().length;
            const imgs = document.querySelectorAll('img').length;
            const media = document.querySelectorAll('video, audio').length;
            const isAuthWall = /accounts\\\\.google|login|signin/i.test(location.href);
            const isChallenge = /sorry|captcha|challenge|verify/i.test(document.title + ' ' + location.href);
            return {
              ok: true,
              finalHost: location.hostname,
              title: document.title.slice(0, 60),
              textLen,
              imgs,
              media,
              isAuthWall,
              isChallenge,
              scrollHeight: document.documentElement?.scrollHeight || 0
            };
          })()\`);
        } catch (err) {
          probe = { ok: false, error: err.message };
        }
      }
      const stats = tab ? mgr.getSnapshot().shieldsRuntime.tabStats[tab.id] : null;
      report.push({
        site: site.name,
        mode,
        navMs,
        blockedTotal: stats?.total ?? 0,
        blockedAds: stats?.ads ?? 0,
        blockedTrackers: stats?.trackers ?? 0,
        ...probe,
      });
      if (tab) {
        await mgr.handleIntent({ type: 'close-tab', tabId: tab.id });
      }
    }
  }

  fs.writeFileSync(process.env.KINEX_REPORT_PATH, JSON.stringify(report, null, 2));
  mgr.dispose();
  if (!win.isDestroyed()) win.destroy();
  app.exit(0);
});
`;

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kinex-compat-'));
const workerFile = path.join(scratch, 'worker.cjs');
const outFile = path.join(scratch, 'compat.json');
fs.writeFileSync(workerFile, workerCode);

try {
  const run = spawnSync(require('electron'), [workerFile], {
    cwd: root,
    env: {
      ...process.env,
      KINEX_USER_DATA_DIR: path.join(scratch, 'profile'),
      KINEX_DISABLE_AUTO_UPDATER: '1',
      KINEX_REPORT_PATH: outFile,
    },
    stdio: 'inherit',
    timeout: 180000,
  });
  if (fs.existsSync(outFile)) {
    console.log('SHIELDS_COMPAT_JSON:' + fs.readFileSync(outFile, 'utf8'));
  }
  process.exitCode = run.status ?? 1;
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
