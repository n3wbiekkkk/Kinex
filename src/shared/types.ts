import type { CommandId } from './commands';

export type TabLocation = 'topApp' | 'pinned' | 'unpinned';

export type SearchEngineId = 'google' | 'duckduckgo' | 'bing' | 'startpage' | 'kagi';

export type NewTabPreset = 'minimal' | 'focus' | 'personal';

export type NewTabBackground = 'clean' | 'mist' | 'dusk' | 'sage';

export interface NewTabConfig {
  preset: NewTabPreset;
  background: NewTabBackground;
  showClock: boolean;
  showFavorites: boolean;
  showFrequent: boolean;
}

export type MemorySaverTimeout = 'disabled' | '5m' | '15m' | '30m' | '60m';

export type SecurityState = 'secure' | 'insecure' | 'cert-warning' | 'internal';

export type SettingsSection =
  | 'general'
  | 'spaces'
  | 'privacy'
  | 'shields'
  | 'shortcuts'
  | 'extensions'
  | 'import'
  | 'updates';

export type ShieldsMode = 'standard' | 'aggressive' | 'disabled';

export type ShieldsBlockedCategory = 'ad' | 'tracker' | 'other';

export type ShieldsFilterCategory = 'ads' | 'privacy' | 'annoyances' | 'fixes';

export interface ShieldsFilterListMeta {
  id: string;
  name: string;
  description: string;
  sourceUrl: string;
  bundledFile: string;
  license: string;
  category: ShieldsFilterCategory;
  tier: 'standard' | 'aggressive';
  enabled: boolean;
  ruleCount: number;
  lastUpdatedAt?: number;
  lastError?: string;
}

export interface ShieldsBlockedSample {
  id: string;
  host: string;
  resourceType: string;
  category: ShieldsBlockedCategory;
  listName: string;
}

export interface TabShieldsStats {
  total: number;
  ads: number;
  trackers: number;
  other: number;
  recentBlocked: ShieldsBlockedSample[];
}

export interface PersistedShieldsSettings {
  globalMode: ShieldsMode;
  lastActiveMode: 'standard' | 'aggressive';
  stripTrackingParams: boolean;
  cosmeticFilteringEnabled: boolean;
  siteOverrides: Record<string, ShieldsMode>;
  filterLists: ShieldsFilterListMeta[];
  customCosmeticRules: Record<string, string[]>;
  lastGlobalUpdateAt?: number;
}

export interface ShieldsRuntimeSnapshot {
  updatingLists: boolean;
  needsReloadByTabId: Record<string, boolean>;
  tabStats: Record<string, TabShieldsStats>;
  totalRuleCount: number;
  engineReady: boolean;
  engineError?: string;
  pickerActiveTabId: string | null;
}

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
  isCrashed?: boolean;
  isDiscarded?: boolean;
  zoomFactor?: number;
  lastActiveAt: number;
}

export interface SplitLayout {
  tabIds: string[];
  focusedIndex: number;
  splitRatio: number;
}

