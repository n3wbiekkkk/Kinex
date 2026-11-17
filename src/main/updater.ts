import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { app } from 'electron';
import { autoUpdater } from 'electron-updater';
import type { AppUpdaterEvents } from 'electron-updater/out/AppUpdater';
import { DEFAULT_UPDATE_FEED_URL } from '../shared/domain';
import type { UpdateStatus } from '../shared/types';
import { isSafeUpdateFeedUrl } from './security';

function formatUpdaterError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err || 'Update check failed');
  if (/404|Cannot find latest-mac\.yml|ERR_UPDATER_LATEST_VERSION_NOT_FOUND/i.test(raw)) {
    return 'No release manifest (latest-mac.yml) published at this update feed yet';
  }
  if (/ENOTFOUND|ECONNREFUSED|ERR_NAME_NOT_RESOLVED|ETIMEDOUT/i.test(raw)) {
    return 'Unable to reach update server — check your internet connection or feed URL';
  }
  return raw.split('\n')[0].slice(0, 140) || 'Update check failed';
}

export type FeedSource =
  | { kind: 'remote'; url: string }
  | { kind: 'local-dir'; dir: string }
  | { kind: 'none' };

export function classifyUpdateFeedSource(rawFeed: string): FeedSource {
  const trimmed = rawFeed.trim();
  if (!trimmed || !isSafeUpdateFeedUrl(trimmed)) return { kind: 'none' };
  if (/^https?:\/\//i.test(trimmed)) {
    return { kind: 'remote', url: trimmed.replace(/\/+$/, '') };
  }
  return { kind: 'local-dir', dir: path.resolve(trimmed) };
}

export function createLocalUpdateFeedServer(dir: string): http.Server {
  const root = path.resolve(dir);
  return http.createServer((req, res) => {
    void (async () => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405).end();
        return;
      }
      let name: string;
      try {
        name = decodeURIComponent((req.url || '/').split('?')[0]).replace(/^\/+/, '');
      } catch {
        res.writeHead(400).end();
        return;
      }
      if (!name || name.includes('\0') || name !== path.basename(name) || name.includes('\\') ||
          !(name === 'latest-mac.yml' || /\.zip(?:\.blockmap)?$/i.test(name))) {
        res.writeHead(404).end();
        return;
      }
      const file = await fs.promises.open(path.join(root, name), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const stat = await file.stat();
        if (!stat.isFile()) {
          res.writeHead(404).end();
          return;
        }
        res.writeHead(200, {
          'Content-Type': name.endsWith('.yml') ? 'text/yaml; charset=utf-8' : 'application/octet-stream',
          'Content-Length': stat.size,
          'X-Content-Type-Options': 'nosniff',
        });
        if (req.method === 'HEAD') {
          res.end();
          return;
        }
        const stream = file.createReadStream({ autoClose: false });
        stream.on('error', () => res.destroy());
        res.once('close', () => stream.destroy());
        await new Promise<void>((resolve) => {
          stream.once('close', resolve);
          stream.once('end', resolve);
          stream.once('error', () => resolve());
          stream.pipe(res);
        });
      } finally {
        await file.close();
      }
    })().catch(() => {
      if (!res.headersSent) res.writeHead(404).end();
      else res.destroy();
    });
  });
}

export class KinexAutoUpdater {
  private status: UpdateStatus = { state: 'idle' };
  private localServer: http.Server | null = null;
  private initialized = false;
  private generation = 0;
  private disposed = false;
  private checkPromise: Promise<void> | null = null;
  private readonly removeListeners: Array<() => void> = [];

  private on<K extends keyof AppUpdaterEvents>(event: K, listener: AppUpdaterEvents[K]): void {
    autoUpdater.on(event, listener);
    this.removeListeners.push(() => autoUpdater.removeListener(event, listener));
  }

  constructor(
    private readonly getFeedUrl: () => string,
    private readonly onStatusChanged: (status: UpdateStatus) => void
  ) {}

  getStatus(): UpdateStatus {
    return this.status;
  }

  private setStatus(next: UpdateStatus): void {
    if (this.disposed) return;
    this.status = next;
    this.onStatusChanged(next);
  }

