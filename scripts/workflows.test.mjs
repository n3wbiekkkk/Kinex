import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const release = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');

test('CI separates fast checks from real Electron and packaging work', () => {
  for (const job of ['fast-checks:', 'e2e:', 'package:']) assert.match(ci, new RegExp(`^  ${job}`, 'm'));
  assert.match(ci, /needs: fast-checks/);
  assert.match(ci, /needs: e2e/);
  assert.match(ci, /npm run package:mac/);
  assert.match(ci, /run-dmg\.mjs/);
});

test('CI ignores documentation and cancels stale branch runs', () => {
  assert.equal(ci.match(/paths-ignore:/g)?.length, 2);
  assert.match(ci, /group: ci-\$\{\{ github\.ref \}\}/);
  assert.match(ci, /cancel-in-progress: true/);
});

test('CI and release cache locked JavaScript, Electron, and Rust dependencies', () => {
  for (const workflow of [ci, release]) {
    assert.match(workflow, /cache: npm/);
    assert.match(workflow, /~\/Library\/Caches\/electron/);
    assert.match(workflow, /~\/\.cargo/);
    assert.match(workflow, /CARGO_TARGET_DIR/);
    assert.match(workflow, /hashFiles\('package\.json', 'package-lock\.json'\)/);
  }
});

test('Release publication stays serialized and credential-free at checkout', () => {
  assert.match(release, /group: kinex-macos-release/);
  assert.match(release, /cancel-in-progress: false/);
  assert.match(release, /persist-credentials: false/);
  assert.match(release, /github\.event\.workflow_run\.head_sha/);
});
