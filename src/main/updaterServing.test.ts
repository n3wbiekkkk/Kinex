import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_UPDATE_FEED_URL } from '../shared/domain';
import type { UpdateStatus } from '../shared/types';
import {
  compareSemver,
  createLocalUpdateFeedServer,
  formatUpdaterError,
  isCompatibleUpdateVersion,
  KinexAutoUpdater,
  parseGitHubFeedRepo,
  resolveGitHubReleaseCandidate,
} from './updater';

describe('local update feed trust boundary', () => {
  it('serves release artifacts and survives malformed, traversal, missing, and symlink requests', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kinex-update-'));
    const feed = path.join(dir, 'feed');
    fs.mkdirSync(feed);
    fs.writeFileSync(path.join(feed, 'latest-mac.yml'), 'version: 7.0.3');
    fs.writeFileSync(path.join(dir, 'secret.zip'), 'private');
    fs.symlinkSync(path.join(dir, 'secret.zip'), path.join(feed, 'escape.zip'));
    fs.writeFileSync(path.join(feed, 'Kinex.zip'), 'archive');
    const server = createLocalUpdateFeedServer(feed);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    const get = (url: string) => new Promise<{ status: number; body: string }>((resolve, reject) => {
      http.get({ hostname: '127.0.0.1', port: address.port, path: url }, (response) => {
        let body = '';
        response.on('data', (chunk) => { body += chunk; });
        response.on('end', () => resolve({ status: response.statusCode!, body }));
      }).on('error', reject);
    });
    try {
      expect(await get('/latest-mac.yml')).toEqual({ status: 200, body: 'version: 7.0.3' });
      expect((await get('/%zz')).status).toBe(400);
      for (const url of ['/../secret.zip', '/%2e%2e%2fsecret.zip', '/escape.zip', '/missing.zip', '/Kinex.zip%00', '/package.json']) {
        expect((await get(url)).status).toBe(404);
      }
      expect(await get('/Kinex.zip')).toEqual({ status: 200, body: 'archive' });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

it('closes a local feed that finishes binding after updater disposal', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kinex-update-dispose-'));
  fs.writeFileSync(path.join(dir, 'latest-mac.yml'), 'version: 7.0.3');
  const updater = new KinexAutoUpdater(() => dir, () => {});
  const binding = (updater as unknown as { startLocalFeedServer: (dir: string) => Promise<string> }).startLocalFeedServer(dir);
  updater.dispose();
  try {
    await expect(binding).rejects.toThrow('Update check cancelled');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it.each(['7.0.1', '7.0.2', '7.0.3'])('rejects legacy misnumbered %s updates on the 0.x line', (version) => {
  expect(isCompatibleUpdateVersion('0.7.3', version)).toBe(false);
});

it.each(['0.7.4', '0.8.0', '1.0.0'])('keeps the normal upgrade path to %s', (version) => {
  expect(isCompatibleUpdateVersion('0.7.3', version)).toBe(true);
});

it('formats updater errors without exposing feed URLs, manifests, or cache paths', () => {
  for (const raw of [
    'HttpError: 404 Not Found',
    'Cannot find latest-mac.yml in the latest release artifacts',
    'ERR_UPDATER_LATEST_VERSION_NOT_FOUND',
    'getaddrinfo ENOTFOUND github.com',
    'Code signature at URL file:///Users/test/Library/Caches/com.kinex.browser.ShipIt/Kinex.app/ did not pass validation',
  ]) {
    const message = formatUpdaterError(new Error(raw));
    expect(message).not.toMatch(/latest-mac\.yml|feed|GitHub|ShipIt|file:\/\//i);
  }
});

it('parses GitHub repository coordinates and resolves release candidates with redirect fallback', async () => {
  expect(parseGitHubFeedRepo(DEFAULT_UPDATE_FEED_URL)).toEqual({ owner: 'n3wbiekkkk', repo: 'Kinex' });
  expect(parseGitHubFeedRepo('http://github.com/n3wbiekkkk/Kinex/releases/latest/download')).toBeNull();
  expect(compareSemver('0.7.11', '0.7.9')).toBe(1);
  expect(compareSemver('0.7.11', '0.7.11')).toBe(0);
  expect(compareSemver('0.7.9', '0.7.11')).toBe(-1);

  const apiCandidate = await resolveGitHubReleaseCandidate('n3wbiekkkk', 'Kinex', (async () =>
    new Response(
      JSON.stringify({
        tag_name: 'v0.7.12',
        assets: [
          {
            name: 'Kinex-0.7.12-arm64.dmg',
            browser_download_url: 'https://github.com/n3wbiekkkk/Kinex/releases/download/v0.7.12/Kinex-0.7.12-arm64.dmg',
            digest: `sha256:${'a'.repeat(64)}`,
            size: 1024,
          },
        ],
      }),
      { status: 200 }
    )) as typeof fetch);
  expect(apiCandidate).toEqual({
    version: '0.7.12',
    assetName: 'Kinex-0.7.12-arm64.dmg',
    assetUrl: 'https://github.com/n3wbiekkkk/Kinex/releases/download/v0.7.12/Kinex-0.7.12-arm64.dmg',
    sha256: 'a'.repeat(64),
    size: 1024,
  });

  const redirectCandidate = await resolveGitHubReleaseCandidate('n3wbiekkkk', 'Kinex', (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('api.github.com')) {
      return new Response('rate limited', { status: 403 });
    }
    const res = new Response(null, { status: 200 });
    Object.defineProperty(res, 'url', { value: 'https://github.com/n3wbiekkkk/Kinex/releases/tag/v0.7.12' });
    return res;
  }) as typeof fetch);
  expect(redirectCandidate).toEqual({
    version: '0.7.12',
    assetName: 'Kinex-0.7.12-arm64.dmg',
    assetUrl: 'https://github.com/n3wbiekkkk/Kinex/releases/download/v0.7.12/Kinex-0.7.12-arm64.dmg',
  });
});

it('falls back to GitHub release assets when latest-mac.yml is absent and verifies SHA-256 before opening', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kinex-fallback-upd-'));
  const openPathSpy = vi.fn().mockResolvedValue('');
  const checkManifest = async () => {
    throw new Error('Cannot find latest-mac.yml in the latest release artifacts (HttpError: 404 Not Found)');
  };

  const payload = Buffer.from('verified-kinex-update-archive');
  const sha256 = createHash('sha256').update(payload).digest('hex');

  try {
    const statuses: UpdateStatus[] = [];
    const upToDateUpdater = new KinexAutoUpdater(
      () => DEFAULT_UPDATE_FEED_URL,
      (st) => statuses.push(st),
      {
        isPackaged: () => true,
        getVersion: () => '0.7.9',
        getTempDir: () => tempRoot,
        openPath: openPathSpy,
        checkManifest,
        fetchImpl: (async () =>
          new Response(JSON.stringify({ tag_name: 'v0.7.9', assets: [] }), { status: 200 })) as typeof fetch,
      }
    );
    await upToDateUpdater.checkForUpdates(false);
    upToDateUpdater.dispose();
    expect(statuses.at(-1)).toEqual({ state: 'up-to-date', version: '0.7.9' });
    expect(statuses.some((s) => s.state === 'error')).toBe(false);

    const downloadStatuses: UpdateStatus[] = [];
    const downloadUpdater = new KinexAutoUpdater(
      () => DEFAULT_UPDATE_FEED_URL,
      (st) => downloadStatuses.push(st),
      {
        isPackaged: () => true,
        getVersion: () => '0.7.9',
        getTempDir: () => tempRoot,
        openPath: openPathSpy,
        checkManifest,
        fetchImpl: (async (input: RequestInfo | URL) => {
          const url = String(input);
          if (url.includes('api.github.com')) {
            return new Response(
              JSON.stringify({
                tag_name: 'v0.7.12',
                assets: [
                  {
                    name: 'Kinex-0.7.12-arm64.zip',
                    browser_download_url: 'https://github.com/n3wbiekkkk/Kinex/releases/download/v0.7.12/Kinex-0.7.12-arm64.zip',
                    digest: `sha256:${sha256}`,
                    size: payload.length,
                  },
                ],
              }),
              { status: 200 }
            );
          }
          return new Response(payload, {
            status: 200,
            headers: { 'content-length': String(payload.length) },
          });
        }) as typeof fetch,
      }
    );
    await downloadUpdater.checkForUpdates(false);
    expect(downloadStatuses.some((s) => s.state === 'available' && s.version === '0.7.12')).toBe(true);
    expect(downloadStatuses.at(-1)).toEqual({ state: 'downloaded', version: '0.7.12' });
    downloadUpdater.quitAndInstall();
    expect(openPathSpy).toHaveBeenCalledWith(path.join(tempRoot, 'kinex-updates', 'Kinex-0.7.12-arm64.zip'));
    downloadUpdater.dispose();

    const tamperedStatuses: UpdateStatus[] = [];
    const tamperedUpdater = new KinexAutoUpdater(
      () => DEFAULT_UPDATE_FEED_URL,
      (st) => tamperedStatuses.push(st),
      {
        isPackaged: () => true,
        getVersion: () => '0.7.9',
        getTempDir: () => tempRoot,
        openPath: openPathSpy,
        checkManifest,
        fetchImpl: (async (input: RequestInfo | URL) => {
          const url = String(input);
          if (url.includes('api.github.com')) {
            return new Response(
              JSON.stringify({
                tag_name: 'v0.7.13',
                assets: [
                  {
                    name: 'Kinex-0.7.13-arm64.zip',
                    browser_download_url: 'https://github.com/n3wbiekkkk/Kinex/releases/download/v0.7.13/Kinex-0.7.13-arm64.zip',
                    digest: `sha256:${'f'.repeat(64)}`,
                    size: payload.length,
                  },
                ],
              }),
              { status: 200 }
            );
          }
          return new Response(payload, { status: 200 });
        }) as typeof fetch,
      }
    );
    await tamperedUpdater.checkForUpdates(false);
    expect(tamperedStatuses.at(-1)).toEqual({
      state: 'error',
      message: 'Downloaded update failed integrity check',
    });
    tamperedUpdater.dispose();
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

it('does not render update feed URL or folder inputs in SettingsView', () => {
  const settingsSource = fs.readFileSync(
    path.resolve(import.meta.dirname, '../renderer/components/SettingsView.tsx'),
    'utf8'
  );
  expect(settingsSource).not.toMatch(/update-feed|Update Feed|Save Feed|Use GitHub Releases/);
});
