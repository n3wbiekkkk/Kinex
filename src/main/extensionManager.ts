import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Session } from 'electron';
import type { ExtensionSource, ExtensionViewModel, InstalledExtension } from '../shared/types';
import {
  EXTENSION_ID_RE,
  MAX_EXTENSION_BYTES,
  MAX_EXTENSION_FILES,
  MAX_INSTALLED_EXTENSIONS,
  MAX_MANIFEST_BYTES,
  RUNTIME_ID_RE,
  allDeclaredExtensionFiles,
  isInsideRoot,
  parseExtensionManifest,
  parseWebStoreUrl,
  resolveInsideRoot,
  type ExtensionManifestSummary,
} from './extensionSupport';
import { extractCrxZip, MAX_CRX_BYTES, parseCrx3, verifyCrx3Signature, type ParsedCrx3 } from './crx';
import { downloadWebStoreCrx } from './webStore';

export interface ExtensionManagerHost {
  getExtensions: () => InstalledExtension[];
  commitExtensions: (extensions: InstalledExtension[]) => void;
  getSessionForPartition: (partition: string) => Session;
  showToast: (message: string) => void;
  /** Injectable for deterministic tests; production uses the HTTPS Web Store downloader. */
  downloadWebStoreCrx?: (extensionId: string) => Promise<ParsedCrx3>;
}

const MAX_ICON_BYTES = 64 * 1024;

function extensionErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 200) : 'Extension could not be loaded';
}

function mimeForIcon(file: string): string | null {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.svg') return 'image/svg+xml';
  return null;
}

/** Owns unpacked MV3 extension storage, consent and per-partition session loading. */
export class ExtensionManager {
  private readonly root: string;
  private readonly loadedByPartition = new Map<string, Set<string>>();
  private readonly errors = new Map<string, string>();
  private readonly icons = new Map<string, string>();

  constructor(
    userDataDir: string,
    private readonly host: ExtensionManagerHost
  ) {
    this.root = path.join(userDataDir, 'Extensions');
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }

  getExtension(extensionId: string): InstalledExtension | undefined {
    return this.host.getExtensions().find((extension) => extension.id === extensionId);
  }

  async ensureLoaded(extensionId: string): Promise<boolean> {
    const extension = this.getExtension(extensionId);
    if (!extension || !extension.enabled || !extension.consented) return false;
    return this.loadIntoSession(extension, this.host.getSessionForPartition(extension.partition));
  }

  getViewModels(): ExtensionViewModel[] {
    return this.host.getExtensions().map((extension) => ({
      ...extension,
      loaded: this.loadedByPartition.get(extension.partition)?.has(extension.id) ?? false,
      ...(this.icons.has(extension.id) ? { iconDataUrl: this.icons.get(extension.id) } : {}),
      ...(this.errors.has(extension.id) ? { error: this.errors.get(extension.id) } : {}),
    }));
  }

  /** Called when a regular (persistent) Space session is created. Private sessions never call this. */
  attachSession(partition: string, sess: Session): void {
    if (!partition.startsWith('persist:')) return;
    for (const extension of this.host.getExtensions()) {
      if (extension.partition === partition && extension.enabled && extension.consented) {
        void this.loadIntoSession(extension, sess);
      }
    }
  }

  private resolveExtensionDirectory(extension: InstalledExtension): string | null {
    if (!EXTENSION_ID_RE.test(extension.id) || extension.directory !== extension.id) return null;
    const directory = resolveInsideRoot(this.root, extension.directory);
    if (!directory) return null;
    try {
      const realRoot = fs.realpathSync(this.root);
      const realDirectory = fs.realpathSync(directory);
      if (!fs.statSync(realDirectory).isDirectory() || !isInsideRoot(realRoot, realDirectory)) return null;
      return realDirectory;
    } catch {
      return null;
    }
  }

  private async loadIntoSession(extension: InstalledExtension, sess: Session): Promise<boolean> {
    const directory = this.resolveExtensionDirectory(extension);
    if (!directory) {
      this.errors.set(extension.id, 'Extension files are missing or invalid');
      return false;
    }
    const loaded = this.loadedByPartition.get(extension.partition) ?? new Set<string>();
    this.loadedByPartition.set(extension.partition, loaded);
    if (loaded.has(extension.id)) return true;

    try {
      const existing = sess.extensions.getAllExtensions().find((item) => item.path === directory);
      const assignedId = existing?.id ?? (await sess.extensions.loadExtension(directory, { allowFileAccess: false })).id;
      if (!RUNTIME_ID_RE.test(assignedId)) throw new Error('Chromium returned an invalid extension id');
      loaded.add(extension.id);
      this.errors.delete(extension.id);
      if (extension.runtimeId !== assignedId) {
        this.commit(this.host.getExtensions().map((item) =>
          item.id === extension.id ? { ...item, runtimeId: assignedId } : item
        ));
      }
      return true;
    } catch (error) {
      this.errors.set(extension.id, extensionErrorMessage(error));
      return false;
    }
  }

