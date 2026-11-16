import type {
  CommandBarResult,
  PersistedNookData,
  SearchEngineId,
  Space,
  SpaceTheme,
  SplitLayout,
  TabItem,
  TabLocation,
} from './types';

export const SEARCH_ENGINES: Record<SearchEngineId, { name: string; template: string }> = {
  google: { name: 'Google', template: 'https://www.google.com/search?q=%s' },
  duckduckgo: { name: 'DuckDuckGo', template: 'https://duckduckgo.com/?q=%s' },
  bing: { name: 'Bing', template: 'https://www.bing.com/search?q=%s' },
  perplexity: { name: 'Perplexity', template: 'https://www.perplexity.ai/search?q=%s' },
  kagi: { name: 'Kagi', template: 'https://kagi.com/search?q=%s' },
};

export const SPACE_THEME_PRESETS: SpaceTheme[] = [
  {
    id: 'graphite-glass',
    name: 'Graphite',
    gradientFrom: '#1c1d22',
    gradientTo: '#141519',
    tintRgba: 'rgba(26, 27, 33, 0.78)',
    accent: '#7c8cff',
    isDark: true,
  },
  {
    id: 'midnight-indigo',
    name: 'Indigo',
    gradientFrom: '#1b1d30',
    gradientTo: '#161726',
    tintRgba: 'rgba(26, 28, 48, 0.78)',
    accent: '#818cf8',
    isDark: true,
  },
  {
    id: 'nordic-pine',
    name: 'Pine',
    gradientFrom: '#172321',
    gradientTo: '#121b1a',
    tintRgba: 'rgba(22, 35, 33, 0.78)',
    accent: '#34d399',
    isDark: true,
  },
  {
    id: 'warm-espresso',
    name: 'Espresso',
    gradientFrom: '#271d1b',
    gradientTo: '#1c1514',
    tintRgba: 'rgba(39, 29, 27, 0.78)',
    accent: '#f59e0b',
    isDark: true,
  },
  {
    id: 'paper-sage',
    name: 'Sage',
    gradientFrom: '#dde5da',
    gradientTo: '#cfdacc',
    tintRgba: 'rgba(221, 229, 218, 0.80)',
    accent: '#2f6f4e',
    isDark: false,
  },
  {
    id: 'soft-alabaster',
    name: 'Alabaster',
    gradientFrom: '#eceaf0',
    gradientTo: '#e2dfea',
    tintRgba: 'rgba(236, 234, 240, 0.82)',
    accent: '#4f46e5',
    isDark: false,
  },
];

export const DEDUP_BY_HOST_AND_TITLE_HOSTS = new Set([
  'figma.com',
  'maps.google.com',
  'notion.so',
  'app.notion.com',
  'zoom.us',
  'opentable.com',
  'zillow.com',
  'github.com',
  'app.mode.com',
  'console.cloud.google.com',
]);

export const QUICK_DOMAIN_SUGGESTIONS = [
  'github.com',
  'google.com',
  'youtube.com',
  'wikipedia.org',
  'notion.so',
  'figma.com',
  'linear.app',
  'news.ycombinator.com',
  'developer.mozilla.org',
  'stackoverflow.com',
];

