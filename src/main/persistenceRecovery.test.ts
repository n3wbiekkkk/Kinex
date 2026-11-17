import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultPersistedData, getActiveSplit } from '../shared/domain';
import { KinexPersistence } from './persistence';

const temporaryDirs: string[] = [];

function setup(raw?: unknown) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kinex-recovery-'));
  temporaryDirs.push(directory);
  const persistence = new KinexPersistence(directory);
  if (raw !== undefined) fs.writeFileSync(persistence.getStateFilePath(), JSON.stringify(raw));
  return { directory, persistence };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('persistent state recovery and write ordering', () => {
  it('keeps the final flush when an older asynchronous write completes afterward', async () => {
    const { directory, persistence } = setup();
    const old = createDefaultPersistedData();
    const newest = { ...old, sidebarWidth: 377 };
    let started!: () => void;
    const writeStarted = new Promise<void>((resolve) => { started = resolve; });
    let release!: () => void;
    const writeReleased = new Promise<void>((resolve) => { release = resolve; });
    let finished!: () => void;
    const writeFinished = new Promise<void>((resolve) => { finished = resolve; });
    const writeFile = fs.promises.writeFile.bind(fs.promises);
    vi.spyOn(fs.promises, 'writeFile').mockImplementationOnce(async (...args) => {
      started();
      await writeReleased;
      await writeFile(...args);
      finished();
    });
    persistence.scheduleSave(old, 0);
    await writeStarted;
    persistence.flushPendingSave(newest);
    release();
    await writeFinished;
    await vi.waitFor(() => expect(fs.readdirSync(directory).some((name) => name.endsWith('.tmp'))).toBe(false));
    expect(JSON.parse(fs.readFileSync(persistence.getStateFilePath(), 'utf8')).sidebarWidth).toBe(377);
  });

  it('recovers malformed split data while preserving valid tabs and profiles', () => {
    const data = createDefaultPersistedData();
    const { persistence } = setup({
      ...data,
      splitsBySpace: {
        [data.activeSpaceId]: { tabIds: 'invalid', focusedIndex: -4, splitRatio: 'invalid' },
      },
    });
    const restored = persistence.load();
    expect(() => getActiveSplit(restored)).not.toThrow();
    expect(restored.tabs.map((tab) => tab.id)).toEqual(data.tabs.map((tab) => tab.id));
    expect(restored.profiles).toEqual(data.profiles);
    expect(getActiveSplit(restored).focusedIndex).toBe(0);
    expect(getActiveSplit(restored).splitRatio).toBe(0.5);
  });

  it('preserves the damaged JSON before writing recovered defaults', () => {
    const { directory, persistence } = setup();
    const damaged = '{interrupted-json';
    fs.writeFileSync(persistence.getStateFilePath(), damaged);
    const recovered = persistence.load();
    persistence.save(recovered);
    const backups = fs.readdirSync(directory).filter((name) => name.includes('.corrupt-'));
    expect(backups).toHaveLength(1);
    expect(fs.readFileSync(path.join(directory, backups[0]), 'utf8')).toBe(damaged);
    expect(JSON.parse(fs.readFileSync(persistence.getStateFilePath(), 'utf8')).spaces.length).toBeGreaterThan(0);
    expect(fs.statSync(persistence.getStateFilePath()).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(directory, backups[0])).mode & 0o777).toBe(0o600);
  });

  it('rejects invalid records and unscoped permissions without losing unrelated state', () => {
    const data = createDefaultPersistedData();
    const profile = data.profiles[0];
    const { persistence } = setup({
      ...data,
      profiles: [null, ...data.profiles, { id: 'bad', name: 'Bad', partition: '../private' }],
      tabs: [null, ...data.tabs, data.tabs[0]],
      boosts: [null, { id: 'bad', css: 7 }],
      folders: [null],
      sitePermissions: [
        null,
        { origin: 'https://example.org', permission: 'notifications', decision: 'allow', updatedAt: 1 },
        { partition: profile.partition, origin: 'https://example.org', permission: 'notifications', decision: 'allow', updatedAt: 2 },
        { partition: 'persist:unknown', origin: 'https://example.org', permission: 'notifications', decision: 'allow', updatedAt: 3 },
      ],
      httpsOnly: 'false',
      cleanCopyUrl: 0,
      sidebarOpen: null,
      searchEngine: '__proto__',
      airTrafficRules: [null, { id: 'bad', pattern: 'example.org', spaceId: 'missing', enabled: true }],
    });
    const restored = persistence.load();
    expect(restored.profiles).toEqual(data.profiles);
    expect(restored.tabs.map((tab) => tab.id)).toEqual(data.tabs.map((tab) => tab.id));
    expect(restored.boosts).toEqual([]);
    expect(restored.folders).toEqual([]);
    expect(restored.airTrafficRules).toEqual([]);
    expect(restored.sitePermissions).toEqual([
      { partition: profile.partition, origin: 'https://example.org', permission: 'notifications', decision: 'allow', updatedAt: 2 },
    ]);
    expect(restored.httpsOnly).toBe(true);
    expect(restored.cleanCopyUrl).toBe(true);
    expect(restored.sidebarOpen).toBe(true);
    expect(restored.searchEngine).toBe('google');
  });

  it('preserves split order, pinning, focus and intentionally empty tab collections', () => {
    const data = createDefaultPersistedData();
    const tabIds = data.tabs.filter((tab) => tab.spaceId === data.activeSpaceId).slice(0, 2).map((tab) => tab.id);
    const { persistence } = setup({
      ...data,
      splitsBySpace: { [data.activeSpaceId]: { tabIds, focusedIndex: 1, splitRatio: 0.63 } },
    });
    const restored = persistence.load();
    expect(getActiveSplit(restored)).toEqual({ tabIds, focusedIndex: 1, splitRatio: 0.63 });
    expect(restored.tabs.map((tab) => [tab.id, tab.location, tab.pinnedUrl])).toEqual(
      data.tabs.map((tab) => [tab.id, tab.location, tab.pinnedUrl])
    );
    fs.writeFileSync(persistence.getStateFilePath(), JSON.stringify({ ...data, tabs: [] }));
    expect(persistence.load().tabs).toEqual([]);
  });

  it('contains invalid field objects to their records and gives invalid partitions isolated recovery sessions', () => {
    const data = createDefaultPersistedData();
    const { persistence } = setup({
      ...data,
      spaces: data.spaces.map((space, index) => index === 1 ? { ...space, profilePartition: { toString: 1 } } : space),
      tabs: data.tabs.map((tab, index) => index === 0 ? { ...tab, title: { toString: 1 } } : tab),
      history: [{ url: { toString: 1 }, title: 'damaged' }, { url: 'https://example.org', title: 'Valid', visitedAt: 1, visitCount: 2 }],
    });
    const restored = persistence.load();
    expect(restored.tabs.map((tab) => tab.id)).toEqual(data.tabs.map((tab) => tab.id));
    expect(restored.tabs[0].title).toBe('New Tab');
    expect(restored.spaces[1].profilePartition).toMatch(/^persist:kinex-recovered-/);
    expect(restored.spaces[1].profilePartition).not.toBe(restored.spaces[0].profilePartition);
    expect(restored.history.map((entry) => entry.title)).toEqual(['Valid']);
  });

  it('keeps the original damaged file if its recovery backup cannot be written', () => {
    const { persistence } = setup();
    const damaged = '{original-damage';
    fs.writeFileSync(persistence.getStateFilePath(), damaged);
    const recovered = persistence.load();
    const writeFileSync = fs.writeFileSync.bind(fs);
    vi.spyOn(fs, 'writeFileSync').mockImplementation((...args) => {
      if (String(args[0]).includes('.corrupt-')) throw new Error('Backup unavailable');
      return writeFileSync(...args);
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    persistence.save(recovered);
    expect(fs.readFileSync(persistence.getStateFilePath(), 'utf8')).toBe(damaged);
  });
});


it('preserves SVG favicons as inert image URLs during restore', () => {
  const data = createDefaultPersistedData();
  data.tabs[0].favicon = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>';
  const { persistence } = setup(data);
  expect(persistence.load().tabs[0].favicon).toBe(data.tabs[0].favicon);
});
