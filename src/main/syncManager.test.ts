import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BACKUP_FILE_SUFFIX,
  buildSyncSnapshot,
  createBackup,
  decryptSnapshot,
  encryptSnapshot,
  exportSyncFile,
  importSyncFile,
  planBackupRotation,
  SyncError,
  SYNC_EXPORT_ALLOWLIST,
  type SyncSnapshot,
} from './syncManager';

const PASSPHRASE = 'correct horse battery staple';

const tempDirs: string[] = [];
function temp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kinex-sync-test-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length > 0) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function sampleState(): Record<string, unknown> {
  return {
    activeSpaceId: 'space-personal',
    spaces: [
      { id: 'space-personal', name: 'Personal', icon: 'star', theme: {}, profilePartition: 'persist:main' },
      { id: 'space-private', name: 'Private', icon: 'eye', theme: {}, profilePartition: 'persist:private' },
    ],
    profiles: [
      { id: 'p-main', name: 'Main', partition: 'persist:main' },
      { id: 'p-private', name: 'Private', partition: 'persist:private' },
    ],
    tabs: [
      { id: 'tab-1', spaceId: 'space-personal', url: 'https://example.org', title: 'Example' },
      { id: 'tab-secret', spaceId: 'space-private', url: 'https://secret.example', title: 'Secret' },
    ],
    history: [{ url: 'https://example.org', visitedAt: 1, password: 'must-be-dropped' }],
    // Sensitive top-level fields (not in the allowlist).
    windows: [{ id: 'win-private', isPrivate: true, spaceId: 'space-private' }],
    privateWindows: [{ id: 'incognito-1' }],
    cookies: [{ name: 'session', value: 'abc123' }],
    passwords: [{ origin: 'https://mail.example', password: 'hunter2' }],
    credentials: [{ token: 'bearer-xyz' }],
    sitePermissions: [{ origin: 'https://example.org', permission: 'camera', decision: 'allow' }],
    updateFeedUrl: 'https://attacker.example/feed',
    sidebarOpen: true,
    searchEngine: 'duckduckgo',
    shields: { globalMode: 'standard', customCosmeticRules: { 'example.org': ['#ad'] } },
  };
}

describe('syncManager — snapshot sanitization', () => {
  it('exports only allowlisted fields and drops private/cookie/password data', () => {
    const snapshot = buildSyncSnapshot(sampleState(), 1_700_000_000_000);
    expect(snapshot.format).toBe('kinex-sync');
    expect(snapshot.version).toBe(1);
    expect(snapshot.exportedAt).toBe(1_700_000_000_000);

    for (const key of Object.keys(snapshot.data)) {
      expect(SYNC_EXPORT_ALLOWLIST as readonly string[]).toContain(key);
    }
    const forbidden = [
      'windows', 'privateWindows', 'cookies', 'passwords', 'credentials',
      'sitePermissions', 'updateFeedUrl', 'downloads', 'extensions', 'overlay',
    ];
    for (const key of forbidden) expect(snapshot.data).not.toHaveProperty(key);

    expect(snapshot.data.tabs).toHaveLength(1);
    expect(JSON.stringify(snapshot.data)).not.toContain('must-be-dropped');
    expect(JSON.stringify(snapshot.data)).not.toContain('hunter2');
    expect(JSON.stringify(snapshot.data)).not.toContain('abc123');
    expect(JSON.stringify(snapshot.data)).not.toContain('persist:private');
    expect(snapshot.data.history).toEqual([{ url: 'https://example.org', visitedAt: 1 }]);
  });

  it('rejects non-object input', () => {
    expect(() => buildSyncSnapshot(null)).toThrow(SyncError);
    expect(() => buildSyncSnapshot('nope')).toThrow(/plain object/);
  });
});