  init(): void {
    if (this.initialized) return;
    this.initialized = true;
    this.disposed = false;

    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    this.on('checking-for-update', () => {
      this.setStatus({ state: 'checking' });
    });

    this.on('update-available', (info) => {
      this.setStatus({ state: 'available', version: info.version });
    });

    this.on('download-progress', (progress) => {
      const ver =
        this.status.state === 'available' || this.status.state === 'downloading'
          ? this.status.version
          : 'new';
      this.setStatus({
        state: 'downloading',
        version: ver,
        percent: Math.round(progress.percent),
      });
    });

    this.on('update-downloaded', (info) => {
      this.setStatus({ state: 'downloaded', version: info.version });
      this.stopLocalFeedServer();
    });

    this.on('update-not-available', (info) => {
      this.setStatus({ state: 'up-to-date', version: info.version || app.getVersion() });
      this.stopLocalFeedServer();
    });

    this.on('error', (err) => {
      this.setStatus({ state: 'error', message: formatUpdaterError(err) });
      this.stopLocalFeedServer();
    });
  }

  private stopLocalFeedServer(): void {
    if (this.localServer) {
      try {
        this.localServer.close();
      } catch {
        // Ignore already-closed server
      }
      this.localServer = null;
    }
  }

  private async startLocalFeedServer(dir: string, generation = this.generation): Promise<string> {
    this.stopLocalFeedServer();
    const manifestPath = path.join(dir, 'latest-mac.yml');
    if (!fs.existsSync(manifestPath)) {
      throw new Error(`No latest-mac.yml found in ${dir}`);
    }

    const server = createLocalUpdateFeedServer(dir);

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });

    if (this.disposed || generation !== this.generation) {
      server.close();
      throw new Error('Update check cancelled');
    }
    this.localServer = server;
    const addr = server.address();
    if (!addr || typeof addr === 'string') {
      throw new Error('Failed to bind local update feed server');
    }
    return `http://127.0.0.1:${addr.port}`;
  }

  checkForUpdates(silentIfUnconfigured = false): Promise<void> {
    if (this.status.state === 'downloading' || this.status.state === 'available' || this.status.state === 'downloaded') return Promise.resolve();
    if (!this.checkPromise) {
      this.checkPromise = this.performCheck(silentIfUnconfigured).finally(() => { this.checkPromise = null; });
    }
    return this.checkPromise;
  }

  private async performCheck(silentIfUnconfigured: boolean): Promise<void> {
    this.init();
    const generation = this.generation;

    if (!app.isPackaged) {
      if (!silentIfUnconfigured) {
        this.setStatus({
          state: 'idle',
          message: 'Run from installed Kinex.app to self-update',
        });
      }
      return;
    }

    const source = classifyUpdateFeedSource(this.getFeedUrl());
    if (source.kind === 'none') {
      if (!silentIfUnconfigured) {
        this.setStatus({ state: 'error', message: 'Set an Update Feed URL or folder in Settings' });
      }
      return;
    }

    try {
      this.setStatus({ state: 'checking' });
      if (source.kind === 'local-dir') {
        if (!fs.existsSync(source.dir)) {
          autoUpdater.setFeedURL({ provider: 'generic', url: DEFAULT_UPDATE_FEED_URL });
        } else if (!fs.existsSync(path.join(source.dir, 'latest-mac.yml'))) {
          if (silentIfUnconfigured) {
            this.setStatus({ state: 'idle' });
            return;
          }
          this.setStatus({
            state: 'up-to-date',
            version: app.getVersion(),
          });
          return;
        } else {
          const localUrl = await this.startLocalFeedServer(source.dir, generation);
          autoUpdater.setFeedURL({ provider: 'generic', url: localUrl });
        }
      } else {
        autoUpdater.setFeedURL({ provider: 'generic', url: source.url });
      }
      if (this.disposed || generation !== this.generation) return;
      await autoUpdater.checkForUpdates();
    } catch (err) {
      if (this.disposed || generation !== this.generation) return;
      this.stopLocalFeedServer();
      this.setStatus({
        state: 'error',
        message: formatUpdaterError(err),
      });
    }
  }

  async downloadUpdate(): Promise<void> {
    if (!app.isPackaged) return;
    try {
      await autoUpdater.downloadUpdate();
    } catch (error) {
      this.setStatus({ state: 'error', message: formatUpdaterError(error) });
    }
  }

  quitAndInstall(): void {
    this.stopLocalFeedServer();
    if (app.isPackaged && this.status.state === 'downloaded') {
      autoUpdater.quitAndInstall(false, true);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.generation += 1;
    for (const remove of this.removeListeners) remove();
    this.removeListeners.length = 0;
    this.initialized = false;
    this.stopLocalFeedServer();
  }
}

/** @deprecated Use KinexAutoUpdater */
export const NookAutoUpdater = KinexAutoUpdater;
