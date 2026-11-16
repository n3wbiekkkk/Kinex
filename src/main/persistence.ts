import fs from 'node:fs';
import path from 'node:path';
import { createDefaultPersistedData, SPACE_THEME_PRESETS } from '../shared/domain';
import type { PersistedNookData } from '../shared/types';

export class NookPersistence {
  private readonly filePath: string;
  private readonly legacyPaths: string[];

  constructor(userDataDir: string) {
    this.filePath = path.join(userDataDir, 'kinex-state.json');
    this.legacyPaths = [
      path.join(userDataDir, 'nook-state.json'),
      path.join(path.dirname(userDataDir), 'NOOK', 'nook-state.json'),
    ];
  }

  load(): PersistedNookData {
    try {
      const sourcePath = fs.existsSync(this.filePath)
        ? this.filePath
        : this.legacyPaths.find((p) => fs.existsSync(p));
      if (!sourcePath) {
        return createDefaultPersistedData();
      }
      const raw = fs.readFileSync(sourcePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<PersistedNookData>;
      const defaults = createDefaultPersistedData();
      if (!Array.isArray(parsed.spaces) || parsed.spaces.length === 0) {
        return defaults;
      }
      const normalizedSpaces = parsed.spaces.map((s) => {
        const presetMatch = SPACE_THEME_PRESETS.find((p) => p.id === s.theme?.id);
        return {
          ...s,
          theme: {
            ...SPACE_THEME_PRESETS[0],
            ...s.theme,
            tintRgba: s.theme?.tintRgba || presetMatch?.tintRgba || 'rgba(26, 27, 33, 0.78)',
          },
        };
      });
      const migratedTabs = (Array.isArray(parsed.tabs) ? parsed.tabs : defaults.tabs).map((t) => ({
        ...t,
        url: t.url.replace(/^nook:\/\//i, 'kinex://'),
        pinnedUrl: t.pinnedUrl ? t.pinnedUrl.replace(/^nook:\/\//i, 'kinex://') : undefined,
        title: t.title === 'Welcome to NOOK' ? 'Welcome to Kinex' : t.title,
      }));
      return {
        ...defaults,
        ...parsed,
        spaces: normalizedSpaces,
        profiles: Array.isArray(parsed.profiles) && parsed.profiles.length > 0 ? parsed.profiles : defaults.profiles,
        folders: Array.isArray(parsed.folders) ? parsed.folders : [],
        tabs: migratedTabs,
        splitsBySpace: parsed.splitsBySpace ?? defaults.splitsBySpace,
        boosts: Array.isArray(parsed.boosts) ? parsed.boosts : [],
        history: Array.isArray(parsed.history) ? parsed.history : [],
        archivedTabs: Array.isArray(parsed.archivedTabs) ? parsed.archivedTabs : [],
        sidebarWidth: parsed.sidebarWidth ?? defaults.sidebarWidth,
        adBlockEnabled: parsed.adBlockEnabled ?? defaults.adBlockEnabled,
        httpsOnly: parsed.httpsOnly ?? defaults.httpsOnly,
        cleanCopyUrl: parsed.cleanCopyUrl ?? defaults.cleanCopyUrl,
        sitePermissions: Array.isArray(parsed.sitePermissions) ? parsed.sitePermissions : [],
        airTrafficRules: Array.isArray(parsed.airTrafficRules) ? parsed.airTrafficRules : [],
        searchEngine: parsed.searchEngine ?? defaults.searchEngine,
        updateFeedUrl: typeof parsed.updateFeedUrl === 'string' ? parsed.updateFeedUrl : defaults.updateFeedUrl,
      };
    } catch {
      return createDefaultPersistedData();
    }
  }

  save(data: PersistedNookData): void {
    try {
      const dir = path.dirname(this.filePath);
      fs.mkdirSync(dir, { recursive: true });
      const tmpPath = `${this.filePath}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
      fs.renameSync(tmpPath, this.filePath);
    } catch {
      // Ignore transient disk write failures during rapid shutdown
    }
  }
}
