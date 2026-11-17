import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '../..');
const result = spawnSync(require('electron'), [path.join(root, 'tests/integration/security-regression.cjs')], {
  cwd: root,
  env: { ...process.env, KINEX_TEST_MODE: '1', KINEX_DISABLE_AUTO_UPDATER: '1' },
  stdio: 'inherit',
  timeout: 120000,
});
assert.ifError(result.error);
assert.equal(result.status, 0, `Security regression process failed (${result.status ?? result.signal})`);
