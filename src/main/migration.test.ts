import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { KinexPersistence } from './persistence';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kinex-mig-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('KinexPersistence legacy NOOK migration & state hardening', () => {
  it('migrates legacy nook-state.json URLs, titles, and preserves profile partitions', () => {
    const baseDir = makeTempDir();
    const userDataDir = path.join(baseDir, 'Kinex');
    fs.mkdirSync(userDataDir, { recursive: true });

    const legacyFile = path.join(userDataDir, 'nook-state.json');
    fs.writeFileSync(
      legacyFile,
      JSON.stringify({
        spaces: [
          {
            id: 'space-personal',
            name: 'Personal',
            icon: '✦',
            theme: { id: 'graphite-glass', name: 'Graphite', gradientFrom: '#1c1d22', gradientTo: '#141519', tintRgba: 'rgba(26, 27, 33, 0.78)', accent: '#7c8cff', isDark: true },
            profilePartition: 'persist:nook-default',
          },
        ],
        profiles: [{ id: 'prof-default', name: 'Default', partition: 'persist:nook-default' }],
        activeSpaceId: 'space-personal',
        tabs: [
          {
            id: 't1',
            spaceId: 'space-personal',
            location: 'pinned',
            url: 'nook://welcome',
            pinnedUrl: 'nook://welcome',
            title: 'Welcome to NOOK',
            isLoading: true,
            canGoBack: false,
            canGoForward: false,
            isMuted: false,
            isAudible: false,
            lastActiveAt: 1000,
          },
          {
            id: 't-bad',
            spaceId: 'space-personal',
            location: 'unpinned',
            url: 'javascript:alert(1)',
            title: 'XSS Tab',
            isLoading: false,
            canGoBack: false,
            canGoForward: false,
            isMuted: false,
            isAudible: false,
            lastActiveAt: 900,
          },
        ],
        history: [
          { url: 'nook://welcome', title: 'Welcome', visitedAt: 100, visitCount: 1 },
          { url: 'https://example.com', title: 'Example', visitedAt: 200, visitCount: 2 },
          { url: 'file:///etc/passwd', title: 'Bad', visitedAt: 300, visitCount: 1 },
        ],
        sidebarWidth: 9999,
        updateFeedUrl: 'http://insecure.example/feed',
      }),
      'utf8'
    );

    const persistence = new KinexPersistence(userDataDir);
    const loaded = persistence.load();

    // Preserved legacy partition
    expect(loaded.spaces[0].profilePartition).toBe('persist:nook-default');
    expect(loaded.profiles[0].partition).toBe('persist:nook-default');

    // Migrated nook:// and legacy welcome title
    expect(loaded.tabs[0].url).toBe('kinex://welcome');
    expect(loaded.tabs[0].pinnedUrl).toBe('kinex://welcome');
    expect(loaded.tabs[0].title).toBe('Welcome to Kinex');
    expect(loaded.tabs[0].isLoading).toBe(false);

    // Sanitized dangerous persisted URLs
    expect(loaded.tabs[1].url).toBe('kinex://welcome');
    expect(loaded.history.map((h) => h.url)).toEqual(['kinex://welcome', 'https://example.com']);

    // Clamped sidebarWidth & sanitized updateFeedUrl
    expect(loaded.sidebarWidth).toBe(380);
    expect(loaded.updateFeedUrl.startsWith('https://')).toBe(true);

    // Migrates stale legacy Nook local/remote update feeds back to default GitHub feed
    fs.writeFileSync(
      path.join(userDataDir, 'kinex-state.json'),
      JSON.stringify({
        spaces: [{ id: 'space-1', name: 'Personal', icon: '✦', profilePartition: 'persist:nook-default' }],
        tabs: [],
        updateFeedUrl: '/Users/dev/Developer/Nook/release',
      }),
      'utf8'
    );
    const migratedFeed = persistence.load();
    expect(migratedFeed.updateFeedUrl).toBe('https://github.com/n3wbiekkkk/Kinex/releases/latest/download');

    // Save writes to kinex-state.json without clobbering legacy file
    persistence.save(loaded);
    expect(fs.existsSync(path.join(userDataDir, 'kinex-state.json'))).toBe(true);
    expect(fs.existsSync(legacyFile)).toBe(true);
  });

  it('migrates sibling NOOK/nook-state.json directory cleanly and recovers from corrupted JSON', () => {
    const baseDir = makeTempDir();
    const legacyDir = path.join(baseDir, 'NOOK');
    const kinexDir = path.join(baseDir, 'Kinex');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.mkdirSync(kinexDir, { recursive: true });

    fs.writeFileSync(
      path.join(legacyDir, 'nook-state.json'),
      JSON.stringify({
        spaces: [
          {
            id: 'sp-custom',
            name: 'Legacy Space',
            icon: '🚀',
            theme: { id: 'nordic-pine', name: 'Pine', gradientFrom: '#172321', gradientTo: '#121b1a', accent: '#34d399', isDark: true },
            profilePartition: 'persist:nook-work',
          },
        ],
        activeSpaceId: 'sp-custom',
        tabs: [
          {
            id: 'tab-x',
            spaceId: 'sp-custom',
            location: 'unpinned',
            url: 'https://mozilla.org',
            title: 'Mozilla',
            isLoading: false,
            canGoBack: false,
            canGoForward: false,
            isMuted: false,
            isAudible: false,
            lastActiveAt: 50,
          },
        ],
      }),
      'utf8'
    );

    const persistence = new KinexPersistence(kinexDir);
    const loaded = persistence.load();
    expect(loaded.spaces[0].name).toBe('Legacy Space');
    expect(loaded.spaces[0].profilePartition).toBe('persist:nook-work');
    expect(loaded.tabs[0].url).toBe('https://mozilla.org');

    // Corrupted kinex-state.json falls back cleanly to defaults
    fs.writeFileSync(path.join(kinexDir, 'kinex-state.json'), '{not-valid-json', 'utf8');
    const recovered = persistence.load();
    expect(recovered.spaces.length).toBeGreaterThanOrEqual(2);
  });
});
