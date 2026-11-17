import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InstalledExtension } from '../shared/types';
import { createDefaultPersistedData } from '../shared/domain';
import { ExtensionManager } from './extensionManager';
import { isSafeRelativePath, parseExtensionManifest } from './extensionSupport';
import { TrustedIpcRegistry, validateIntent } from './ipcValidation';
import { isSafeNavigationUrl } from './security';
import { KinexPersistence } from './persistence';

const temporaryDirs: string[] = [];
const RUNTIME_ID = 'a'.repeat(32);

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirs.push(dir);
  return dir;
}

function validManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    manifest_version: 3,
    name: 'Fixture Extension',
    version: '1.0.0',
    description: 'Test fixture',
    permissions: ['storage', 'scripting'],
    host_permissions: ['http://localhost/*'],
    content_scripts: [{ matches: ['http://localhost/*'], js: ['content.js'] }],
    background: { service_worker: 'background.js' },
    action: { default_popup: 'popup.html', default_icon: 'icon.png' },
    ...overrides,
  };
}

function writeFixture(source: string, manifest: Record<string, unknown> = validManifest()): void {
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, 'manifest.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(source, 'content.js'), 'document.body.dataset.extension = "yes";');
  fs.writeFileSync(path.join(source, 'background.js'), 'chrome.runtime.onInstalled.addListener(() => {});');
  fs.writeFileSync(path.join(source, 'popup.html'), '<!doctype html><title>Popup</title>');
  fs.writeFileSync(path.join(source, 'icon.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of temporaryDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('extension support helpers', () => {
  it('accepts a supported MV3 manifest and records its declared files', () => {
    const parsed = parseExtensionManifest(validManifest());
    expect(parsed).not.toBeNull();
    expect(parsed!.name).toBe('Fixture Extension');
    expect(parsed!.contentScriptFiles).toEqual(['content.js']);
    expect(parsed!.actionPopup).toBe('popup.html');
    expect(parsed!.actionIcon).toBe('icon.png');
  });

  it('rejects unsupported manifests and escaping paths', () => {
    expect(parseExtensionManifest(validManifest({ manifest_version: 2 }))).toBeNull();
    expect(parseExtensionManifest(validManifest({ action: { default_popup: '../escape.html' } }))).toBeNull();
    expect(parseExtensionManifest(validManifest({ content_scripts: [{ matches: ['*'], js: ['/etc/passwd'] }] }))).toBeNull();
    expect(isSafeRelativePath('content.js')).toBe(true);
    expect(isSafeRelativePath('../content.js')).toBe(false);
    expect(isSafeRelativePath('C:\\evil.js')).toBe(false);
  });
});

describe('extension IPC intents', () => {
  it('accepts well-formed extension intents', () => {
    const install = validateIntent({ type: 'install-extension', sourcePath: '/tmp/extension' });
    expect(install.ok).toBe(true);
    const enable = validateIntent({
      type: 'set-extension-enabled',
      extensionId: `ext-${'a'.repeat(8)}-${'a'.repeat(4)}-${'a'.repeat(4)}-${'a'.repeat(4)}-${'a'.repeat(12)}`,
      enabled: true,
      consent: true,
    });
    expect(enable.ok).toBe(true);
    expect(validateIntent({ type: 'close-extension-popup' }).ok).toBe(true);
  });

  it('rejects traversal paths, bad ids and unknown consent values', () => {
    expect(validateIntent({ type: 'install-extension', sourcePath: '../extension' }).ok).toBe(false);
    expect(validateIntent({ type: 'uninstall-extension', extensionId: '../../etc' }).ok).toBe(false);
    expect(validateIntent({ type: 'set-extension-enabled', extensionId: 'bad', enabled: true }).ok).toBe(false);
    expect(validateIntent({ type: 'set-extension-enabled', extensionId: `ext-${'a'.repeat(8)}-${'a'.repeat(4)}-${'a'.repeat(4)}-${'a'.repeat(4)}-${'a'.repeat(12)}`, enabled: true, consent: 'yes' }).ok).toBe(false);
  });
});

describe('persisted extension sanitization', () => {
  it('keeps valid records and drops traversal or malformed ones', () => {
    const defaults = createDefaultPersistedData();
    const id = `ext-${'b'.repeat(8)}-${'b'.repeat(4)}-${'b'.repeat(4)}-${'b'.repeat(4)}-${'b'.repeat(12)}`;
    const valid: InstalledExtension = {
      id,
      name: 'Valid',
      version: '1.0.0',
      directory: id,
      partition: 'persist:nook-default',
      spaceId: 'space-personal',
      enabled: true,
      consented: true,
      permissions: ['storage'],
      hostPermissions: ['http://localhost/*'],
      actionPopup: 'popup.html',
      installedAt: 1,
    };
    const dir = tempDir('kinex-ext-persist-');
    const persistence = new KinexPersistence(dir);
    fs.writeFileSync(persistence.getStateFilePath(), JSON.stringify({
      ...defaults,
      extensions: [
        valid,
        { ...valid, id: `ext-${'c'.repeat(8)}-${'c'.repeat(4)}-${'c'.repeat(4)}-${'c'.repeat(4)}-${'c'.repeat(12)}`, directory: 'ext-evil', actionPopup: '../escape.html' },
        { ...valid, id: 'not-an-extension-id', directory: 'not-an-extension-id' },
      ],
    }));
    const restored = persistence.load();
    expect(restored.extensions).toEqual([valid]);
  });
});

describe('extension security boundaries', () => {
  it('never loads extensions into in-memory or private sessions', () => {
    const id = `ext-${'d'.repeat(8)}-${'d'.repeat(4)}-${'d'.repeat(4)}-${'d'.repeat(4)}-${'d'.repeat(12)}`;
    const record: InstalledExtension = {
      id,
      name: 'Private Test',
      version: '1.0.0',
      directory: id,
      partition: 'persist:nook-default',
      spaceId: 'space-personal',
      enabled: true,
      consented: true,
      permissions: [],
      hostPermissions: [],
      installedAt: 1,
    };
    const loadExtension = vi.fn(async () => ({ id: RUNTIME_ID }));
    const manager = new ExtensionManager(tempDir('kinex-ext-private-'), {
      getExtensions: () => [record],
      commitExtensions: () => {},
      getSessionForPartition: () => ({ extensions: { getAllExtensions: () => [], loadExtension, removeExtension: vi.fn() } }) as any,
      showToast: () => {},
    });
    manager.attachSession('kinex-private-123-1', { extensions: { getAllExtensions: () => [], loadExtension } } as any);
    expect(loadExtension).not.toHaveBeenCalled();
  });

  it('does not trust extension popup senders and keeps chrome-extension out of the navigation allowlist', () => {
    const registry = new TrustedIpcRegistry();
    registry.addAllowedBaseUrl('file:///app/index.html');
    expect(registry.isTrusted(42, 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/popup.html')).toBe(false);
    expect(isSafeNavigationUrl('chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/popup.html')).toBe(false);
  });
});

describe('extension lifecycle', () => {
  it('installs disabled, requires consent, loads per partition, and uninstalls cleanly', async () => {
    const dir = tempDir('kinex-ext-life-');
    const source = path.join(dir, 'source');
    writeFixture(source);

    let extensions: InstalledExtension[] = [];
    const loadExtension = vi.fn(async () => ({ id: RUNTIME_ID }));
    const removeExtension = vi.fn();
    const getAllExtensions = vi.fn(() => []);
    const sess = { extensions: { loadExtension, removeExtension, getAllExtensions } } as any;
    const toasts: string[] = [];
    const manager = new ExtensionManager(dir, {
      getExtensions: () => extensions,
      commitExtensions: (next) => { extensions = next; },
      getSessionForPartition: () => sess,
      showToast: (message) => toasts.push(message),
    });

    const record = await manager.install(source, 'space-personal', 'persist:nook-default');
    expect(record.enabled).toBe(false);
    expect(record.consented).toBe(false);
    expect(record.actionPopup).toBe('popup.html');
    expect(manager.getViewModels()[0].loaded).toBe(false);
    expect(toasts.join()).toMatch(/Review/);

    expect(() => manager.setEnabled(record.id, true)).toThrow(/Review and accept/);
    manager.setEnabled(record.id, true, true);
    await vi.waitFor(() => expect(loadExtension).toHaveBeenCalledWith(expect.stringContaining(record.id), { allowFileAccess: false }));
    expect(extensions[0].consented).toBe(true);
    expect(extensions[0].runtimeId).toBe(RUNTIME_ID);
    expect(manager.getViewModels()[0].loaded).toBe(true);

    manager.uninstall(record.id);
    expect(removeExtension).toHaveBeenCalledWith(RUNTIME_ID);
    expect(extensions).toEqual([]);
    expect(fs.existsSync(path.join(dir, 'Extensions', record.id))).toBe(false);
  });

  it('refuses symlinks, missing declared files and manifests with escaping paths', async () => {
    const dir = tempDir('kinex-ext-invalid-');
    const symlinkSource = path.join(dir, 'symlink-source');
    writeFixture(symlinkSource);
    fs.symlinkSync('/etc/passwd', path.join(symlinkSource, 'escape.js'));

    const missingSource = path.join(dir, 'missing-source');
    fs.mkdirSync(missingSource);
    fs.writeFileSync(path.join(missingSource, 'manifest.json'), JSON.stringify(validManifest()));

    const escapeSource = path.join(dir, 'escape-source');
    writeFixture(escapeSource, validManifest({ action: { default_popup: '../escape.html' } }));

    let extensions: InstalledExtension[] = [];
    const manager = new ExtensionManager(dir, {
      getExtensions: () => extensions,
      commitExtensions: (next) => { extensions = next; },
      getSessionForPartition: () => ({ extensions: { getAllExtensions: () => [], loadExtension: vi.fn(), removeExtension: vi.fn() } }) as any,
      showToast: () => {},
    });

    await expect(manager.install(symlinkSource, 'space-personal', 'persist:nook-default')).rejects.toThrow(/symbolic link/);
    await expect(manager.install(missingSource, 'space-personal', 'persist:nook-default')).rejects.toThrow(/missing/);
    await expect(manager.install(escapeSource, 'space-personal', 'persist:nook-default')).rejects.toThrow(/Manifest V3/);
    expect(extensions).toEqual([]);
    expect(fs.readdirSync(path.join(dir, 'Extensions'))).toEqual([]);
  });
});