export function normalizeNavigationInput(
  rawInput: string,
  searchEngine: SearchEngineId = 'google'
): string {
  const trimmed = rawInput.trim();
  if (!trimmed) {
    return 'kinex://welcome';
  }
  if (/^(https?|kinex|nook|about|file):\/\//i.test(trimmed)) {
    return trimmed.replace(/^nook:\/\//i, 'kinex://');
  }
  if (/^localhost(:\d+)?(\/.*)?$/i.test(trimmed) || /^127\.0\.0\.1(:\d+)?(\/.*)?$/i.test(trimmed)) {
    return `http://${trimmed}`;
  }
  if (!trimmed.includes(' ') && /^[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)+([/?#].*)?$/.test(trimmed)) {
    return `https://${trimmed}`;
  }
  const tpl = SEARCH_ENGINES[searchEngine]?.template ?? SEARCH_ENGINES.google.template;
  return tpl.replace('%s', encodeURIComponent(trimmed));
}

export function extractHostname(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    return parsed.hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

export function matchesDomainPattern(rawUrl: string, pattern: string): boolean {
  const cleanPattern = pattern.trim().toLowerCase().replace(/^www\./, '');
  if (!cleanPattern) return false;
  if (cleanPattern === '*') return true;
  const host = extractHostname(rawUrl);
  if (!host) return false;
  if (cleanPattern.startsWith('*.')) {
    const suffix = cleanPattern.slice(2);
    return host === suffix || host.endsWith(`.${suffix}`);
  }
  return host === cleanPattern || host.endsWith(`.${cleanPattern}`);
}

export function createDefaultPersistedData(): PersistedNookData {
  const personalSpace: Space = {
    id: 'space-personal',
    name: 'Personal',
    icon: '✦',
    theme: SPACE_THEME_PRESETS[0],
    profilePartition: 'persist:nook-default',
  };
  const workSpace: Space = {
    id: 'space-work',
    name: 'Work',
    icon: '⌘',
    theme: SPACE_THEME_PRESETS[4],
    profilePartition: 'persist:nook-work',
  };

  const now = Date.now();
  const tabs: TabItem[] = [
    {
      id: 'tab-fav-github',
      spaceId: personalSpace.id,
      location: 'topApp',
      url: 'https://github.com',
      pinnedUrl: 'https://github.com',
      title: 'GitHub',
      isLoading: false,
      canGoBack: false,
      canGoForward: false,
      isMuted: false,
      isAudible: false,
      lastActiveAt: now,
    },
    {
      id: 'tab-fav-youtube',
      spaceId: personalSpace.id,
      location: 'topApp',
      url: 'https://www.youtube.com',
      pinnedUrl: 'https://www.youtube.com',
      title: 'YouTube',
      isLoading: false,
      canGoBack: false,
      canGoForward: false,
      isMuted: false,
      isAudible: false,
      lastActiveAt: now - 1000,
    },
    {
      id: 'tab-pin-hn',
      spaceId: personalSpace.id,
      location: 'pinned',
      url: 'https://news.ycombinator.com',
      pinnedUrl: 'https://news.ycombinator.com',
      title: 'Hacker News',
      isLoading: false,
      canGoBack: false,
      canGoForward: false,
      isMuted: false,
      isAudible: false,
      lastActiveAt: now - 2000,
    },
    {
      id: 'tab-today-welcome',
      spaceId: personalSpace.id,
      location: 'unpinned',
      url: 'kinex://welcome',
      title: 'Welcome to Kinex',
      isLoading: false,
      canGoBack: false,
      canGoForward: false,
      isMuted: false,
      isAudible: false,
      lastActiveAt: now,
    },
    {
      id: 'tab-work-mdn',
      spaceId: workSpace.id,
      location: 'pinned',
      url: 'https://developer.mozilla.org',
      pinnedUrl: 'https://developer.mozilla.org',
      title: 'MDN Web Docs',
      isLoading: false,
      canGoBack: false,
      canGoForward: false,
      isMuted: false,
      isAudible: false,
      lastActiveAt: now - 3000,
    },
  ];

  return {
    spaces: [personalSpace, workSpace],
    profiles: [
      { id: 'prof-default', name: 'Default', partition: 'persist:nook-default' },
      { id: 'prof-work', name: 'Work', partition: 'persist:nook-work' },
    ],
    folders: [],
    activeSpaceId: personalSpace.id,
    tabs,
    splitsBySpace: {
      [personalSpace.id]: { tabIds: ['tab-today-welcome'], focusedIndex: 0, splitRatio: 0.5 },
      [workSpace.id]: { tabIds: ['tab-work-mdn'], focusedIndex: 0, splitRatio: 0.5 },
    },
    boosts: [],
    history: [],
    archivedTabs: [],
    sidebarOpen: true,
    sidebarWidth: 256,
    adBlockEnabled: true,
    httpsOnly: true,
    cleanCopyUrl: true,
    sitePermissions: [],
    airTrafficRules: [],
    searchEngine: 'google',
    updateFeedUrl: 'https://github.com/n3wbiekkkk/Kinex/releases/latest/download',
  };
}

export function getActiveSplit(data: PersistedNookData, spaceId = data.activeSpaceId): SplitLayout {
  const existing = data.splitsBySpace[spaceId];
  const validIds = (existing?.tabIds ?? []).filter((id) => data.tabs.some((t) => t.id === id));
  if (validIds.length > 0) {
    return {
      tabIds: validIds.slice(0, 2),
      focusedIndex: Math.min(existing.focusedIndex, validIds.length - 1),
      splitRatio: existing.splitRatio ?? 0.5,
    };
  }
  const fallback = data.tabs.find((t) => t.spaceId === spaceId || t.location === 'topApp');
  return {
    tabIds: fallback ? [fallback.id] : [],
    focusedIndex: 0,
    splitRatio: 0.5,
  };
}

export function getFocusedTab(data: PersistedNookData): TabItem | undefined {
  const split = getActiveSplit(data);
  const tabId = split.tabIds[split.focusedIndex] ?? split.tabIds[0];
  return data.tabs.find((t) => t.id === tabId);
}

export function setTabLocation(data: PersistedNookData, tabId: string, location: TabLocation): PersistedNookData {
  return {
    ...data,
    tabs: data.tabs.map((tab) => {
      if (tab.id !== tabId) return tab;
      if (location === 'unpinned') {
        return { ...tab, location, pinnedUrl: undefined, folderId: undefined };
      }
      return {
        ...tab,
        location,
        folderId: location === 'pinned' ? tab.folderId : undefined,
        pinnedUrl: tab.pinnedUrl ?? tab.url,
      };
    }),
  };
}

export function reorderTabs(data: PersistedNookData, sourceTabId: string, targetTabId: string): PersistedNookData {
  if (sourceTabId === targetTabId) return data;
  const sourceIdx = data.tabs.findIndex((t) => t.id === sourceTabId);
  const targetIdx = data.tabs.findIndex((t) => t.id === targetTabId);
  if (sourceIdx === -1 || targetIdx === -1) return data;
  const source = data.tabs[sourceIdx];
  const target = data.tabs[targetIdx];
  const updatedSource: TabItem = {
    ...source,
    location: target.location,
    folderId: target.location === 'pinned' ? target.folderId : undefined,
    pinnedUrl: target.location === 'unpinned' ? undefined : source.pinnedUrl ?? source.url,
  };
  const copy = [...data.tabs];
  copy.splice(sourceIdx, 1);
  const insertAt = copy.findIndex((t) => t.id === targetTabId);
  copy.splice(insertAt, 0, updatedSource);
  return { ...data, tabs: copy };
}

export function closeOrResetTab(data: PersistedNookData, tabId: string): {
  next: PersistedNookData;
  destroyedTabId: string | null;
  resetTab: TabItem | null;
} {
  const target = data.tabs.find((t) => t.id === tabId);
  if (!target) {
    return { next: data, destroyedTabId: null, resetTab: null };
  }

  if (target.location === 'pinned' || target.location === 'topApp') {
    const resetUrl = target.pinnedUrl ?? target.url;
    const resetTab: TabItem = { ...target, url: resetUrl };
    const updatedTabs = data.tabs.map((t) => (t.id === tabId ? resetTab : t));
    const spaceSplit = getActiveSplit(data, data.activeSpaceId);
    const remaining = spaceSplit.tabIds.filter((id) => id !== tabId);
    const fallback = updatedTabs.find(
      (t) => t.id !== tabId && (t.spaceId === data.activeSpaceId || t.location === 'topApp')
    );
    const nextSplitIds = remaining.length > 0 ? remaining : fallback ? [fallback.id] : [tabId];
    return {
      next: {
        ...data,
        tabs: updatedTabs,
        splitsBySpace: {
          ...data.splitsBySpace,
          [data.activeSpaceId]: {
            ...spaceSplit,
            tabIds: nextSplitIds,
            focusedIndex: 0,
          },
        },
      },
      destroyedTabId: null,
      resetTab,
    };
  }

  const remainingTabs = data.tabs.filter((t) => t.id !== tabId);
  const nextSplits = { ...data.splitsBySpace };
  for (const [sid, split] of Object.entries(nextSplits)) {
    if (split.tabIds.includes(tabId)) {
      const filtered = split.tabIds.filter((id) => id !== tabId);
      const fallback = remainingTabs.find((t) => t.spaceId === sid || t.location === 'topApp');
      nextSplits[sid] = {
        ...split,
        tabIds: filtered.length > 0 ? filtered : fallback ? [fallback.id] : [],
        focusedIndex: 0,
      };
    }
  }

  const archived = [
    {
      id: `arch-${target.id}-${Date.now()}`,
      spaceId: target.spaceId,
      url: target.url,
      title: target.title,
      favicon: target.favicon,
      archivedAt: Date.now(),
    },
    ...data.archivedTabs,
  ].slice(0, 100);

  return {
    next: {
      ...data,
      tabs: remainingTabs,
      splitsBySpace: nextSplits,
      archivedTabs: archived,
    },
    destroyedTabId: tabId,
    resetTab: null,
  };
}

export function clearTodayTabsForSpace(data: PersistedNookData, spaceId: string): {
  next: PersistedNookData;
  destroyedTabIds: string[];
} {
  const toArchive = data.tabs.filter((t) => t.spaceId === spaceId && t.location === 'unpinned');
  if (toArchive.length === 0) {
    return { next: data, destroyedTabIds: [] };
  }
  const destroyedSet = new Set(toArchive.map((t) => t.id));
  const remainingTabs = data.tabs.filter((t) => !destroyedSet.has(t.id));
  const now = Date.now();
  const newArchived = toArchive.map((t) => ({
    id: `arch-${t.id}-${now}`,
    spaceId: t.spaceId,
    url: t.url,
    title: t.title,
    favicon: t.favicon,
    archivedAt: now,
  }));

  const currentSplit = getActiveSplit(data, spaceId);
  const filteredSplit = currentSplit.tabIds.filter((id) => !destroyedSet.has(id));
  const fallback = remainingTabs.find((t) => t.spaceId === spaceId || t.location === 'topApp');

  return {
    next: {
      ...data,
      tabs: remainingTabs,
      archivedTabs: [...newArchived, ...data.archivedTabs].slice(0, 100),
      splitsBySpace: {
        ...data.splitsBySpace,
        [spaceId]: {
          ...currentSplit,
          tabIds: filteredSplit.length > 0 ? filteredSplit : fallback ? [fallback.id] : [],
          focusedIndex: 0,
        },
      },
    },
    destroyedTabIds: Array.from(destroyedSet),
  };
}

export function buildCommandBarResults(query: string, data: PersistedNookData): CommandBarResult[] {
  const q = query.trim();
  const qLower = q.toLowerCase();
  const results: CommandBarResult[] = [];
  const seenKeys = new Set<string>();

  const makeDedupKey = (url: string, title: string): string => {
    const host = extractHostname(url);
    if (DEDUP_BY_HOST_AND_TITLE_HOSTS.has(host)) {
      return `${host}::${title.toLowerCase()}`;
    }
    return url;
  };

  const spaceById = new Map(data.spaces.map((s) => [s.id, s]));

  for (const tab of data.tabs) {
    if (
      !qLower ||
      tab.title.toLowerCase().includes(qLower) ||
      tab.url.toLowerCase().includes(qLower)
    ) {
      const key = makeDedupKey(tab.url, tab.title);
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      const sp = spaceById.get(tab.spaceId);
      results.push({
        id: `tab:${tab.id}`,
        kind: tab.location === 'unpinned' ? 'open-tab' : 'pinned-tab',
        title: tab.title || tab.url,
        subtitle: tab.url,
        url: tab.url,
        tabId: tab.id,
        spaceId: tab.spaceId,
        spaceLabel: tab.location === 'topApp' ? 'Favorite' : sp ? `${sp.icon} ${sp.name}` : undefined,
        favicon: tab.favicon,
      });
    }
  }

  if (qLower) {
    for (const h of data.history) {
      if (h.title.toLowerCase().includes(qLower) || h.url.toLowerCase().includes(qLower)) {
        const key = makeDedupKey(h.url, h.title);
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);
        results.push({
          id: `hist:${h.url}`,
          kind: 'history',
          title: h.title || h.url,
          subtitle: h.url,
          url: h.url,
        });
      }
      if (results.length >= 10) break;
    }
  }

  if (qLower && !qLower.includes(' ')) {
    for (const dom of QUICK_DOMAIN_SUGGESTIONS) {
      if (dom.includes(qLower)) {
        const url = `https://${dom}`;
        if (!seenKeys.has(url)) {
          seenKeys.add(url);
          results.push({
            id: `dom:${dom}`,
            kind: 'domain',
            title: dom,
            subtitle: `Open ${url}`,
            url,
          });
        }
      }
    }
  }

  if (q) {
    const normalized = normalizeNavigationInput(q, data.searchEngine);
    const engineName = SEARCH_ENGINES[data.searchEngine]?.name ?? 'Google';
    const isSearch = normalized.includes('?q=') && !/^(https?|kinex|nook):\/\//i.test(q);
    results.unshift({
      id: 'direct-nav',
      kind: isSearch ? 'search' : 'domain',
      title: isSearch ? `Search ${engineName} for "${q}"` : `Go to ${normalized}`,
      subtitle: normalized,
      url: normalized,
    });
  } else {
    results.push(
      {
        id: 'act:split',
        kind: 'action',
        title: 'Toggle Split View',
        subtitle: 'View two tabs side-by-side in this space',
        actionId: 'new-split',
      },
      {
        id: 'act:boosts',
        kind: 'action',
        title: 'Open Boosts Studio',
        subtitle: 'Customize CSS, JS, or Zap elements on this site',
        actionId: 'toggle-boosts',
      },
      {
        id: 'act:little',
        kind: 'action',
        title: 'Open Little Kinex',
        subtitle: 'Quick floating mini browser window',
        actionId: 'little-nook',
      },
      {
        id: 'act:space',
        kind: 'action',
        title: 'Create New Space',
        subtitle: 'Organize tabs with a new Space & theme',
        actionId: 'new-space',
      },
      {
        id: 'act:settings',
        kind: 'action',
        title: 'Settings & Import',
        subtitle: 'Search engine, profiles, and Arc/Chrome bookmark import',
        actionId: 'open-settings',
      },
      {
        id: 'act:updates',
        kind: 'action',
        title: 'Check for Updates',
        subtitle: 'Check for a new Kinex Browser release',
        actionId: 'check-updates',
      }
    );
  }

  return results.slice(0, 12);
}
