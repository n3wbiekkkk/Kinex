import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { describe, expect, it } from 'vitest';
import { createLocalUpdateFeedServer, isCompatibleUpdateVersion, KinexAutoUpdater } from './updater';

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
