import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const roots = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

describe('local release version preparation', () => {
  for (const [args, expected] of [[[], '0.7.4'], [['--minor'], '0.8.0'], [['--no-bump'], '0.7.3']]) {
    it(`keeps the manifest and lockfile at ${expected} with ${args.join(' ') || 'default patch'}`, () => {
      const root = mkdtempSync(join(tmpdir(), 'kinex-release-test-'));
      roots.push(root);
      mkdirSync(join(root, 'scripts'));
      copyFileSync(new URL('./release-local.mjs', import.meta.url), join(root, 'scripts/release-local.mjs'));
      // These fixtures exercise orchestration and real npm versioning, not application packaging.
      const scripts = Object.fromEntries(['typecheck', 'test', 'package:mac'].map(name => [name, 'node -e "process.exit(0)"']));
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'kinex-release-test', version: '0.7.3', scripts }));
      writeFileSync(join(root, 'package-lock.json'), JSON.stringify({
        name: 'kinex-release-test', version: '0.7.3', lockfileVersion: 3,
        packages: { '': { name: 'kinex-release-test', version: '0.7.3' } },
      }));
      const output = execFileSync(process.execPath, [join(root, 'scripts/release-local.mjs'), ...args], { encoding: 'utf8', timeout: 15000 });
      const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
      const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
      expect([manifest.version, lock.version, lock.packages[''].version]).toEqual([expected, expected, expected]);
      expect(output).toContain('Automatic installation requires compatible Developer ID signing');
    });
  }
});
