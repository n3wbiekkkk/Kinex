import path from 'node:path';

export const EXTENSION_ID_RE = /^ext-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const RUNTIME_ID_RE = /^[a-p]{32}$/;
export const MAX_INSTALLED_EXTENSIONS = 32;
export const MAX_EXTENSION_FILES = 500;
export const MAX_EXTENSION_BYTES = 25 * 1024 * 1024;
export const MAX_MANIFEST_BYTES = 512 * 1024;

export interface ExtensionManifestSummary {
  name: string;
  version: string;
  description?: string;
  permissions: string[];
  hostPermissions: string[];
  contentScriptFiles: string[];
  backgroundServiceWorker?: string;
  actionPopup?: string;
  actionIcon?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Reject absolute paths, drives, URLs, backslashes, empty segments and traversal. */
export function isSafeRelativePath(value: unknown, maxLen = 512): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLen) return false;
  if (value.includes('\0') || value.includes('\\') || value.startsWith('/')) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return false;
  const segments = value.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return false;
  return true;
}

export function resolveInsideRoot(root: string, relative: string): string | null {
  if (!isSafeRelativePath(relative)) return null;
  const resolved = path.resolve(root, relative);
  const base = path.resolve(root);
  if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`)) return null;
  return resolved;
}

export function isInsideRoot(root: string, candidate: string): boolean {
  const base = path.resolve(root);
  const resolved = path.resolve(candidate);
  return resolved !== base && resolved.startsWith(`${base}${path.sep}`);
}

export function sanitizeBoundedStringArray(value: unknown, maxItems: number, maxLen: number): string[] | null {
  return safeStringArray(value, maxItems, maxLen);
}

function safeStringArray(value: unknown, maxItems: number, maxLen: number): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maxItems) return null;
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || item.length === 0 || item.length > maxLen || item.includes('\0')) return null;
    result.push(item);
  }
  return result;
}

function safePathArray(value: unknown, maxItems: number): string[] | null {
  const strings = safeStringArray(value, maxItems, 512);
  if (!strings) return null;
  return strings.every((item) => isSafeRelativePath(item)) ? strings : null;
}

/** Validate an untrusted manifest before any file is read or handed to Electron. */
export function parseExtensionManifest(raw: unknown): ExtensionManifestSummary | null {
  if (!isRecord(raw) || raw.manifest_version !== 3) return null;
  if (typeof raw.name !== 'string' || raw.name.trim().length === 0 || raw.name.length > 128) return null;
  if (typeof raw.version !== 'string' || raw.version.length === 0 || raw.version.length > 32) return null;
  if (raw.description !== undefined && (typeof raw.description !== 'string' || raw.description.length > 512)) return null;

  const permissions = safeStringArray(raw.permissions, 64, 128);
  const hostPermissions = safeStringArray(raw.host_permissions, 64, 256);
  if (!permissions || !hostPermissions) return null;

  const contentScriptFiles: string[] = [];
  if (raw.content_scripts !== undefined) {
    if (!Array.isArray(raw.content_scripts) || raw.content_scripts.length > 16) return null;
    for (const script of raw.content_scripts) {
      if (!isRecord(script)) return null;
      const matches = safeStringArray(script.matches, 64, 256);
      const js = safePathArray(script.js, 32);
      const css = safePathArray(script.css, 32);
      if (!matches || matches.length === 0 || !js || !css) return null;
      contentScriptFiles.push(...js, ...css);
    }
  }

  let backgroundServiceWorker: string | undefined;
  if (raw.background !== undefined) {
    if (!isRecord(raw.background) || !isSafeRelativePath(raw.background.service_worker) || raw.background.scripts !== undefined) {
      return null;
    }
    backgroundServiceWorker = raw.background.service_worker;
  }

  let actionPopup: string | undefined;
  let actionIcon: string | undefined;
  if (raw.action !== undefined) {
    if (!isRecord(raw.action)) return null;
    if (raw.action.default_popup !== undefined) {
      if (!isSafeRelativePath(raw.action.default_popup)) return null;
      actionPopup = raw.action.default_popup;
    }
    if (raw.action.default_icon !== undefined) {
      const icon = raw.action.default_icon;
      if (isSafeRelativePath(icon)) {
        actionIcon = icon;
      } else if (isRecord(icon)) {
        for (const value of Object.values(icon)) {
          if (isSafeRelativePath(value)) {
            actionIcon = value;
            break;
          }
        }
        if (!actionIcon) return null;
      } else {
        return null;
      }
    }
  }

  return {
    name: raw.name.trim(),
    version: raw.version.trim(),
    ...(typeof raw.description === 'string' ? { description: raw.description.trim() } : {}),
    permissions,
    hostPermissions,
    contentScriptFiles: [...new Set(contentScriptFiles)].slice(0, 256),
    ...(backgroundServiceWorker ? { backgroundServiceWorker } : {}),
    ...(actionPopup ? { actionPopup } : {}),
    ...(actionIcon ? { actionIcon } : {}),
  };
}

export function allDeclaredExtensionFiles(manifest: ExtensionManifestSummary): string[] {
  return [
    'manifest.json',
    ...manifest.contentScriptFiles,
    ...(manifest.backgroundServiceWorker ? [manifest.backgroundServiceWorker] : []),
    ...(manifest.actionPopup ? [manifest.actionPopup] : []),
    ...(manifest.actionIcon ? [manifest.actionIcon] : []),
  ];
}
