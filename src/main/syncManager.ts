/**
 * Passphrase-encrypted Kinex sync snapshots (`.kinex-sync` files).
 *
 * Design goals:
 *  - Deny by default: only an explicit allowlist of snapshot fields is exported.
 *  - Private windows, cookies, passwords, credentials and other sensitive
 *    fields are never serialized (nested keys matching a sensitive pattern are
 *    dropped at any depth).
 *  - Pure transforms (snapshot building, encryption/decryption, rotation
 *    planning) are separated from the async file IO so they can be unit tested
 *    without touching disk or Electron.
 *
 * Envelope layout (binary, big-endian agnostic):
 *   [magic: 9 bytes][version: 1 byte][salt: 16 bytes][iv: 12 bytes]
 *   [authTag: 16 bytes][ciphertext: N bytes]
 * The magic + version bytes are also used as GCM AAD, so tampering with the
 * header fails authentication as well as the explicit header checks.
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { BackupResult, SyncSnapshot } from '../shared/types';

export type { BackupResult, SyncSnapshot } from '../shared/types';

// ---------------------------------------------------------------------------
// Constants and errors
// ---------------------------------------------------------------------------

export const SYNC_MAGIC = Buffer.from('KINEXSYNC', 'ascii');
export const SYNC_VERSION = 1;

const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = SYNC_MAGIC.length + 1;
const MIN_ENVELOPE_BYTES = HEADER_BYTES + SALT_BYTES + IV_BYTES + TAG_BYTES;
const KEY_BYTES = 32; // AES-256

export const BACKUP_FILE_SUFFIX = '.kinex-sync';
export const BACKUP_FILE_PREFIX = 'kinex-sync-';
const BACKUP_NAME_RE = /^kinex-sync-\d{8}-\d{6}-\d{3}\.kinex-sync$/;

export type SyncErrorCode =
  | 'invalid-passphrase'
  | 'invalid-input'
  | 'invalid-envelope'
  | 'unsupported-version'
  | 'decryption-failed'
  | 'invalid-snapshot';

export class SyncError extends Error {
  readonly code: SyncErrorCode;

  constructor(code: SyncErrorCode, message: string) {
    super(message);
    this.name = 'SyncError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Allowlist / sanitization (pure)
// ---------------------------------------------------------------------------

/** Fields that are safe and useful to move between Kinex profiles. */
export const SYNC_EXPORT_ALLOWLIST = [
  'spaces',
  'profiles',
  'folders',
  'activeSpaceId',
  'tabs',
  'splitsBySpace',
  'boosts',
  'history',
  'archivedTabs',
  'closedTabs',
  'zoomByHost',
  'readerOptions',
  'sidebarOpen',
  'sidebarWidth',
  'adBlockEnabled',
  'shields',
  'httpsOnly',
  'cleanCopyUrl',
  'airTrafficRules',
  'searchEngine',
  'autoPictureInPicture',
  'memorySaverTimeout',
  'memorySaverExemptPinned',
  'newTabConfig',
] as const;

/**
 * Explicitly denied at the top level. Everything not in the allowlist is
 * already dropped; this list exists to document the sensitive boundaries and
 * to guard against an allowlist accidentally being widened in the future.
 */
export const SYNC_EXPORT_DENYLIST = [
  'windows', // includes Private windows and their per-window state
  'privateWindows',
  'sitePermissions', // camera/microphone/location grants
  'extensions',
  'cookies',
  'passwords',
  'credentials',
  'sessions',
  'downloads',
  'updateFeedUrl',
  'overlay',
  'toastMessage',
] as const;

const SENSITIVE_KEY_RE =
  /(password|passphrase|cookie|credential|secret|token|private|incognito|session|authorization|authheader)/i;
const PRIVATE_PARTITION_RE = /(^|:)private$/i;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPrivateRecord(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  if (value.isPrivate === true || value.private === true || value.incognito === true) {
    return true;
  }
  for (const key of ['partition', 'profilePartition'] as const) {
    const candidate = value[key];
    if (typeof candidate === 'string' && PRIVATE_PARTITION_RE.test(candidate)) {
      return true;
    }
  }
  return false;
}

