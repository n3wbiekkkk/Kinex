import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import yaml from 'js-yaml';

const workflow = yaml.load(readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'));
const steps = workflow.jobs['release-mac'].steps;
const roots = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'kinex-release-workflow-'));
  roots.push(root);
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'main');
  writeFileSync(join(root, 'package.json'), '{"version":"0.7.4"}');
  git('add', 'package.json');
  git('-c', 'user.name=Release Test', '-c', 'user.email=test@localhost', 'commit', '-m', 'fixture');
  git('remote', 'add', 'origin', root);
  mkdirSync(join(root, 'bin'));
  // Only the external publication boundary is replaced; versioning and refs use real Git.
  writeFileSync(join(root, 'bin/gh'), '#!/bin/bash\nprintf "%s\\n" "$*" >> "$TRACE"\nif [ "$1 $2" = "release view" ]; then exit 1; fi\n', { mode: 0o755 });
  const run = (name, env = {}) => spawnSync('/bin/bash', ['-e', '-o', 'pipefail', '-c', steps.find(step => step.name === name).run], {
    cwd: root, encoding: 'utf8', timeout: 10000,
    env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`, GITHUB_OUTPUT: join(root, 'outputs'),
      GITHUB_EVENT_NAME: 'workflow_run', TAG: 'v0.7.4', TRACE: join(root, 'trace'), ...env },
  });
  return { root, git, run };
}

it('resolves a fresh main-push version and rejects mismatched explicit tags', () => {
  const { root, run } = fixture();
  expect(run('Resolve release channel').status).toBe(0);
  expect(readFileSync(join(root, 'outputs'), 'utf8')).toContain('tag=v0.7.4');
  expect(run('Resolve release channel', { GITHUB_EVENT_NAME: 'push', GITHUB_REF_NAME: 'v0.7.3' }).status).not.toBe(0);
});

it('rejects version tags belonging to another commit, including annotated tags', () => {
  const { root, git, run } = fixture();
  git('-c', 'user.name=Release Test', '-c', 'user.email=test@localhost', 'tag', '-a', 'v0.7.4', '-m', 'fixture');
  expect(run('Resolve release channel').status).toBe(0);
  writeFileSync(join(root, 'package.json'), '{"version":"0.7.4","changed":true}');
  git('add', 'package.json');
  git('-c', 'user.name=Release Test', '-c', 'user.email=test@localhost', 'commit', '-m', 'changed');
  expect(run('Resolve release channel').status).not.toBe(0);
});

it('does not publish a stale commit after main advances', () => {
  const { root, git, run } = fixture();
  const previous = git('rev-parse', 'HEAD');
  git('-c', 'user.name=Release Test', '-c', 'user.email=test@localhost', 'commit', '--allow-empty', '-m', 'newer');
  git('checkout', '--detach', previous);
  expect(run('Publish GitHub Release').status).toBe(0);
  expect(existsSync(join(root, 'trace'))).toBe(false);
});

it('uploads a new version as a draft before exposing it through Latest', () => {
  const { root, run } = fixture();
  expect(run('Publish GitHub Release').status).toBe(0);
  const trace = readFileSync(join(root, 'trace'), 'utf8');
  expect(trace).toMatch(/release create v0.7.4 .*--draft --target [a-f0-9]{40}/);
  expect(trace.trim().split('\n').at(-1)).toBe('release edit v0.7.4 --draft=false --prerelease=false --latest');
});

it('blocks publication with missing signing credentials', () => {
  const { run } = fixture();
  const result = run('Require signing and notarization configuration', {
    CSC_LINK: '', CSC_KEY_PASSWORD: '', APPLE_ID: '', APPLE_APP_SPECIFIC_PASSWORD: '', APPLE_TEAM_ID: '',
  });
  expect(result.status).not.toBe(0);
  expect(result.stdout).toContain('::error::Missing release secret: CSC_LINK.');
});
