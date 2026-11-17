import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

vi.mock('electron', () => ({
  app: {
    getVersion: () => '0.7.19', getName: () => 'Kinex', isPackaged: true,
    getAppPath: () => '/tmp', getPath: () => '/tmp', whenReady: async () => {},
    quit: () => {}, relaunch: () => {}, once: () => {},
  },
  shell: { openPath: vi.fn(), openExternal: vi.fn() },
}));
import { DEFAULT_UPDATE_FEED_URL } from '../shared/domain';
import type { UpdateStatus } from '../shared/types';
import {
  KinexAutoUpdater,
  parseMacZipManifest,
  resolveGitHubReleaseCandidate,
  type VerifiedMacZip,
} from './updater';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })));

function release(version: string, bytes: Buffer) {
  const name = `Kinex-${version}-arm64-mac.zip`;
  const url = `https://github.com/n3wbiekkkk/Kinex/releases/download/v${version}/${name}`;
  return {
    version, assetName: name, assetUrl: url,
    releaseUrl: `https://github.com/n3wbiekkkk/Kinex/releases/tag/v${version}`,
    sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length,
  };
}

function candidateFetch(candidate: ReturnType<typeof release>, bytes: Buffer): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/latest-mac.yml')) return new Response('Not Found', { status: 404 });
    if (url.includes('api.github.com')) {
      return new Response(JSON.stringify({
        tag_name: `v${candidate.version}`,
        assets: [{ name: candidate.assetName, browser_download_url: candidate.assetUrl, digest: `sha256:${candidate.sha256}`, size: bytes.length }],
      }));
    }
    if (url === candidate.assetUrl) return new Response(bytes, { headers: { 'content-length': String(bytes.length) } });
    return new Response('Not Found', { status: 404 });
  }) as typeof fetch;
}

