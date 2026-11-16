import fs from 'node:fs';
import path from 'node:path';
import { createDefaultPersistedData, DEFAULT_UPDATE_FEED_URL, SEARCH_ENGINES, SPACE_THEME_PRESETS } from '../shared/domain';
import type { MemorySaverTimeout, NewTabConfig, PersistedKinexData, SearchEngineId } from '../shared/types';
import { isSafeNavigationUrl, isSafeUpdateFeedUrl } from './security';

const VALID_MEMORY_SAVER = new Set<MemorySaverTimeout>(['disabled', '5m', '15m', '30m', '60m']);
const VALID_NEW_TAB_PRESETS = new Set(['minimal', 'focus', 'personal']);
const VALID_NEW_TAB_BGS = new Set(['clean', 'mist', 'dusk', 'sage']);

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
    try {
      const sourcePath = fs.existsSync(this.filePath)
        ? this.filePath
        : this.legacyPaths.find((p) => fs.existsSync(p));
      if (!sourcePath) {
        return createDefaultPersistedData();
      }
      const raw = fs.readFileSync(sourcePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<PersistedKinexData>;
      const defaults = createDefaultPersistedData();
      if (!Array.isArray(parsed.spaces) || parsed.spaces.length === 0) {
        return defaults;
      }
      const normalizedSpaces = parsed.spaces
        .filter((s) => s && typeof s.id === 'string' && typeof s.name === 'string')
        .map((s) => {
          const presetMatch = SPACE_THEME_PRESETS.find((p) => p.id === s.theme?.id);
          return {
            ...s,
            profilePartition: s.profilePartition || defaults.profiles[0].partition,
            theme: {
              ...SPACE_THEME_PRESETS[0],
              ...s.theme,
              tintRgba: s.theme?.tintRgba || presetMatch?.tintRgba || 'rgba(26, 27, 33, 0.78)',
            },
          };
        });
      if (normalizedSpaces.length === 0) {
        return defaults;
      }

      const rawTabs = Array.isArray(parsed.tabs) && parsed.tabs.length > 0 ? parsed.tabs : defaults.tabs;
      const migratedTabs = rawTabs
        .filter((t) => t && typeof t.id === 'string')
        .map((t) => ({
          ...t,
          url: sanitizePersistedUrl(t.url, 'kinex://welcome'),
          pinnedUrl: t.pinnedUrl ? sanitizePersistedUrl(t.pinnedUrl, 'kinex://welcome') : undefined,
          title: t.title === 'Welcome to NOOK' ? 'Welcome to Kinex' : String(t.title || 'New Tab'),
          isLoading: false,
          isCrashed: false,
        }));

      const activeSpaceId = normalizedSpaces.some((s) => s.id === parsed.activeSpaceId)
        ? String(parsed.activeSpaceId)
        : normalizedSpaces[0].id;

      const rawSidebarWidth = typeof parsed.sidebarWidth === 'number' && Number.isFinite(parsed.sidebarWidth)
        ? parsed.sidebarWidth
        : defaults.sidebarWidth;

      const resolvedFeedUrl = resolvePersistedUpdateFeedUrl(parsed.updateFeedUrl, defaults.updateFeedUrl);

      return {
        ...defaults,
        ...parsed,
        activeSpaceId,
        spaces: normalizedSpaces,
        profiles: Array.isArray(parsed.profiles) && parsed.profiles.length > 0 ? parsed.profiles : defaults.profiles,
        folders: Array.isArray(parsed.folders) ? parsed.folders : [],
        tabs: migratedTabs,
        splitsBySpace: parsed.splitsBySpace && typeof parsed.splitsBySpace === 'object'
          ? parsed.splitsBySpace
          : defaults.splitsBySpace,
        boosts: Array.isArray(parsed.boosts) ? parsed.boosts : [],
        history: Array.isArray(parsed.history)
          ? parsed.history
              .filter((h) => h && isSafeNavigationUrl(String(h.url ?? '')))
              .map((h) => ({ ...h, url: sanitizePersistedUrl(h.url) }))
          : [],
        archivedTabs: Array.isArray(parsed.archivedTabs)
          ? parsed.archivedTabs
              .filter((a) => a && typeof a.id === 'string')
              .map((a) => ({ ...a, url: sanitizePersistedUrl(a.url) }))
          : [],
        closedTabs: Array.isArray(parsed.closedTabs)
          ? parsed.closedTabs
              .filter((c) => c && typeof c.id === 'string')
              .map((c) => ({
                ...c,
                url: sanitizePersistedUrl(c.url),
                pinnedUrl: c.pinnedUrl ? sanitizePersistedUrl(c.pinnedUrl) : undefined,
              }))
              .slice(0, 50)
          : [],
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
        adBlockEnabled: parsed.adBlockEnabled ?? defaults.adBlockEnabled,
        httpsOnly: parsed.httpsOnly ?? defaults.httpsOnly,
        cleanCopyUrl: parsed.cleanCopyUrl ?? defaults.cleanCopyUrl,
        sitePermissions: Array.isArray(parsed.sitePermissions) ? parsed.sitePermissions : [],
        airTrafficRules: Array.isArray(parsed.airTrafficRules) ? parsed.airTrafficRules : [],
        searchEngine:
          typeof parsed.searchEngine === 'string' && parsed.searchEngine in SEARCH_ENGINES
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
    } catch {
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
    const toWrite = this.pendingData ?? fallbackData ?? null;
    this.pendingData = null;
    if (toWrite) {
      this.save(toWrite);
    }
  }

  private enqueueAsyncWrite(data: PersistedKinexData): void {
    const payload = JSON.stringify(data);
    this.writeChain = this.writeChain
      .then(async () => {
        if (!this.ensuredDir) {
          await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
          this.ensuredDir = true;
        }
        const tmpPath = `${this.filePath}.${process.pid}.tmp`;
        await fs.promises.writeFile(tmpPath, payload, 'utf8');
        await fs.promises.rename(tmpPath, this.filePath);
      })
      .catch(() => {
        // Ignore transient disk write failures
      });
  }

  save(data: PersistedKinexData): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.pendingData = null;
    try {
      if (!this.ensuredDir) {
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
        this.ensuredDir = true;
      }
      const tmpPath = `${this.filePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(data), 'utf8');
      fs.renameSync(tmpPath, this.filePath);
    } catch {
      // Ignore transient disk write failures during rapid shutdown
    }
  }
}

/** @deprecated Use KinexPersistence */
export const NookPersistence = KinexPersistence;
