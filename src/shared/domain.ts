import { BROWSER_COMMANDS, formatShortcut } from './commands';
import type {
  ClosedTabItem,
  CommandBarResult,
  PersistedKinexData,
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
  startpage: { name: 'Startpage', template: 'https://www.startpage.com/do/search?query=%s' },
  kagi: { name: 'Kagi', template: 'https://kagi.com/search?q=%s' },
};

export const DEFAULT_UPDATE_FEED_URL = 'https://github.com/n3wbiekkkk/Kinex/releases/latest/download';

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
  if (/^about:blank$/i.test(trimmed)) {
    return 'about:blank';
  }
  if (/^(https?|kinex|nook):\/\//i.test(trimmed)) {
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
    closedTabs: [],
    zoomByHost: {},
    readerOptions: { fontSize: 17, theme: 'dark' },
    sidebarOpen: true,
    sidebarWidth: 256,
    adBlockEnabled: true,
    httpsOnly: true,
    cleanCopyUrl: true,
    sitePermissions: [],
    airTrafficRules: [],
    searchEngine: 'google',
    updateFeedUrl: DEFAULT_UPDATE_FEED_URL,
    memorySaverTimeout: '30m',
    memorySaverExemptPinned: true,
    newTabConfig: {
      preset: 'minimal',
      background: 'clean',
      showClock: true,
      showFavorites: true,
      showFrequent: false,
    },
  };
}

export function getActiveSplit(data: PersistedNookData, spaceId = data.activeSpaceId): SplitLayout {
  const existing = data.splitsBySpace[spaceId];
  const validIds = (existing?.tabIds ?? []).filter((id) =>
    data.tabs.some((t) => t.id === id && t.spaceId === spaceId)
  );
  if (validIds.length > 0) {
    return {
      tabIds: validIds.slice(0, 2),
      focusedIndex: Math.min(existing.focusedIndex, validIds.length - 1),
      splitRatio: existing.splitRatio ?? 0.5,
    };
  }
  const fallback = data.tabs.find((t) => t.spaceId === spaceId);
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
      (t) => t.id !== tabId && t.spaceId === data.activeSpaceId
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

  const folderName = target.folderId
    ? data.folders.find((f) => f.id === target.folderId)?.name
    : undefined;
  const now = Date.now();
  const isInternalBlank =
    target.url === 'kinex://newtab' || target.url === 'kinex://welcome' || target.url === 'about:blank';

  const closedEntry: ClosedTabItem | null = isInternalBlank
    ? null
    : {
        id: `closed-${target.id}-${now}`,
        spaceId: target.spaceId,
        location: target.location,
        folderId: target.folderId,
        folderName,
        url: target.url,
        pinnedUrl: target.pinnedUrl,
        title: target.title || target.url,
        favicon: target.favicon,
        closedAt: now,
      };

  const remainingTabs = data.tabs.filter((t) => t.id !== tabId);
  const nextSplits = { ...data.splitsBySpace };
  for (const [sid, split] of Object.entries(nextSplits)) {
    if (split.tabIds.includes(tabId)) {
      const filtered = split.tabIds.filter((id) => id !== tabId);
      const fallback = remainingTabs.find((t) => t.spaceId === sid);
      nextSplits[sid] = {
        ...split,
        tabIds: filtered.length > 0 ? filtered : fallback ? [fallback.id] : [],
        focusedIndex: 0,
      };
    }
  }

  const archived = [
    {
      id: `arch-${target.id}-${now}`,
      spaceId: target.spaceId,
      url: target.url,
      title: target.title,
      favicon: target.favicon,
      archivedAt: now,
    },
    ...data.archivedTabs,
  ].slice(0, 100);

  return {
    next: {
      ...data,
      tabs: remainingTabs,
      splitsBySpace: nextSplits,
      archivedTabs: archived,
      closedTabs: closedEntry ? [closedEntry, ...data.closedTabs].slice(0, 50) : data.closedTabs,
    },
    destroyedTabId: tabId,
    resetTab: null,
  };
}