/** Recursively copies a value, dropping sensitive keys and private records. */
function sanitizeValue(value: unknown, key?: string): unknown {
  if (key !== undefined && SENSITIVE_KEY_RE.test(key)) return undefined;
  if (isPrivateRecord(value)) return undefined;
  if (Array.isArray(value)) {
    return value
      .map((item) => sanitizeValue(item))
      .filter((item) => item !== undefined);
  }
  if (isPlainObject(value)) {
    const result: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      const sanitized = sanitizeValue(childValue, childKey);
      if (sanitized !== undefined) result[childKey] = sanitized;
    }
    return result;
  }
  return value;
}

function filterPrivateReferences(
  data: Record<string, unknown>,
  rawInput: Record<string, unknown>
): void {
  // Derive private identifiers from the RAW input: the sanitizer has already
  // removed private records from `data`, so they cannot be detected there.
  const profiles = Array.isArray(rawInput.profiles) ? rawInput.profiles : [];
  const spaces = Array.isArray(rawInput.spaces) ? rawInput.spaces : [];

  const privatePartitions = new Set(
    profiles
      .filter((p) => isPlainObject(p) && typeof p.partition === 'string' && PRIVATE_PARTITION_RE.test(p.partition))
      .map((p) => (p as Record<string, unknown>).partition as string)
  );
  const privateSpaceIds = new Set(
    spaces
      .filter((s) => {
        if (!isPlainObject(s)) return false;
        const partition = s.profilePartition;
        return typeof partition === 'string' && privatePartitions.has(partition);
      })
      .map((s) => (s as Record<string, unknown>).id)
  );

  if (privatePartitions.size === 0 && privateSpaceIds.size === 0) return;

  for (const key of ['tabs', 'closedTabs', 'archivedTabs', 'folders'] as const) {
    const list = data[key];
    if (!Array.isArray(list)) continue;
    data[key] = list.filter((item) => {
      if (!isPlainObject(item)) return true;
      const spaceId = item.spaceId;
      const partition = item.profilePartition ?? item.partition;
      if (typeof spaceId === 'string' && privateSpaceIds.has(spaceId)) return false;
      if (typeof partition === 'string' && privatePartitions.has(partition)) return false;
      return true;
    });
  }

  const splits = data.splitsBySpace;
  if (isPlainObject(splits)) {
    const result: Record<string, unknown> = {};
    for (const [spaceId, layout] of Object.entries(splits)) {
      if (!privateSpaceIds.has(spaceId)) result[spaceId] = layout;
    }
    data.splitsBySpace = result;
  }
}

/**
 * Builds a validated, sanitized snapshot from an arbitrary plain object.
 * Only allowlisted fields survive; sensitive and private data is dropped.
 */
export function buildSyncSnapshot(input: unknown, now: number = Date.now()): SyncSnapshot {
  if (!isPlainObject(input)) {
    throw new SyncError('invalid-input', 'Sync snapshot input must be a plain object.');
  }

  const data: Record<string, unknown> = {};
  for (const field of SYNC_EXPORT_ALLOWLIST) {
    if (!Object.prototype.hasOwnProperty.call(input, field)) continue;
    const sanitized = sanitizeValue(input[field], field);
    if (sanitized !== undefined) data[field] = sanitized;
  }
  filterPrivateReferences(data, input);

  return {
    format: 'kinex-sync',
    version: SYNC_VERSION,
    exportedAt: Number.isFinite(now) && now >= 0 ? Math.floor(now) : Date.now(),
    data,
  };
}

function assertValidSnapshot(value: unknown): asserts value is SyncSnapshot {
  if (!isPlainObject(value)) {
    throw new SyncError('invalid-snapshot', 'Decrypted sync payload is not an object.');
  }
  if (value.format !== 'kinex-sync') {
    throw new SyncError('invalid-snapshot', 'Decrypted sync payload has an unknown format.');
  }
  if (value.version !== SYNC_VERSION) {
    throw new SyncError('unsupported-version', `Unsupported sync payload version: ${String(value.version)}.`);
  }
  if (!Number.isFinite(value.exportedAt) || !isPlainObject(value.data)) {
    throw new SyncError('invalid-snapshot', 'Decrypted sync payload is missing required fields.');
  }
}

