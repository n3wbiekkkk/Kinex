import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const electronBinary = require('electron');
const root = path.resolve(import.meta.dirname, '..', '..');
const reportPath = path.join(os.tmpdir(), `kinex-int-report-${process.pid}.json`);

const res = spawnSync(electronBinary, [path.join(root, 'tests', 'integration', 'electron-integration.cjs')], {
  cwd: root,
  env: {
    ...process.env,
    KINEX_TEST_MODE: '1',
    KINEX_DISABLE_AUTO_UPDATER: '1',
    KINEX_REPORT_PATH: reportPath,
  },
  stdio: 'inherit',
});

assert.equal(res.status, 0, `Electron integration process failed with exit code ${res.status}`);
assert.equal(fs.existsSync(reportPath), true, 'Expected integration report JSON file to exist');
const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
fs.unlinkSync(reportPath);
assert.equal(report.ok, true);
console.log('Electron Integration Suite PASSED:', report);
