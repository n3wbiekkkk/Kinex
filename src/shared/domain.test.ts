import { describe, expect, it } from 'vitest';
import {
  buildCommandBarResults,
  clearTodayTabsForSpace,
  closeOrResetTab,
  closeOtherTabsForSpace,
  closeTabsToRightForSpace,
  createDefaultPersistedData,
  extractHostname,
  findDuplicateOpenTab,
  matchesDomainPattern,
  moveTabToSpace,
  normalizeNavigationInput,
  reorderSpaces,
  reorderTabs,
  restoreClosedTabs,
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

  it('supports tab search across spaces, settings, duplicate detection, batch close & group restore', () => {
    let data = createDefaultPersistedData();
    data = {
      ...data,
      tabs: [
        ...data.tabs,
        {
          id: 'tab-u1',
          spaceId: 'space-personal',
          location: 'unpinned',
          url: 'https://example.org/docs#intro',
          title: 'Docs Intro',
          isLoading: false,
          canGoBack: false,
          canGoForward: false,
          isMuted: false,
          isAudible: false,
          lastActiveAt: Date.now(),
        },
        {
          id: 'tab-u2',
          spaceId: 'space-personal',
          location: 'unpinned',
          url: 'https://news.example.org/today',
          title: 'News Today',
          isLoading: false,
          canGoBack: false,
          canGoForward: false,
          isMuted: false,
          isAudible: false,
          lastActiveAt: Date.now() - 10,
        },
      ],
    };

    // Duplicate URL canonicalization ignores hash differences
    expect(findDuplicateOpenTab(data, 'https://example.org/docs')?.id).toBe('tab-u1');

    // Space search + Settings search in Command Bar
    const workMatches = buildCommandBarResults('Work', data);
    expect(workMatches.some((r) => r.tabId === 'tab-work-mdn')).toBe(true);
    const privacySetting = buildCommandBarResults('Privacy', data);
    expect(privacySetting.some((r) => r.kind === 'settings' && r.settingsSection === 'privacy')).toBe(true);

    // Close other unpinned tabs in space -> creates closed group -> restore closed group
    const closedOther = closeOtherTabsForSpace(data, 'tab-u1');
    expect(closedOther.destroyedTabIds).toContain('tab-u2');
    expect(closedOther.next.closedTabs.some((c) => c.url === 'https://news.example.org/today')).toBe(true);

    const groupId = closedOther.next.closedTabs[0].groupId;
    expect(groupId).toBeTruthy();
    const restoredGroup = restoreClosedTabs(closedOther.next, { groupId });
    expect(restoredGroup.restoredTabs.some((t) => t.url === 'https://news.example.org/today')).toBe(true);

    // Move tab across Spaces with different profiles
    const moved = moveTabToSpace(data, 'tab-u1', 'space-work');
    expect(moved.profileChanged).toBe(true);
    expect(moved.next.tabs.find((t) => t.id === 'tab-u1')?.spaceId).toBe('space-work');

    // Close tabs to the right preserves anchor and removes strictly trailing tabs
    const closedRight = closeTabsToRightForSpace(data, 'tab-u1');
    expect(closedRight.destroyedTabIds).toEqual(['tab-u2']);

    // Reorder spaces
    const reorderedSpaces = reorderSpaces(data, 'space-work', 'space-personal');
    expect(reorderedSpaces.spaces[0].id).toBe('space-work');
  });
});
