/**
 * "Save Page as MHTML" policy.
 *
 * Pure URL eligibility, filename/path validation and save-dialog construction.
 * The actual `webContents.savePage` call is injected; no Electron module is
 * imported at runtime. Internal, chrome/devtools and non-web URLs can never be
 * saved as MHTML.
 */

import path from 'node:path';

export type MhtmlRejectReason = 'invalid' | 'internal' | 'non-http';
export type MhtmlEligibility =
  | { allowed: true }
  | { allowed: false; reason: MhtmlRejectReason };

export type MhtmlPathReason =
  | 'not-a-string'
  | 'empty'
  | 'too-long'
  | 'control-characters'
  | 'file-url'
  | 'not-absolute'
  | 'wrong-extension'
  | 'outside-root';

export type MhtmlPathValidation =
  | { ok: true; path: string }
  | { ok: false; reason: MhtmlPathReason };

export interface SaveDialogOptionsLike {
  title: string;
  defaultPath: string;
  filters: Array<{ name: string; extensions: string[] }>;
  properties: string[];
  buttonLabel: string;
}

export interface SaveDialogResultLike {
  canceled: boolean;
  filePath?: string;
}

const MAX_PATH_LEN = 4096;
const MAX_FILENAME_LEN = 120;
const MHTML_EXTENSIONS = new Set(['.mhtml', '.mht']);
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;
const BAD_FILENAME_CHARS_RE = /[\u0000-\u001f\u007f/\\:*?"<>|]/g;

/** Internal, privileged or non-document URLs must never be serialized. */
const INTERNAL_PROTOCOLS = new Set([
  'kinex:',
  'nook:',
  'chrome:',
  'chrome-extension:',
  'chrome-search:',
  'devtools:',
  'file:',
  'view-source:',
  'moz-extension:',
  'about:',
  'javascript:',
  'data:',
  'blob:',
  'filesystem:',
]);

/** Only real web pages are eligible for MHTML export. */
export function checkMhtmlEligibility(rawUrl: unknown): MhtmlEligibility {
  if (typeof rawUrl !== 'string') return { allowed: false, reason: 'invalid' };
  const value = rawUrl.trim();
  if (!value || value.length > 8192 || CONTROL_CHARS_RE.test(value)) {
    return { allowed: false, reason: 'invalid' };
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { allowed: false, reason: 'invalid' };
  }
  const protocol = parsed.protocol.toLowerCase();
  if (INTERNAL_PROTOCOLS.has(protocol)) return { allowed: false, reason: 'internal' };
  if (protocol !== 'http:' && protocol !== 'https:') {
    return { allowed: false, reason: 'non-http' };
  }
  if (!parsed.hostname) return { allowed: false, reason: 'invalid' };
  return { allowed: true };
}

/** Bound and sanitize a page title into a single safe filename component. */
export function sanitizeMhtmlFilename(raw: unknown, fallback = 'kinex-page'): string {
  const rawTitle = typeof raw === 'string' ? raw : '';
  const base = rawTitle
    .replace(BAD_FILENAME_CHARS_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_FILENAME_LEN);
  const safeBase = base || fallback;
  const ext = path.extname(safeBase).toLowerCase();
  if (MHTML_EXTENSIONS.has(ext)) return safeBase;
  return `${safeBase}.mhtml`;
}

/** Validate a dialog-provided path before handing it to a privileged writer. */
export function validateMhtmlPath(raw: unknown, allowedRoot?: string): MhtmlPathValidation {
  if (typeof raw !== 'string') return { ok: false, reason: 'not-a-string' };
  const value = raw.trim();
  if (!value) return { ok: false, reason: 'empty' };
  if (value.length > MAX_PATH_LEN) return { ok: false, reason: 'too-long' };
  if (CONTROL_CHARS_RE.test(value)) return { ok: false, reason: 'control-characters' };
  if (/^file:/i.test(value)) return { ok: false, reason: 'file-url' };
  if (!path.isAbsolute(value)) return { ok: false, reason: 'not-absolute' };
  if (!MHTML_EXTENSIONS.has(path.extname(value).toLowerCase())) {
    return { ok: false, reason: 'wrong-extension' };
  }
  const resolved = path.resolve(value);
  if (allowedRoot) {
    const root = path.resolve(allowedRoot);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      return { ok: false, reason: 'outside-root' };
    }
  }
  return { ok: true, path: resolved };
}

/** Build a safe, fixed-shape save dialog options object (no arbitrary fields). */
export function buildMhtmlSaveDialogOptions(input: {
  title?: unknown;
  filename?: unknown;
  directory?: unknown;
} = {}): SaveDialogOptionsLike {
  const filename = sanitizeMhtmlFilename(input.filename);
  const directory = typeof input.directory === 'string' && path.isAbsolute(input.directory)
    ? input.directory
    : undefined;
  const defaultPath = directory ? path.join(directory, filename) : filename;
  const rawTitle = typeof input.title === 'string' ? input.title.slice(0, 80) : '';
  return {
    title: rawTitle.trim() || 'Save Page as MHTML',
    defaultPath,
    filters: [{ name: 'MHTML Webpage', extensions: ['mhtml', 'mht'] }],
    properties: ['createDirectory', 'showOverwriteConfirmation'],
    buttonLabel: 'Save',
  };
}

export interface SavePageCapabilities {
  getPageUrl(): unknown;
  getPageTitle(): unknown;
  showSaveDialog(options: SaveDialogOptionsLike): Promise<SaveDialogResultLike>;
  saveMhtml(filePath: string): Promise<void>;
  getDownloadsDir?(): string | undefined;
}

export interface SavePageOutcome {
  ok: boolean;
  reason?: MhtmlRejectReason | MhtmlPathReason | 'canceled' | 'save-failed';
  filePath?: string;
}

export class SavePageController {
  constructor(private readonly caps: SavePageCapabilities) {}

  async saveAsMhtml(): Promise<SavePageOutcome> {
    const eligibility = checkMhtmlEligibility(this.caps.getPageUrl());
    if (!eligibility.allowed) return { ok: false, reason: eligibility.reason };

    const options = buildMhtmlSaveDialogOptions({
      title: this.caps.getPageTitle(),
      filename: this.caps.getPageTitle(),
      directory: this.caps.getDownloadsDir?.(),
    });
    const result = await this.caps.showSaveDialog(options);
    if (result.canceled || !result.filePath) return { ok: false, reason: 'canceled' };
    const validated = validateMhtmlPath(result.filePath);
    if (!validated.ok) return { ok: false, reason: validated.reason };
    try {
      await this.caps.saveMhtml(validated.path);
    } catch {
      return { ok: false, reason: 'save-failed' };
    }
    return { ok: true, filePath: validated.path };
  }
}
