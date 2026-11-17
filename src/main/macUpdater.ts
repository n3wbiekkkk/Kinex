import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isMac, macOnly } from './platformSupport';

/**
 * The in-app updater shells out to macOS-only tooling (`/sbin/mount`, ditto,
 * codesign, plutil, lipo, xattr, bash) and expects a `.app` bundle layout.
 * Off macOS every mutating entry point fails closed with this message without
 * invoking any native binary; `detectInstallLocation` instead reports a
 * read-only install so the updater degrades to its verified manual download.
 */
const MAC_ONLY_MESSAGE = 'In-app updates are only available on macOS; use the manual download instead.';

function requireMac(): void {
  if (!isMac()) throw new Error(MAC_ONLY_MESSAGE);
}

export interface MacZipRelease {
  version: string;
  assetUrl: string;
  assetName: string;
  sha256: string;
  size?: number;
}
export type InstallLocation =
  | { kind: 'writable'; appBundlePath: string }
  | { kind: 'read-only'; appBundlePath: string; reason: string };
export interface StagedMacUpdate { appBundlePath: string; stagingDirectory: string; version: string }
export interface MacUpdaterDeps {
  run?: (command: string, args: string[]) => Promise<string>;
  spawnHelper?: (scriptPath: string, args: string[]) => Promise<void>;
}

export function normalizeSha256(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  return /^\s*(?:sha256:)?([a-f\d]{64})(?:\s+\*?[^\r\n]*)?\s*$/i.exec(raw)?.[1].toLowerCase() ?? null;
}

export async function verifyFileSha256(archivePath: string, expected: string): Promise<void> {
  const digest = normalizeSha256(expected);
  if (!digest) throw new Error('The update has no valid SHA-256 checksum');
  const hash = createHash('sha256');
  const file = await fs.promises.open(archivePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    for await (const chunk of file.createReadStream({ autoClose: false })) hash.update(chunk);
  } finally { await file.close(); }
  if (!timingSafeEqual(hash.digest(), Buffer.from(digest, 'hex'))) {
    throw new Error('Downloaded update failed integrity check');
  }
}

interface ZipEntry {
  name: string;
  flags: number;
  method: number;
  compressedSize: number;
  expandedSize: number;
  mode: number;
  localOffset: number;
}

function validateName(name: string): void {
  if (!name.startsWith('Kinex.app/') || name.includes('\0') || name.includes('\\') ||
      path.posix.isAbsolute(name) || /(^|\/)\.\.(\/|$)/.test(name)) {
    throw new Error('Unsafe update archive path');
  }
}

async function readAll(file: fs.promises.FileHandle, offset: number, length: number): Promise<Buffer> {
  const data = Buffer.alloc(length);
  const result = await file.read(data, 0, length, offset);
  if (result.bytesRead !== length) throw new Error('Truncated update archive');
  return data;
}

