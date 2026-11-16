import fs from 'node:fs';
import path from 'node:path';
import { app, shell, type DownloadItem as ElectronDownloadItem, type Session } from 'electron';
import type { DownloadItem } from '../shared/types';

const trackedRegularSessions = new WeakSet<Session>();
const trackedPrivateSessions = new WeakSet<Session>();

export function isTrackedDownloadPath(savePath: string, downloads: DownloadItem[]): boolean {
  const clean = savePath.trim();
  if (!clean || clean.includes('\0')) return false;
  const resolved = path.resolve(clean);
  return downloads.some((d) => d.savePath && path.resolve(d.savePath) === resolved);
}

export function getUniqueDownloadSavePath(dlDir: string, rawFilename: string): string {
  const baseName = path.basename(rawFilename || 'download').replace(/[\0/\\]/g, '_') || 'download';
  const ext = path.extname(baseName);
  const stem = ext ? baseName.slice(0, -ext.length) : baseName;
  let candidate = path.join(dlDir, baseName);
  let counter = 1;
  while (fs.existsSync(candidate) && counter < 100) {
    candidate = path.join(dlDir, `${stem} (${counter})${ext}`);
    counter += 1;
  }
  return candidate;
}

export class DownloadManager {
  private downloads: DownloadItem[] = [];
  private readonly liveItems = new Map<string, ElectronDownloadItem>();
  private readonly speedSampleById = new Map<string, { atMs: number; bytes: number; lastBroadcastMs: number }>();
  private readonly activeDownloadCountsByWcId = new Map<number, number>();
  private disposed = false;

  constructor(private readonly onUpdated: () => void) {}

  getDownloads(): DownloadItem[] {
    return this.downloads;
  }

  hasActiveDownloadForWebContents(wcId: number): boolean {
    return (this.activeDownloadCountsByWcId.get(wcId) ?? 0) > 0;
  }

  hasAnyActiveDownload(): boolean {
    return this.activeDownloadCountsByWcId.size > 0;
  }

  private incrementActiveWc(wcId: number | undefined): void {
    if (!wcId) return;
    this.activeDownloadCountsByWcId.set(wcId, (this.activeDownloadCountsByWcId.get(wcId) ?? 0) + 1);
  }

  private decrementActiveWc(wcId: number | undefined): void {
    if (!wcId) return;
    const prev = this.activeDownloadCountsByWcId.get(wcId) ?? 0;
    if (prev <= 1) {
      this.activeDownloadCountsByWcId.delete(wcId);
    } else {
      this.activeDownloadCountsByWcId.set(wcId, prev - 1);
    }
  }