describe('unsigned macOS release installation', () => {
  it('requires the exact arm64 ZIP and accepts SHA-256 in latest-mac.yml', async () => {
    const payload = Buffer.from('zip');
    const candidate = release('0.7.20', payload);
    const manifest = `version: ${candidate.version}\nfiles:\n  - url: ${candidate.assetName}\n    sha256: ${Buffer.from(candidate.sha256, 'hex').toString('base64')}\n    size: ${payload.length}\n`;
    expect(parseMacZipManifest(manifest, 'n3wbiekkkk', 'Kinex')).toEqual(candidate);
    expect(parseMacZipManifest(manifest, 'n3wbiekkkk', 'Kinex').assetUrl).toMatch(/^https:/);
    expect(() => parseMacZipManifest(manifest.replace('sha256:', 'sha512:'), 'n3wbiekkkk', 'Kinex')).toThrow(/SHA-256/);
    expect(await resolveGitHubReleaseCandidate('n3wbiekkkk', 'Kinex', candidateFetch(candidate, payload))).toEqual(candidate);
  });

  it('downloads with progress, stages for in-app restart and relaunches through the helper', async () => {
    const bytes = Buffer.from('verified update');
    const candidate = release('0.7.20', bytes);
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kinex-updater-'));
    roots.push(tempRoot);
    const statuses: UpdateStatus[] = [];
    const stage = vi.fn(async (_path: string, candidate: VerifiedMacZip) => ({
      appBundlePath: path.join(tempRoot, 'stage', 'Kinex.app'), stagingDirectory: path.join(tempRoot, 'stage'), version: candidate.version,
    }));
    const launch = vi.fn(async () => {});
    const quit = vi.fn();
    const updater = new KinexAutoUpdater(() => '', (status) => statuses.push(status), {
      isPackaged: () => true, getVersion: () => '0.7.19', getTempDir: () => tempRoot,
      getInstallLocation: async () => ({ kind: 'writable', appBundlePath: '/Applications/Kinex.app' }),
      stageUpdate: stage, launchHelper: launch, quit,
      fetchImpl: candidateFetch(candidate, bytes),
    });
    await updater.checkForUpdates(false);
    expect(statuses.at(-1), `statuses: ${JSON.stringify(statuses)}`).toEqual({ state: 'downloaded', version: '0.7.20', installation: 'in-app' });
    expect(statuses).toContainEqual({ state: 'downloading', version: '0.7.20', percent: 100 });
    expect(stage).toHaveBeenCalledWith(path.join(fs.realpathSync(tempRoot), 'kinex-updates', candidate.assetName), candidate,
      { kind: 'writable', appBundlePath: '/Applications/Kinex.app' });
    await updater.quitAndInstall();
    expect(launch).toHaveBeenCalledOnce();
    expect(quit).toHaveBeenCalledOnce();
    updater.dispose();
  });

  it('opens a verified DMG only on read-only volumes', async () => {
    const zipBytes = Buffer.from('zip');
    const dmgBytes = Buffer.from('dmg');
    const candidate = release('0.7.20', zipBytes);
    const dmg = { ...candidate, assetName: 'Kinex-0.7.20-arm64.dmg', assetUrl: `${candidate.assetUrl.replace(`${candidate.assetName}`, 'Kinex-0.7.20-arm64.dmg')}`, sha256: createHash('sha256').update(dmgBytes).digest('hex'), size: dmgBytes.length };
    const statuses: UpdateStatus[] = [];
    const openPath = vi.fn(async () => '');
    const verifyDmg = vi.fn(async () => {});
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/latest-mac.yml')) return new Response('Not Found', { status: 404 });
      if (url.includes('api.github.com')) {
        return new Response(JSON.stringify({ tag_name: 'v0.7.20', assets: [
          { name: candidate.assetName, browser_download_url: candidate.assetUrl, digest: `sha256:${candidate.sha256}`, size: candidate.size },
          { name: dmg.assetName, browser_download_url: dmg.assetUrl, digest: `sha256:${dmg.sha256}`, size: dmg.size },
        ] }));
      }
      return new Response(url === dmg.assetUrl ? dmgBytes : zipBytes, { headers: { 'content-length': String(url === dmg.assetUrl ? dmgBytes.length : zipBytes.length) } });
    }) as typeof fetch;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kinex-readonly-'));
    roots.push(root);
    const updater = new KinexAutoUpdater(() => '', (status) => statuses.push(status), {
      isPackaged: () => true, getVersion: () => '0.7.19', getTempDir: () => root,
      getInstallLocation: async () => ({ kind: 'read-only', appBundlePath: '/Volumes/Kinex/Kinex.app', reason: 'Mounted DMG' }),
      openPath, verifyDmg, fetchImpl,
    });
    await updater.checkForUpdates(false);
    expect(statuses.at(-1)).toMatchObject({ state: 'downloaded', installation: 'manual', releaseUrl: candidate.releaseUrl });
    await updater.quitAndInstall();
    expect(openPath).toHaveBeenCalledWith(path.join(fs.realpathSync(root), 'kinex-updates', dmg.assetName));
    expect(verifyDmg).toHaveBeenCalledOnce();
    updater.dispose();
  });

  it('fails closed on missing or tampered checksums', async () => {
    const bytes = Buffer.from('tampered update');
    const candidate = { ...release('0.7.20', bytes), sha256: 'f'.repeat(64) };
    const statuses: UpdateStatus[] = [];
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kinex-integrity-'));
    roots.push(root);
    const updater = new KinexAutoUpdater(() => '', (status) => statuses.push(status), {
      isPackaged: () => true, getVersion: () => '0.7.19', getTempDir: () => root,
      getInstallLocation: async () => ({ kind: 'writable', appBundlePath: '/Applications/Kinex.app' }),
      stageUpdate: vi.fn(), fetchImpl: candidateFetch(candidate, bytes),
    });
    await updater.checkForUpdates(false);
    expect(statuses.at(-1)).toEqual({ state: 'error', message: 'Downloaded update failed integrity check' });
    expect(updater.getStatus().state).toBe('error');
    const status = statuses.at(-1);
    expect(status).toMatchObject({ state: 'error' });
    expect(statuses.every((item) => item.state !== 'downloaded')).toBe(true);
    updater.dispose();
  });
});