export async function validateMacUpdateArchive(archivePath: string): Promise<void> {
  const handle = await fs.promises.open(archivePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 22 || stat.size > 1024 ** 3) throw new Error('Invalid update archive');
    const tail = await readAll(handle, Math.max(0, stat.size - 65557), Math.min(stat.size, 65557));
    let eocd = -1;
    for (let offset = tail.length - 22; offset >= 0; offset--) {
      if (tail.readUInt32LE(offset) === 0x06054b50 && tail.readUInt16LE(offset + 20) === tail.length - offset - 22) {
        eocd = offset;
        break;
      }
    }
    if (eocd < 0) throw new Error('Invalid update archive directory');
    const end = tail;
    const count = end.readUInt16LE(eocd + 10);
    const size = end.readUInt32LE(eocd + 12);
    const offset = end.readUInt32LE(eocd + 16);
    if (count === 0 || count > 20000 || end.readUInt16LE(eocd + 8) !== count ||
        end.readUInt16LE(eocd + 4) !== 0 || end.readUInt16LE(eocd + 6) !== 0 ||
        size > 16 * 1024 ** 2 || offset + size > stat.size) {
      throw new Error('Invalid update archive directory');
    }
    const directory = await readAll(handle, offset, size);
    const seen = new Set<string>();
    let cursor = 0;
    let total = 0;
    for (let index = 0; index < count; index++) {
      if (cursor + 46 > directory.length || directory.readUInt32LE(cursor) !== 0x02014b50) {
        throw new Error('Invalid update archive entry');
      }
      const nameLength = directory.readUInt16LE(cursor + 28);
      const extraLength = directory.readUInt16LE(cursor + 30);
      const commentLength = directory.readUInt16LE(cursor + 32);
      const entryLength = 46 + nameLength + extraLength + commentLength;
      if (cursor + entryLength > directory.length) throw new Error('Invalid update archive entry');
      const entry: ZipEntry = {
        name: directory.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8'),
        flags: directory.readUInt16LE(cursor + 8),
        method: directory.readUInt16LE(cursor + 10),
        compressedSize: directory.readUInt32LE(cursor + 20),
        expandedSize: directory.readUInt32LE(cursor + 24),
        mode: (directory.readUInt32LE(cursor + 38) >>> 16) & 0xffff,
        localOffset: directory.readUInt32LE(cursor + 42),
      };
      cursor += entryLength;
      validateName(entry.name);
      const type = entry.mode & 0xf000;
      if ((entry.flags & 1) || entry.compressedSize === 0xffffffff || entry.expandedSize === 0xffffffff ||
          ![0, 0x4000, 0x8000, 0xa000].includes(type) || (entry.mode & 0o6000) !== 0) {
        throw new Error('Unsafe update archive path');
      }
      if (path.basename(entry.name).startsWith('._')) {
        if (type === 0xa000) throw new Error('Unsafe update archive link');
        continue;
      }
      const normalized = entry.name.replace(/\/$/, '').toLowerCase();
      if (seen.has(normalized)) throw new Error('Duplicate update archive path');
      seen.add(normalized);
      total += entry.expandedSize;
      if (total > 3 * 1024 ** 3) throw new Error('Update archive is too large');
      const local = await readAll(handle, entry.localOffset, 30);
      if (local.length !== 30 || local.readUInt32LE(0) !== 0x04034b50) throw new Error('Invalid update archive local entry');
      if (type === 0xa000) {
        if (entry.method !== 0 || entry.compressedSize > 4096) throw new Error('Invalid update archive link');
        const localHeader = await readAll(handle, entry.localOffset, 30);
        const dataOffset = entry.localOffset + 30 + localHeader.readUInt16LE(26) + localHeader.readUInt16LE(28);
        const target = (await readAll(handle, dataOffset, entry.compressedSize)).toString('utf8');
        const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(entry.name), target));
        if (target.includes('\0') || target.includes('\\') || path.posix.isAbsolute(target) ||
            !resolved.startsWith('Kinex.app/')) throw new Error('Unsafe update archive link');
      }
    }
    if (cursor !== directory.length) throw new Error('Invalid update archive directory');
  } finally { await handle.close(); }
}

export function parseDarwinMountTable(raw: string): Map<string, boolean> {
  const mounts = new Map<string, boolean>();
  for (const line of raw.split('\n')) {
    const match = /^\/dev\/\S+ on (\/.+) \(([^)]+)\)$/.exec(line);
    if (match) mounts.set(match[1], /(?:^|,\s*)read-only(?:,|$)/.test(match[2]));
  }
  return mounts;
}

export function isReadOnlyMount(appPath: string, mounts: Map<string, boolean>): boolean {
  let target = path.resolve(appPath);
  for (;;) {
    if (mounts.get(target)) return true;
    const parent = path.dirname(target);
    if (target === parent) return false;
    target = parent;
  }
}

export async function detectInstallLocation(
  rawPath: string,
  runImpl: (command: string, args: string[]) => Promise<string> = run,
  accessImpl: typeof fs.promises.access = fs.promises.access,
  realpathImpl: typeof fs.promises.realpath = fs.promises.realpath
): Promise<InstallLocation> {
  if (!isMac()) {
    // Safe cross-platform fallback: never probe macOS-only mounts or tooling.
    // Reporting a read-only install routes the caller to the manual download.
    return { kind: 'read-only', appBundlePath: rawPath, reason: MAC_ONLY_MESSAGE };
  }
  const appBundlePath = await realpathImpl(rawPath);
  if (path.basename(appBundlePath) !== 'Kinex.app') throw new Error('Installed application bundle is invalid');
  const parent = path.dirname(appBundlePath);
  if (appBundlePath === '/Kinex.app') throw new Error('Installed application location is unsafe');
  if (parent === '/Volumes' || parent.startsWith('/Volumes/') ||
      isReadOnlyMount(appBundlePath, parseDarwinMountTable(await runImpl('/sbin/mount', [])))) {
    return { kind: 'read-only', appBundlePath, reason: 'Kinex is running from a read-only volume. Install it in Applications, or use the manual download.' };
  }
  try { await accessImpl(parent, fs.constants.W_OK); }
  catch { throw new Error('Kinex cannot replace the application folder. Move Kinex to Applications and make sure you have permission to update it.'); }
  return { kind: 'writable', appBundlePath };
}

