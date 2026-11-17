import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  createDefaultPersistedData,
  createDefaultShieldsFilterLists,
  createDefaultShieldsSettings,
  DEFAULT_UPDATE_FEED_URL,
  normalizeShieldsSiteKey,
  SEARCH_ENGINES,
  SPACE_THEME_PRESETS,
} from '../shared/domain';
import type {
  MemorySaverTimeout,
  NewTabConfig,
  PersistedKinexData,
  PersistedShieldsSettings,
  SearchEngineId,
  ShieldsMode,
  Profile,
  Space,
  TabItem,
  SplitLayout,
  PersistedWindowState,
  SitePermissionDecision,
  InstalledExtension,
} from '../shared/types';
import {
  EXTENSION_ID_RE,
  MAX_INSTALLED_EXTENSIONS,
  RUNTIME_ID_RE,
  isSafeRelativePath,
  parseWebStoreUrl,
  sanitizeBoundedStringArray,
} from './extensionSupport';
import { classifySecurityState, isLocalHostname, isSafeNavigationUrl, isSafeUpdateFeedUrl } from './security';

const VALID_MEMORY_SAVER = new Set<MemorySaverTimeout>(['disabled', '5m', '15m', '30m', '60m']);
const VALID_NEW_TAB_PRESETS = new Set(['minimal', 'focus', 'personal']);
const VALID_NEW_TAB_BGS = new Set(['clean', 'mist', 'dusk', 'sage']);
const VALID_SHIELDS_MODES = new Set<ShieldsMode>(['standard', 'aggressive', 'disabled']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPartition(value: unknown): value is string {
  return typeof value === 'string' && /^persist:[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value);
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 &&
    !['__proto__', 'constructor', 'prototype'].includes(value);
}

function finiteNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function sanitizeFavicon(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return /^https?:\/\//i.test(value) || /^data:image\/(?:png|gif|jpeg|webp|x-icon|vnd\.microsoft\.icon|svg\+xml)(?:;[^,]*)?,/i.test(value)
    ? value : undefined;
}

function sanitizePersistedShields(
  rawShields: unknown,
  legacyAdBlockEnabled: boolean
): PersistedShieldsSettings {
  const defaults = createDefaultShieldsSettings();
  if (!rawShields || typeof rawShields !== 'object') {
    if (!legacyAdBlockEnabled) {
      return { ...defaults, globalMode: 'disabled' };
    }
    return defaults;
  }

  const obj = rawShields as Record<string, unknown>;
  const globalMode =
    typeof obj.globalMode === 'string' && VALID_SHIELDS_MODES.has(obj.globalMode as ShieldsMode)
      ? (obj.globalMode as ShieldsMode)
      : legacyAdBlockEnabled
        ? defaults.globalMode
        : 'disabled';
  const lastActiveMode =
    obj.lastActiveMode === 'aggressive' || obj.lastActiveMode === 'standard'
      ? obj.lastActiveMode
      : globalMode === 'aggressive'
        ? 'aggressive'
        : 'standard';

  const siteOverrides: Record<string, ShieldsMode> = Object.create(null);
  if (obj.siteOverrides && typeof obj.siteOverrides === 'object' && !Array.isArray(obj.siteOverrides)) {
    for (const [rawKey, mode] of Object.entries(obj.siteOverrides as Record<string, unknown>)) {
      const key = normalizeShieldsSiteKey(rawKey);
      if (key && typeof mode === 'string' && VALID_SHIELDS_MODES.has(mode as ShieldsMode)) {
        siteOverrides[key] = mode as ShieldsMode;
      }
    }
  }

  const savedListsById = new Map<string, Record<string, unknown>>();
  if (Array.isArray(obj.filterLists)) {
    for (const item of obj.filterLists) {
      if (item && typeof item === 'object' && typeof (item as Record<string, unknown>).id === 'string') {
        savedListsById.set((item as Record<string, unknown>).id as string, item as Record<string, unknown>);
      }
    }
  }

  const filterLists = createDefaultShieldsFilterLists().map((def) => {
    const saved = savedListsById.get(def.id);
    if (!saved) return def;
    return {
      ...def,
      enabled: typeof saved.enabled === 'boolean' ? saved.enabled : def.enabled,
      ruleCount: Math.max(0, finiteNumber(saved.ruleCount, def.ruleCount)),
      lastUpdatedAt: typeof saved.lastUpdatedAt === 'number' && Number.isFinite(saved.lastUpdatedAt) ? saved.lastUpdatedAt : undefined,
      lastError: typeof saved.lastError === 'string' ? saved.lastError : undefined,
    };
  });

  const customCosmeticRules: Record<string, string[]> = Object.create(null);
  if (obj.customCosmeticRules && typeof obj.customCosmeticRules === 'object' && !Array.isArray(obj.customCosmeticRules)) {
    for (const [rawDomain, rules] of Object.entries(obj.customCosmeticRules as Record<string, unknown>)) {
      const key = normalizeShieldsSiteKey(rawDomain);
      if (key && Array.isArray(rules)) {
        const cleaned = Array.from(
          new Set(
            rules
              .filter((r): r is string => typeof r === 'string')
              .map((r) => r.trim())
              .filter((r) => r.length > 0 && r.length <= 512 && !/[{}\n\r;]/.test(r))
          )
        );
        if (cleaned.length > 0) {
          customCosmeticRules[key] = cleaned;
        }
      }
    }
  }

  return {
    globalMode,
    lastActiveMode,
    stripTrackingParams:
      typeof obj.stripTrackingParams === 'boolean' ? obj.stripTrackingParams : defaults.stripTrackingParams,
    cosmeticFilteringEnabled:
      typeof obj.cosmeticFilteringEnabled === 'boolean'
        ? obj.cosmeticFilteringEnabled
        : defaults.cosmeticFilteringEnabled,
    siteOverrides,
    filterLists,
    customCosmeticRules,
    lastGlobalUpdateAt:
      typeof obj.lastGlobalUpdateAt === 'number' && Number.isFinite(obj.lastGlobalUpdateAt) ? obj.lastGlobalUpdateAt : undefined,
  };
}

function resolvePersistedUpdateFeedUrl(rawFeed: unknown, fallback: string): string {
  if (typeof rawFeed !== 'string') return fallback;
  const trimmed = rawFeed.trim();
  if (!trimmed || !isSafeUpdateFeedUrl(trimmed)) return fallback;
  if (/releases\.nook\.dev/i.test(trimmed)) return fallback;
  if (!/^https?:\/\//i.test(trimmed)) {
    const resolved = path.resolve(trimmed);
    // Migrate stale legacy NOOK local release paths or missing local folders back to GitHub Releases
    if (/(?:^|[\\/])nook(?:[\\/]|$)/i.test(resolved) || !fs.existsSync(resolved)) {
      return DEFAULT_UPDATE_FEED_URL;
    }
    return trimmed;
  }
  return trimmed;
}

function sanitizePersistedUrl(rawUrl: unknown, fallback = 'kinex://welcome'): string {
  if (typeof rawUrl !== 'string') return fallback;
  const migrated = rawUrl.trim().replace(/^nook:\/\//i, 'kinex://');
  return isSafeNavigationUrl(migrated) ? migrated : fallback;
}

export class KinexPersistence {
  private readonly filePath: string;
  private readonly legacyPaths: string[];
  private saveTimer: NodeJS.Timeout | null = null;
  private pendingData: PersistedKinexData | null = null;
  private writeChain: Promise<void> = Promise.resolve();
  private ensuredDir = false;
  private writeGeneration = 0;
  private recoveryPayload: string | null = null;

  constructor(userDataDir: string) {
    this.filePath = path.join(userDataDir, 'kinex-state.json');
    this.legacyPaths = [
      path.join(userDataDir, 'nook-state.json'),
      path.join(path.dirname(userDataDir), 'NOOK', 'nook-state.json'),
    ];
  }

  getStateFilePath(): string {
    return this.filePath;
  }

  load(): PersistedKinexData {
    let raw: string | undefined;
    try {
      const sourcePath = fs.existsSync(this.filePath)
        ? this.filePath
        : this.legacyPaths.find((p) => fs.existsSync(p));
      if (!sourcePath) {
        return createDefaultPersistedData();
      }
      raw = fs.readFileSync(sourcePath, 'utf8');
      const decoded: unknown = JSON.parse(raw);
      if (!isRecord(decoded)) throw new Error('Invalid state document');
      const parsed = decoded as Partial<PersistedKinexData>;
      const defaults = createDefaultPersistedData();
      let damaged = false;
      const records = (value: unknown): Record<string, unknown>[] => {
        if (value === undefined) return [];
        if (!Array.isArray(value)) { damaged = true; return []; }
        const result = value.filter(isRecord);
        if (result.length !== value.length) damaged = true;
        return result;
      };
      const namedRecords = (value: unknown): Record<string, unknown>[] => {
        const seen = new Set<string>();
        return records(value).filter((item) => {
          if (!isId(item.id) || seen.has(item.id)) { damaged = true; return false; }
          seen.add(item.id);
          return true;
        });
      };
      const rawSpaces = namedRecords(parsed.spaces).filter((space) => {
        if (typeof space.name !== 'string') { damaged = true; return false; }
        return true;
      });
      if (rawSpaces.length === 0) damaged = true;
      const normalizedSpaces: Space[] = (rawSpaces.length > 0 ? rawSpaces : defaults.spaces)
        .map((s) => {
          if (s.theme !== undefined && !isRecord(s.theme)) damaged = true;
          const theme = isRecord(s.theme) ? s.theme : {};
          const preset = SPACE_THEME_PRESETS.find((p) => p.id === theme.id) ?? SPACE_THEME_PRESETS[0];
          const partition = isPartition(s.profilePartition) ? s.profilePartition
            : s.profilePartition === undefined ? defaults.profiles[0].partition
              : `persist:kinex-recovered-${createHash('sha256').update(String(s.id)).digest('hex').slice(0, 16)}`;
          if (s.profilePartition !== undefined && !isPartition(s.profilePartition)) damaged = true;
          return {
            id: String(s.id),
            name: String(s.name),
            icon: typeof s.icon === 'string' ? s.icon : '✦',
            profilePartition: partition,
            theme: {
              id: optionalString(theme.id) ?? preset.id,
              name: optionalString(theme.name) ?? preset.name,
              gradientFrom: optionalString(theme.gradientFrom) ?? preset.gradientFrom,
              gradientTo: optionalString(theme.gradientTo) ?? preset.gradientTo,
              tintRgba: optionalString(theme.tintRgba) ?? preset.tintRgba,
              accent: optionalString(theme.accent) ?? preset.accent,
              isDark: typeof theme.isDark === 'boolean' ? theme.isDark : preset.isDark,
            },
          };
        });
      const spaceIds = new Set(normalizedSpaces.map((space) => space.id));
      const usedPartitions = new Set<string>();
      const profiles: Profile[] = namedRecords(parsed.profiles === undefined ? defaults.profiles : parsed.profiles).flatMap((profile) => {
        if (typeof profile.name !== 'string' || !isPartition(profile.partition) || usedPartitions.has(profile.partition)) {
          damaged = true;
          return [];
        }
        usedPartitions.add(profile.partition);
        return [{ id: String(profile.id), name: profile.name, partition: profile.partition }];
      });
      for (const space of normalizedSpaces) {
        if (!usedPartitions.has(space.profilePartition)) {
          usedPartitions.add(space.profilePartition);
          profiles.push({ id: `recovered-${randomUUID()}`, name: space.name, partition: space.profilePartition });
        }
      }
      const folders = namedRecords(parsed.folders).flatMap((folder) => {
        if (typeof folder.name !== 'string' || typeof folder.spaceId !== 'string' || !spaceIds.has(folder.spaceId)) { damaged = true; return []; }
        return [{ id: String(folder.id), spaceId: folder.spaceId, name: folder.name, collapsed: folder.collapsed === true }];
      });
      const migratedTabs: TabItem[] = namedRecords(parsed.tabs === undefined ? defaults.tabs : parsed.tabs).map((t) => {
        const spaceId = typeof t.spaceId === 'string' && spaceIds.has(t.spaceId) ? t.spaceId : normalizedSpaces[0].id;
        if (spaceId !== t.spaceId) damaged = true;
        const url = sanitizePersistedUrl(t.url, 'kinex://welcome');
        return {
          id: String(t.id),
          spaceId,
          location: t.location === 'pinned' || t.location === 'topApp' ? t.location : 'unpinned',
          folderId: folders.some((f) => f.id === t.folderId && f.spaceId === spaceId) ? String(t.folderId) : undefined,
          url,
          pinnedUrl: t.pinnedUrl ? sanitizePersistedUrl(t.pinnedUrl, 'kinex://welcome') : undefined,
          title: t.title === 'Welcome to NOOK' ? 'Welcome to Kinex' : optionalString(t.title) || 'New Tab',
          favicon: sanitizeFavicon(t.favicon),
          isLoading: false,
          isCrashed: false,
          isDiscarded: t.isDiscarded === true,
          canGoBack: false,
          canGoForward: false,
          isMuted: t.isMuted === true,
          isAudible: false,
          securityState: classifySecurityState(url, false),
          zoomFactor: typeof t.zoomFactor === 'number' && t.zoomFactor >= 0.5 && t.zoomFactor <= 2.5 ? t.zoomFactor : undefined,
          lastActiveAt: Math.max(0, finiteNumber(t.lastActiveAt)),
        };
      });
      const splitsBySpace: Record<string, SplitLayout> = Object.create(null);
      const rawSplits = isRecord(parsed.splitsBySpace) ? parsed.splitsBySpace : {};
      if (parsed.splitsBySpace !== undefined && !isRecord(parsed.splitsBySpace)) damaged = true;
      for (const space of normalizedSpaces) {
        const rawSplit = rawSplits[space.id];
        const split: Record<string, unknown> = isRecord(rawSplit) ? rawSplit : {};
        if (rawSplit !== undefined && (!isRecord(rawSplit) || !Array.isArray(split.tabIds))) damaged = true;
        const requestedIds = Array.isArray(split.tabIds) ? split.tabIds : [];
        const tabIds = [...new Set(requestedIds.filter((id): id is string =>
          typeof id === 'string' && migratedTabs.some((tab) => tab.id === id && tab.spaceId === space.id)
        ))].slice(0, 2);
        if (requestedIds.length !== tabIds.length) damaged = true;
        if (split.focusedIndex !== undefined && (!Number.isInteger(split.focusedIndex) || finiteNumber(split.focusedIndex) < 0 || finiteNumber(split.focusedIndex) >= Math.max(1, tabIds.length))) damaged = true;
        if (split.splitRatio !== undefined && (typeof split.splitRatio !== 'number' || split.splitRatio < 0.2 || split.splitRatio > 0.8)) damaged = true;
        if (tabIds.length === 0) {
          const fallback = migratedTabs.find((tab) => tab.spaceId === space.id);
          if (fallback) tabIds.push(fallback.id);
        }
        splitsBySpace[space.id] = {
          tabIds,
          focusedIndex: Math.max(0, Math.min(tabIds.length - 1, Math.trunc(finiteNumber(split.focusedIndex)))),
          splitRatio: typeof split.splitRatio === 'number' && split.splitRatio >= 0.2 && split.splitRatio <= 0.8 ? split.splitRatio : 0.5,
        };
      }

      const parsedActiveSpaceId = normalizedSpaces.some((s) => s.id === parsed.activeSpaceId)
        ? String(parsed.activeSpaceId)
        : normalizedSpaces[0].id;
      const rawWindows = records(parsed.windows);
      const windowIds = new Set<string>();
      const windowSpaceIds = new Set<string>();
      const windows: PersistedWindowState[] = [];
      for (const rawWindow of rawWindows.slice(0, 16)) {
        const bounds = isRecord(rawWindow.bounds) ? rawWindow.bounds : {};
        const spaceId = typeof rawWindow.spaceId === 'string' ? rawWindow.spaceId : '';
        if (
          !isId(rawWindow.id) || windowIds.has(String(rawWindow.id)) ||
          !spaceIds.has(spaceId) || windowSpaceIds.has(spaceId) ||
          !isRecord(rawWindow.bounds)
        ) {
          damaged = true;
          continue;
        }
        windowIds.add(String(rawWindow.id));
        windowSpaceIds.add(spaceId);
        windows.push({
          id: String(rawWindow.id),
          bounds: {
            x: Math.min(8192, Math.max(-2048, Math.trunc(finiteNumber(bounds.x, 100)))),
            y: Math.min(8192, Math.max(-2048, Math.trunc(finiteNumber(bounds.y, 80)))),
            width: Math.min(4096, Math.max(880, Math.trunc(finiteNumber(bounds.width, 1380)))),
            height: Math.min(2160, Math.max(580, Math.trunc(finiteNumber(bounds.height, 880)))),
          },
          isMaximized: rawWindow.isMaximized === true,
          spaceId,
          isFocused: rawWindow.isFocused === true,
        });
      }
      if (windows.length === 0) {
        windows.push({ ...defaults.windows[0], bounds: { ...defaults.windows[0].bounds }, spaceId: parsedActiveSpaceId, isFocused: true });
        if (rawWindows.length > 0) damaged = true;
      } else if (!windows.some((window) => window.isFocused)) {
        windows[0].isFocused = true;
      }
      if (rawWindows.length > 16) damaged = true;
      const activeSpaceId = windows.find((window) => window.isFocused)?.spaceId ?? parsedActiveSpaceId;

      const rawSidebarWidth = typeof parsed.sidebarWidth === 'number' && Number.isFinite(parsed.sidebarWidth)
        ? parsed.sidebarWidth
        : defaults.sidebarWidth;

      const resolvedFeedUrl = resolvePersistedUpdateFeedUrl(parsed.updateFeedUrl, defaults.updateFeedUrl);
      const shields = sanitizePersistedShields(parsed.shields, parsed.adBlockEnabled ?? defaults.adBlockEnabled);

      const sitePermissions = records(parsed.sitePermissions).flatMap<SitePermissionDecision>((permission) => {
        if (!isPartition(permission.partition) || !usedPartitions.has(permission.partition) ||
            typeof permission.origin !== 'string' || typeof permission.permission !== 'string' ||
            !permission.permission || (permission.decision !== 'allow' && permission.decision !== 'deny')) {
          damaged = true;
          return [];
        }
        try {
          const url = new URL(permission.origin);
          if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocalHostname(url.hostname))) { damaged = true; return []; }
          return [{ partition: permission.partition, origin: url.origin, permission: permission.permission,
            decision: permission.decision, updatedAt: Math.max(0, finiteNumber(permission.updatedAt)) }];
        } catch { damaged = true; return []; }
      });
      const boosts = namedRecords(parsed.boosts).flatMap((boost) => {
        if (typeof boost.name !== 'string' || typeof boost.domainPattern !== 'string' ||
            typeof boost.css !== 'string' || typeof boost.js !== 'string') { damaged = true; return []; }
        return [{ id: String(boost.id), name: boost.name, domainPattern: boost.domainPattern,
          enabled: boost.enabled === true, css: boost.css, js: boost.js,
          zappedSelectors: Array.isArray(boost.zappedSelectors)
            ? boost.zappedSelectors.filter((s): s is string => typeof s === 'string' && s.length <= 512 && !/[{}\n\r;]/.test(s)) : [],
          filterInvert: boost.filterInvert === true, fontFamily: optionalString(boost.fontFamily),
          zoomFactor: typeof boost.zoomFactor === 'number' && boost.zoomFactor >= 0.5 && boost.zoomFactor <= 2.5 ? boost.zoomFactor : undefined }];
      });
      const airTrafficRules = namedRecords(parsed.airTrafficRules).flatMap((rule) => {
        if (typeof rule.pattern !== 'string' || typeof rule.spaceId !== 'string' || !spaceIds.has(rule.spaceId)) { damaged = true; return []; }
        return [{ id: String(rule.id), pattern: rule.pattern, spaceId: rule.spaceId, enabled: rule.enabled === true }];
      });
      const extensions: InstalledExtension[] = namedRecords(parsed.extensions)
        .slice(0, MAX_INSTALLED_EXTENSIONS)
        .flatMap((extension) => {
          const id = String(extension.id);
          const permissions = sanitizeBoundedStringArray(extension.permissions, 64, 128);
          const hostPermissions = sanitizeBoundedStringArray(extension.hostPermissions, 64, 256);
          const runtimeId = extension.runtimeId;
          const actionPopup = extension.actionPopup;
          const actionIcon = extension.actionIcon;
          const crxId = extension.crxId;
          const webStoreUrl = extension.webStoreUrl;
          const source = extension.source === undefined ? 'folder' : extension.source;
          if (
            !EXTENSION_ID_RE.test(id) ||
            extension.directory !== id ||
            typeof extension.partition !== 'string' || !extension.partition.startsWith('persist:') || !usedPartitions.has(extension.partition) ||
            typeof extension.spaceId !== 'string' || !spaceIds.has(extension.spaceId) ||
            typeof extension.name !== 'string' || extension.name.length === 0 || extension.name.length > 128 ||
            typeof extension.version !== 'string' || extension.version.length === 0 || extension.version.length > 32 ||
            (extension.description !== undefined && (typeof extension.description !== 'string' || extension.description.length > 512)) ||
            typeof extension.enabled !== 'boolean' || typeof extension.consented !== 'boolean' ||
            typeof extension.installedAt !== 'number' || !Number.isFinite(extension.installedAt) ||
            !permissions || !hostPermissions ||
            (runtimeId !== undefined && (typeof runtimeId !== 'string' || !RUNTIME_ID_RE.test(runtimeId))) ||
            (actionPopup !== undefined && !isSafeRelativePath(actionPopup)) ||
            (actionIcon !== undefined && !isSafeRelativePath(actionIcon)) ||
            !['folder', 'crx', 'webstore'].includes(String(source)) ||
            (crxId !== undefined && (typeof crxId !== 'string' || !RUNTIME_ID_RE.test(crxId))) ||
            (webStoreUrl !== undefined && !parseWebStoreUrl(webStoreUrl))
          ) {
            damaged = true;
            return [];
          }
          return [{
            id,
            name: extension.name,
            version: extension.version,
            ...(typeof extension.description === 'string' ? { description: extension.description } : {}),
            source: source as 'folder' | 'crx' | 'webstore',
            ...(typeof crxId === 'string' ? { crxId } : {}),
            ...(typeof webStoreUrl === 'string' ? { webStoreUrl } : {}),
            directory: id,
            ...(typeof runtimeId === 'string' ? { runtimeId } : {}),
            partition: extension.partition,
            spaceId: extension.spaceId,
            enabled: extension.enabled,
            consented: extension.consented,
            permissions,
            hostPermissions,
            ...(isSafeRelativePath(actionPopup) ? { actionPopup } : {}),
            ...(isSafeRelativePath(actionIcon) ? { actionIcon } : {}),
            installedAt: extension.installedAt,
          }];
        });
      if (namedRecords(parsed.extensions).length !== extensions.length || namedRecords(parsed.extensions).length > MAX_INSTALLED_EXTENSIONS) damaged = true;
      const result: PersistedKinexData = {
        ...defaults,
        extensions,
        activeSpaceId,
        spaces: normalizedSpaces,
        profiles,
        folders,
        tabs: migratedTabs,
        splitsBySpace,
        windows,
        boosts,
        history: records(parsed.history).filter((h) => typeof h.url === 'string' && isSafeNavigationUrl(h.url)).map((h) => ({
          url: sanitizePersistedUrl(h.url), title: optionalString(h.title) || optionalString(h.url) || 'New Tab',
          visitedAt: Math.max(0, finiteNumber(h.visitedAt)), visitCount: Math.max(1, Math.trunc(finiteNumber(h.visitCount, 1))),
        })),
        archivedTabs: namedRecords(parsed.archivedTabs).map((a) => ({
          id: String(a.id), spaceId: typeof a.spaceId === 'string' && spaceIds.has(a.spaceId) ? a.spaceId : activeSpaceId,
          url: sanitizePersistedUrl(a.url), title: optionalString(a.title) || 'New Tab',
          favicon: sanitizeFavicon(a.favicon), archivedAt: Math.max(0, finiteNumber(a.archivedAt)),
        })),
        closedTabs: namedRecords(parsed.closedTabs).slice(0, 50).map((c) => ({
          id: String(c.id), spaceId: typeof c.spaceId === 'string' && spaceIds.has(c.spaceId) ? c.spaceId : activeSpaceId,
          location: c.location === 'pinned' || c.location === 'topApp' ? c.location : 'unpinned',
          folderId: optionalString(c.folderId), folderName: optionalString(c.folderName),
          url: sanitizePersistedUrl(c.url), pinnedUrl: c.pinnedUrl ? sanitizePersistedUrl(c.pinnedUrl) : undefined,
          title: optionalString(c.title) || 'New Tab', favicon: sanitizeFavicon(c.favicon),
          closedAt: Math.max(0, finiteNumber(c.closedAt)), groupId: optionalString(c.groupId),
        })),
        zoomByHost:
          parsed.zoomByHost && typeof parsed.zoomByHost === 'object' && !Array.isArray(parsed.zoomByHost)
            ? Object.fromEntries(
                Object.entries(parsed.zoomByHost).filter(
                  ([host, z]) => typeof host === 'string' && typeof z === 'number' && Number.isFinite(z) && z >= 0.5 && z <= 2.5
                )
              )
            : {},
        readerOptions: {
          fontSize:
            typeof parsed.readerOptions?.fontSize === 'number' &&
            parsed.readerOptions.fontSize >= 12 &&
            parsed.readerOptions.fontSize <= 28
              ? Math.round(parsed.readerOptions.fontSize)
              : defaults.readerOptions.fontSize,
          theme:
            parsed.readerOptions?.theme === 'light' ||
            parsed.readerOptions?.theme === 'sepia' ||
            parsed.readerOptions?.theme === 'dark'
              ? parsed.readerOptions.theme
              : defaults.readerOptions.theme,
        },
        sidebarWidth: Math.min(380, Math.max(200, Math.round(rawSidebarWidth))),
        sidebarOpen: typeof parsed.sidebarOpen === 'boolean' ? parsed.sidebarOpen : defaults.sidebarOpen,
        shields,
        adBlockEnabled: shields.globalMode !== 'disabled',
        httpsOnly: typeof parsed.httpsOnly === 'boolean' ? parsed.httpsOnly : defaults.httpsOnly,
        cleanCopyUrl: typeof parsed.cleanCopyUrl === 'boolean' ? parsed.cleanCopyUrl : defaults.cleanCopyUrl,
        sitePermissions,
        airTrafficRules,
        searchEngine:
          typeof parsed.searchEngine === 'string' && Object.hasOwn(SEARCH_ENGINES, parsed.searchEngine)
            ? (parsed.searchEngine as SearchEngineId)
            : defaults.searchEngine,
        updateFeedUrl: resolvedFeedUrl,
        memorySaverTimeout:
          typeof parsed.memorySaverTimeout === 'string' &&
          VALID_MEMORY_SAVER.has(parsed.memorySaverTimeout as MemorySaverTimeout)
            ? (parsed.memorySaverTimeout as MemorySaverTimeout)
            : defaults.memorySaverTimeout,
        memorySaverExemptPinned:
          typeof parsed.memorySaverExemptPinned === 'boolean'
            ? parsed.memorySaverExemptPinned
            : defaults.memorySaverExemptPinned,
        newTabConfig: {
          preset:
            parsed.newTabConfig && VALID_NEW_TAB_PRESETS.has(parsed.newTabConfig.preset)
              ? parsed.newTabConfig.preset
              : defaults.newTabConfig.preset,
          background:
            parsed.newTabConfig && VALID_NEW_TAB_BGS.has(parsed.newTabConfig.background)
              ? parsed.newTabConfig.background
              : defaults.newTabConfig.background,
          showClock:
            typeof parsed.newTabConfig?.showClock === 'boolean'
              ? parsed.newTabConfig.showClock
              : defaults.newTabConfig.showClock,
          showFavorites:
            typeof parsed.newTabConfig?.showFavorites === 'boolean'
              ? parsed.newTabConfig.showFavorites
              : defaults.newTabConfig.showFavorites,
          showFrequent:
            typeof parsed.newTabConfig?.showFrequent === 'boolean'
              ? parsed.newTabConfig.showFrequent
              : defaults.newTabConfig.showFrequent,
        } satisfies NewTabConfig,
      };
      if (damaged) this.recoveryPayload = raw;
      return result;
    } catch {
      if (raw !== undefined) this.recoveryPayload = raw;
      return createDefaultPersistedData();
    }
  }

  scheduleSave(data: PersistedKinexData, delayMs = 400): void {
    this.pendingData = data;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      const latest = this.pendingData;
      this.pendingData = null;
      if (latest) {
        this.enqueueAsyncWrite(latest);
      }
    }, delayMs);
    this.saveTimer.unref?.();
  }

  flushPendingSave(fallbackData?: PersistedKinexData): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    const toWrite = fallbackData ?? this.pendingData ?? null;
    this.pendingData = null;
    if (toWrite) {
      this.save(toWrite);
    }
  }

  private enqueueAsyncWrite(data: PersistedKinexData): void {
    const payload = JSON.stringify(data);
    const generation = ++this.writeGeneration;
    const tmpPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    this.writeChain = this.writeChain
      .then(async () => {
        if (generation !== this.writeGeneration) return;
        if (!this.ensuredDir) {
          await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
          this.ensuredDir = true;
        }
        try {
          await fs.promises.writeFile(tmpPath, payload, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
          if (generation === this.writeGeneration) {
            this.preserveRecoveryPayload();
            // Keep the generation check and promotion in one turn so shutdown cannot interleave.
            fs.renameSync(tmpPath, this.filePath);
          }
        } finally {
          await fs.promises.rm(tmpPath, { force: true });
        }
      })
      .catch((error: unknown) => {
        console.warn('Kinex could not save browser state.', error instanceof Error && 'code' in error ? error.code : 'write failed');
      });
  }

  private preserveRecoveryPayload(): void {
    if (this.recoveryPayload === null) return;
    const backupPath = `${this.filePath}.corrupt-${randomUUID()}.json`;
    fs.writeFileSync(backupPath, this.recoveryPayload, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    this.recoveryPayload = null;
  }

  save(data: PersistedKinexData): void {
    this.writeGeneration += 1;
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.pendingData = null;
    const tmpPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      if (!this.ensuredDir) {
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
        this.ensuredDir = true;
      }
      fs.writeFileSync(tmpPath, JSON.stringify(data), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      this.preserveRecoveryPayload();
      fs.renameSync(tmpPath, this.filePath);
    } catch (error) {
      console.warn('Kinex could not save browser state.', error instanceof Error && 'code' in error ? error.code : 'write failed');
    } finally {
      try { fs.rmSync(tmpPath, { force: true }); } catch {}
    }
  }
}

/** @deprecated Use KinexPersistence */
export const NookPersistence = KinexPersistence;
