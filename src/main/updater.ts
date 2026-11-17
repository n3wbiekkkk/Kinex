import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { app, shell } from 'electron';
import { autoUpdater } from 'electron-updater';
import type { AppUpdaterEvents } from 'electron-updater/out/AppUpdater';
import { DEFAULT_UPDATE_FEED_URL } from '../shared/domain';
import type { UpdateStatus } from '../shared/types';
import { isSafeUpdateFeedUrl } from './security';

export function isMissingManifestError(err: unknown): boolean {
  const raw = err instanceof Error ? err.message : String(err || '');
  return /404|Cannot find latest-mac\.yml|ERR_UPDATER_LATEST_VERSION_NOT_FOUND/i.test(raw);
}

export function isSignatureValidationError(err: unknown): boolean {
  const raw = err instanceof Error ? err.message : String(err || '');
  return /SQRLCodeSignatureErrorDomain|did not pass validation|code failed to satisfy specified code requirement/i.test(raw);
}

export function formatUpdaterError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err || 'Update check failed');
  if (isMissingManifestError(err)) {
    return 'Unable to check for updates right now. Please try again later.';
  }
  if (/ENOTFOUND|ECONNREFUSED|ERR_NAME_NOT_RESOLVED|ETIMEDOUT|EAI_AGAIN|fetch failed/i.test(raw)) {
    return 'Unable to check for updates. Check your internet connection and try again.';
  }
  if (isSignatureValidationError(err)) {
    return 'Automatic update requires a signed release build.';
  }
  return raw.split('\n')[0].slice(0, 140) || 'Update check failed';
}

const MISNUMBERED_RELEASES = new Set(['7.0.1', '7.0.2', '7.0.3']);

export function isCompatibleUpdateVersion(currentVersion: string, nextVersion: string): boolean {
  return !currentVersion.startsWith('0.') || !MISNUMBERED_RELEASES.has(nextVersion);
}

export function compareSemver(a: string, b: string): number {
  const parse = (v: string): [number, number, number] | null => {
    const match = /^\s*v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:[-+].*)?\s*$/.exec(v);
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return NaN;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1;
  }
  return 0;
}

export interface ReleaseFallbackCandidate {
  version: string;
  assetUrl: string;
  assetName: string;
  sha256?: string;
  size?: number;
}

export function parseGitHubFeedRepo(rawUrl: string): { owner: string; repo: string } | null {
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'github.com') return null;
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts.length >= 3 && parts[2].toLowerCase() === 'releases') {
      return { owner: parts[0], repo: parts[1] };
    }
    return null;
  } catch {
    return null;
  }
}