export interface PersistedWindowState {
  id: string;
  bounds: { x: number; y: number; width: number; height: number };
  isMaximized: boolean;
  spaceId: string;
  isFocused: boolean;
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
  partition: string;
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

export interface ClosedTabItem {
  id: string;
  spaceId: string;
  location: TabLocation;
  folderId?: string;
  folderName?: string;
  url: string;
  pinnedUrl?: string;
  title: string;
  favicon?: string;
  closedAt: number;
  groupId?: string;
}

export type ReaderTheme = 'light' | 'sepia' | 'dark';

export interface ReaderOptions {
  fontSize: number;
  theme: ReaderTheme;
}

export interface FindInPageStatus {
  tabId: string;
  query: string;
  activeMatchOrdinal: number;
  matches: number;
}

export interface DuplicateTabPrompt {
  url: string;
  existingTabId: string;
  existingTabTitle: string;
  existingSpaceId: string;
  target: 'current' | 'new-tab' | 'split';
  requestedSpaceId?: string;
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
  speedBytesPerSec?: number;
  etaSeconds?: number;
  canResume?: boolean;
  isPaused?: boolean;
  mimeType?: string;
}

export type UpdateStatus =
  | { state: 'idle'; message?: string }
  | { state: 'checking' }
  | { state: 'available'; version: string }
  | { state: 'downloading'; version: string; percent: number }
  | { state: 'preparing'; version: string }
  | { state: 'downloaded'; version: string; installation?: 'in-app' | 'manual'; releaseUrl?: string }
  | { state: 'installing'; version: string }
  | { state: 'up-to-date'; version: string }
  | { state: 'error'; message: string };

export type OverlayState =
  | { mode: 'none' }
  | { mode: 'command-bar'; initialQuery: string; targetMode: 'new-tab' | 'edit-url' | 'split' }
  | { mode: 'boosts'; domain: string }
  | { mode: 'space-editor'; spaceId?: string }
  | { mode: 'archive' }
  | { mode: 'history' }
  | { mode: 'downloads' }
  | { mode: 'find' }
  | { mode: 'settings'; section?: SettingsSection }
  | { mode: 'shields' }
  | { mode: 'site-info' };

export type ExtensionSource = 'folder' | 'crx' | 'webstore';

export interface InstalledExtension {
  id: string;
  name: string;
  version: string;
  description?: string;
  source?: ExtensionSource;
  /** CRX3 extension id in the a-p alphabet, when installed from a CRX or the Web Store. */
  crxId?: string;
  webStoreUrl?: string;
  /** Relative directory name under the managed Extensions folder. */
  directory: string;
  /** Chromium-assigned id, populated once the extension has been loaded. */
  runtimeId?: string;
  /** Profile partition this extension is installed into. */
  partition: string;
  spaceId: string;
  enabled: boolean;
  consented: boolean;
  permissions: string[];
  hostPermissions: string[];
  backgroundServiceWorker?: string;
  actionPopup?: string;
  actionIcon?: string;
  installedAt: number;
}

export interface ExtensionActionBadge {
  text: string;
  color: string;
}

export interface ExtensionViewModel extends InstalledExtension {
  badge?: ExtensionActionBadge;
  iconDataUrl?: string;
  loaded: boolean;
  error?: string;
}

export interface PersistedKinexData {
  extensions: InstalledExtension[];
  spaces: Space[];
  profiles: Profile[];
  folders: FolderItem[];
  activeSpaceId: string;
  tabs: TabItem[];
  splitsBySpace: Record<string, SplitLayout>;
  windows: PersistedWindowState[];
  boosts: BoostRule[];
  history: HistoryEntry[];
  archivedTabs: ArchivedTab[];
  closedTabs: ClosedTabItem[];
  zoomByHost: Record<string, number>;
  readerOptions: ReaderOptions;
  sidebarOpen: boolean;
  sidebarCollapsed: boolean;
  hoverPeek: boolean;
  sidebarWidth: number;
  adBlockEnabled: boolean;
  shields: PersistedShieldsSettings;
  httpsOnly: boolean;
  cleanCopyUrl: boolean;
  sitePermissions: SitePermissionDecision[];
  airTrafficRules: AirTrafficRule[];
  searchEngine: SearchEngineId;
  updateFeedUrl: string;
  autoPictureInPicture: boolean;
  memorySaverTimeout: MemorySaverTimeout;
  memorySaverExemptPinned: boolean;
  newTabConfig: NewTabConfig;
}

export interface KinexStateSnapshot extends PersistedKinexData {
  extensions: ExtensionViewModel[];
  reducedEffects: boolean;
  sidebarPeeking: boolean;
  overlayGeneration: number;
  overlay: OverlayState;
  downloads: DownloadItem[];
  blockedRequestsCount: number;
  shieldsRuntime: ShieldsRuntimeSnapshot;
  zapperActiveTabId: string | null;
  toastMessage: string | null;
  isDefaultBrowser: boolean;
  appVersion: string;
  updateStatus: UpdateStatus;
  findStatus: FindInPageStatus | null;
  duplicatePrompt: DuplicateTabPrompt | null;
  readerTabIds: string[];
}

/** @deprecated Use PersistedKinexData */
export type PersistedNookData = PersistedKinexData;
/** @deprecated Use KinexStateSnapshot */
export type NookStateSnapshot = KinexStateSnapshot;

export type CommandBarItemKind =
  | 'open-tab'
  | 'pinned-tab'
  | 'favorite'
  | 'history'
  | 'domain'
  | 'search'
  | 'action'
  | 'settings'
  | 'calculation';

export interface CommandBarResult {
  id: string;
  kind: CommandBarItemKind;
  title: string;
  subtitle: string;
  url?: string;
  tabId?: string;
  spaceId?: string;
  spaceLabel?: string;
  settingsSection?: SettingsSection;
  isSleeping?: boolean;
  copyText?: string;
  isAlreadyOpen?: boolean;
  actionId?: CommandId;
  intent?: KinexIntent;
  shortcut?: string;
  favicon?: string;
}

export type FocusRegion = 'content' | 'sidebar' | 'toolbar';
export type FocusRequest = FocusRegion | 'restore' | 'address';

export type KinexIntent =
  | { type: 'run-command'; commandId: CommandId }
  | { type: 'focus-region'; region: FocusRegion }
  | { type: 'select-space'; spaceId: string }
  | { type: 'create-space'; name: string; icon: string; theme: SpaceTheme; profilePartition?: string }
  | { type: 'update-space'; spaceId: string; name: string; icon: string; theme: SpaceTheme; profilePartition?: string }
  | { type: 'rename-space'; spaceId: string; name: string }
  | { type: 'reorder-space'; sourceSpaceId: string; targetSpaceId: string }
  | { type: 'delete-space'; spaceId: string }
  | { type: 'create-profile'; name: string }
  | { type: 'create-folder'; spaceId: string; name: string }
  | { type: 'toggle-folder'; folderId: string }
  | { type: 'rename-folder'; folderId: string; name: string }
  | { type: 'delete-folder'; folderId: string }
  | { type: 'move-tab-to-folder'; tabId: string; folderId?: string }
  | { type: 'move-tab-to-space'; tabId: string; spaceId: string }
  | { type: 'reorder-tab'; sourceTabId: string; targetTabId: string }
  | { type: 'copy-text'; text: string }
  | { type: 'select-tab'; tabId: string; paneIndex?: number }
  | { type: 'duplicate-tab'; tabId: string }
  | {
      type: 'open-url';
      url: string;
      target: 'current' | 'new-tab' | 'new-tab-background' | 'split' | 'little-kinex' | 'little-nook';
      spaceId?: string;
      duplicatePolicy?: 'prompt' | 'allow';
    }
  | { type: 'resolve-duplicate-open'; decision: 'switch-existing' | 'open-anyway' | 'cancel' }
  | { type: 'close-tab'; tabId: string }
  | { type: 'close-other-tabs'; tabId: string }
  | { type: 'close-tabs-to-right'; tabId: string }
  | { type: 'reopen-closed-tab'; closedId?: string }
  | { type: 'restore-closed-group'; groupId: string }
  | { type: 'clear-closed-tabs' }
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
  | { type: 'toggle-sidebar-collapse'; collapsed?: boolean }
  | { type: 'set-hover-peek'; enabled: boolean }
  | { type: 'set-sidebar-peeking'; peeking: boolean }
  | { type: 'set-sidebar-width'; width: number }
  | { type: 'set-overlay'; overlay: OverlayState }
  | { type: 'set-search-engine'; engine: SearchEngineId }
  | { type: 'set-https-only'; enabled: boolean }
  | { type: 'set-clean-copy-url'; enabled: boolean }
  | { type: 'revoke-site-permission'; partition: string; origin: string; permission: string }
  | { type: 'save-air-traffic-rule'; rule: AirTrafficRule }
  | { type: 'delete-air-traffic-rule'; ruleId: string }
  | { type: 'clear-browsing-data'; scopes: Array<'history' | 'cookies' | 'cache' | 'archived'> }
  | { type: 'save-boost'; boost: BoostRule }
  | { type: 'delete-boost'; boostId: string }
  | { type: 'toggle-boost-enabled'; boostId: string }
  | { type: 'start-zapper' }
  | { type: 'stop-zapper' }
  | { type: 'toggle-adblock' }
  | { type: 'set-shields-global-mode'; mode: ShieldsMode }
  | { type: 'set-shields-site-mode'; domain: string; mode: ShieldsMode | 'inherit' }
  | { type: 'set-shields-strip-params'; enabled: boolean }
  | { type: 'set-shields-cosmetic-enabled'; enabled: boolean }
  | { type: 'toggle-filter-list'; listId: string; enabled: boolean }
  | { type: 'update-filter-lists' }
  | { type: 'restore-default-filter-lists' }
  | { type: 'add-shields-cosmetic-rule'; domain: string; selector: string }
  | { type: 'remove-shields-cosmetic-rule'; domain: string; selector: string }
  | { type: 'start-element-picker' }
  | { type: 'stop-element-picker' }
  | { type: 'copy-current-url'; tabId?: string }
  | { type: 'open-devtools' }
  | { type: 'print-page' }
  | { type: 'save-page-pdf' }
  | { type: 'toggle-reader-mode'; tabId?: string }
  | { type: 'set-reader-options'; options: Partial<ReaderOptions> }
  | { type: 'open-incognito'; url?: string }
  | { type: 'find-in-page'; text: string; forward?: boolean; findNext?: boolean }
  | { type: 'stop-find-in-page' }
  | { type: 'promote-little-nook'; url: string; title: string }
  | { type: 'import-browser-data'; source: 'arc' | 'chrome' | 'file' }
  | { type: 'set-default-browser' }
  | { type: 'show-download-in-finder'; savePath: string }
  | { type: 'pause-download'; downloadId: string }
  | { type: 'resume-download'; downloadId: string }
  | { type: 'cancel-download'; downloadId: string }
  | { type: 'open-download'; downloadId: string }
  | { type: 'clear-completed-downloads' }
  | { type: 'set-update-feed-url'; url: string }
  | { type: 'check-for-updates' }
  | { type: 'download-update' }
  | { type: 'install-update' }
  | { type: 'open-update-release' }
  | { type: 'set-auto-picture-in-picture'; enabled: boolean }
  | { type: 'set-memory-saver-timeout'; timeout: MemorySaverTimeout }
  | { type: 'set-memory-saver-exempt-pinned'; exempt: boolean }
  | { type: 'discard-tab'; tabId: string }
  | { type: 'set-new-tab-config'; config: Partial<NewTabConfig> }
  | { type: 'install-extension'; sourcePath: string }
  | { type: 'install-extension-crx'; sourcePath: string }
  | { type: 'install-extension-webstore'; url: string; consent: boolean }
  | { type: 'uninstall-extension'; extensionId: string }
  | { type: 'set-extension-enabled'; extensionId: string; enabled: boolean; consent?: boolean }
  | { type: 'open-extension-popup'; extensionId: string; anchor?: { x: number; y: number; width: number; height: number } }
  | { type: 'close-extension-popup' };

export type LittleKinexAction = 'back' | 'forward' | 'reload' | 'navigate' | 'promote' | 'close' | 'focus-content';

export interface LittleKinexInfo {
  url: string;
  title: string;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  isPrivate?: boolean;
  securityState?: SecurityState;
}

/** Aggregated, privacy-safe performance counters for `kinex://performance`. */
export interface ShieldsBlockCounts {
  ads: number;
  trackers: number;
  other: number;
  total: number;
}

export interface PerformanceSnapshot {
  tabCount: number;
  activeViewCount: number;
  sleepingTabCount: number;
  estimatedSleepingMemorySavedBytes: number;
  shieldsBlocked: ShieldsBlockCounts;
  shieldsBlockedTotal: number;
  capturedAt: number;
}

/** Sanitized, passphrase-encrypted sync envelope payload. */
export interface SyncSnapshot {
  format: 'kinex-sync';
  version: number;
  exportedAt: number;
  data: Record<string, unknown>;
}

export interface BackupResult {
  filename: string;
  primaryPath: string;
  icloudPath?: string;
  removed: string[];
  icloudRemoved: string[];
}

export interface KinexAPI {
  getState: () => Promise<KinexStateSnapshot>;
  dispatch: (intent: KinexIntent) => Promise<void>;
  getPerformanceSnapshot: () => Promise<PerformanceSnapshot>;
  syncExport: (passphrase: string) => Promise<{ filePath: string; snapshot: SyncSnapshot } | null>;
  syncImport: (passphrase: string) => Promise<SyncSnapshot | null>;
  syncBackup: (passphrase: string) => Promise<BackupResult | null>;
  onFocusRequested: (listener: (region: FocusRequest) => void) => () => void;
  onStateUpdated: (listener: (state: KinexStateSnapshot) => void) => () => void;
  showTabContextMenu: (tabId: string) => Promise<void>;
  pickExtensionFolder: () => Promise<string | null>;
  pickExtensionCrx: () => Promise<string | null>;
  getLittleKinexInfo: () => Promise<LittleKinexInfo>;
  onLittleKinexUpdated: (listener: (info: LittleKinexInfo) => void) => () => void;
  littleKinexAction: (action: LittleKinexAction, url?: string) => Promise<void>;
}

/** @deprecated Use KinexIntent */
export type NookIntent = KinexIntent;
/** @deprecated Use KinexAPI */
export type NookAPI = KinexAPI;
