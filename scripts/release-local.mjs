import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const pkgPath = path.join(root, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

if (!process.argv.includes('--no-bump')) {
  const [maj, min, pat] = String(pkg.version).split('.').map(Number);
  const bumpMinor = process.argv.includes('--minor');
  const nextVersion = bumpMinor ? `${maj}.${min + 1}.0` : `${maj}.${min}.${pat + 1}`;
  pkg.version = nextVersion;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  console.log(`Bumped Kinex version -> ${nextVersion}`);
}

execSync('npm run typecheck && npm test && npm run package:mac', {
  cwd: root,
  stdio: 'inherit',
});

console.log(`\nRelease ready in ${path.join(root, 'release')}`);
console.log('Running Kinex.app instances configured with this release folder can now auto-update.');
