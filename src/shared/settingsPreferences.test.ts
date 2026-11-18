import { describe, expect, it } from 'vitest';
import {
  ACCENT_PREFERENCES,
  clampDefaultZoom,
  detectShortcutConflicts,
  findShortcutConflict,
  formatCustomSearchUrl,
  isValidCustomFilterUrl,
  isValidSearchKeyword,
  isValidSearchTemplate,
  normalizeCustomFilterUrls,
  normalizeCustomSearchEngine,
  normalizeSitePattern,
  normalizeSiteWhitelist,
  readSettingsPreferences,
  searchSettings,
  SETTINGS_SEARCH_INDEX,
} from './settingsPreferences';

describe('settings preference validators', () => {
  it('accepts only declared enum values', () => {
    const prefs = readSettingsPreferences({
      theme: 'dark',
      sidebarSide: 'right',
      density: 'compact',
      accent: 'emerald',
      vibrancy: 'full',
      startupBehavior: 'restore-session',
      thirdPartyCookies: 'incognito-only',
      referrerPolicy: 'no-referrer',
      webRtcPolicy: 'disabled',
    });
    expect(prefs.theme).toBe('dark');
    expect(prefs.sidebarSide).toBe('right');
    expect(prefs.density).toBe('compact');
    expect(prefs.accent).toBe('emerald');
    expect(prefs.vibrancy).toBe('full');
    expect(prefs.startupBehavior).toBe('restore-session');
    expect(prefs.thirdPartyCookies).toBe('incognito-only');
    expect(prefs.referrerPolicy).toBe('no-referrer');
    expect(prefs.webRtcPolicy).toBe('disabled');

    const bad = readSettingsPreferences({
      theme: 'neon', sidebarSide: 'center', density: 'huge', accent: 'chartreuse',
      vibrancy: 'glassy', startupBehavior: 'whenever', thirdPartyCookies: 'maybe',
      referrerPolicy: 'everything', webRtcPolicy: 'sometimes',
      httpsOnly: 'yes', cleanCopyUrl: 1, showFullUrl: 'true',
    });
    expect(bad.theme).toBe('system');
    expect(bad.sidebarSide).toBe('left');
    expect(bad.density).toBe('cozy');
    expect(bad.accent).toBe('indigo');
    expect(bad.vibrancy).toBe('subtle');
    expect(bad.startupBehavior).toBe('new-tab');
    expect(bad.thirdPartyCookies).toBe('block');
    expect(bad.referrerPolicy).toBe('strict-origin-when-cross-origin');
    expect(bad.webRtcPolicy).toBe('public-only');
    expect(bad.httpsOnly).toBe(true);
    expect(bad.cleanCopyUrl).toBe(true);
    expect(bad.showFullUrl).toBe(false);
    expect(ACCENT_PREFERENCES).toContain('indigo');
  });

  it('clamps default zoom and never accepts NaN', () => {
    expect(clampDefaultZoom(1.25)).toBe(1.25);
    expect(clampDefaultZoom(0.01)).toBe(0.5);
    expect(clampDefaultZoom(9)).toBe(2);
    expect(clampDefaultZoom('3')).toBe(2);
    expect(clampDefaultZoom('not-a-number')).toBe(1);
    expect(readSettingsPreferences({ defaultZoom: 100 }).defaultZoom).toBe(2);
  });

  it('validates custom search engines with %s templates and @keywords', () => {
    expect(isValidSearchTemplate('https://example.com/search?q=%s')).toBe(true);
    expect(isValidSearchTemplate('https://example.com/search?q=hello')).toBe(false);
    expect(isValidSearchTemplate('http://example.com/search?q=%s')).toBe(false);
    expect(isValidSearchTemplate('javascript:alert(%s)')).toBe(false);
    expect(isValidSearchKeyword('@docs')).toBe(true);
    expect(isValidSearchKeyword('docs')).toBe(false);
    expect(isValidSearchKeyword('@has space')).toBe(false);

    expect(normalizeCustomSearchEngine({
      name: 'Docs', template: 'https://example.com/search?q=%s', keyword: '@Docs',
    })).toEqual({ name: 'Docs', template: 'https://example.com/search?q=%s', keyword: '@docs' });
    expect(normalizeCustomSearchEngine({ name: '', template: 'https://x/?q=%s', keyword: '@x' })).toBeNull();
    expect(formatCustomSearchUrl(
      { name: 'Docs', template: 'https://example.com/search?q=%s', keyword: '@docs' },
      'a b&c'
    )).toBe('https://example.com/search?q=a%20b%26c');
  });

  it('restricts custom filter URLs to HTTPS or loopback and de-duplicates', () => {
    expect(isValidCustomFilterUrl('https://lists.example.com/filter.txt')).toBe(true);
    expect(isValidCustomFilterUrl('http://localhost:8080/filter.txt')).toBe(true);
    expect(isValidCustomFilterUrl('http://lists.example.com/filter.txt')).toBe(false);
    expect(isValidCustomFilterUrl('file:///etc/passwd')).toBe(false);
    expect(isValidCustomFilterUrl('javascript:alert(1)')).toBe(false);
    expect(normalizeCustomFilterUrls([
      'https://a.example/x', 'https://a.example/x', 'file:///etc/passwd', 42,
      'http://attacker.local/y',
    ])).toEqual(['https://a.example/x']);
  });

  it('normalizes site whitelist patterns', () => {
    expect(normalizeSitePattern('https://WWW.Example.com/path')).toBe('example.com');
    expect(normalizeSitePattern('*.linear.app')).toBe('*.linear.app');
    expect(normalizeSitePattern('*')).toBe('*');
    expect(normalizeSitePattern('not a host')).toBe('');
    expect(normalizeSiteWhitelist([
      'https://example.com/a', 'example.com', 'bad host', '*.linear.app', 'example.com',
    ])).toEqual(['example.com', '*.linear.app']);
  });
});

