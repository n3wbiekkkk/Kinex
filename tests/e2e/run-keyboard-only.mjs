import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '..', '..');
const outFlag = process.argv.find((argument) => argument.startsWith('--out='));
const outDir = path.resolve(outFlag?.slice(6) || path.join(os.tmpdir(), 'kinex-keyboard-results'));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kinex-keyboard-'));
fs.mkdirSync(outDir, { recursive: true });
try {
  const child = spawn(require('electron'), [path.join(root, 'tests/e2e/keyboard-only.cjs'), `--out=${outDir}`], {
    cwd: root,
    env: { ...process.env, KINEX_QUALITY_USER_DATA_DIR: scratch, KINEX_TEST_MODE: '1', KINEX_DISABLE_AUTO_UPDATER: '1' },
    stdio: 'inherit',
  });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, 150000);
  const forceTimer = setTimeout(() => child.kill('SIGKILL'), 155000);
  const status = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  }).finally(() => { clearTimeout(timer); clearTimeout(forceTimer); });
  assert.equal(timedOut, false, 'Keyboard acceptance exceeded 150 seconds');
  assert.equal(status.code, 0, `Keyboard acceptance failed (${status.code ?? status.signal})`);
  const report = JSON.parse(fs.readFileSync(path.join(outDir, 'keyboard-results.json'), 'utf8'));
  assert.equal(report.ok, true);
  assert.equal(report.steps.filter((step) => step.number <= 20 && step.status === 'passed').length, 20);
  assert.equal(report.input.mouseEvents, 0);
  console.log(`Keyboard-only acceptance passed. Report: ${path.join(outDir, 'keyboard-results.json')}`);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
