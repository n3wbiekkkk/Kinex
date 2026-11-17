import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import plist from 'plist';
import yaml from 'js-yaml';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const pkg = JSON.parse(read('../package.json'));
const production = plist.parse(read('../build/entitlements.mac.plist'));
const preview = plist.parse(read('../build/entitlements.preview.mac.plist'));

it('limits the library-validation exception to the explicit ad-hoc preview profile', () => {
  expect(pkg.build.mac.hardenedRuntime).toBe(true);
  expect(pkg.build.mac.entitlements).toBe('build/entitlements.mac.plist');
  expect(pkg.build.mac.entitlementsInherit).toBe('build/entitlements.mac.plist');
  expect(production).not.toHaveProperty('com.apple.security.cs.disable-library-validation');
  expect(preview).toEqual({ ...production, 'com.apple.security.cs.disable-library-validation': true });
  expect(pkg.scripts['package:mac']).toContain('--config.mac.identity=-');
  expect(pkg.scripts['package:mac']).toContain('--config.mac.entitlements=build/entitlements.preview.mac.plist');
  expect(pkg.scripts['package:mac']).toContain('--config.mac.entitlementsInherit=build/entitlements.preview.mac.plist');
  expect(pkg.scripts['package:mac']).not.toContain('hardenedRuntime=false');
});

it('uses the sealed preview package in both CI and manual-preview releases', () => {
  const ci = yaml.load(read('../.github/workflows/ci.yml'));
  const release = yaml.load(read('../.github/workflows/release.yml'));
  expect(ci.jobs['package'].steps.some(step => step.run === 'npm run package:mac')).toBe(true);
  const steps = release.jobs['release-mac'].steps;
  const manual = steps.find(step => step.if === "steps.signing.outputs.signed == 'false'");
  expect(manual.run).toContain('npm run package:mac');
  const signed = steps.find(step => step.if === "steps.signing.outputs.signed == 'true'");
  expect(signed.run).toContain('--config.forceCodeSigning=true');
  expect(signed.run).not.toContain('entitlements.preview');
  expect(signed.run).not.toContain('identity=-');
});
