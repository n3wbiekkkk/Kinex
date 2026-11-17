import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const dmg = path.join(root, 'release', `Kinex-${version}-arm64.dmg`);
assert.ok(fs.statSync(dmg).size > 0, 'Release must include a nonempty arm64 DMG');
execFileSync('hdiutil', ['verify', dmg], { stdio: 'inherit', timeout: 60000 });

const mount = fs.mkdtempSync(path.join(os.tmpdir(), 'kinex-dmg-'));
let mounted = false;
try {
  execFileSync('hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, dmg], { stdio: 'inherit', timeout: 60000 });
  mounted = true;
  execFileSync(process.execPath, [
    path.join(root, 'tests/integration/run-packaged.mjs'),
    `--app=${path.join(mount, 'Kinex.app')}`,
    '--out=artifacts/ci/dmg.json',
  ], { cwd: root, stdio: 'inherit', timeout: 120000 });
  console.log(`DMG verification and mounted application startup passed: ${path.basename(dmg)}`);
} finally {
  if (mounted) execFileSync('hdiutil', ['detach', mount], { stdio: 'inherit', timeout: 30000 });
  fs.rmdirSync(mount);
}
