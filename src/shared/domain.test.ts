import { describe, expect, it } from 'vitest';
import {
  buildCommandBarResults,
  clearTodayTabsForSpace,
  closeOrResetTab,
  createDefaultPersistedData,
  extractHostname,
  matchesDomainPattern,
  normalizeNavigationInput,
  reorderTabs,
  setTabLocation,
} from './domain';
import {
  parseArcStorableSidebarJson,
  parseChromeBookmarksJson,
  parseHtmlBookmarks,
} from './importer';

describe('NOOK domain model', () => {
  it('normalizes URLs, localhost, internal kinex:// URLs, and search queries across engines', () => {
    expect(normalizeNavigationInput('')).toBe('kinex://welcome');
    expect(normalizeNavigationInput('https://arc.net')).toBe('https://arc.net');
    expect(normalizeNavigationInput('kinex://welcome')).toBe('kinex://welcome');
    expect(normalizeNavigationInput('nook://welcome')).toBe('kinex://welcome');
    expect(normalizeNavigationInput('localhost:3000/app')).toBe('http://localhost:3000/app');
    expect(normalizeNavigationInput('github.com/morluto/rea')).toBe('https://github.com/morluto/rea');
    expect(normalizeNavigationInput('how to build a browser', 'google')).toBe(
      'https://www.google.com/search?q=how%20to%20build%20a%20browser'
    );
    expect(normalizeNavigationInput('privacy browser', 'duckduckgo')).toBe(
      'https://duckduckgo.com/?q=privacy%20browser'
    );
  });

  it('matches boost domain patterns accurately', () => {
    expect(extractHostname('https://www.GitHub.com/user/repo')).toBe('github.com');
    expect(matchesDomainPattern('https://gist.github.com/foo', 'github.com')).toBe(true);
    expect(matchesDomainPattern('https://gist.github.com/foo', '*.github.com')).toBe(true);
    expect(matchesDomainPattern('https://notgithub.com', 'github.com')).toBe(false);
    expect(matchesDomainPattern('https://example.org', '*')).toBe(true);
  });

  it('resets pinned tabs instead of destroying them on close', () => {
    let data = createDefaultPersistedData();
    data = {
      ...data,
      tabs: data.tabs.map((t) =>
        t.id === 'tab-pin-hn' ? { ...t, url: 'https://news.ycombinator.com/item?id=123' } : t
      ),
    };
    const res = closeOrResetTab(data, 'tab-pin-hn');
    expect(res.destroyedTabId).toBeNull();
    expect(res.resetTab?.url).toBe('https://news.ycombinator.com');
    expect(res.next.tabs.some((t) => t.id === 'tab-pin-hn')).toBe(true);
  });

  it('destroys and archives unpinned today tabs on close and clear-today', () => {
    let data = createDefaultPersistedData();
    data = setTabLocation(data, 'tab-today-welcome', 'unpinned');
    const cleared = clearTodayTabsForSpace(data, 'space-personal');
    expect(cleared.destroyedTabIds).toContain('tab-today-welcome');
    expect(cleared.next.tabs.some((t) => t.id === 'tab-today-welcome')).toBe(false);
    expect(cleared.next.archivedTabs.length).toBe(1);
  });

  it('reorders tabs and updates location when dragged into pinned', () => {
    const data = createDefaultPersistedData();
    const reordered = reorderTabs(data, 'tab-today-welcome', 'tab-pin-hn');
    const moved = reordered.tabs.find((t) => t.id === 'tab-today-welcome');
    expect(moved?.location).toBe('pinned');
  });

  it('deduplicates Command Bar results by host+title for Arc dedup hosts', () => {
    let data = createDefaultPersistedData();
    data = {
      ...data,
      tabs: [
        ...data.tabs,
        {
          id: 'tab-gh-1',
          spaceId: 'space-personal',
          location: 'unpinned',
          url: 'https://github.com/a?tab=1',
          title: 'GitHub',
          isLoading: false,
          canGoBack: false,
          canGoForward: false,
          isMuted: false,
          isAudible: false,
          lastActiveAt: Date.now(),
        },
      ],
    };
    const results = buildCommandBarResults('github', data);
    const githubTabItems = results.filter((r) => r.kind === 'pinned-tab' || r.kind === 'open-tab');
    expect(githubTabItems).toHaveLength(1);
  });

  it('imports Chrome Bookmarks, Arc StorableSidebar, and HTML bookmarks', () => {
    const chromeRes = parseChromeBookmarksJson(
      JSON.stringify({
        roots: {
          bookmark_bar: {
            name: 'Bookmarks bar',
            children: [
              {
                name: 'Dev',
                children: [{ type: 'url', name: 'MDN', url: 'https://developer.mozilla.org' }],
              },
            ],
          },
        },
      }),
      'space-personal'
    );
    expect(chromeRes.folders).toHaveLength(1);
    expect(chromeRes.tabs[0].url).toBe('https://developer.mozilla.org');

    const arcRes = parseArcStorableSidebarJson(
      JSON.stringify({
        sidebar: {
          containers: [
            { items: [{ title: 'Arc Site', data: { tab: { savedURL: 'https://arc.net' } } }] },
          ],
        },
      }),
      'space-personal'
    );
    expect(arcRes.tabs[0].url).toBe('https://arc.net');

    const htmlRes = parseHtmlBookmarks('<DT><A HREF="https://example.com">Example</A>', 'space-personal');
    expect(htmlRes.tabs[0].title).toBe('Example');
  });
});
