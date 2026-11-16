import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const electronBinary = require('electron');
const root = path.resolve(import.meta.dirname, '..', '..');

const leakReportPath = path.join(os.tmpdir(), `kinex-leak-report-${process.pid}.json`);

// Run Scenarios 1-6 inside Electron with --expose-gc
const workerRes = spawnSync(
  electronBinary,
  ['--js-flags=--expose-gc', path.join(root, 'tests', 'perf', 'electron-leak-worker.cjs')],
  {
    cwd: root,
    env: {
      ...process.env,
      KINEX_TEST_MODE: '1',
      KINEX_DISABLE_AUTO_UPDATER: '1',
      KINEX_LEAK_REPORT_PATH: leakReportPath,
    },
    stdio: 'inherit',
  }
);

assert.equal(workerRes.status, 0, `Leak stress worker exited with code ${workerRes.status}`);
assert.equal(fs.existsSync(leakReportPath), true, 'Expected leak report file');
const workerReport = JSON.parse(fs.readFileSync(leakReportPath, 'utf8'));
fs.unlinkSync(leakReportPath);
assert.equal(workerReport.ok, true);

// Scenario 7: Repeatedly restart and restore sessions (5 full restarts)
const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kinex-restart-stress-'));
try {
  for (let i = 0; i < 5; i++) {
    const checkScript = `
      const fs = require('node:fs');
      const path = require('node:path');
      const { app, protocol } = require('electron');
      app.setPath('userData', ${JSON.stringify(sessionDir)});
      protocol.registerSchemesAsPrivileged([
        { scheme: 'kinex', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
        { scheme: 'nook', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
      ]);
      const { KinexWindowManager, registerKinexProtocol } = require(${JSON.stringify(path.join(root, 'dist-electron/main/windowManager'))});
      app.on('window-all-closed', (e) => e.preventDefault());
      app.whenReady().then(async () => {
        registerKinexProtocol(protocol);
        const mgr = new KinexWindowManager(${JSON.stringify(sessionDir)});
        const win = mgr.createWindow();
        if (${i} === 0) {
          await mgr.handleIntent({ type: 'open-url', url: 'https://example.org/session-keep', target: 'new-tab' });
        } else {
          const found = mgr.getSnapshot().tabs.some(t => t.url.includes('session-keep'));
          if (!found) process.exit(2);
        }
        mgr.cleanupWindowResources();
        win.destroy();
        mgr.dispose();
        app.exit(0);
      });
    `;
    const tmpScript = path.join(os.tmpdir(), `kinex-restart-${process.pid}-${i}.cjs`);
    fs.writeFileSync(tmpScript, checkScript, 'utf8');
    const r = spawnSync(electronBinary, [tmpScript], {
      cwd: root,
      env: { ...process.env, KINEX_TEST_MODE: '1', KINEX_DISABLE_AUTO_UPDATER: '1' },
      stdio: 'inherit',
    });
    fs.unlinkSync(tmpScript);
    assert.equal(r.status, 0, `Restart cycle ${i + 1} failed with code ${r.status}`);
  }
} finally {
  fs.rmSync(sessionDir, { recursive: true, force: true });
}

console.log(
  'LEAK_STRESS_ALL_7_SCENARIOS_PASS',
  JSON.stringify({ ...workerReport, restartRestoreCycles: 5 }, null, 2)
);