export async function resolveGitHubReleaseCandidate(
  owner: string,
  repo: string,
  fetchImpl: typeof fetch = fetch
): Promise<ReleaseFallbackCandidate | null> {
  const downloadPrefix = `https://github.com/${owner}/${repo}/releases/download/`;
  try {
    const apiRes = await fetchImpl(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases/latest`,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'Kinex-Browser',
        },
      }
    );
    if (apiRes.ok) {
      const data = (await apiRes.json()) as {
        tag_name?: unknown;
        assets?: Array<{
          name?: unknown;
          browser_download_url?: unknown;
          digest?: unknown;
          size?: unknown;
        }>;
      };
      const version = String(data?.tag_name || '').replace(/^v/i, '').trim();
      if (compareSemver(version, '0.0.0') >= 0) {
        const assets = Array.isArray(data?.assets) ? data.assets : [];
        const dmgAsset =
          assets.find((item) => typeof item?.name === 'string' && /arm64.*\.dmg$/i.test(item.name)) ||
          assets.find((item) => typeof item?.name === 'string' && /\.dmg$/i.test(item.name)) ||
          assets.find((item) => typeof item?.name === 'string' && /arm64.*\.zip$/i.test(item.name)) ||
          assets.find((item) => typeof item?.name === 'string' && /\.zip$/i.test(item.name));
        const rawUrl = typeof dmgAsset?.browser_download_url === 'string' ? dmgAsset.browser_download_url : '';
        if (rawUrl.toLowerCase().startsWith(downloadPrefix.toLowerCase())) {
          const assetName = path.basename(new URL(rawUrl).pathname);
          const digest = typeof dmgAsset?.digest === 'string' ? dmgAsset.digest : '';
          const shaMatch = /^sha256:([a-f0-9]{64})$/i.exec(digest);
          return {
            version,
            assetUrl: rawUrl,
            assetName,
            sha256: shaMatch ? shaMatch[1].toLowerCase() : undefined,
            size: typeof dmgAsset?.size === 'number' && Number.isFinite(dmgAsset.size) ? dmgAsset.size : undefined,
          };
        }
        const fallbackName = `Kinex-${version}-arm64.dmg`;
        return {
          version,
          assetName: fallbackName,
          assetUrl: `${downloadPrefix}v${version}/${fallbackName}`,
        };
      }
    }
  } catch {}

  const headRes = await fetchImpl(
    `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases/latest`,
    { method: 'HEAD', redirect: 'follow' }
  );
  const tagMatch = /\/releases\/tag\/v?(\d+\.\d+\.\d+)\/?$/i.exec(headRes.url || '');
  if (!tagMatch) return null;
  const version = tagMatch[1];
  const assetName = `Kinex-${version}-arm64.dmg`;
  return {
    version,
    assetName,
    assetUrl: `${downloadPrefix}v${version}/${assetName}`,
  };
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

function verifyDmgIntegrity(dmgPath: string): Promise<void> {
  if (process.platform !== 'darwin') return Promise.resolve();
  return new Promise((resolve, reject) => {
    execFile('hdiutil', ['verify', dmgPath], (err) => {
      if (err) reject(new Error('Downloaded update image failed verification'));
      else resolve();
    });
  });
}

export interface UpdaterRuntimeDeps {
  isPackaged?: () => boolean;
  getVersion?: () => string;
  getTempDir?: () => string;
  openPath?: (targetPath: string) => Promise<string>;
  fetchImpl?: typeof fetch;
  checkManifest?: (feedUrl: string) => Promise<void>;
}

export class KinexAutoUpdater {
  private status: UpdateStatus = { state: 'idle' };
  private localServer: http.Server | null = null;
  private activeLocalDir: string | null = null;
  private downloadedInstallerPath: string | null = null;
  private initialized = false;
  private generation = 0;
  private disposed = false;
  private suppressManifestNotFoundError = false;
  private checkPromise: Promise<void> | null = null;
  private readonly removeListeners: Array<() => void> = [];

  private on<K extends keyof AppUpdaterEvents>(event: K, listener: AppUpdaterEvents[K]): void {
    autoUpdater.on(event, listener);
    this.removeListeners.push(() => autoUpdater.removeListener(event, listener));
  }

  constructor(
    private readonly getFeedUrl: () => string,
    private readonly onStatusChanged: (status: UpdateStatus) => void,
    private readonly deps: UpdaterRuntimeDeps = {}
  ) {}

  private isPackaged(): boolean {
    return this.deps.isPackaged ? this.deps.isPackaged() : Boolean(app?.isPackaged);
  }

  private getCurrentVersion(): string {
    return this.deps.getVersion ? this.deps.getVersion() : app.getVersion();
  }

  private getTempPath(): string {
    return this.deps.getTempDir ? this.deps.getTempDir() : app.getPath('temp');
  }

  private getFetch(): typeof fetch {
    return this.deps.fetchImpl ?? fetch;
  }

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
    if (this.deps.checkManifest) return;

    autoUpdater.allowDowngrade = false;
    const supported = autoUpdater.isUpdateSupported;
    autoUpdater.isUpdateSupported = (info) => isCompatibleUpdateVersion(autoUpdater.currentVersion.version, info.version) && supported(info);
    this.removeListeners.push(() => { autoUpdater.isUpdateSupported = supported; });
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    this.on('checking-for-update', () => {
      this.setStatus({ state: 'checking' });
    });

    this.on('update-available', (info) => {
      this.downloadedInstallerPath = null;
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

    this.on('update-not-available', () => {
      this.setStatus({ state: 'up-to-date', version: this.getCurrentVersion() });
      this.stopLocalFeedServer();
    });

    this.on('error', (err) => {
      if (this.suppressManifestNotFoundError && isMissingManifestError(err)) {
        return;
      }
      if (isSignatureValidationError(err) && this.status.state === 'downloaded' && this.activeLocalDir) {
        const localDmg = path.join(this.activeLocalDir, `Kinex-${this.status.version}-arm64.dmg`);
        if (fs.existsSync(localDmg)) {
          this.downloadedInstallerPath = localDmg;
          this.stopLocalFeedServer();
          return;
        }
      }
      this.setStatus({ state: 'error', message: formatUpdaterError(err) });
      this.stopLocalFeedServer();
    });
  }

  private stopLocalFeedServer(): void {
    if (this.localServer) {
      try {
        this.localServer.close();
      } catch {}
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

    if (!this.isPackaged()) {
      if (!silentIfUnconfigured) {
        this.setStatus({
          state: 'idle',
          message: 'Run from installed Kinex.app to self-update',
        });
      }
      return;
    }

    const resolvedSource = classifyUpdateFeedSource(this.getFeedUrl());
    const source: Exclude<FeedSource, { kind: 'none' }> =
      resolvedSource.kind === 'none'
        ? { kind: 'remote', url: DEFAULT_UPDATE_FEED_URL }
        : resolvedSource;

    let remoteFeedUrl = DEFAULT_UPDATE_FEED_URL;
    try {
      this.setStatus({ state: 'checking' });
      if (source.kind === 'local-dir') {
        if (!fs.existsSync(source.dir)) {
          this.activeLocalDir = null;
          if (!this.deps.checkManifest) {
            autoUpdater.setFeedURL({ provider: 'generic', url: DEFAULT_UPDATE_FEED_URL });
          }
        } else if (!fs.existsSync(path.join(source.dir, 'latest-mac.yml'))) {
          this.activeLocalDir = null;
          if (silentIfUnconfigured) {
            this.setStatus({ state: 'idle' });
            return;
          }
          this.setStatus({
            state: 'up-to-date',
            version: this.getCurrentVersion(),
          });
          return;
        } else {
          this.activeLocalDir = source.dir;
          const localUrl = await this.startLocalFeedServer(source.dir, generation);
          remoteFeedUrl = localUrl;
          if (!this.deps.checkManifest) {
            autoUpdater.setFeedURL({ provider: 'generic', url: localUrl });
          }
        }
      } else {
        this.activeLocalDir = null;
        remoteFeedUrl = source.url;
        if (!this.deps.checkManifest) {
          autoUpdater.setFeedURL({ provider: 'generic', url: source.url });
        }
      }
      if (this.disposed || generation !== this.generation) return;
      const ghRepo = this.activeLocalDir ? null : parseGitHubFeedRepo(remoteFeedUrl);
      this.suppressManifestNotFoundError = Boolean(ghRepo);
      try {
        if (this.deps.checkManifest) {
          await this.deps.checkManifest(remoteFeedUrl);
        } else {
          await autoUpdater.checkForUpdates();
        }
      } catch (err) {
        if (ghRepo && isMissingManifestError(err)) {
          await this.checkViaGitHubReleaseFallback(ghRepo, generation);
          return;
        }
        throw err;
      } finally {
        this.suppressManifestNotFoundError = false;
      }
    } catch (err) {
      if (this.disposed || generation !== this.generation) return;
      this.stopLocalFeedServer();
      this.setStatus({
        state: 'error',
        message: formatUpdaterError(err),
      });
    }
  }

  private async checkViaGitHubReleaseFallback(
    repo: { owner: string; repo: string },
    generation: number
  ): Promise<void> {
    const candidate = await resolveGitHubReleaseCandidate(repo.owner, repo.repo, this.getFetch());
    if (this.disposed || generation !== this.generation) return;
    if (!candidate) {
      throw new Error('Unable to check for updates right now. Please try again later.');
    }
    const currentVersion = this.getCurrentVersion();
    if (
      !isCompatibleUpdateVersion(currentVersion, candidate.version) ||
      !(compareSemver(candidate.version, currentVersion) > 0)
    ) {
      this.setStatus({ state: 'up-to-date', version: currentVersion });
      return;
    }
    this.downloadedInstallerPath = null;
    this.setStatus({ state: 'available', version: candidate.version });
    await this.downloadFallbackInstaller(candidate, generation);
  }

  private async downloadFallbackInstaller(
    candidate: ReleaseFallbackCandidate,
    generation: number
  ): Promise<void> {
    if (
      !candidate.assetUrl.startsWith('https://') ||
      candidate.assetName !== path.basename(candidate.assetName) ||
      !/^Kinex-[0-9A-Za-z._-]+\.(?:dmg|zip)$/i.test(candidate.assetName)
    ) {
      throw new Error('Update package URL failed validation');
    }

    const updateDir = path.join(this.getTempPath(), 'kinex-updates');
    await fs.promises.mkdir(updateDir, { recursive: true });
    const finalPath = path.join(updateDir, candidate.assetName);
    const partPath = `${finalPath}.part`;

    if (candidate.sha256 && fs.existsSync(finalPath)) {
      const existingHash = createHash('sha256');
      existingHash.update(await fs.promises.readFile(finalPath));
      if (existingHash.digest('hex').toLowerCase() === candidate.sha256.toLowerCase()) {
        this.downloadedInstallerPath = finalPath;
        this.setStatus({ state: 'downloaded', version: candidate.version });
        return;
      }
    }

    const res = await this.getFetch()(candidate.assetUrl);
    if (!res.ok || !res.body) {
      throw new Error('Unable to download update package');
    }
    const totalBytes = Number(res.headers.get('content-length')) || candidate.size || 0;
    const hash = createHash('sha256');
    let receivedBytes = 0;
    let lastPercent = -1;

    const fileStream = fs.createWriteStream(partPath, { flags: 'w' });
    try {
      const nodeBody = Readable.fromWeb(res.body as unknown as WebReadableStream);
      for await (const chunk of nodeBody) {
        if (this.disposed || generation !== this.generation) {
          throw new Error('Update check cancelled');
        }
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        hash.update(buf);
        receivedBytes += buf.length;
        if (!fileStream.write(buf)) {
          await new Promise<void>((resolve) => fileStream.once('drain', resolve));
        }
        if (totalBytes > 0) {
          const percent = Math.min(99, Math.round((receivedBytes / totalBytes) * 100));
          if (percent !== lastPercent) {
            lastPercent = percent;
            this.setStatus({ state: 'downloading', version: candidate.version, percent });
          }
        }
      }
      await new Promise<void>((resolve, reject) => {
        fileStream.end((err?: Error | null) => (err ? reject(err) : resolve()));
      });
      if (candidate.sha256 && hash.digest('hex').toLowerCase() !== candidate.sha256.toLowerCase()) {
        throw new Error('Downloaded update failed integrity check');
      }
      if (partPath.toLowerCase().endsWith('.dmg')) {
        await verifyDmgIntegrity(partPath);
      }
      await fs.promises.rename(partPath, finalPath);
    } catch (err) {
      fileStream.destroy();
      await fs.promises.rm(partPath, { force: true }).catch(() => {});
      throw err;
    }

    if (this.disposed || generation !== this.generation) return;
    this.downloadedInstallerPath = finalPath;
    this.setStatus({ state: 'downloaded', version: candidate.version });
  }

  async downloadUpdate(): Promise<void> {
    if (!this.isPackaged()) return;
    try {
      await autoUpdater.downloadUpdate();
    } catch (error) {
      this.setStatus({ state: 'error', message: formatUpdaterError(error) });
    }
  }

  quitAndInstall(): void {
    this.stopLocalFeedServer();
    if (this.status.state !== 'downloaded') return;
    if (this.downloadedInstallerPath && fs.existsSync(this.downloadedInstallerPath)) {
      const openPath = this.deps.openPath ?? ((target: string) => shell.openPath(target));
      void openPath(this.downloadedInstallerPath).then((err) => {
        if (!err && !this.deps.openPath && typeof app?.quit === 'function') {
          app.quit();
        }
      });
      return;
    }
    if (this.isPackaged()) {
      autoUpdater.quitAndInstall(false, true);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.generation += 1;
    this.suppressManifestNotFoundError = false;
    for (const remove of this.removeListeners) remove();
    this.removeListeners.length = 0;
    this.initialized = false;
    this.stopLocalFeedServer();
  }
}
