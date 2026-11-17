import { execFileSync, execSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
if (!process.argv.includes('--no-bump')) {
  execFileSync('npm', ['version', process.argv.includes('--minor') ? 'minor' : 'patch', '--no-git-tag-version'], {
    cwd: root,
    stdio: 'inherit',
  });
}

execSync('npm run typecheck && npm test && npm run package:mac', {
  cwd: root,
  stdio: 'inherit',
});

console.log(`\nRelease ready in ${path.join(root, 'release')}`);
console.log('Local package only. Automatic installation requires compatible Developer ID signing and update qualification.');