// ---------------------------------------------------------------------------
// Encryption / decryption (pure)
// ---------------------------------------------------------------------------

function assertPassphrase(passphrase: string): void {
  if (typeof passphrase !== 'string' || passphrase.length === 0) {
    throw new SyncError('invalid-passphrase', 'A non-empty passphrase is required.');
  }
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, KEY_BYTES, {
    N: 16_384,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
}

function makeHeader(): Buffer {
  const header = Buffer.alloc(HEADER_BYTES);
  SYNC_MAGIC.copy(header, 0);
  header.writeUInt8(SYNC_VERSION, SYNC_MAGIC.length);
  return header;
}

/** Serializes and encrypts a snapshot into a binary `.kinex-sync` envelope. */
export function encryptSnapshot(snapshot: SyncSnapshot, passphrase: string): Buffer {
  assertPassphrase(passphrase);
  assertValidSnapshot(snapshot);

  const header = makeHeader();
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const key = deriveKey(passphrase, salt);

  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(header);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(snapshot), 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return Buffer.concat([header, salt, iv, authTag, ciphertext]);
}

/** Validates, decrypts and authenticates a binary sync envelope. */
export function decryptSnapshot(envelope: Buffer, passphrase: string): SyncSnapshot {
  assertPassphrase(passphrase);
  if (!Buffer.isBuffer(envelope) || envelope.length < MIN_ENVELOPE_BYTES) {
    throw new SyncError('invalid-envelope', 'Not a valid Kinex sync file (truncated envelope).');
  }

  const magic = envelope.subarray(0, SYNC_MAGIC.length);
  if (!magic.equals(SYNC_MAGIC)) {
    throw new SyncError('invalid-envelope', 'Not a Kinex sync file (bad magic header).');
  }

  const version = envelope.readUInt8(SYNC_MAGIC.length);
  if (version !== SYNC_VERSION) {
    throw new SyncError('unsupported-version', `Unsupported sync file version: ${version}.`);
  }

  let offset = HEADER_BYTES;
  const salt = envelope.subarray(offset, offset + SALT_BYTES);
  offset += SALT_BYTES;
  const iv = envelope.subarray(offset, offset + IV_BYTES);
  offset += IV_BYTES;
  const authTag = envelope.subarray(offset, offset + TAG_BYTES);
  offset += TAG_BYTES;
  const ciphertext = envelope.subarray(offset);
  const header = envelope.subarray(0, HEADER_BYTES);

  const key = deriveKey(passphrase, salt);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(header);
  decipher.setAuthTag(authTag);

  let plaintext: Buffer;
  try {
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new SyncError(
      'decryption-failed',
      'Unable to decrypt sync file: wrong passphrase or tampered/corrupt data.'
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext.toString('utf8'));
  } catch {
    throw new SyncError('invalid-snapshot', 'Sync file contains invalid JSON payload.');
  }
  assertValidSnapshot(parsed);
  return parsed;
}

// ---------------------------------------------------------------------------
// Backup rotation (pure planning) and async IO
// ---------------------------------------------------------------------------

export interface BackupEntry {
  name: string;
  mtimeMs: number;
}

export interface RotationPlan {
  keep: string[];
  remove: string[];
}

/** Pure rotation planner: newest first by mtime (name as tiebreaker). */
export function planBackupRotation(entries: BackupEntry[], keepLast = 5): RotationPlan {
  const limit = Number.isFinite(keepLast) && keepLast > 0 ? Math.floor(keepLast) : 5;
  const sorted = [...entries].sort(
    (a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name)
  );
  return {
    keep: sorted.slice(0, limit).map((entry) => entry.name),
    remove: sorted.slice(limit).map((entry) => entry.name),
  };
}

export function formatBackupFilename(date: Date): string {
  const iso = Number.isFinite(date.getTime()) ? date : new Date();
  const pad = (value: number, width = 2) => String(value).padStart(width, '0');
  const stamp =
    `${iso.getUTCFullYear()}${pad(iso.getUTCMonth() + 1)}${pad(iso.getUTCDate())}` +
    `-${pad(iso.getUTCHours())}${pad(iso.getUTCMinutes())}${pad(iso.getUTCSeconds())}` +
    `-${pad(iso.getUTCMilliseconds(), 3)}`;
  return `${BACKUP_FILE_PREFIX}${stamp}${BACKUP_FILE_SUFFIX}`;
}

export interface BackupOptions {
  /** Primary backup folder. */
  directory: string;
  /** Optional iCloud-style folder that mirrors each backup. */
  icloudDirectory?: string;
  /** Number of backups to retain in each folder (default 5). */
  keepLast?: number;
  /** Injectable clock for deterministic filenames in tests. */
  now?: () => Date;
}

async function listBackupEntries(directory: string): Promise<BackupEntry[]> {
  let names: string[];
  try {
    names = await fs.promises.readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const entries: BackupEntry[] = [];
  for (const name of names) {
    if (!BACKUP_NAME_RE.test(name)) continue;
    try {
      const stat = await fs.promises.stat(path.join(directory, name));
      if (stat.isFile()) entries.push({ name, mtimeMs: stat.mtimeMs });
    } catch {
      // A file may disappear mid-rotation; ignore it.
    }
  }
  return entries;
}

async function writeAndRotate(
  directory: string,
  filename: string,
  contents: Buffer,
  keepLast: number
): Promise<string[]> {
  await fs.promises.mkdir(directory, { recursive: true });
  await fs.promises.writeFile(path.join(directory, filename), contents, { mode: 0o600 });
  const plan = planBackupRotation(await listBackupEntries(directory), keepLast);
  for (const name of plan.remove) {
    await fs.promises.unlink(path.join(directory, name)).catch(() => undefined);
  }
  return plan.remove;
}

/** Exports a plain object to an encrypted `.kinex-sync` file. */
export async function exportSyncFile(
  filePath: string,
  input: unknown,
  passphrase: string,
  now: number = Date.now()
): Promise<SyncSnapshot> {
  const snapshot = buildSyncSnapshot(input, now);
  const envelope = encryptSnapshot(snapshot, passphrase);
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, envelope, { mode: 0o600 });
  return snapshot;
}

/** Imports and validates an encrypted `.kinex-sync` file. */
export async function importSyncFile(filePath: string, passphrase: string): Promise<SyncSnapshot> {
  const envelope = await fs.promises.readFile(filePath);
  return decryptSnapshot(envelope, passphrase);
}

/** Writes a rotated auto-backup to the primary folder and optional iCloud folder. */
export async function createBackup(
  input: unknown,
  passphrase: string,
  options: BackupOptions
): Promise<BackupResult> {
  if (!options || typeof options.directory !== 'string' || options.directory.length === 0) {
    throw new SyncError('invalid-input', 'A backup directory is required.');
  }
  const snapshot = buildSyncSnapshot(input, (options.now ?? (() => new Date()))().getTime());
  const envelope = encryptSnapshot(snapshot, passphrase);
  const filename = formatBackupFilename((options.now ?? (() => new Date()))());
  const keepLast = options.keepLast ?? 5;

  const removed = await writeAndRotate(options.directory, filename, envelope, keepLast);
  let icloudPath: string | undefined;
  let icloudRemoved: string[] = [];
  if (options.icloudDirectory) {
    icloudPath = path.join(options.icloudDirectory, filename);
    icloudRemoved = await writeAndRotate(options.icloudDirectory, filename, envelope, keepLast);
  }

  return {
    filename,
    primaryPath: path.join(options.directory, filename),
    icloudPath,
    removed,
    icloudRemoved,
  };
}

/** Convenience object that carries backup configuration for IPC wiring. */
export class SyncManager {
  private readonly options: BackupOptions;

  constructor(options: BackupOptions) {
    this.options = options;
  }

  exportToFile(filePath: string, input: unknown, passphrase: string): Promise<SyncSnapshot> {
    return exportSyncFile(filePath, input, passphrase);
  }

  importFromFile(filePath: string, passphrase: string): Promise<SyncSnapshot> {
    return importSyncFile(filePath, passphrase);
  }

  backup(input: unknown, passphrase: string): Promise<BackupResult> {
    return createBackup(input, passphrase, this.options);
  }
}