describe('syncManager — encryption', () => {
  it('round-trips a snapshot with AES-256-GCM', () => {
    const snapshot = buildSyncSnapshot(sampleState(), 42);
    const envelope = encryptSnapshot(snapshot, PASSPHRASE);
    expect(Buffer.isBuffer(envelope)).toBe(true);
    expect(envelope.subarray(0, 9).toString('ascii')).toBe('KINEXSYNC');
    // Header (9 + 1) + salt (16) + iv (12) + tag (16) = 54 bytes overhead.
    expect(envelope.length).toBeGreaterThan(54);
    expect(decryptSnapshot(envelope, PASSPHRASE)).toEqual(snapshot);
  });

  it('uses fresh salt/IV so identical snapshots produce different envelopes', () => {
    const snapshot = buildSyncSnapshot(sampleState(), 42);
    const a = encryptSnapshot(snapshot, PASSPHRASE);
    const b = encryptSnapshot(snapshot, PASSPHRASE);
    expect(a.equals(b)).toBe(false);
    expect(decryptSnapshot(a, PASSPHRASE)).toEqual(decryptSnapshot(b, PASSPHRASE));
  });

  it('fails with a clear error on the wrong passphrase', () => {
    const envelope = encryptSnapshot(buildSyncSnapshot(sampleState()), PASSPHRASE);
    expect(() => decryptSnapshot(envelope, 'wrong passphrase')).toThrow(
      /wrong passphrase or tampered\/corrupt data/
    );
  });

  it('rejects an empty passphrase', () => {
    expect(() => encryptSnapshot(buildSyncSnapshot(sampleState()), '')).toThrow(/non-empty passphrase/);
  });

  it('fails on tampered ciphertext and tampered auth tag', () => {
    const envelope = encryptSnapshot(buildSyncSnapshot(sampleState()), PASSPHRASE);
    const ciphertextOffset = 9 + 1 + 16 + 12 + 16; // 54

    const tamperedCiphertext = Buffer.from(envelope);
    tamperedCiphertext[ciphertextOffset] ^= 0x01;
    expect(() => decryptSnapshot(tamperedCiphertext, PASSPHRASE)).toThrow(/tampered\/corrupt data/);

    const tamperedTag = Buffer.from(envelope);
    tamperedTag[9 + 1 + 16 + 12] ^= 0x01;
    expect(() => decryptSnapshot(tamperedTag, PASSPHRASE)).toThrow(/tampered\/corrupt data/);
  });

  it('rejects a bad magic header and a truncated envelope', () => {
    const envelope = encryptSnapshot(buildSyncSnapshot(sampleState()), PASSPHRASE);
    const badMagic = Buffer.from(envelope);
    badMagic[0] = 0x58;
    expect(() => decryptSnapshot(badMagic, PASSPHRASE)).toThrow(/bad magic header/);
    expect(() => decryptSnapshot(envelope.subarray(0, 20), PASSPHRASE)).toThrow(/truncated envelope/);
  });

  it('rejects an unsupported version byte', () => {
    const envelope = encryptSnapshot(buildSyncSnapshot(sampleState()), PASSPHRASE);
    const badVersion = Buffer.from(envelope);
    badVersion[9] = 99;
    expect(() => decryptSnapshot(badVersion, PASSPHRASE)).toThrow(/Unsupported sync file version/);
  });
});

describe('syncManager — file IO', () => {
  it('exports and imports an encrypted file', async () => {
    const dir = temp();
    const filePath = path.join(dir, 'nested', 'snapshot.kinex-sync');
    const expected = buildSyncSnapshot(sampleState(), 7);
    const snapshot = await exportSyncFile(filePath, sampleState(), PASSPHRASE, 7);
    expect(snapshot).toEqual(expected);
    expect(await importSyncFile(filePath, PASSPHRASE)).toEqual(expected);

    const fromDisk = fs.readFileSync(filePath);
    expect(fromDisk.subarray(0, 9).toString('ascii')).toBe('KINEXSYNC');
    expect(fromDisk.toString('utf8')).not.toContain('example.org');
  });
});

describe('syncManager — backup rotation', () => {
  it('plans rotation deterministically (pure helper)', () => {
    const plan = planBackupRotation(
      [
        { name: 'old', mtimeMs: 1 },
        { name: 'mid', mtimeMs: 2 },
        { name: 'new', mtimeMs: 3 },
      ],
      2
    );
    expect(plan.keep).toEqual(['new', 'mid']);
    expect(plan.remove).toEqual(['old']);
    expect(planBackupRotation([{ name: 'only', mtimeMs: 1 }], 0).keep).toEqual(['only']);
  });

  it('keeps only the last N backups and mirrors to an iCloud-style folder', async () => {
    const dir = temp();
    const icloud = temp();
    const times = [1_000, 2_000, 3_000].map((ms) => new Date(ms));
    for (const date of times) {
      await createBackup(sampleState(), PASSPHRASE, {
        directory: dir,
        icloudDirectory: icloud,
        keepLast: 2,
        now: () => date,
      });
    }

    const list = (folder: string) =>
      fs.readdirSync(folder).filter((name) => name.endsWith(BACKUP_FILE_SUFFIX)).sort();
    expect(list(dir)).toHaveLength(2);
    expect(list(icloud)).toHaveLength(2);
    expect(list(dir)).toEqual(list(icloud));

    const imported = await importSyncFile(path.join(dir, list(dir)[1]), PASSPHRASE);
    expect(imported.format).toBe('kinex-sync');
    expect(imported.data).not.toHaveProperty('cookies');
  });
});