  private commit(extensions: InstalledExtension[]): void {
    this.host.commitExtensions(extensions);
  }

  private copyExtensionFiles(source: string, target: string, declaredFiles: string[]): void {
    let fileCount = 0;
    let totalBytes = 0;
    const walk = (from: string, to: string): void => {
      for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue;
        if (entry.isSymbolicLink()) throw new Error('Extension contains a symbolic link');
        const sourcePath = path.join(from, entry.name);
        const targetPath = path.join(to, entry.name);
        if (entry.isDirectory()) {
          fileCount += 1;
          if (fileCount > MAX_EXTENSION_FILES) throw new Error('Extension has too many files');
          fs.mkdirSync(targetPath, { recursive: true, mode: 0o700 });
          walk(sourcePath, targetPath);
          continue;
        }
        if (!entry.isFile()) throw new Error('Extension contains an unsupported file type');
        fileCount += 1;
        if (fileCount > MAX_EXTENSION_FILES) throw new Error('Extension has too many files');
        const stats = fs.statSync(sourcePath);
        totalBytes += stats.size;
        if (totalBytes > MAX_EXTENSION_BYTES) throw new Error('Extension is too large');
        fs.copyFileSync(sourcePath, targetPath, fs.constants.COPYFILE_EXCL);
      }
    };
    walk(source, target);
    for (const file of declaredFiles) {
      const resolved = resolveInsideRoot(target, file);
      let isFile = false;
      try {
        isFile = Boolean(resolved) && fs.statSync(resolved!).isFile();
      } catch {
        isFile = false;
      }
      if (!isFile) throw new Error(`Extension is missing ${file}`);
    }
  }

  private readIcon(extension: InstalledExtension, directory: string): string | undefined {
    if (!extension.actionIcon) return undefined;
    const file = resolveInsideRoot(directory, extension.actionIcon);
    if (!file) return undefined;
    const mime = mimeForIcon(file);
    if (!mime) return undefined;
    try {
      if (fs.statSync(file).size > MAX_ICON_BYTES) return undefined;
      return `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;
    } catch {
      return undefined;
    }
  }

  private createTarget(): { id: string; target: string } {
    if (this.host.getExtensions().length >= MAX_INSTALLED_EXTENSIONS) {
      throw new Error('Extension limit reached');
    }
    const id = `ext-${randomUUID()}`;
    const target = path.join(this.root, id);
    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
    return { id, target };
  }

  private readStagedManifest(target: string): ExtensionManifestSummary {
    const manifestPath = resolveInsideRoot(target, 'manifest.json');
    if (!manifestPath) throw new Error('Extension manifest is missing');
    const stats = fs.statSync(manifestPath);
    if (!stats.isFile() || stats.size > MAX_MANIFEST_BYTES) {
      throw new Error('Extension manifest is missing or too large');
    }
    const manifest = parseExtensionManifest(JSON.parse(fs.readFileSync(manifestPath, 'utf8')));
    if (!manifest) throw new Error('Only Manifest V3 extensions with supported fields can be installed');
    return manifest;
  }

  private finalizeInstall(
    id: string,
    target: string,
    manifest: ExtensionManifestSummary,
    partition: string,
    spaceId: string,
    source: ExtensionSource,
    extra: { crxId?: string; webStoreUrl?: string } = {}
  ): InstalledExtension {
    const record: InstalledExtension = {
      id,
      name: manifest.name,
      version: manifest.version,
      ...(manifest.description ? { description: manifest.description } : {}),
      source,
      ...(extra.crxId ? { crxId: extra.crxId } : {}),
      ...(extra.webStoreUrl ? { webStoreUrl: extra.webStoreUrl } : {}),
      directory: id,
      partition,
      spaceId,
      enabled: false,
      consented: false,
      permissions: manifest.permissions,
      hostPermissions: manifest.hostPermissions,
      ...(manifest.actionPopup ? { actionPopup: manifest.actionPopup } : {}),
      ...(manifest.actionIcon ? { actionIcon: manifest.actionIcon } : {}),
      installedAt: Date.now(),
    };
    const icon = this.readIcon(record, target);
    if (icon) this.icons.set(id, icon);
    this.commit([...this.host.getExtensions(), record]);
    this.host.showToast(`${record.name} added. Review its permissions to enable it.`);
    return record;
  }

  private discardTarget(id: string, target: string): void {
    fs.rmSync(target, { recursive: true, force: true });
    this.icons.delete(id);
  }

  async install(sourcePath: string, spaceId: string, partition: string): Promise<InstalledExtension> {
    if (!path.isAbsolute(sourcePath) || !partition.startsWith('persist:')) {
      throw new Error('Invalid extension install request');
    }
    const source = fs.realpathSync(sourcePath);
    const realRoot = fs.realpathSync(this.root);
    if (!fs.statSync(source).isDirectory() || isInsideRoot(realRoot, source)) {
      throw new Error('Choose an unpacked extension folder outside Kinex storage');
    }
    const manifest = this.readStagedManifest(source);
    const { id, target } = this.createTarget();
    try {
      this.copyExtensionFiles(source, target, allDeclaredExtensionFiles(manifest));
      return this.finalizeInstall(id, target, manifest, partition, spaceId, 'folder');
    } catch (error) {
      this.discardTarget(id, target);
      throw error instanceof Error ? error : new Error('Extension could not be installed');
    }
  }

  async installFromCrx(sourcePath: string, spaceId: string, partition: string): Promise<InstalledExtension> {
    if (!path.isAbsolute(sourcePath) || path.extname(sourcePath).toLowerCase() !== '.crx' || !partition.startsWith('persist:')) {
      throw new Error('Invalid CRX install request');
    }
    const stats = fs.statSync(sourcePath);
    if (!stats.isFile() || stats.size > MAX_CRX_BYTES) throw new Error('CRX package is too large');
    const parsed = parseCrx3(fs.readFileSync(sourcePath));
    if (!verifyCrx3Signature(parsed)) throw new Error('CRX3 signature verification failed');
    return this.installParsedCrx(parsed, spaceId, partition, 'crx');
  }

  async installFromWebStore(url: string, spaceId: string, partition: string): Promise<InstalledExtension> {
    if (!partition.startsWith('persist:')) throw new Error('Invalid extension install request');
    const item = parseWebStoreUrl(url);
    if (!item) throw new Error('Invalid Chrome Web Store URL or extension id');
    const parsed = this.host.downloadWebStoreCrx
      ? await this.host.downloadWebStoreCrx(item.extensionId)
      : await downloadWebStoreCrx(item.extensionId);
    if (parsed.crxId !== item.extensionId) throw new Error('Downloaded extension id does not match the Web Store item');
    if (!verifyCrx3Signature(parsed)) throw new Error('CRX3 signature verification failed');
    return this.installParsedCrx(parsed, spaceId, partition, 'webstore', item.itemUrl);
  }

  private installParsedCrx(
    parsed: ParsedCrx3,
    spaceId: string,
    partition: string,
    source: 'crx' | 'webstore',
    webStoreUrl?: string
  ): InstalledExtension {
    const { id, target } = this.createTarget();
    try {
      extractCrxZip(parsed.zip, target);
      const manifest = this.readStagedManifest(target);
      for (const file of allDeclaredExtensionFiles(manifest)) {
        const resolved = resolveInsideRoot(target, file);
        if (!resolved || !fs.statSync(resolved).isFile()) throw new Error(`CRX package is missing ${file}`);
      }
      return this.finalizeInstall(id, target, manifest, partition, spaceId, source, {
        crxId: parsed.crxId,
        ...(webStoreUrl ? { webStoreUrl } : {}),
      });
    } catch (error) {
      this.discardTarget(id, target);
      throw error instanceof Error ? error : new Error('CRX package could not be installed');
    }
  }

  setEnabled(extensionId: string, enabled: boolean, consent?: boolean): void {
    const extensions = this.host.getExtensions();
    const extension = extensions.find((item) => item.id === extensionId);
    if (!extension) return;
    if (enabled && !extension.consented) {
      if (consent !== true) throw new Error('Review and accept the extension permissions before enabling it');
    }
    const updated: InstalledExtension = {
      ...extension,
      enabled,
      ...(enabled ? { consented: true } : {}),
    };
    this.commit(extensions.map((item) => (item.id === extensionId ? updated : item)));
    if (enabled) {
      void this.loadIntoSession(updated, this.host.getSessionForPartition(updated.partition));
    } else {
      this.unload(updated);
    }
  }

  private unload(extension: InstalledExtension): void {
    const loaded = this.loadedByPartition.get(extension.partition);
    if (loaded) loaded.delete(extension.id);
    if (extension.runtimeId && RUNTIME_ID_RE.test(extension.runtimeId)) {
      try {
        this.host.getSessionForPartition(extension.partition).extensions.removeExtension(extension.runtimeId);
      } catch {
        // Already unloaded.
      }
    }
  }

  uninstall(extensionId: string): void {
    const extensions = this.host.getExtensions();
    const extension = extensions.find((item) => item.id === extensionId);
    if (!extension) return;
    this.unload(extension);
    const directory = this.resolveExtensionDirectory(extension);
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
    this.errors.delete(extensionId);
    this.icons.delete(extensionId);
    this.commit(extensions.filter((item) => item.id !== extensionId));
    this.host.showToast(`${extension.name} removed.`);
  }
}