function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => execFile(command, args, { timeout: 180000, maxBuffer: 4194304 }, (error, stdout, stderr) => {
    if (error) reject(new Error(`Update validation command failed: ${command} ${stderr.trim().slice(0, 160)}`));
    else resolve(`${stdout}\n${stderr}`);
  }));
}

async function validateExtractedTree(root: string): Promise<void> {
  async function visit(directory: string): Promise<void> {
    for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('._')) continue;
      const candidate = path.join(directory, entry.name);
      const target = await fs.promises.realpath(candidate);
      if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error('Staged application has an escaping link');
      if (entry.isSymbolicLink()) continue;
      if (!entry.isDirectory() && !entry.isFile()) throw new Error('Unsafe staged application entry');
      if (entry.isDirectory()) await visit(candidate);
    }
  }
  await visit(root);
}

export async function validateStagedBundle(
  appPath: string,
  version: string,
  runImpl: (command: string, args: string[]) => Promise<string> = run
): Promise<void> {
  requireMac();
  const root = await fs.promises.realpath(appPath);
  if (path.basename(root) !== 'Kinex.app') throw new Error('Staged application bundle is invalid');
  for (const relative of ['Contents/MacOS/Kinex', 'Contents/Info.plist', 'Contents/Resources/app.asar']) {
    const target = await fs.promises.realpath(path.join(root, relative));
    if (!target.startsWith(`${root}${path.sep}`)) throw new Error('Staged application has an escaping link');
  }
  await validateExtractedTree(root);
  let metadata: Record<string, unknown>;
  try {
    metadata = JSON.parse(await runImpl('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(root, 'Contents/Info.plist')]));
  } catch { throw new Error('Staged application metadata is invalid'); }
  if (metadata.CFBundleIdentifier !== 'com.kinex.browser' || metadata.CFBundleExecutable !== 'Kinex' ||
      metadata.CFBundleShortVersionString !== version || metadata.CFBundlePackageType !== 'APPL') {
    throw new Error('Staged application metadata does not match the release');
  }
  const executable = await fs.promises.stat(path.join(root, 'Contents/MacOS/Kinex'));
  if (!executable.isFile() || !(executable.mode & 0o111)) throw new Error('Staged application executable is invalid');
  const architectures = await runImpl('/usr/bin/lipo', ['-archs', path.join(root, 'Contents/MacOS/Kinex')]);
  if (architectures.trim() !== 'arm64') throw new Error('Staged application is not Apple Silicon compatible');
  await runImpl('/usr/bin/codesign', ['--verify', '--deep', '--strict', root]);
  const signing = await runImpl('/usr/bin/codesign', ['-dv', '--verbose=4', root]);
  if (!/flags=.*(?:adhoc.*runtime|runtime.*adhoc)/.test(signing)) {
    throw new Error('Staged application lacks its required ad-hoc hardened-runtime seal');
  }
}

async function removeAppleDouble(root: string): Promise<void> {
  for (const entry of await fs.promises.readdir(root, { recursive: true })) {
    if (path.basename(entry.toString()).startsWith('._')) {
      await fs.promises.unlink(path.join(root, entry.toString()));
    }
  }
}

export function updateHelperScript(): string {
  return `#!/bin/bash
set -u
pid="$1"
staged="$2"
installed="$3"
device="$4"
inode="$5"
version="$6"
case "$pid" in ''|*[!0-9]*) exit 1 ;; esac
staging="$(/usr/bin/dirname "$staged")"
backup="$staging/Kinex.app.bak"
log="$staging/install.log"
exec >>"$log" 2>&1
case "$(/usr/bin/basename "$staging")" in .kinex-update-*) ;; *) exit 1 ;; esac
if [ "$staged" != "$staging/Kinex.app" ] || [ "$(/usr/bin/basename "$installed")" != Kinex.app ]; then exit 1; fi
for ((i=0; i<1200; i++)); do
  if ! kill -0 "$pid" 2>/dev/null; then break; fi
  /bin/sleep 0.25
done
if kill -0 "$pid" 2>/dev/null; then exit 1; fi
if [ -e "$backup" ] || [ -L "$backup" ] || [ -L "$staged" ] || [ -L "$installed" ]; then exit 1; fi
if [ "$(/usr/bin/stat -f %d "$installed")" != "$device" ] || [ "$(/usr/bin/stat -f %i "$installed")" != "$inode" ]; then exit 1; fi
bundle_version="$(/usr/bin/plutil -extract CFBundleShortVersionString raw -o - "$staged/Contents/Info.plist")" || exit 1
if [ "$bundle_version" != "$version" ] || ! /usr/bin/codesign --verify --deep --strict "$staged"; then exit 1; fi
if ! /bin/mv "$installed" "$backup"; then exit 1; fi
if /bin/mv "$staged" "$installed" && /usr/bin/codesign --verify --deep --strict "$installed" && /usr/bin/open -n "$installed"; then
  /bin/rm -rf -- "$backup"
  printf 'Installed Kinex %s and relaunched\n' "$version"
  exit 0
fi
printf 'Activation failed; restoring application\n'
if [ -e "$installed" ] || [ -L "$installed" ]; then /bin/mv "$installed" "$staging/Kinex-partial" || exit 1; fi
if /bin/mv "$backup" "$installed"; then
  printf 'Original application restored\n'
else
  printf 'Rollback failed; original retained at %s\n' "$backup"
fi
exit 1
`;
}

export async function stageMacUpdate(
  archivePath: string, release: MacZipRelease,
  location: { kind: 'writable'; appBundlePath: string },
  tempDirectory: string, deps: MacUpdaterDeps = {}
): Promise<StagedMacUpdate> {
  requireMac();
  const runImpl = deps.run ?? run;
  const root = await fs.promises.realpath(tempDirectory);
  const extractionRoot = await fs.promises.mkdtemp(path.join(root, 'kinex-staged-'));
  const stagingDirectory = path.join(path.dirname(location.appBundlePath), `.kinex-update-${randomUUID()}`);
  try {
    const stat = await fs.promises.stat(archivePath);
    if (release.size !== undefined && release.size !== stat.size) throw new Error('Downloaded update has an unexpected size');
    await verifyFileSha256(archivePath, release.sha256);
    await validateMacUpdateArchive(archivePath);
    const extract = path.join(extractionRoot, 'extracted');
    await fs.promises.mkdir(extract, { mode: 0o700 });
    await runImpl('/usr/bin/ditto', ['-xk', archivePath, extract]);
    if ((await fs.promises.readdir(extract)).join(',') !== 'Kinex.app') {
      throw new Error('Staged application archive has an invalid layout');
    }
    const appPath = path.join(extract, 'Kinex.app');
    await removeAppleDouble(appPath);
    await validateStagedBundle(appPath, release.version, runImpl);
    await runImpl('/usr/bin/xattr', ['-cr', appPath]);
    await validateStagedBundle(appPath, release.version, runImpl);
    await fs.promises.mkdir(stagingDirectory, { mode: 0o700 });
    const stagedPath = path.join(stagingDirectory, 'Kinex.app');
    await runImpl('/usr/bin/ditto', [appPath, stagedPath]);
    await validateStagedBundle(stagedPath, release.version, runImpl);
    await fs.promises.writeFile(path.join(stagingDirectory, 'install-update.sh'), updateHelperScript(), { mode: 0o700, flag: 'wx' });
    await fs.promises.rm(extractionRoot, { recursive: true, force: true });
    return { appBundlePath: stagedPath, stagingDirectory, version: release.version };
  } catch (error) {
    await fs.promises.rm(extractionRoot, { recursive: true, force: true }).catch(() => {});
    await fs.promises.rm(stagingDirectory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export async function launchMacUpdateHelper(
  staged: StagedMacUpdate, location: { kind: 'writable'; appBundlePath: string },
  parentPid = process.pid, deps: MacUpdaterDeps = {}
): Promise<void> {
  if (!isMac()) {
    // Safe cross-platform fallback: there is no macOS helper to launch, so
    // never spawn a shell. Callers gate the surrounding flow with isMac();
    // off macOS there is nothing to swap and this is an intentional no-op.
    return;
  }
  const installed = await fs.promises.stat(location.appBundlePath);
  const scriptPath = path.join(staged.stagingDirectory, 'install-update.sh');
  const args = [String(parentPid), staged.appBundlePath, location.appBundlePath,
    String(installed.dev), String(installed.ino), staged.version];
  if (deps.spawnHelper) { await deps.spawnHelper(scriptPath, args); return; }
  await new Promise<void>((resolve, reject) => {
    const child = spawn('/bin/bash', [scriptPath, ...args], { detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

export function getRunningAppBundlePath(): string {
  // A macOS executable lives at <App>.app/Contents/MacOS/<Binary>, so the
  // bundle root is three directories up. Other platforms have no .app bundle;
  // fall back to the executable path itself rather than a meaningless parent.
  return macOnly(
    () => path.resolve(process.execPath, '../../..'),
    () => process.execPath,
  );
}
