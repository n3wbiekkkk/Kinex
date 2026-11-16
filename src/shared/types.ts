export type TabLocation = 'topApp' | 'pinned' | 'unpinned';

export type SearchEngineId = 'google' | 'duckduckgo' | 'bing' | 'perplexity' | 'kagi';

export type SecurityState = 'secure' | 'insecure' | 'cert-warning' | 'internal';

export type SettingsSection =
  | 'general'
  | 'spaces'
  | 'privacy'
  | 'shortcuts'
  | 'import'
  | 'updates';

export interface SpaceTheme {
  id: string;
  name: string;
  gradientFrom: string;
  gradientTo: string;
  tintRgba: string;
  accent: string;
  isDark: boolean;
}

export interface Profile {
  id: string;
  name: string;
  partition: string;
}

export interface Space {
  id: string;
  name: string;
  icon: string;
  theme: SpaceTheme;
  profilePartition: string;
}

export interface FolderItem {
  id: string;
  spaceId: string;
  name: string;
  collapsed: boolean;
}

export interface TabItem {
  id: string;
  spaceId: string;
  location: TabLocation;
  folderId?: string;
  url: string;
  pinnedUrl?: string;
  title: string;
  favicon?: string;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  isMuted: boolean;
  isAudible: boolean;
  securityState?: SecurityState;
  zoomFactor?: number;
  lastActiveAt: number;
}

export interface SplitLayout {
  tabIds: string[];
  focusedIndex: number;
  splitRatio: number;
}

export interface BoostRule {
  id: string;
  name: string;
  domainPattern: string;
  enabled: boolean;
  css: string;
  js: string;
  zappedSelectors: string[];
  filterInvert?: boolean;
  fontFamily?: string;
  zoomFactor?: number;
}

export interface SitePermissionDecision {
  origin: string;
  permission: string;
  decision: 'allow' | 'deny';
  updatedAt: number;
}

export interface AirTrafficRule {
  id: string;
  pattern: string;
  spaceId: string;
  enabled: boolean;
}

export interface HistoryEntry {
  url: string;
  title: string;
  visitedAt: number;
  visitCount: number;
}

export interface ArchivedTab {
  id: string;
  spaceId: string;
  url: string;
  title: string;
  favicon?: string;
  archivedAt: number;
}

export interface DownloadItem {
  id: string;
  filename: string;
  url: string;
  savePath: string;
  receivedBytes: number;
  totalBytes: number;
  state: 'progressing' | 'completed' | 'cancelled' | 'interrupted';
  startedAt: number;
}

export type UpdateStatus =
  | { state: 'idle'; message?: string }
  | { state: 'checking' }
  | { state: 'available'; version: string }
  | { state: 'downloading'; version: string; percent: number }
  | { state: 'downloaded'; version: string }
  | { state: 'up-to-date'; version: string }
  | { state: 'error'; message: string };

export type OverlayState =
  | { mode: 'none' }
  | { mode: 'command-bar'; initialQuery: string; targetMode: 'new-tab' | 'edit-url' | 'split' }
  | { mode: 'boosts'; domain: string }
  | { mode: 'space-editor'; spaceId?: string }
  | { mode: 'archive' }
  | { mode: 'downloads' }
  | { mode: 'find' }
  | { mode: 'settings'; section?: SettingsSection }
  | { mode: 'site-info' };

export interface PersistedNookData {
  spaces: Space[];
  profiles: Profile[];
  folders: FolderItem[];
  activeSpaceId: string;
  tabs: TabItem[];
  splitsBySpace: Record<string, SplitLayout>;
  boosts: BoostRule[];
  history: HistoryEntry[];
  archivedTabs: ArchivedTab[];
  sidebarOpen: boolean;
  sidebarWidth: number;
  adBlockEnabled: boolean;
  httpsOnly: boolean;
  cleanCopyUrl: boolean;
  sitePermissions: SitePermissionDecision[];
  airTrafficRules: AirTrafficRule[];
  searchEngine: SearchEngineId;
  updateFeedUrl: string;
}

export interface NookStateSnapshot extends PersistedNookData {
  overlay: OverlayState;
  downloads: DownloadItem[];
  blockedRequestsCount: number;
  zapperActiveTabId: string | null;
  toastMessage: string | null;
  isDefaultBrowser: boolean;
  appVersion: string;
  updateStatus: UpdateStatus;
}

export type CommandBarItemKind = 'open-tab' | 'pinned-tab' | 'history' | 'domain' | 'search' | 'action';

export interface CommandBarResult {
  id: string;
  kind: CommandBarItemKind;
  title: string;
  subtitle: string;
  url?: string;
  tabId?: string;
  spaceId?: string;
  spaceLabel?: string;
  actionId?:
    | 'new-split'
    | 'toggle-boosts'
    | 'new-space'
    | 'little-nook'
    | 'toggle-adblock'
    | 'open-settings'
    | 'check-updates';
  favicon?: string;
}

