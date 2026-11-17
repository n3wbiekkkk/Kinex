import { execFile, execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  detectInstallLocation,
  getRunningAppBundlePath,
  launchMacUpdateHelper,
  stageMacUpdate,
  updateHelperScript,
  validateMacUpdateArchive,
  validateStagedBundle,
} from './macUpdater';

const exec = promisify(execFile);
const dirs: string[] = [];
const children: ReturnType<typeof spawn>[] = [];

// The updater gates its macOS-only paths on `process.platform` (a configurable
// data property). Force darwin for the pre-existing integrity tests so they
// behave identically on every host; the fallback suite overrides it per case.
const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { ...realPlatform, value: platform, configurable: true });
}

const run = async (command: string, args: string[]) => {
  const result = await exec(command, args);
  return `${result.stdout}\n${result.stderr}`;
};

function temp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kinex-updater-test-'));
  dirs.push(dir);
  return dir;
}

function bundle(parent: string, version = '9.9.9'): string {
  const app = path.join(parent, 'Kinex.app');
  fs.mkdirSync(path.join(app, 'Contents/MacOS'), { recursive: true });
  fs.mkdirSync(path.join(app, 'Contents/Resources'));
  const source = path.join(parent, `.main-${version}.c`);
  fs.writeFileSync(source, 'int main(void) { return 0; }\n');
  execFileSync('/usr/bin/clang', ['-arch', 'arm64', source, '-o', path.join(app, 'Contents/MacOS/Kinex')]);
  fs.rmSync(source);
  fs.writeFileSync(path.join(app, 'Contents/Resources/app.asar'), `signed-${version}`);
  fs.writeFileSync(path.join(app, 'Contents/Info.plist'), `<?xml version="1.0"?><plist><dict>
    <key>CFBundleIdentifier</key><string>com.kinex.browser</string>
    <key>CFBundleExecutable</key><string>Kinex</string>
    <key>CFBundleShortVersionString</key><string>${version}</string>
    <key>CFBundlePackageType</key><string>APPL</string></dict></plist>`);
  execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', '--options', 'runtime', app]);
  return app;
}

