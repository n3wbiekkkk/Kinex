import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { app } from 'electron';
import { autoUpdater } from 'electron-updater';
import type { UpdateStatus } from '../shared/types';

export type FeedSource =
  | { kind: 'remote'; url: string }
  | { kind: 'local-dir'; dir: string }
  | { kind: 'none' };

export function classifyUpdateFeedSource(rawFeed: string): FeedSource {
  const trimmed = rawFeed.trim();
  if (!trimmed) return { kind: 'none' };
  if (/^https?:\/\//i.test(trimmed)) {
    return { kind: 'remote', url: trimmed.replace(/\/+$/, '') };
  }
  return { kind: 'local-dir', dir: path.resolve(trimmed) };
}

export class NookAutoUpdater {
  private status: UpdateStatus = { state: 'idle' };
  private localServer: http.Server | null = null;
  private initialized = false;

  constructor(
    private readonly getFeedUrl: () => string,
    private readonly onStatusChanged: (status: UpdateStatus) => void
  ) {}

  getStatus(): UpdateStatus {
    return this.status;
  }

  private setStatus(next: UpdateStatus): void {
    this.status = next;
    this.onStatusChanged(next);
  }

  init(): void {
    if (this.initialized) return;
    this.initialized = true;

    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on('checking-for-update', () => {
      this.setStatus({ state: 'checking' });
    });

    autoUpdater.on('update-available', (info) => {
      this.setStatus({ state: 'available', version: info.version });
    });

    autoUpdater.on('download-progress', (progress) => {
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

    autoUpdater.on('update-downloaded', (info) => {
      this.setStatus({ state: 'downloaded', version: info.version });
      this.stopLocalFeedServer();
    });

    autoUpdater.on('update-not-available', (info) => {
      this.setStatus({ state: 'up-to-date', version: info.version || app.getVersion() });
      this.stopLocalFeedServer();
    });

    autoUpdater.on('error', (err) => {
      this.setStatus({ state: 'error', message: err?.message || 'Update check failed' });
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

  private async startLocalFeedServer(dir: string): Promise<string> {
    this.stopLocalFeedServer();
    const manifestPath = path.join(dir, 'latest-mac.yml');
    if (!fs.existsSync(manifestPath)) {
      throw new Error(`No latest-mac.yml found in ${dir}`);
    }

    const server = http.createServer((req, res) => {
      const reqPath = decodeURIComponent((req.url || '/').split('?')[0]).replace(/^\/+/, '');
      if (!reqPath || reqPath.includes('..')) {
        res.writeHead(404);
        res.end();
        return;
      }
      const resolved = path.resolve(dir, reqPath);
      if (!resolved.startsWith(dir + path.sep) || !fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) {
        res.writeHead(404);
        res.end();
        return;
      }
      const stat = fs.statSync(resolved);
      const contentType = resolved.endsWith('.yml')
        ? 'text/yaml; charset=utf-8'
        : resolved.endsWith('.zip')
          ? 'application/zip'
          : 'application/octet-stream';
      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': stat.size,
      });
      fs.createReadStream(resolved).pipe(res);
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });

    this.localServer = server;
    const addr = server.address();
    if (!addr || typeof addr === 'string') {
      throw new Error('Failed to bind local update feed server');
    }
    return `http://127.0.0.1:${addr.port}`;
  }

  async checkForUpdates(silentIfUnconfigured = false): Promise<void> {
    this.init();

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
        if (!fs.existsSync(path.join(source.dir, 'latest-mac.yml'))) {
          if (silentIfUnconfigured) {
            this.setStatus({ state: 'idle' });
            return;
          }
          this.setStatus({
            state: 'up-to-date',
            version: app.getVersion(),
          });
          return;
        }
        const localUrl = await this.startLocalFeedServer(source.dir);
        autoUpdater.setFeedURL({ provider: 'generic', url: localUrl });
      } else {
        autoUpdater.setFeedURL({ provider: 'generic', url: source.url });
      }
      await autoUpdater.checkForUpdates();
    } catch (err) {
      this.stopLocalFeedServer();
      this.setStatus({
        state: 'error',
        message: err instanceof Error ? err.message : 'Update check failed',
      });
    }
  }

  async downloadUpdate(): Promise<void> {
    if (!app.isPackaged) return;
    await autoUpdater.downloadUpdate();
  }

  quitAndInstall(): void {
    this.stopLocalFeedServer();
    if (app.isPackaged) {
      autoUpdater.quitAndInstall(false, true);
    }
  }

  dispose(): void {
    this.stopLocalFeedServer();
  }
}
