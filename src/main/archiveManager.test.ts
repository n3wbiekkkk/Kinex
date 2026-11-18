import { describe, expect, it } from 'vitest';
import type { TabItem } from '../shared/types';
import {
  AUTO_ARCHIVE_TIMEOUT_MS,
  createArchivedEntry,
  getFolderDepth,
  getFolderPath,
  getFolderPathNames,
  isAutoArchiveTimeout,
  isFolderDescendant,
  mergeArchivedEntries,
  planAutoArchive,
  queryArchiveVault,
  selectIdleTabs,
  wouldCreateFolderCycle,
  type NestedFolder,
} from './archiveManager';

const NOW = 1_000_000;

function tab(overrides: Partial<TabItem> = {}): TabItem {
  return {
    id: 'tab-1',
    spaceId: 'space-a',
    location: 'unpinned',
    url: 'https://example.com/article',
    title: 'Example Article',
    isLoading: false,
    canGoBack: false,
    canGoForward: false,
    isMuted: false,
    isAudible: false,
    lastActiveAt: NOW - AUTO_ARCHIVE_TIMEOUT_MS['12h'],
    ...overrides,
  };
}

const folder = (id: string, parentId?: string, name = id): NestedFolder => ({
  id,
  spaceId: 'space-a',
  name,
  collapsed: false,
  parentId,
});

describe('archiveManager timeout policy', () => {
  it('recognizes only supported timeouts and maps off to infinity', () => {
    expect(isAutoArchiveTimeout('12h')).toBe(true);
    expect(isAutoArchiveTimeout('24h')).toBe(true);
    expect(isAutoArchiveTimeout('7d')).toBe(true);
    expect(isAutoArchiveTimeout('off')).toBe(true);
    expect(isAutoArchiveTimeout('5m')).toBe(false);
    expect(AUTO_ARCHIVE_TIMEOUT_MS.off).toBe(Number.POSITIVE_INFINITY);
  });

  it('selects idle unpinned tabs and excludes protected categories', () => {
    const idle = tab({ id: 'idle' });
    const input = {
      tabs: [
        idle,
        tab({ id: 'recent', lastActiveAt: NOW - 1000 }),
        tab({ id: 'pinned', location: 'pinned' }),
        tab({ id: 'top', location: 'topApp' }),
        tab({ id: 'audible', isAudible: true }),
      ],
      now: NOW,
      timeout: '12h' as const,
      privateSpaceIds: new Set<string>(),
    };
    expect(selectIdleTabs(input).map((t) => t.id)).toEqual(['idle']);

    expect(
      selectIdleTabs({
        ...input,
        privateSpaceIds: new Set(['space-a']),
      })
    ).toEqual([]);
  });

  it('honors off and invalid clocks', () => {
    expect(selectIdleTabs({ tabs: [tab()], now: NOW, timeout: 'off' })).toEqual([]);
    expect(selectIdleTabs({ tabs: [tab()], now: Number.NaN, timeout: '12h' })).toEqual([]);
  });

  it('uses the configured threshold for 24h and 7d', () => {
    const twentyHours = tab({ id: '20h', lastActiveAt: NOW - 20 * 3600_000 });
    expect(selectIdleTabs({ tabs: [twentyHours], now: NOW, timeout: '24h' })).toEqual([]);
    expect(selectIdleTabs({ tabs: [twentyHours], now: NOW, timeout: '12h' })).toEqual([twentyHours]);
    const eightDays = tab({ id: '8d', lastActiveAt: NOW - 8 * 24 * 3600_000 });
    expect(selectIdleTabs({ tabs: [eightDays], now: NOW, timeout: '7d' })).toEqual([eightDays]);
  });
});

describe('archiveManager archived entries and vault', () => {
  it('creates deterministic archived entries and a matching plan', () => {
    const source = tab();
    const entry = createArchivedEntry(source, NOW);
    expect(entry).toEqual({
      id: `arch-${source.id}-${NOW}`,
      spaceId: 'space-a',
      url: source.url,
      title: source.title,
      favicon: undefined,
      archivedAt: NOW,
    });
    expect(createArchivedEntry({ ...source, title: '' }, NOW).title).toBe(source.url);

    const plan = planAutoArchive({ tabs: [source], now: NOW, timeout: '12h' });
    expect(plan.tabIds).toEqual([source.id]);
    expect(plan.entries).toEqual([entry]);
  });

  it('merges entries in bounded, newest-first order', () => {
    const merged = mergeArchivedEntries(
      [{ id: 'old', spaceId: 's', url: 'u', title: 'old', archivedAt: 1 }],
      [{ id: 'new', spaceId: 's', url: 'u', title: 'new', archivedAt: 2 }],
      1
    );
    expect(merged.map((e) => e.id)).toEqual(['new']);
  });

  it('queries the vault by text and space, newest first', () => {
    const entries = [
      { id: 'a', spaceId: 's1', url: 'https://news.example/a', title: 'News A', archivedAt: 10 },
      { id: 'b', spaceId: 's2', url: 'https://blog.example/b', title: 'Blog B', archivedAt: 30 },
      { id: 'c', spaceId: 's1', url: 'https://news.example/c', title: 'News C', archivedAt: 20 },
    ];
    expect(queryArchiveVault(entries).map((e) => e.id)).toEqual(['b', 'c', 'a']);
    expect(queryArchiveVault(entries, { query: 'NEWS' }).map((e) => e.id)).toEqual(['c', 'a']);
    expect(queryArchiveVault(entries, { spaceId: 's1' }).map((e) => e.id)).toEqual(['c', 'a']);
    expect(queryArchiveVault(entries, { limit: 1 }).map((e) => e.id)).toEqual(['b']);
    expect(queryArchiveVault(entries, { query: 'example.com' })).toEqual([]);
  });
});

describe('archiveManager nested folder helpers', () => {
  const folders = [
    folder('root', undefined, 'Root'),
    folder('child', 'root', 'Child'),
    folder('grand', 'child', 'Grandchild'),
    folder('other', undefined, 'Other'),
  ];

  it('builds a root-first path and depth', () => {
    expect(getFolderPath(folders, 'grand').map((f) => f.id)).toEqual(['root', 'child', 'grand']);
    expect(getFolderPathNames(folders, 'grand')).toEqual(['Root', 'Child', 'Grandchild']);
    expect(getFolderDepth(folders, 'grand')).toBe(2);
    expect(getFolderPath(folders, 'missing')).toEqual([]);
  });

  it('detects descendants and rejects cycles', () => {
    expect(isFolderDescendant(folders, 'root', 'grand')).toBe(true);
    expect(isFolderDescendant(folders, 'grand', 'root')).toBe(false);
    expect(isFolderDescendant(folders, 'other', 'other')).toBe(true);
    expect(wouldCreateFolderCycle(folders, 'root', 'grand')).toBe(true);
    expect(wouldCreateFolderCycle(folders, 'grand', 'grand')).toBe(true);
    expect(wouldCreateFolderCycle(folders, 'grand', 'other')).toBe(false);
    expect(wouldCreateFolderCycle(folders, 'grand', undefined)).toBe(false);
  });

  it('is cycle-safe on malformed folder data', () => {
    const cyclic = [folder('a', 'b'), folder('b', 'a')];
    expect(getFolderPath(cyclic, 'a').map((f) => f.id)).toEqual(['b', 'a']);
    expect(isFolderDescendant(cyclic, 'a', 'b')).toBe(true);
  });
});