function scriptTool(parent: string, name: string, body: string): string {
  const file = path.join(parent, name);
  fs.writeFileSync(file, `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  return file;
}

beforeEach(() => setPlatform('darwin'));
afterEach(() => {
  Object.defineProperty(process, 'platform', realPlatform);
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill('SIGKILL');
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const native = describe.skipIf(process.platform !== 'darwin' || process.arch !== 'arm64');
describe('macOS update integrity and archives', () => {
  it.each([
    ['', 'no valid SHA-256'],
    ['0'.repeat(63), 'no valid SHA-256'],
    ['0'.repeat(64), 'failed integrity'],
  ])('rejects checksum %j without extracting', async (sha256, message) => {
    const root = temp();
    const archive = path.join(root, 'update.zip');
    fs.writeFileSync(archive, 'tampered');
    const run = vi.fn();
    await expect(stageMacUpdate(archive,
      { version: '9.9.9', assetUrl: 'https://invalid', assetName: 'update.zip', sha256 },
      { kind: 'writable', appBundlePath: path.join(root, 'Kinex.app') }, root, { run }
    )).rejects.toThrow(message);
    expect(run).not.toHaveBeenCalled();
    expect(fs.readdirSync(root)).toEqual(['update.zip']);
  });

  it('rejects traversal and escaping links without extraction', async () => {
    const root = temp();
    const archive = path.join(root, 'unsafe.zip');
    await exec('/usr/bin/python3', ['-c', `import sys,zipfile
z=zipfile.ZipFile(sys.argv[1],"w")
a=zipfile.ZipInfo("Kinex.app/link");a.external_attr=0o120777<<16
z.writestr(a,"../../../../../../escape")
z.writestr("Kinex.app/../../../escape","bad")
z.close()`, archive]);
    const run = vi.fn();
    await expect(stageMacUpdate(archive, {
      version: '9.9.9', assetUrl: 'https://invalid', assetName: 'unsafe.zip',
      sha256: createHash('sha256').update(fs.readFileSync(archive)).digest('hex'),
    }, { kind: 'writable', appBundlePath: path.join(root, 'Kinex.app') }, root, { run }))
      .rejects.toThrow('Unsafe update archive');
    expect(run).not.toHaveBeenCalled();
    expect(fs.readdirSync(root)).toEqual(['unsafe.zip']);
  });
});

native('macOS archive and signed bundle staging', () => {
  it('accepts a real Kinex.app zip', async () => {
    const root = temp();
    fs.mkdirSync(path.join(root, 'Kinex.app/Contents/MacOS'), { recursive: true });
    fs.writeFileSync(path.join(root, 'Kinex.app/Contents/MacOS/Kinex'), 'fixture');
    const archive = path.join(root, 'valid.zip');
    await exec('/usr/bin/ditto', ['-c', '-k', '--keepParent', path.join(root, 'Kinex.app'), archive]);
    await validateMacUpdateArchive(archive);
    const extract = path.join(root, 'extract');
    fs.mkdirSync(extract);
    await exec('/usr/bin/ditto', ['-xk', archive, extract]);
    expect(fs.readFileSync(path.join(extract, 'Kinex.app/Contents/MacOS/Kinex'), 'utf8')).toBe('fixture');
  });

  it('stages a verified real zip and validates its signed bundle', async () => {
    const root = temp();
    const input = path.join(root, 'input');
    fs.mkdirSync(input);
    bundle(input);
    const archive = path.join(root, 'update.zip');
    await exec('/usr/bin/ditto', ['-c', '-k', '--keepParent', path.join(input, 'Kinex.app'), archive]);
    const stagingParent = path.join(root, 'staging');
    fs.mkdirSync(stagingParent);
    const staged = await stageMacUpdate(archive, {
      version: '9.9.9', assetUrl: 'https://invalid', assetName: 'update.zip',
      sha256: createHash('sha256').update(fs.readFileSync(archive)).digest('hex'),
    }, { kind: 'writable', appBundlePath: path.join(stagingParent, 'Kinex.app') }, root, { run });
    await validateStagedBundle(staged.appBundlePath, staged.version);
    expect(await exec('/usr/bin/lipo', ['-archs', path.join(staged.appBundlePath, 'Contents/MacOS/Kinex')])).toMatchObject({ stdout: expect.stringContaining('arm64') });
    expect(path.dirname(staged.appBundlePath)).toBe(staged.stagingDirectory);
    expect(path.basename(staged.stagingDirectory)).toMatch(/^\.kinex-update-/);
    expect(fs.readFileSync(path.join(staged.stagingDirectory, 'install-update.sh'), 'utf8')).toBe(updateHelperScript());
  });
});

describe('read-only update installation', () => {
  const absent = async () => Promise.reject(new Error('must not probe permissions'));
  const identity = async (p: fs.PathLike) => String(p);
  it.each([
    ['/Applications/Kinex.app', '/dev/disk1s1 on / (apfs, local, nodev, nosuid, journaled)\n/dev/disk2s1 on /Applications (apfs, read-only, nosuid)'],
    ['/mnt/Kinex.app', '/dev/disk2s1 on /mnt (apfs, local, read-only)'],
    ['/Volumes/Kinex Preview/Kinex.app', '/dev/disk2s1 on /Volumes/Kinex Preview (hfs, local, nodev, nosuid, journaled, mounted by test)'],
  ])('detects read-only ancestors for %s', async (app, mounts) => {
    await expect(detectInstallLocation(app, async () => mounts, absent, identity)).resolves.toMatchObject({ kind: 'read-only', appBundlePath: app });
  });
  it('rejects unreadable installation parents with a closed error', async () => {
    const inaccessible = async () => Promise.reject(new Error('EACCES'));
    await expect(detectInstallLocation('/Applications/Kina.app', async () => '',
      async () => { throw new Error('must not access'); }, identity)).rejects.toThrow('Installed application bundle is invalid');
    await expect(detectInstallLocation('/Applications/Kinex.app', async () => '', inaccessible, identity))
      .rejects.toThrowError(/^Kinex cannot replace the application folder\. Move Kinex to Applications and make sure you have permission to update it\.$/);
  });

  it('allows writable ordinary local applications', async () => {
    await expect(detectInstallLocation('/Users/test/Applications/Kinex.app', async () => '/dev/disk1s1 on / (apfs, local, journaled)',
      async () => {}, identity)).resolves.toEqual({ kind: 'writable', appBundlePath: '/Users/test/Applications/Kinex.app' });
  });
});

describe.skipIf(process.platform !== 'darwin' || process.arch !== 'arm64')('actual helper process', () => {
  async function fixture() {
    const root = temp();
    const staging = path.join(root, '.kinex-update-test');
    fs.mkdirSync(staging);
    const installed = bundle(path.join(root, 'installed'), '1.0.0');
    bundle(staging, '9.9.9');
    fs.writeFileSync(path.join(staging, 'install-update.sh'), updateHelperScript(), { mode: 0o700 });
    const staged = { appBundlePath: path.join(staging, 'Kinex.app'), stagingDirectory: staging, version: '9.9.9' };
    return { root, installed, staged };
  }

  it('waits for the real parent before swapping and relaunching a signed bundle', async () => {
    const { root, installed, staged } = await fixture();
    const open = scriptTool(root, 'open', 'test -e "$TEST_ROOT/parent-exited" || exit 70\nprintf "%s " "$2" >>"$TEST_ROOT/relaunched"');
    fs.writeFileSync(path.join(staged.stagingDirectory, 'install-update.sh'),
      updateHelperScript().replaceAll('/usr/bin/open', open));
    const parent = spawn('/bin/bash', ['-c', 'sleep 0.75']);
    children.push(parent);
    const exited = new Promise<void>((resolve) => parent.once('close', () => {
      fs.writeFileSync(path.join(root, 'parent-exited'), 'done');
      resolve();
    }));
    await launchMacUpdateHelper(staged, { kind: 'writable', appBundlePath: installed }, parent.pid!, {
      spawnHelper: (scriptPath, args) => new Promise<void>((resolve, reject) => {
        const child = spawn('/bin/bash', [scriptPath, ...args], { env: { ...process.env, TEST_ROOT: root } });
        children.push(child);
        child.once('error', reject);
        child.once('close', (code) => code === 0 ? resolve() : reject(new Error(fs.readFileSync(path.join(staged.stagingDirectory, 'install.log'), 'utf8'))));
      }),
    });
    await exited;
    expect(fs.readFileSync(path.join(root, 'relaunched'), 'utf8')).toBe(`${installed} `);
    expect(fs.readFileSync(path.join(installed, 'Contents/Resources/app.asar'), 'utf8')).toBe('signed-9.9.9');
    expect(fs.existsSync(path.join(staged.appBundlePath))).toBe(false);
    expect(fs.existsSync(path.join(staged.stagingDirectory, 'Kinex.app.bak'))).toBe(false);
  }, 30_000);

  it('restores the original at its installed path when activation leaves a directory', async () => {
    const { root, installed, staged } = await fixture();
    const tools = path.join(root, 'bin');
    fs.mkdirSync(tools);
    const commands: Record<string, string> = {
      dirname: 'exec /usr/bin/dirname "$@"',
      basename: 'exec /usr/bin/basename "$@"',
      stat: 'exec /usr/bin/stat "$@"',
      plutil: 'exec /usr/bin/plutil "$@"',
      codesign: 'exec /usr/bin/codesign "$@"',
      sleep: 'exec /bin/sleep "$@"',
      open: 'exit 70',
      mv: '/bin/mv "$@"; mkdir -p "$3"; exit 1',
    };
    for (const [name, body] of Object.entries(commands)) scriptTool(tools, name, body);
    let script = updateHelperScript().replaceAll('/usr/bin/', `${tools}/`).replaceAll('/bin/sleep', `${tools}/sleep`);
    const activation = '/bin/mv "$staged" "$installed"';
    expect(script).toContain(activation);
    script = script.replace(activation, `${tools}/mv "$staged" "$installed"`);
    fs.writeFileSync(path.join(staged.stagingDirectory, 'install-update.sh'), script);
    const parent = spawn('/bin/bash', ['-c', 'exit 0']);
    children.push(parent);
    await new Promise<void>((resolve) => parent.once('close', () => resolve()));
    let status: NodeJS.Signals | number | null = null;
    await launchMacUpdateHelper(staged, { kind: 'writable', appBundlePath: installed }, parent.pid!, {
      spawnHelper: (scriptPath, args) => new Promise<void>((resolve, reject) => {
        const child = spawn('/bin/bash', [scriptPath, ...args], { env: process.env });
        children.push(child);
        child.once('error', reject);
        child.once('close', (code, signal) => { status = code ?? signal; resolve(); });
      }),
    });
    expect(status).toBe(1);
    expect(fs.readFileSync(path.join(installed, 'Contents/Info.plist'), 'utf8')).toContain('1.0.0');
    expect(fs.existsSync(path.join(staged.stagingDirectory, 'Kinex.app.bak'))).toBe(false);
  }, 30_000);

  it('injects launch arguments and refuses scripts outside an update directory', async () => {
    const root = temp();
    const installed = path.join(root, 'Kinex.app');
    fs.mkdirSync(installed);
    const staged = { appBundlePath: path.join(root, '.kinex-update-id/Kinex.app'), stagingDirectory: path.join(root, '.kinex-update-id'), version: '1.2.3' };
    const spawnHelper = vi.fn().mockResolvedValue(undefined);
    await launchMacUpdateHelper(staged, { kind: 'writable', appBundlePath: installed }, 321, { spawnHelper });
    const [script, args] = spawnHelper.mock.calls[0] as [string, string[]];
    expect(script).toBe(path.join(staged.stagingDirectory, 'install-update.sh'));
    expect(args).toEqual(['321', staged.appBundlePath, installed,
      String(fs.statSync(installed).dev), String(fs.statSync(installed).ino), '1.2.3']);
    const helper = spawn('/bin/bash', [script, ...args]);
    children.push(helper);
    expect(await new Promise((resolve) => helper.on('close', resolve))).not.toBe(0);
  }, 10_000);
});

describe('non-macOS guards and fallbacks', () => {
  const writable = { kind: 'writable' as const, appBundlePath: '/tmp/Kinex.app' };
  const staged = {
    appBundlePath: '/tmp/.kinex-update-id/Kinex.app',
    stagingDirectory: '/tmp/.kinex-update-id',
    version: '1.2.3',
  };
  const release = { version: '1.2.3', assetUrl: 'https://invalid', assetName: 'update.zip', sha256: '0'.repeat(64) };

  it.each(['win32', 'linux'] as const)('detectInstallLocation never probes native tooling on %s', async (platform) => {
    setPlatform(platform);
    const runImpl = vi.fn();
    const accessImpl = vi.fn();
    const realpathImpl = vi.fn();
    await expect(detectInstallLocation('/opt/Kinex.app', runImpl, accessImpl, realpathImpl))
      .resolves.toEqual({
        kind: 'read-only',
        appBundlePath: '/opt/Kinex.app',
        reason: expect.stringContaining('macOS'),
      });
    expect(runImpl).not.toHaveBeenCalled();
    expect(accessImpl).not.toHaveBeenCalled();
    expect(realpathImpl).not.toHaveBeenCalled();
  });

  it.each(['win32', 'linux'] as const)('stageMacUpdate fails closed on %s without extracting or shelling out', async (platform) => {
    setPlatform(platform);
    const runImpl = vi.fn();
    await expect(stageMacUpdate('/tmp/update.zip', release, writable, '/tmp', { run: runImpl }))
      .rejects.toThrow(/macOS/);
    expect(runImpl).not.toHaveBeenCalled();
  });

  it.each(['win32', 'linux'] as const)('validateStagedBundle fails closed on %s', async (platform) => {
    setPlatform(platform);
    const runImpl = vi.fn();
    await expect(validateStagedBundle(staged.appBundlePath, staged.version, runImpl))
      .rejects.toThrow(/macOS/);
    expect(runImpl).not.toHaveBeenCalled();
  });

  it.each(['win32', 'linux'] as const)('launchMacUpdateHelper is a safe no-op on %s', async (platform) => {
    setPlatform(platform);
    const spawnHelper = vi.fn();
    await expect(launchMacUpdateHelper(staged, writable, 321, { spawnHelper })).resolves.toBeUndefined();
    expect(spawnHelper).not.toHaveBeenCalled();
  });

  it.each(['win32', 'linux'] as const)('getRunningAppBundlePath falls back to the executable on %s', (platform) => {
    setPlatform(platform);
    expect(getRunningAppBundlePath()).toBe(process.execPath);
  });

  it('getRunningAppBundlePath uses the .app bundle layout on macOS', () => {
    setPlatform('darwin');
    expect(getRunningAppBundlePath()).toBe(path.resolve(process.execPath, '../../..'));
  });
});
