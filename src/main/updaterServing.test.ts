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

it('resolves exact arm64 ZIP candidates with required digests', async () => {
  expect(parseGitHubFeedRepo(DEFAULT_UPDATE_FEED_URL)).toEqual({ owner: 'n3wbiekkkk', repo: 'Kinex' });
  expect(parseGitHubFeedRepo('http://github.com/n3wbiekkkk/Kinex/releases/latest/download')).toBeNull();
  expect(compareSemver('0.7.11', '0.7.9')).toBe(1);
  expect(compareSemver('0.7.11', '0.7.11')).toBe(0);
  expect(compareSemver('0.7.9', '0.7.11')).toBe(-1);
  const assetName = 'Kinex-0.7.12-arm64-mac.zip';
  const assetUrl = 'https://github.com/n3wbiekkkk/Kinex/releases/download/v0.7.12/Kinex-0.7.12-arm64-mac.zip';
  const releaseUrl = 'https://github.com/n3wbiekkkk/Kinex/releases/tag/v0.7.12';
  const api = await resolveGitHubReleaseCandidate('n3wbiekkkk', 'Kinex', (async (input: RequestInfo | URL) => {
    if (String(input).endsWith('/latest-mac.yml')) return new Response('missing', { status: 404 });
    return new Response(JSON.stringify({ tag_name: 'v0.7.12', assets: [{ name: assetName, browser_download_url: assetUrl, digest: 'sha256:' + 'a'.repeat(64), size: 1024 }] }));
  }) as typeof fetch);
  expect(api).toEqual({ version: '0.7.12', assetName, assetUrl, releaseUrl, sha256: 'a'.repeat(64), size: 1024 });
  const redirected = await resolveGitHubReleaseCandidate('n3wbiekkkk', 'Kinex', (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/latest-mac.yml')) return new Response('missing', { status: 404 });
    if (url.includes('api.github.com')) return new Response('rate limited', { status: 403 });
    if (url.endsWith('.sha256')) return new Response('b'.repeat(64) + '  ' + assetName);
    const response = new Response(null);
    Object.defineProperty(response, 'url', { value: releaseUrl });
    return response;
  }) as typeof fetch);
  expect(redirected).toEqual({ version: '0.7.12', assetName, assetUrl, releaseUrl, sha256: 'b'.repeat(64) });
});

it('rejects tampered update bytes and treats a matching release version as current', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kinex-updater-'));
  const bytes = Buffer.from('tampered');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/latest-mac.yml')) return new Response('missing', { status: 404 });
    if (url.includes('api.github.com')) return new Response(JSON.stringify({
      tag_name: url.includes('same-version') ? 'v0.7.9' : 'v0.7.13',
      assets: [{ name: 'Kinex-0.7.13-arm64-mac.zip', browser_download_url: 'https://github.com/n3wbiekkkk/Kinex/releases/download/v0.7.13/Kinex-0.7.13-arm64-mac.zip', digest: 'sha256:' + 'f'.repeat(64), size: bytes.length }],
    }));
    return new Response(bytes, { headers: { 'content-length': String(bytes.length) } });
  }) as typeof fetch;
  try {
    const status: UpdateStatus[] = [];
    const updater = new KinexAutoUpdater(() => DEFAULT_UPDATE_FEED_URL, (item) => status.push(item), {
        isPackaged: () => true, getVersion: () => '0.7.9', getTempDir: () => root,
        fetchImpl, getInstallLocation: async () => ({ kind: 'writable', appBundlePath: '/Applications/Kinex.app' }), stageUpdate: vi.fn(),
    });
    await updater.checkForUpdates(false);
    expect(status.at(-1)).toEqual({ state: 'error', message: 'Downloaded update failed integrity check' });
    updater.dispose();
    const current = await resolveGitHubReleaseCandidate('n3wbiekkkk', 'Kinex', (async () => new Response(JSON.stringify({ tag_name: 'v0.7.9', assets: [] }))) as typeof fetch);
    expect(current).toBeNull();
    expect(sha256).toHaveLength(64);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

it('does not render update feed URL or folder inputs in SettingsView', () => {
  const settingsSource = fs.readFileSync(
    path.resolve(import.meta.dirname, '../renderer/components/SettingsView.tsx'),
    'utf8'
  );
  expect(settingsSource).not.toMatch(/update-feed|Update Feed|Save Feed|Use GitHub Releases/);
});