describe('settings search', () => {
  it('returns the full catalogue for an empty query', () => {
    expect(searchSettings('')).toHaveLength(SETTINGS_SEARCH_INDEX.length);
  });

  it('matches labels, ids and keywords case-insensitively', () => {
    expect(searchSettings('PASSKEY').map((e) => e.id)).toContain('site-permissions');
    expect(searchSettings('appearance').map((e) => e.id)).toEqual(
      expect.arrayContaining(['theme', 'accent', 'vibrancy'])
    );
    expect(searchSettings('@keyword').map((e) => e.id)).toContain('custom-search-engine');
    expect(searchSettings('nothing-matches-this')).toEqual([]);
  });
});

describe('shortcut conflict detection', () => {
  it('detects built-in and custom collisions with normalized modifiers', () => {
    expect(findShortcutConflict('CmdOrCtrl+Shift+K')).toMatchObject({
      conflictsWithId: 'open-shields', source: 'built-in',
    });
    expect(findShortcutConflict('Command+Shift+K')).toMatchObject({
      conflictsWithId: 'open-shields', source: 'built-in',
    });
    expect(findShortcutConflict('CmdOrCtrl+Alt+G', [{ id: 'x', accelerator: 'CmdOrCtrl+Option+G' }])).toMatchObject({
      conflictsWithId: 'x', source: 'custom',
    });
    expect(findShortcutConflict('')).toBeNull();
  });

  it('reports every conflicting custom binding once', () => {
    const conflicts = detectShortcutConflicts([
      { id: 'a', accelerator: 'CmdOrCtrl+Alt+1' },
      { id: 'b', accelerator: 'Command+Option+1' },
      { id: 'c', accelerator: 'CmdOrCtrl+Shift+K' },
      { id: 'd', accelerator: 'CmdOrCtrl+Alt+9' },
    ]);
    expect(conflicts).toHaveLength(2);
    expect(conflicts[0]).toMatchObject({ bindingId: 'b', conflictsWithId: 'a', source: 'custom' });
    expect(conflicts[1]).toMatchObject({ bindingId: 'c', conflictsWithId: 'open-shields', source: 'built-in' });
  });

  it('leaves unique chords alone', () => {
    expect(detectShortcutConflicts([
      { id: 'a', accelerator: 'CmdOrCtrl+Alt+1' },
      { id: 'b', accelerator: 'CmdOrCtrl+Alt+2' },
    ])).toEqual([]);
  });
});