  attachRegularSession(sess: Session): void {
    if (trackedRegularSessions.has(sess)) return;
    trackedRegularSessions.add(sess);

    sess.on('will-download', (_event, item, webContents) => {
      if (this.disposed) return;
      const dlDir = app.getPath('downloads');
      const targetPath = getUniqueDownloadSavePath(dlDir, item.getFilename() || 'download');
      const finalFilename = path.basename(targetPath);
      item.setSavePath(targetPath);

      const sourceWcId = webContents && !webContents.isDestroyed() ? webContents.id : undefined;
      this.incrementActiveWc(sourceWcId);

      const id = `dl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const entry: DownloadItem = {
        id,
        filename: finalFilename,
        url: item.getURL(),
        savePath: targetPath,
        receivedBytes: item.getReceivedBytes(),
        totalBytes: item.getTotalBytes(),
        state: 'progressing',
        startedAt: Date.now(),
        speedBytesPerSec: 0,
        canResume: item.canResume(),
        isPaused: item.isPaused(),
        mimeType: item.getMimeType(),
      };
      this.liveItems.set(id, item);
      this.speedSampleById.set(id, {
        atMs: Date.now(),
        bytes: entry.receivedBytes,
        lastBroadcastMs: Date.now(),
      });
      this.downloads = [entry, ...this.downloads.slice(0, 39)];
      this.onUpdated();

      item.on('updated', (_ev, state) => {
        if (this.disposed) return;
        const now = Date.now();
        const received = item.getReceivedBytes();
        const total = item.getTotalBytes();
        const sample = this.speedSampleById.get(id);
        let speed = entry.speedBytesPerSec ?? 0;
        if (sample && now - sample.atMs >= 250) {
          const dtSec = Math.max(0.05, (now - sample.atMs) / 1000);
          speed = Math.max(0, Math.round((received - sample.bytes) / dtSec));
          sample.atMs = now;
          sample.bytes = received;
        }
        const paused = item.isPaused();
        entry.receivedBytes = received;
        entry.totalBytes = total;
        entry.isPaused = paused;
        entry.canResume = item.canResume();
        entry.speedBytesPerSec = paused ? 0 : speed;
        entry.etaSeconds =
          !paused && speed > 0 && total > received
            ? Math.ceil((total - received) / speed)
            : undefined;
        entry.state = state === 'interrupted' ? 'interrupted' : 'progressing';

        if (!sample || now - sample.lastBroadcastMs >= 200) {
          if (sample) sample.lastBroadcastMs = now;
          this.onUpdated();
        }
      });

      item.once('done', (_ev, state) => {
        this.decrementActiveWc(sourceWcId);
        this.liveItems.delete(id);
        this.speedSampleById.delete(id);
        if (this.disposed) return;
        entry.receivedBytes = item.getReceivedBytes();
        entry.totalBytes = item.getTotalBytes();
        entry.isPaused = false;
        entry.canResume = false;
        entry.speedBytesPerSec = 0;
        entry.etaSeconds = undefined;
        entry.state =
          state === 'completed' ? 'completed' : state === 'cancelled' ? 'cancelled' : 'interrupted';
        this.onUpdated();
      });
    });
  }

  attachPrivateSession(sess: Session): void {
    if (trackedPrivateSessions.has(sess)) return;
    trackedPrivateSessions.add(sess);

    sess.on('will-download', (_event, item) => {
      const dlDir = app.getPath('downloads');
      const targetPath = getUniqueDownloadSavePath(dlDir, item.getFilename() || 'download');
      item.setSavePath(targetPath);
      // Intentionally do not record private-window downloads in regular session history/snapshot
    });
  }

  pauseDownload(downloadId: string): boolean {
    const item = this.liveItems.get(downloadId);
    const entry = this.downloads.find((d) => d.id === downloadId);
    if (!item || !entry || entry.state !== 'progressing' || item.isPaused()) return false;
    item.pause();
    entry.isPaused = item.isPaused();
    entry.canResume = item.canResume();
    entry.speedBytesPerSec = 0;
    entry.etaSeconds = undefined;
    this.onUpdated();
    return true;
  }

  resumeDownload(downloadId: string): boolean {
    const item = this.liveItems.get(downloadId);
    const entry = this.downloads.find((d) => d.id === downloadId);
    if (!item || !entry || !item.canResume()) return false;
    item.resume();
    entry.isPaused = item.isPaused();
    entry.canResume = item.canResume();
    entry.state = 'progressing';
    this.onUpdated();
    return true;
  }

  cancelDownload(downloadId: string): boolean {
    const item = this.liveItems.get(downloadId);
    const entry = this.downloads.find((d) => d.id === downloadId);
    if (!item || !entry) return false;
    item.cancel();
    return true;
  }

  openCompletedDownload(downloadId: string): boolean {
    const entry = this.downloads.find((d) => d.id === downloadId);
    if (!entry || entry.state !== 'completed' || !isTrackedDownloadPath(entry.savePath, this.downloads)) {
      return false;
    }
    const dlRoot = path.resolve(app.getPath('downloads'));
    const resolved = path.resolve(entry.savePath);
    if (!resolved.startsWith(`${dlRoot}${path.sep}`) && resolved !== dlRoot) {
      return false;
    }
    if (!fs.existsSync(resolved)) {
      return false;
    }
    void shell.openPath(resolved);
    return true;
  }

  clearCompleted(): void {
    this.downloads = this.downloads.filter((d) => d.state === 'progressing');
    this.onUpdated();
  }

  showInFinder(savePath: string): boolean {
    if (!isTrackedDownloadPath(savePath, this.downloads)) {
      return false;
    }
    const resolved = path.resolve(savePath);
    if (!fs.existsSync(resolved)) {
      return false;
    }
    shell.showItemInFolder(resolved);
    return true;
  }

  resetForNewWindow(): void {
    this.disposed = false;
  }

  dispose(): void {
    this.disposed = true;
    for (const item of this.liveItems.values()) {
      try {
        item.cancel();
      } catch {
        // Ignore teardown cancellation failure
      }
    }
    this.liveItems.clear();
    this.speedSampleById.clear();
    this.downloads = [];
    this.activeDownloadCountsByWcId.clear();
  }
}
