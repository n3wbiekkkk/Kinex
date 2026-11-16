import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '..', '..');
const reportPath = path.join(os.tmpdir(), `kinex-experience-report-${process.pid}.json`);
const result = spawnSync(require('electron'), [path.join(root, 'tests/integration/experience-integration.cjs')], {
  cwd: root,
  env: { ...process.env, KINEX_TEST_MODE: '1', KINEX_DISABLE_AUTO_UPDATER: '1', KINEX_REPORT_PATH: reportPath },
  stdio: 'inherit',
  timeout: 180000,
});
let report;
if (fs.existsSync(reportPath)) {
  report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  const out = process.argv.find((arg) => arg.startsWith('--out='))?.slice(6);
  if (out) {
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(report, null, 2));
  }
  fs.unlinkSync(reportPath);
}
assert.ifError(result.error);
assert.equal(result.status, 0, `Experience integration failed: ${report?.error ?? result.signal ?? result.status}`);
assert.equal(report?.ok, true, 'Experience integration must produce a passing report');
console.log('Experience Integration PASSED:', report);
