import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '..', '..');
const electron = require('electron');
let output = '';
const child = spawn(electron, [path.join(root, 'tests/integration/extensions.cjs')], {
  cwd: root,
  env: { ...process.env, KINEX_TEST_MODE: '1', KINEX_DISABLE_AUTO_UPDATER: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', (data) => { output += data; process.stdout.write(data); });
child.stderr.on('data', (data) => { output += data; process.stderr.write(data); });
const code = await new Promise((resolve) => child.once('exit', resolve));
assert.equal(code, 0, `Extensions integration failed: ${output}`);
assert.match(output, /EXTENSIONS_PASS/);
console.log('Extension integration passed.');