export type NookIntent =
  | { type: 'select-space'; spaceId: string }
  | { type: 'create-space'; name: string; icon: string; theme: SpaceTheme; profilePartition?: string }
  | { type: 'update-space'; spaceId: string; name: string; icon: string; theme: SpaceTheme; profilePartition?: string }
  | { type: 'delete-space'; spaceId: string }
  | { type: 'create-profile'; name: string }
  | { type: 'create-folder'; spaceId: string; name: string }
  | { type: 'toggle-folder'; folderId: string }
  | { type: 'rename-folder'; folderId: string; name: string }
  | { type: 'delete-folder'; folderId: string }
  | { type: 'move-tab-to-folder'; tabId: string; folderId?: string }
  | { type: 'reorder-tab'; sourceTabId: string; targetTabId: string }
  | { type: 'select-tab'; tabId: string; paneIndex?: number }
  | { type: 'duplicate-tab'; tabId: string }
  | { type: 'open-url'; url: string; target: 'current' | 'new-tab' | 'split' | 'little-nook'; spaceId?: string }
  | { type: 'close-tab'; tabId: string }
  | { type: 'reset-pinned-tab'; tabId: string }
  | { type: 'set-tab-location'; tabId: string; location: TabLocation }
  | { type: 'clear-today-tabs'; spaceId: string }
  | { type: 'restore-archived-tab'; archivedId: string }
  | { type: 'toggle-split'; tabId?: string }
  | { type: 'close-split-pane'; paneIndex: number }
  | { type: 'set-split-ratio'; ratio: number }
  | { type: 'focus-pane'; paneIndex: number }
  | { type: 'nav-back'; tabId?: string }
  | { type: 'nav-forward'; tabId?: string }
  | { type: 'nav-reload'; tabId?: string }
  | { type: 'nav-stop'; tabId?: string }
  | { type: 'set-zoom'; delta: 'in' | 'out' | 'reset'; tabId?: string }
  | { type: 'toggle-mute'; tabId: string }
  | { type: 'toggle-sidebar'; open?: boolean }
  | { type: 'set-sidebar-width'; width: number }
  | { type: 'set-overlay'; overlay: OverlayState }
  | { type: 'set-search-engine'; engine: SearchEngineId }
  | { type: 'set-https-only'; enabled: boolean }
  | { type: 'set-clean-copy-url'; enabled: boolean }
  | { type: 'revoke-site-permission'; origin: string; permission: string }
  | { type: 'save-air-traffic-rule'; rule: AirTrafficRule }
  | { type: 'delete-air-traffic-rule'; ruleId: string }
  | { type: 'clear-browsing-data'; scopes: Array<'history' | 'cookies' | 'cache' | 'archived'> }
  | { type: 'save-boost'; boost: BoostRule }
  | { type: 'delete-boost'; boostId: string }
  | { type: 'toggle-boost-enabled'; boostId: string }
  | { type: 'start-zapper' }
  | { type: 'stop-zapper' }
  | { type: 'toggle-adblock' }
  | { type: 'copy-current-url'; tabId?: string }
  | { type: 'open-devtools' }
  | { type: 'print-page' }
  | { type: 'open-incognito'; url?: string }
  | { type: 'find-in-page'; text: string; forward?: boolean; findNext?: boolean }
  | { type: 'stop-find-in-page' }
  | { type: 'promote-little-nook'; url: string; title: string }
  | { type: 'import-browser-data'; source: 'arc' | 'chrome' | 'file' }
  | { type: 'set-default-browser' }
  | { type: 'show-download-in-finder'; savePath: string }
  | { type: 'set-update-feed-url'; url: string }
  | { type: 'check-for-updates' }
  | { type: 'download-update' }
  | { type: 'install-update' };

export interface NookAPI {
  getState: () => Promise<NookStateSnapshot>;
  dispatch: (intent: NookIntent) => Promise<void>;
  onStateUpdated: (listener: (state: NookStateSnapshot) => void) => () => void;
  showTabContextMenu: (tabId: string) => Promise<void>;
  getLittleNookInfo: () => Promise<{ url: string; title: string; isLoading: boolean; canGoBack: boolean; canGoForward: boolean }>;
  onLittleNookUpdated: (listener: (info: { url: string; title: string; isLoading: boolean; canGoBack: boolean; canGoForward: boolean }) => void) => () => void;
  littleNookAction: (action: 'back' | 'forward' | 'reload' | 'navigate' | 'promote' | 'close', url?: string) => Promise<void>;
}