function archiveAndRecordClosedBatch(
  data: PersistedKinexData,
  spaceId: string,
  toRemove: TabItem[]
): { next: PersistedKinexData; destroyedTabIds: string[] } {
  if (toRemove.length === 0) {
    return { next: data, destroyedTabIds: [] };
  }
  const destroyedSet = new Set(toRemove.map((t) => t.id));
  const remainingTabs = data.tabs.filter((t) => !destroyedSet.has(t.id));
  const now = Date.now();
  const groupId = toRemove.length > 1 ? `grp-${now}-${Math.random().toString(36).slice(2, 6)}` : undefined;
  const newArchived = toRemove.map((t) => ({
    id: `arch-${t.id}-${now}`,
    spaceId: t.spaceId,
    url: t.url,
    title: t.title,
    favicon: t.favicon,
    archivedAt: now,
  }));
  const newClosed: ClosedTabItem[] = toRemove
    .filter((t) => t.url !== 'kinex://newtab' && t.url !== 'kinex://welcome' && t.url !== 'about:blank')
    .map((t) => ({
      id: `closed-${t.id}-${now}`,
      spaceId: t.spaceId,
      location: t.location,
      folderId: t.folderId,
      folderName: t.folderId ? data.folders.find((f) => f.id === t.folderId)?.name : undefined,
      url: t.url,
      pinnedUrl: t.pinnedUrl,
      title: t.title || t.url,
      favicon: t.favicon,
      closedAt: now,
      groupId,
    }));

  const currentSplit = getActiveSplit(data, spaceId);
  const filteredSplit = currentSplit.tabIds.filter((id) => !destroyedSet.has(id));
  const fallback = remainingTabs.find((t) => t.spaceId === spaceId);

  return {
    next: {
      ...data,
      tabs: remainingTabs,
      archivedTabs: [...newArchived, ...data.archivedTabs].slice(0, 100),
      closedTabs: [...newClosed, ...data.closedTabs].slice(0, 50),
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

export function clearTodayTabsForSpace(
  data: PersistedNookData,
  spaceId: string
): { next: PersistedNookData; destroyedTabIds: string[] } {
  const toArchive = data.tabs.filter((t) => t.spaceId === spaceId && t.location === 'unpinned');
  return archiveAndRecordClosedBatch(data, spaceId, toArchive);
}

export function closeOtherTabsForSpace(
  data: PersistedKinexData,
  keepTabId: string
): { next: PersistedKinexData; destroyedTabIds: string[] } {
  const keep = data.tabs.find((t) => t.id === keepTabId);
  if (!keep) return { next: data, destroyedTabIds: [] };
  const toRemove = data.tabs.filter(
    (t) => t.spaceId === keep.spaceId && t.location === 'unpinned' && t.id !== keepTabId
  );
  return archiveAndRecordClosedBatch(data, keep.spaceId, toRemove);
}

export function closeTabsToRightForSpace(
  data: PersistedKinexData,
  anchorTabId: string
): { next: PersistedKinexData; destroyedTabIds: string[] } {
  const anchor = data.tabs.find((t) => t.id === anchorTabId);
  if (!anchor) return { next: data, destroyedTabIds: [] };
  const unpinnedInSpace = data.tabs.filter(
    (t) => t.spaceId === anchor.spaceId && t.location === 'unpinned'
  );
  const idx = unpinnedInSpace.findIndex((t) => t.id === anchorTabId);
  const toRemove = idx === -1 ? [] : unpinnedInSpace.slice(idx + 1);
  return archiveAndRecordClosedBatch(data, anchor.spaceId, toRemove);
}

export function canonicalizeUrlForDuplicate(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl.trim().replace(/^nook:\/\//i, 'kinex://'));
    parsed.hash = '';
    if (parsed.pathname === '/') parsed.pathname = '';
    return parsed.toString().replace(/\/$/, '').toLowerCase();
  } catch {
    return rawUrl.trim().toLowerCase();
  }
}

export function findDuplicateOpenTab(data: PersistedKinexData, rawUrl: string): TabItem | undefined {
  const normalized = normalizeNavigationInput(rawUrl, data.searchEngine);
  if (normalized.startsWith('kinex://') || normalized === 'about:blank') return undefined;
  const targetCanon = canonicalizeUrlForDuplicate(normalized);
  return data.tabs.find((t) => canonicalizeUrlForDuplicate(t.url) === targetCanon);
}

export function restoreClosedTabs(
  data: PersistedKinexData,
  opts: { closedId?: string; groupId?: string } = {}
): { next: PersistedKinexData; restoredTabs: TabItem[] } {
  let targets: ClosedTabItem[] = [];
  if (opts.groupId) {
    targets = data.closedTabs.filter((c) => c.groupId === opts.groupId);
  } else if (opts.closedId) {
    const match = data.closedTabs.find((c) => c.id === opts.closedId);
    if (match) targets = [match];
  } else if (data.closedTabs.length > 0) {
    targets = [data.closedTabs[0]];
  }
  if (targets.length === 0) return { next: data, restoredTabs: [] };

  const removeIds = new Set(targets.map((c) => c.id));
  const now = Date.now();
  const restoredTabs: TabItem[] = targets.map((c, idx) => {
    const targetSpaceId = data.spaces.some((s) => s.id === c.spaceId)
      ? c.spaceId
      : data.activeSpaceId;
    const matchedFolder =
      c.folderId && data.folders.some((f) => f.id === c.folderId && f.spaceId === targetSpaceId)
        ? c.folderId
        : c.folderName
          ? data.folders.find((f) => f.spaceId === targetSpaceId && f.name === c.folderName)?.id
          : undefined;
    return {
      id: `tab-restored-${now}-${idx}-${Math.random().toString(36).slice(2, 5)}`,
      spaceId: targetSpaceId,
      location: c.location === 'pinned' || c.location === 'topApp' ? c.location : 'unpinned',
      folderId: matchedFolder,
      url: c.url,
      pinnedUrl: c.pinnedUrl,
      title: c.title || c.url,
      favicon: c.favicon,
      isLoading: true,
      canGoBack: false,
      canGoForward: false,
      isMuted: false,
      isAudible: false,
      lastActiveAt: now,
    };
  });

  const primary = restoredTabs[0];
  const currentSplit = getActiveSplit(data, primary.spaceId);
  return {
    next: {
      ...data,
      activeSpaceId: primary.spaceId,
      tabs: [...data.tabs, ...restoredTabs],
      closedTabs: data.closedTabs.filter((c) => !removeIds.has(c.id)),
      splitsBySpace: {
        ...data.splitsBySpace,
        [primary.spaceId]: {
          ...currentSplit,
          tabIds: [primary.id],
          focusedIndex: 0,
        },
      },
    },
    restoredTabs,
  };
}

export function moveTabToSpace(
  data: PersistedKinexData,
  tabId: string,
  targetSpaceId: string
): { next: PersistedKinexData; profileChanged: boolean } {
  const tab = data.tabs.find((t) => t.id === tabId);
  const targetSpace = data.spaces.find((s) => s.id === targetSpaceId);
  if (!tab || !targetSpace || tab.spaceId === targetSpaceId) {
    return { next: data, profileChanged: false };
  }
  const sourceSpace = data.spaces.find((s) => s.id === tab.spaceId);
  const profileChanged = sourceSpace?.profilePartition !== targetSpace.profilePartition;

  const updatedTabs = data.tabs.map((t) =>
    t.id === tabId
      ? {
          ...t,
          spaceId: targetSpaceId,
          folderId: undefined,
          lastActiveAt: Date.now(),
        }
      : t
  );

  const nextSplits = { ...data.splitsBySpace };
  const sourceSplit = getActiveSplit(data, tab.spaceId);
  if (sourceSplit.tabIds.includes(tabId)) {
    const remaining = sourceSplit.tabIds.filter((id) => id !== tabId);
    const fallback = updatedTabs.find((t) => t.spaceId === tab.spaceId);
    nextSplits[tab.spaceId] = {
      ...sourceSplit,
      tabIds: remaining.length > 0 ? remaining : fallback ? [fallback.id] : [],
      focusedIndex: 0,
    };
  }
  const destSplit = getActiveSplit({ ...data, tabs: updatedTabs }, targetSpaceId);
  nextSplits[targetSpaceId] = {
    ...destSplit,
    tabIds: [tabId],
    focusedIndex: 0,
  };

  return {
    next: {
      ...data,
      activeSpaceId: targetSpaceId,
      tabs: updatedTabs,
      splitsBySpace: nextSplits,
    },
    profileChanged,
  };
}

export function reorderSpaces(
  data: PersistedKinexData,
  sourceSpaceId: string,
  targetSpaceId: string
): PersistedKinexData {
  if (sourceSpaceId === targetSpaceId) return data;
  const srcIdx = data.spaces.findIndex((s) => s.id === sourceSpaceId);
  const dstIdx = data.spaces.findIndex((s) => s.id === targetSpaceId);
  if (srcIdx === -1 || dstIdx === -1) return data;
  const copy = [...data.spaces];
  const [moved] = copy.splice(srcIdx, 1);
  copy.splice(dstIdx, 0, moved);
  return { ...data, spaces: copy };
}

function commandActions(data: PersistedNookData): CommandBarResult[] {
  const actions: CommandBarResult[] = BROWSER_COMMANDS.filter((c) => c.palette !== false).map((c) => ({
    id: `act:${c.id}`, kind: 'action', title: c.title, subtitle: `${c.category} · ${c.description}`,
    actionId: c.id, intent: { type: 'run-command', commandId: c.id }, shortcut: formatShortcut(c.accelerator),
  }));
  const focused = getFocusedTab(data);
  if (focused) {
    for (const space of data.spaces) {
      if (space.id === focused.spaceId) continue;
      actions.push({ id: `move:${space.id}`, kind: 'action', title: `Move Tab to ${space.name}`,
        subtitle: 'Spaces · Move the focused tab to this workspace',
        intent: { type: 'move-tab-to-space', tabId: focused.id, spaceId: space.id } });
    }
    for (const folder of data.folders.filter((f) => f.spaceId === focused.spaceId)) {
      actions.push({ id: `folder:${folder.id}`, kind: 'action', title: `Move Tab to Folder ${folder.name}`,
        subtitle: 'Tabs · Pin and organize the focused tab',
        intent: { type: 'move-tab-to-folder', tabId: focused.id, folderId: folder.id } });
    }
    if (focused.folderId) actions.push({ id: 'folder:remove', kind: 'action', title: 'Remove Tab from Folder',
      subtitle: 'Tabs · Keep the tab in Pinned', intent: { type: 'move-tab-to-folder', tabId: focused.id } });
  }
  return actions;
}

const SETTINGS_RESULTS: CommandBarResult[] = [
  {
    id: 'set:general',
    kind: 'settings',
    title: 'Settings: General & Default Browser',
    subtitle: 'Default browser, search engine, Memory Saver & New Tab',
    settingsSection: 'general',
  },
  {
    id: 'set:spaces',
    kind: 'settings',
    title: 'Settings: Spaces & Profiles',
    subtitle: 'Cookie profiles & Air Traffic routing rules',
    settingsSection: 'spaces',
  },
  {
    id: 'set:privacy',
    kind: 'settings',
    title: 'Settings: Privacy & Security',
    subtitle: 'Ad & Tracker Shields, HTTPS-Only, Permissions & Clear Data',
    settingsSection: 'privacy',
  },
  {
    id: 'set:shortcuts',
    kind: 'settings',
    title: 'Settings: Keyboard Shortcuts',
    subtitle: 'View macOS browser shortcuts reference',
    settingsSection: 'shortcuts',
  },
  {
    id: 'set:import',
    kind: 'settings',
    title: 'Settings: Import & Data',
    subtitle: 'Import bookmarks from Arc, Chrome, or HTML',
    settingsSection: 'import',
  },
  {
    id: 'set:updates',
    kind: 'settings',
    title: 'Settings: Updates & About',
    subtitle: 'Auto-update feed URL and version details',
    settingsSection: 'updates',
  },
];

function scoreQueryMatch(qLower: string, target: string): number {
  if (!qLower) return 1;
  const t = target.toLowerCase();
  if (t === qLower) return 100;
  if (t.startsWith(qLower)) return 80;
  if (t.includes(` ${qLower}`) || t.includes(`/${qLower}`) || t.includes(`.${qLower}`)) return 60;
  if (t.includes(qLower)) return 40;
  let cursor = 0;
  for (const ch of t) {
    if (ch === qLower[cursor]) cursor += 1;
    if (cursor === qLower.length) return 20;
  }
  return 0;
}

export function buildCommandBarResults(query: string, data: PersistedNookData): CommandBarResult[] {
  const q = query.trim();
  const qLower = q.toLowerCase();
  const scored: Array<{ score: number; item: CommandBarResult }> = [];
  const seenKeys = new Set<string>();

  const makeDedupKey = (url: string, title: string): string => {
    const host = extractHostname(url);
    if (DEDUP_BY_HOST_AND_TITLE_HOSTS.has(host)) {
      return `${host}::${title.toLowerCase()}`;
    }
    return url;
  };

  const spaceById = new Map(data.spaces.map((s) => [s.id, s]));
  const openCanonToTab = new Map<string, TabItem>();
  for (const t of data.tabs) {
    if (!t.url.startsWith('kinex://') && t.url !== 'about:blank') {
      openCanonToTab.set(canonicalizeUrlForDuplicate(t.url), t);
    }
  }

  for (const tab of data.tabs) {
    const sp = spaceById.get(tab.spaceId);
    const domain = extractHostname(tab.url);
    const spaceName = sp?.name ?? '';
    const matchScore = qLower
      ? Math.max(
          scoreQueryMatch(qLower, tab.title),
          scoreQueryMatch(qLower, domain),
          scoreQueryMatch(qLower, tab.url) - 10,
          scoreQueryMatch(qLower, spaceName) - 20
        )
      : 50;
    if (!qLower || matchScore > 0) {
      const key = makeDedupKey(tab.url, tab.title);
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      const activeBonus = tab.spaceId === data.activeSpaceId ? 15 : 0;
      const favBonus = tab.location === 'topApp' ? 8 : tab.location === 'pinned' ? 4 : 0;
      scored.push({
        score: matchScore + activeBonus + favBonus,
        item: {
          id: `tab:${tab.id}`,
          kind: tab.location === 'unpinned' ? 'open-tab' : 'pinned-tab',
          title: tab.title || tab.url,
          subtitle: tab.url,
          url: tab.url,
          tabId: tab.id,
          spaceId: tab.spaceId,
          spaceLabel: tab.location === 'topApp' ? `${sp ? sp.icon + ' ' : ''}Favorite` : sp ? `${sp.icon} ${sp.name}` : undefined,
          favicon: tab.favicon,
        },
      });
    }
  }

  if (qLower) {
    for (const h of data.history) {
      const matchScore = Math.max(
        scoreQueryMatch(qLower, h.title),
        scoreQueryMatch(qLower, extractHostname(h.url)),
        scoreQueryMatch(qLower, h.url) - 10
      );
      if (matchScore > 0) {
        const key = makeDedupKey(h.url, h.title);
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);
        const existingTab = openCanonToTab.get(canonicalizeUrlForDuplicate(h.url));
        scored.push({
          score: matchScore + Math.min(12, h.visitCount),
          item: {
            id: `hist:${h.url}`,
            kind: 'history',
            title: h.title || h.url,
            subtitle: h.url,
            url: h.url,
            isAlreadyOpen: Boolean(existingTab),
            tabId: existingTab?.id,
          },
        });
      }
    }

    for (const act of commandActions(data)) {
      if (act.actionId === 'reopen-closed-tab' && data.closedTabs.length === 0) continue;
      const s = Math.max(scoreQueryMatch(qLower, act.title), scoreQueryMatch(qLower, act.subtitle) - 12);
      if (s > 0) scored.push({ score: s + 30, item: act });
    }

    for (const st of SETTINGS_RESULTS) {
      const s = Math.max(scoreQueryMatch(qLower, st.title), scoreQueryMatch(qLower, st.subtitle) - 12);
      if (s > 0) scored.push({ score: s - 8, item: st });
    }

    if (!qLower.includes(' ')) {
      for (const dom of QUICK_DOMAIN_SUGGESTIONS) {
        if (dom.includes(qLower)) {
          const url = `https://${dom}`;
          if (!seenKeys.has(url)) {
            seenKeys.add(url);
            const existingTab = openCanonToTab.get(canonicalizeUrlForDuplicate(url));
            scored.push({
              score: scoreQueryMatch(qLower, dom) - 12,
              item: {
                id: `dom:${dom}`,
                kind: 'domain',
                title: dom,
                subtitle: `Open ${url}`,
                url,
                isAlreadyOpen: Boolean(existingTab),
                tabId: existingTab?.id,
              },
            });
          }
        }
      }
    }
  } else {
    for (const act of commandActions(data)) {
      if (act.actionId === 'reopen-closed-tab' && data.closedTabs.length === 0) continue;
      scored.push({ score: 25, item: act });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  const results = scored.map((entry) => entry.item);

  if (q) {
    const normalized = normalizeNavigationInput(q, data.searchEngine);
    const engineName = SEARCH_ENGINES[data.searchEngine]?.name ?? 'Google';
    const isSearch = normalized.includes('?q=') && !/^(https?|kinex|nook):\/\//i.test(q);
    const existingTab = isSearch ? undefined : openCanonToTab.get(canonicalizeUrlForDuplicate(normalized));
    const navigationResult: CommandBarResult = {
      id: 'direct-nav',
      kind: isSearch ? 'search' : 'domain',
      title: isSearch ? `Search ${engineName} for "${q}"` : `Go to ${normalized}`,
      subtitle: normalized,
      url: normalized,
      isAlreadyOpen: Boolean(existingTab),
      tabId: existingTab?.id,
    };
    const firstCommandIndex = results.findIndex((r) => r.kind === 'action');
    const commandMatch = scored.find((r) => r.item.kind === 'action');
    if (isSearch && commandMatch && commandMatch.score >= 50 && firstCommandIndex >= 0) {
      results.splice(firstCommandIndex + 1, 0, navigationResult);
    } else {
      results.unshift(navigationResult);
    }
  }

  return results.slice(0, 30);
}
