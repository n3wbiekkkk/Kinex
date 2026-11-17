import { matchShortcut, type CommandId } from '../shared/commands';
import fs from 'node:fs';
import { app, BrowserWindow, clipboard, dialog, Menu, type Session, type WebContents, webContents, systemPreferences, powerMonitor, WebContentsView } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  clearTodayTabsForSpace,
  closeOrResetTab,
  closeOtherTabsForSpace,
  closeTabsToRightForSpace,
  extractHostname,
  findDuplicateOpenTab,
  getActiveSplit,
  getFocusedTab,
  moveTabToSpace,
  normalizeNavigationInput,
  normalizeShieldsSiteKey,
  reorderSpaces,
  reorderTabs,
  restoreClosedTabs,
  SEARCH_ENGINES,
  setTabLocation,
} from '../shared/domain';
import type {
  DuplicateTabPrompt,
  FocusRegion,
  FindInPageStatus,
  KinexIntent,
  KinexStateSnapshot,
  LittleKinexAction,
  LittleKinexInfo,
  OverlayState,
  PersistedKinexData,
  PersistedWindowState,
  TabItem,
  UpdateStatus,
  Space,
} from '../shared/types';
import { extractArticleFromWebContents, renderReaderHtml, type ReaderDocument } from './readerMode';
import { buildAndInstallApplicationMenu } from './appMenu';
import { AuxiliaryWindowManager } from './auxiliaryWindows';
import { DownloadManager } from './downloadManager';
import { runBrowserImport } from './importController';
import { TrustedIpcRegistry } from './ipcValidation';
import { evaluateDiscardEligibility, MEMORY_SAVER_TIMEOUT_MS } from './memorySaver';
import { NavigationManager } from './navigationManager';
import { PermissionManager } from './permissionManager';
import type { NewTabRenderContext } from './internalPages';
import { KinexPersistence } from './persistence';
import {
  classifySecurityState,
  matchAirTrafficSpace,
  stripTrackingParams,
} from './security';
import {
  registerDefaultAppProtocols,
  registerKinexProtocolOnSession,
  SessionManager,
} from './sessionManager';
import { runShieldsElementPicker, ShieldsCosmeticInjector, stopShieldsElementPicker } from './shields/cosmetics';
import { KinexShieldsCoordinator } from './shields/coordinator';
import { KinexShieldsEngine } from './shields/engine';
import { TabManager } from './tabManager';
import { KinexAutoUpdater } from './updater';
import { ViewLayoutManager } from './viewLayoutManager';
import { WindowSessionRegistry } from './windowRegistry';

export function ensureAppName(): void {
  if (app.getName() !== 'Kinex') {
    app.setName('Kinex');
  }
}

interface BrowserWindowContext {
  state: PersistedWindowState;
  win: BrowserWindow;
  shellView: WebContentsView;
  overlayView: WebContentsView | null;
  overlay: OverlayState;
  duplicatePrompt: DuplicateTabPrompt | null;
  htmlFullscreenTabId: string | null;
  overlayOrigin: 'shell' | 'content';
  shellRegion: FocusRegion;
  focusOnWindowActivation: boolean;
  overlayClosing: boolean;
  overlayCloseTimer: NodeJS.Timeout | null;
}

export class KinexWindowManager {
  private readonly persistence: KinexPersistence;
  private persisted: PersistedKinexData;
  private overlay: OverlayState = { mode: 'none' };
  private overlayGeneration = 0;
  private toastMessage: string | null = null;
  private updateStatus: UpdateStatus = { state: 'idle' };
  private startupUrl: string | undefined;
  private disposed = false;
  private cachedIsDefaultBrowser = false;
  private lastDefaultCheckAt = 0;
  private isWindowOccluded = false;
  private overlayNeedsCloseSync = false;
  private findStatus: FindInPageStatus | null = null;
  private duplicatePrompt: DuplicateTabPrompt | null = null;
  private readonly findQueryByTabId = new Map<string, string>();
  private readonly readerDocsByTabId = new Map<string, ReaderDocument>();
  private readonly tabIdByWcId = new Map<number, string>();
  private readonly needsReloadByTabId = new Set<string>();
  private updatingShieldsLists = false;
  private pickerActiveTabId: string | null = null;

  private speedLimited = false;
  private thermalLimited = false;
  private readonly onSpeedLimit = ({ limit }: { limit: number }) => {
    this.speedLimited = limit < 100;
    this.scheduleBroadcast();
  };
  private readonly onThermalState = ({ state }: { state: string }) => {
    this.thermalLimited = state === 'serious' || state === 'critical';
    this.scheduleBroadcast();
  };
  private overlayOrigin: 'shell' | 'content' = 'content';
  private shellRegion: FocusRegion = 'sidebar';
  private overlayClosing = false;
  private overlayCloseTimer: NodeJS.Timeout | null = null;
  private htmlFullscreenTabId: string | null = null;
  private enforcingOverlayFocus = false;
  private pendingFocus: { target: () => WebContents | null; remaining: number } | null = null;
  private focusRetryTimer: NodeJS.Timeout | null = null;
  private focusOnWindowActivation = false;
  private overlayFocusRedirects = 0;

  private mainWindow: BrowserWindow | null = null;
  private shellView: WebContentsView | null = null;
  private overlayView: WebContentsView | null = null;

  private toastTimer: NodeJS.Timeout | null = null;
  private broadcastTimer: NodeJS.Timeout | null = null;
  private memorySaverTimer: NodeJS.Timeout | null = null;
  private startupUpdateTimer: NodeJS.Timeout | null = null;
  private periodicUpdateTimer: NodeJS.Timeout | null = null;

  public readonly ipcRegistry = new TrustedIpcRegistry();
  private readonly permissionManager: PermissionManager;
  private readonly downloadManager: DownloadManager;
  private readonly shieldsEngine: KinexShieldsEngine;
  private readonly shieldsCosmetics: ShieldsCosmeticInjector;
  private readonly shieldsCoordinator: KinexShieldsCoordinator;
  private readonly sessionManager: SessionManager;
  private readonly navigationManager: NavigationManager;
  private readonly tabManager: TabManager;
  private readonly layoutManager = new ViewLayoutManager();
  private readonly windowRegistry = new WindowSessionRegistry();
  private readonly contexts = new Map<string, BrowserWindowContext>();
  private readonly windowIdBySenderId = new Map<number, string>();
  private readonly tabOwnerByTabId = new Map<string, string>();
  private currentWindowId = 'window-default';
  private restoredAtStartup = false;
  private runtimeListenersActive = false;
  private readonly auxiliaryWindows: AuxiliaryWindowManager;
  private readonly updater: KinexAutoUpdater;

  constructor(
    userDataDir: string,
    private readonly devServerUrl?: string
  ) {
    this.persistence = new KinexPersistence(userDataDir);
    this.persisted = this.persistence.load();

    const distHtmlUrl = pathToFileURL(path.join(__dirname, '../../dist/index.html')).toString();
    this.ipcRegistry.addAllowedBaseUrl(this.devServerUrl || distHtmlUrl);

    this.permissionManager = new PermissionManager({
      getMainWindow: () => this.mainWindow,
      getDecisions: () => this.persisted.sitePermissions,
      recordDecision: (partition, origin, permission, decision) => {
        const filtered = this.persisted.sitePermissions.filter(
          (p) => !(p.partition === partition && p.origin === origin && p.permission === permission)
        );
        this.persisted = {
          ...this.persisted,
          sitePermissions: [...filtered, { partition, origin, permission, decision, updatedAt: Date.now() }],
        };
        this.persistAndBroadcast();
      },
      revokeDecision: (partition, origin, permission) => {
        this.persisted = {
          ...this.persisted,
          sitePermissions: this.persisted.sitePermissions.filter(
            (p) => !(p.partition === partition && p.origin === origin && p.permission === permission)
          ),
        };
        this.persistAndBroadcast();
      },
    });

    this.downloadManager = new DownloadManager(() => {
      if (!this.disposed) this.scheduleBroadcast();
    });

    this.shieldsEngine = new KinexShieldsEngine(userDataDir, this.persisted.shields);
    if (this.shieldsEngine.hasWarmCache()) {
      const { updatedLists } = this.shieldsEngine.initializeSync();
      this.persisted = {
        ...this.persisted,
        shields: { ...this.persisted.shields, filterLists: updatedLists },
        adBlockEnabled: this.persisted.shields.globalMode !== 'disabled',
      };
    } else {
      void this.shieldsEngine.initialize().then(({ updatedLists }) => {
        if (this.disposed) return;
        this.persisted = {
          ...this.persisted,
          shields: { ...this.persisted.shields, filterLists: updatedLists },
          adBlockEnabled: this.persisted.shields.globalMode !== 'disabled',
        };
        this.persistence.scheduleSave(this.persisted);
        this.applyCosmeticsToVisibleTabs();
        this.scheduleBroadcast();
      });
    }
    this.shieldsCosmetics = new ShieldsCosmeticInjector(this.shieldsEngine);
    this.shieldsCoordinator = new KinexShieldsCoordinator(this.shieldsEngine, {
      resolveTabIdByWebContentsId: (wcId) => this.tabIdByWcId.get(wcId),
      isPrivateWebContents: (wcId) => this.auxiliaryWindows.isPrivateWebContents(wcId),
      onStatsChanged: () => {
        if (!this.disposed) this.scheduleBroadcast();
      },
    });

    this.sessionManager = new SessionManager(
      this.permissionManager,
      this.downloadManager,
      this.shieldsCoordinator,
      () => this.buildNewTabContext()
    );

    this.navigationManager = new NavigationManager({
      getDialogParentWindow: () => BrowserWindow.getFocusedWindow() ?? this.mainWindow,
      isHttpsOnly: () => this.persisted.httpsOnly,
      onBlockedNavigation: (rawUrl, reason) => {
        this.showToast(`${reason}: ${rawUrl.slice(0, 60)}`);
      },
    });

    this.tabManager = new TabManager(
      {
        getMainWindow: () => this.mainWindow,
        onWebContentsCreated: (wc) => {
          this.attachKeyboard(wc);
          this.attachOverlayFocusGuard(wc);
          this.attachShieldsCleanup(wc);
        },
        onTabWebContentsCreated: (tabId, wc) => {
          this.tabIdByWcId.set(wc.id, tabId);
        },
        onTabWebContentsDestroyed: (wcId) => {
          this.tabIdByWcId.delete(wcId);
        },
        onApplyShieldsCosmetics: (wc, url) => this.shieldsCosmetics.applyForWebContents(wc, url),
        getTabById: (tabId) => this.persisted.tabs.find((t) => t.id === tabId),
        updateTab: (tabId, patch, persist = false) => {
          const patchKeys = Object.keys(patch) as Array<keyof TabItem>;
          let changed = false;
          this.persisted = {
            ...this.persisted,
            tabs: this.persisted.tabs.map((t) => {
              if (t.id !== tabId) return t;
              const hasDiff = patchKeys.some((k) => t[k] !== patch[k]);
              if (!hasDiff) return t;
              changed = true;
              return { ...t, ...patch };
            }),
          };
          if (!changed || this.disposed) return;
          if ('isAudible' in patch) {
            this.syncBackgroundThrottling();
          }
          if ('zoomFactor' in patch && getFocusedTab(this.persisted)?.id === tabId) this.layoutViews();
          if (persist) {
            this.persistAndBroadcast(false);
          } else {
            this.scheduleBroadcast();
          }
        },
        getSessionForTab: (tab) => this.getSessionForSpace(tab.spaceId),
        getPartitionForTab: (tab) => this.getPartitionForSpace(tab.spaceId),
        getBoosts: () => this.persisted.boosts,
        getZoomForUrl: (url) => {
          const host = extractHostname(url);
          return host ? this.persisted.zoomByHost[host] : undefined;
        },
        onNavigationFinished: (tabId, url, title) => {
          this.needsReloadByTabId.delete(tabId);
          if (!url.startsWith('kinex://reader')) {
            this.readerDocsByTabId.delete(tabId);
          }
          this.recordHistory(url, title);
          this.layoutViews();
          this.persistAndBroadcast(false);
          this.syncBackgroundThrottling();
        },
        onFoundInPage: (tabId, result) => {
          const query = this.findQueryByTabId.get(tabId) ?? '';
          this.findStatus = query
            ? {
                tabId,
                query,
                activeMatchOrdinal: result.activeMatchOrdinal,
                matches: result.matches,
              }
            : null;
          this.scheduleBroadcast();
        },
        onPageContextAction: (action) => {
          if (action.type === 'open-link') {
            if (action.target === 'private') {
              this.auxiliaryWindows.openPrivateWindow(action.url);
            } else {
              this.openUrl(action.url, action.target, action.spaceId);
            }
          } else if (action.type === 'find') {
            void this.handleIntent({ type: 'set-overlay', overlay: { mode: 'find' } });
          } else if (action.type === 'print') {
            void this.handleIntent({ type: 'print-page' });
          } else if (action.type === 'save-pdf') {
            void this.handleIntent({ type: 'save-page-pdf' });
          } else if (action.type === 'toggle-reader') {
            void this.handleIntent({ type: 'toggle-reader-mode', tabId: action.tabId });
          }
        },
        onOpenPopupInTab: (sourceTabId, url, disposition) => {
          const sourceTab = this.persisted.tabs.find((t) => t.id === sourceTabId);
          this.openUrl(
            url,
            disposition === 'background' ? 'new-tab-background' : 'new-tab',
            sourceTab?.spaceId
          );
        },
        onSpaceMismatchCheck: (tabId, url) => this.handleAirTrafficRouting(tabId, url),
        onHtmlFullscreenChanged: (tabId, isFullscreen) => {
          if (this.disposed) return;
          const tab = this.persisted.tabs.find((item) => item.id === tabId);
          const fullscreenContext = [...this.contexts.values()].find((context) => context.state.spaceId === tab?.spaceId);
          if (fullscreenContext) fullscreenContext.htmlFullscreenTabId = isFullscreen ? tabId : null;
          if (isFullscreen) {
            this.htmlFullscreenTabId = tabId;
            this.layoutViews();
          } else if (this.htmlFullscreenTabId === tabId) {
            this.htmlFullscreenTabId = null;
            this.layoutViews();
          }
        },
        onStateChanged: () => this.scheduleBroadcast(),
        onShowToast: (msg) => this.showToast(msg),
      },
      this.navigationManager
    );

    this.auxiliaryWindows = new AuxiliaryWindowManager(
      {
        getRendererUrl: (view) => this.getRendererUrl(view),
        onWebContentsCreated: (wc) => {
          this.attachKeyboard(wc);
          this.attachShieldsCleanup(wc);
        },
        onApplyShieldsCosmetics: (wc, url) => this.shieldsCosmetics.applyForWebContents(wc, url),
        getSearchEngine: () => this.persisted.searchEngine,
        getRegularSessionForActiveSpace: () => this.getSessionForSpace(this.persisted.activeSpaceId),
        onPromoteUrl: (url, _title) => {
          this.openUrl(url, 'new-tab');
          this.mainWindow?.focus();
        },
      },
      this.ipcRegistry,
      this.sessionManager,
      this.navigationManager
    );

    this.updater = new KinexAutoUpdater(
      () => this.persisted.updateFeedUrl,
      (status) => {
        this.updateStatus = status;
        if (!this.disposed) {
          this.broadcastState();
        }
      }
    );
  }

  private attachShieldsCleanup(wc: WebContents): void {
    const wcId = wc.id;
    wc.once('destroyed', () => {
      this.shieldsCoordinator.clearWebContentsTracking(wcId);
      this.shieldsCosmetics.forgetWebContents(wcId);
    });
  }

  setStartupUrl(rawUrl?: string): void {
    this.startupUrl = rawUrl;
  }

  hasWindow(): boolean {
    return [...this.contexts.values()].some((context) => !context.win.isDestroyed());
  }

  getWindowCount(): number {
    return [...this.contexts.values()].filter((context) => !context.win.isDestroyed()).length;
  }

  private getActiveContext(): BrowserWindowContext | null {
    return this.contexts.get(this.currentWindowId) ?? null;
  }

  private saveActiveContext(): void {
    const context = this.contexts.get(this.currentWindowId);
    if (!context) return;
    context.overlay = this.overlay;
    context.duplicatePrompt = this.duplicatePrompt;
    context.htmlFullscreenTabId = this.htmlFullscreenTabId;
    context.overlayOrigin = this.overlayOrigin;
    context.shellRegion = this.shellRegion;
    context.focusOnWindowActivation = this.focusOnWindowActivation;
    context.overlayClosing = this.overlayClosing;
    context.overlayCloseTimer = this.overlayCloseTimer;
    context.overlayView = this.overlayView;
    if (this.shellView) context.shellView = this.shellView;
    if (this.mainWindow && !this.mainWindow.isDestroyed()) context.win = this.mainWindow;
  }

  private activateContext(id: string): void {
    if (this.currentWindowId === id && this.mainWindow && !this.mainWindow.isDestroyed()) return;
    this.saveActiveContext();
    const context = this.contexts.get(id);
    if (!context || context.win.isDestroyed()) return;
    this.cancelPendingFocus();
    for (const [tabId] of this.tabManager.getAllViews()) {
      if (this.tabOwnerByTabId.get(tabId) !== id) {
        this.tabManager.destroyTabView(tabId);
        this.tabOwnerByTabId.delete(tabId);
      }
    }
    this.currentWindowId = id;
    this.mainWindow = context.win;
    this.shellView = context.shellView;
    this.overlayView = context.overlayView;
    this.overlay = context.overlay;
    this.duplicatePrompt = context.duplicatePrompt;
    this.htmlFullscreenTabId = context.htmlFullscreenTabId;
    this.overlayOrigin = context.overlayOrigin;
    this.shellRegion = context.shellRegion;
    this.overlayClosing = context.overlayClosing;
    this.overlayCloseTimer = context.overlayCloseTimer;
    this.focusOnWindowActivation = context.focusOnWindowActivation;
    this.persisted = { ...this.persisted, activeSpaceId: context.state.spaceId };
    this.ensureActiveViewsLoaded();
    this.layoutViews();
  }

  private contextForSender(senderId?: number): BrowserWindowContext | null {
    if (senderId !== undefined) {
      const id = this.windowIdBySenderId.get(senderId);
      if (id && id !== this.currentWindowId) this.activateContext(id);
    }
    return this.getActiveContext();
  }

  private claimedSpaceIds(): Set<string> {
    return new Set([...this.contexts.values()].map((context) => context.state.spaceId));
  }

  focusMainWindow(): void {
    const context = this.getActiveContext() ?? [...this.contexts.values()][0];
    if (!context || context.win.isDestroyed()) return;
    this.activateContext(context.state.id);
    if (context.win.isMinimized()) context.win.restore();
    context.win.show();
    context.win.focus();
  }

  getPersistenceFilePath(): string {
    return this.persistence.getStateFilePath();
  }

  getMetricsSnapshot(): {
    tabCount: number;
    activeViewCount: number;
    privateWindowCount: number;
    hasLittleWindow: boolean;
    memory: NodeJS.MemoryUsage;
  } {
    return {
      tabCount: this.persisted.tabs.length,
      activeViewCount: this.tabManager.getActiveViewCount(),
      privateWindowCount: this.auxiliaryWindows.getPrivateWindowCount(),
      hasLittleWindow: this.auxiliaryWindows.hasLittleWindow(),
      memory: process.memoryUsage(),
    };
  }

  createWindow(): BrowserWindow {
    if (this.hasWindow()) {
      this.focusMainWindow();
      return this.mainWindow!;
    }

    this.startRuntime();
    const states = this.persisted.windows.length > 0
      ? this.persisted.windows.slice(0, 16)
      : [this.defaultWindowState()];
    if (!this.restoredAtStartup) {
      this.restoredAtStartup = true;
      for (const state of states) this.createWindowForState(state, state.isFocused);
      this.activateContext(states.find((state) => state.isFocused)?.id ?? states[0].id);
    } else {
      this.createWindowForState(states[0], true);
    }
    return this.mainWindow!;
  }

  private defaultWindowState(): PersistedWindowState {
    return {
      id: 'window-default',
      bounds: { x: 100, y: 80, width: 1380, height: 880 },
      isMaximized: false,
      spaceId: this.persisted.activeSpaceId,
      isFocused: true,
    };
  }

  private startRuntime(): void {
    if (this.runtimeListenersActive) return;
    this.runtimeListenersActive = true;
    this.disposed = false;
    this.onThermalState({ state: powerMonitor.getCurrentThermalState() });
    powerMonitor.on('speed-limit-change', this.onSpeedLimit);
    powerMonitor.on('thermal-state-change', this.onThermalState);
    this.tabManager.resetForNewWindow();
    this.auxiliaryWindows.resetForNewWindow();
    this.downloadManager.resetForNewWindow();

    this.memorySaverTimer = setInterval(() => {
      if (!this.disposed) void this.runMemorySaverSweep();
    }, 60_000);
    this.memorySaverTimer.unref?.();

    if (!process.env.KINEX_DISABLE_AUTO_UPDATER) {
      this.startupUpdateTimer = setTimeout(() => {
        if (!this.disposed) void this.updater.checkForUpdates(true);
      }, 8000);
      this.periodicUpdateTimer = setInterval(() => {
        if (!this.disposed) void this.updater.checkForUpdates(true);
      }, 4 * 60 * 60 * 1000);
    }
  }

  private allocateSpaceForWindow(): Space {
    const claimed = this.claimedSpaceIds();
    const free = this.persisted.spaces.find((space) => !claimed.has(space.id));
    if (free) return free;

    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const id = `space-window-${suffix}`;
    const partition = `persist:kinex-window-${suffix}`;
    const welcomeTab: TabItem = {
      id: `tab-${suffix}-w`,
      spaceId: id,
      location: 'unpinned',
      url: 'kinex://newtab',
      title: 'New Tab — Kinex',
      isLoading: false,
      canGoBack: false,
      canGoForward: false,
      isMuted: false,
      isAudible: false,
      securityState: 'internal',
      lastActiveAt: Date.now(),
    };
    this.persisted = {
      ...this.persisted,
      spaces: [...this.persisted.spaces, {
        id,
        name: `Space ${this.persisted.spaces.length + 1}`,
        icon: '✦',
        theme: { ...this.persisted.spaces[0].theme },
        profilePartition: partition,
      }],
      profiles: [...this.persisted.profiles, { id: `prof-${id}`, name: `Window ${this.persisted.spaces.length + 1}`, partition }],
      tabs: [...this.persisted.tabs, welcomeTab],
      splitsBySpace: { ...this.persisted.splitsBySpace, [id]: { tabIds: [welcomeTab.id], focusedIndex: 0, splitRatio: 0.5 } },
    };
    return this.persisted.spaces.find((space) => space.id === id)!;
  }

  private createWindowForState(rawState: PersistedWindowState, isFocused = false): BrowserWindowContext {
    const claimed = this.claimedSpaceIds();
    const spaceId =
      rawState.spaceId && this.persisted.spaces.some((space) => space.id === rawState.spaceId) && !claimed.has(rawState.spaceId)
        ? rawState.spaceId
        : this.allocateSpaceForWindow().id;
    const state: PersistedWindowState = { ...rawState, spaceId, isFocused: isFocused || this.contexts.size === 0 };
    const exists = this.persisted.windows.some((window) => window.id === state.id);
    this.persisted = {
      ...this.persisted,
      windows: exists
        ? this.persisted.windows.map((window) => window.id === state.id ? state : window)
        : [...this.persisted.windows, state],
    };

    const id = state.id;
    const win = new BrowserWindow({
      x: state.bounds.x,
      y: state.bounds.y,
      width: state.bounds.width,
      height: state.bounds.height,
      minWidth: 880,
      minHeight: 580,
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 16, y: 16 },
      vibrancy: 'under-window',
      visualEffectState: 'active',
      backgroundColor: '#00000000',
      transparent: process.platform === 'darwin',
      show: false,
      title: 'Kinex',
    });
    if (state.isMaximized) win.maximize();
    this.windowRegistry.register(id, win, state);

    const shellView = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, '../preload/shell.js'),
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        nodeIntegrationInSubFrames: false,
        webviewTag: false,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        navigateOnDragDrop: false,
      },
    });
    shellView.setBackgroundColor('#00000000');
    win.contentView.addChildView(shellView);
    this.ipcRegistry.register(shellView.webContents.id, 'shell');
    this.windowIdBySenderId.set(shellView.webContents.id, id);
    this.hardenInternalView(shellView, 'shell');
    this.attachKeyboard(shellView.webContents);
    this.attachOverlayFocusGuard(shellView.webContents);

    const context: BrowserWindowContext = {
      state,
      win,
      shellView,
      overlayView: null,
      overlay: { mode: 'none' },
      duplicatePrompt: null,
      htmlFullscreenTabId: null,
      overlayOrigin: 'content',
      shellRegion: 'sidebar',
      focusOnWindowActivation: false,
      overlayClosing: false,
      overlayCloseTimer: null,
    };
    this.contexts.set(id, context);
    this.activateContext(id);

    void shellView.webContents.loadURL(this.getRendererUrl('shell'));
    this.ensureActiveViewsLoaded();
    this.layoutViews();
    this.syncBackgroundThrottling();

    let presented = false;
    const presentWindow = () => {
      if (presented || win.isDestroyed()) return;
      presented = true;
      this.activateContext(id);
      win.show();
      context.focusOnWindowActivation = true;
      this.focusOnWindowActivation = true;
      this.requestNativeFocus(() => this.getFocusedTabWebContents(), 8);
      this.installApplicationMenu();
      setTimeout(() => {
        if (!this.disposed) this.refreshDefaultBrowserFlag(false);
      }, 1500).unref?.();
      if (this.startupUrl) {
        this.openUrl(this.startupUrl, 'new-tab');
        this.startupUrl = undefined;
      }
    };
    win.once('ready-to-show', presentWindow);
    shellView.webContents.once('did-finish-load', presentWindow);

    win.on('resize', () => {
      this.layoutContext(context);
      this.syncWindowGeometry(id);
    });
    win.on('move', () => this.syncWindowGeometry(id));
    win.on('maximize', () => this.syncWindowGeometry(id));
    win.on('unmaximize', () => this.syncWindowGeometry(id));
    win.on('close', () => this.syncWindowGeometry(id));
    win.on('enter-full-screen', () => this.layoutContext(context));
    win.on('leave-full-screen', () => {
      context.htmlFullscreenTabId = null;
      if (this.currentWindowId === id) this.htmlFullscreenTabId = null;
      this.layoutContext(context);
    });
    win.on('minimize', () => {
      this.isWindowOccluded = true;
      this.syncBackgroundThrottling();
    });
    win.on('hide', () => {
      this.isWindowOccluded = true;
      this.syncBackgroundThrottling();
    });
    win.on('restore', () => {
      this.isWindowOccluded = false;
      this.syncBackgroundThrottling();
    });
    win.on('show', () => {
      this.isWindowOccluded = false;
      this.syncBackgroundThrottling();
    });
    win.on('focus', () => {
      this.activateContext(id);
      if (this.isWindowOccluded) {
        this.isWindowOccluded = false;
        this.syncBackgroundThrottling();
      }
      if (context.focusOnWindowActivation) {
        context.focusOnWindowActivation = false;
        this.focusOnWindowActivation = false;
        this.requestNativeFocus(() => this.getFocusedTabWebContents(), 4);
      }
      this.syncWindowState();
      this.persistence.scheduleSave(this.persisted);
    });
    win.on('closed', () => this.closeWindowContext(id));

    return context;
  }

  private openNewWindow(): void {
    if (this.disposed) return;
    const space = this.allocateSpaceForWindow();
    const bounds = this.defaultWindowState().bounds;
    const offset = (this.contexts.size % 4) * 28;
    const state: PersistedWindowState = {
      id: `window-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      bounds: { ...bounds, x: bounds.x + offset, y: bounds.y + offset },
      isMaximized: false,
      spaceId: space.id,
      isFocused: true,
    };
    for (const existing of this.persisted.windows) {
      this.windowRegistry.update(existing.id, { isFocused: false });
      const existingContext = this.contexts.get(existing.id);
      if (existingContext) existingContext.state = { ...existingContext.state, isFocused: false };
    }
    this.persisted = {
      ...this.persisted,
      windows: [...this.persisted.windows.map((window) => ({ ...window, isFocused: false })), state],
    };
    const context = this.createWindowForState(state, true);
    this.activateContext(context.state.id);
    this.persistAndBroadcast();
  }

  private closeWindowContext(id: string): void {
    const context = this.contexts.get(id);
    if (!context) return;
    if (context.overlayCloseTimer) clearTimeout(context.overlayCloseTimer);
    const shellId = context.shellView.webContents.id;
    this.ipcRegistry.unregister(shellId);
    this.windowIdBySenderId.delete(shellId);
    if (context.overlayView && !context.overlayView.webContents.isDestroyed()) {
      const overlayId = context.overlayView.webContents.id;
      this.ipcRegistry.unregister(overlayId);
      this.windowIdBySenderId.delete(overlayId);
      context.overlayView.webContents.close();
    }
    this.contexts.delete(id);
    this.windowRegistry.unregister(id);
    this.persisted = {
      ...this.persisted,
      windows: this.persisted.windows.map((window) => window.id === id ? { ...window, isFocused: false } : window),
    };
    const remaining = [...this.contexts.values()].find((item) => !item.win.isDestroyed());
    if (remaining) {
      this.activateContext(remaining.state.id);
      this.layoutViews();
      this.persistAndBroadcast(false);
    } else {
      this.cleanupWindowResources();
    }
  }

  private hardenInternalView(view: WebContentsView, mode: 'shell' | 'overlay'): void {
    const wc = view.webContents;
    const base = this.getRendererUrl(mode).split('?')[0];
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('will-navigate', (event, url) => {
      if (url.split('?')[0].split('#')[0] !== base) {
        event.preventDefault();
      }
    });
    wc.on('will-redirect', (event, url) => {
      if (url.split('?')[0].split('#')[0] !== base) event.preventDefault();
    });
    wc.on('render-process-gone', () => {
      if (!this.disposed && !wc.isDestroyed()) {
        void wc.loadURL(this.getRendererUrl(mode));
      }
    });
  }

  private getRendererUrl(view: 'shell' | 'overlay' | 'little' | 'private'): string {
    if (this.devServerUrl) {
      return `${this.devServerUrl}?view=${view}`;
    }
    const htmlPath = path.join(__dirname, '../../dist/index.html');
    return `${pathToFileURL(htmlPath).toString()}?view=${view}`;
  }

  private getPartitionForSpace(spaceId: string): string {
    const space = this.persisted.spaces.find((s) => s.id === spaceId) ?? this.persisted.spaces[0];
    return space?.profilePartition || 'persist:nook-default';
  }

  private getSessionForSpace(spaceId: string): Session {
    return this.sessionManager.getRegularSession(this.getPartitionForSpace(spaceId));
  }

  private showToast(message: string): void {
    if (this.disposed) return;
    this.toastMessage = message;
    this.broadcastState();
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      this.toastTimer = null;
      if (!this.disposed) {
        this.toastMessage = null;
        this.broadcastState();
      }
    }, 2800);
  }

  private ensureOverlayView(): WebContentsView | null {
    if (this.disposed || !this.mainWindow || this.mainWindow.isDestroyed()) return null;
    if (this.overlayView && !this.overlayView.webContents.isDestroyed()) {
      return this.overlayView;
    }

    const overlayView = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, '../preload/shell.js'),
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        nodeIntegrationInSubFrames: false,
        webviewTag: false,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        navigateOnDragDrop: false,
      },
    });
    overlayView.setBackgroundColor('#00000000');
    overlayView.setVisible(false);
    this.overlayView = overlayView;
    const activeContext = this.getActiveContext();
    if (activeContext) activeContext.overlayView = overlayView;
    this.mainWindow.contentView.addChildView(overlayView);
    this.ipcRegistry.register(overlayView.webContents.id, 'overlay');
    this.windowIdBySenderId.set(overlayView.webContents.id, this.currentWindowId);
    this.hardenInternalView(overlayView, 'overlay');
    this.attachKeyboard(overlayView.webContents);
    this.attachOverlayFocusGuard(overlayView.webContents);
    void overlayView.webContents.loadURL(this.getRendererUrl('overlay'));
    return overlayView;
  }

  private refreshDefaultBrowserFlag(broadcastIfChanged = true): void {
    const now = Date.now();
    if (broadcastIfChanged && now - this.lastDefaultCheckAt < 30_000) return;
    this.lastDefaultCheckAt = now;
    const next = app.isDefaultProtocolClient('http') && app.isDefaultProtocolClient('https');
    if (next !== this.cachedIsDefaultBrowser) {
      this.cachedIsDefaultBrowser = next;
      if (broadcastIfChanged && !this.disposed) {
        this.scheduleBroadcast();
      }
    }
  }

  private buildSnapshot(context: BrowserWindowContext | null): KinexStateSnapshot {
    const isActive = context?.state.id === this.currentWindowId;
    return {
      ...this.persisted,
      activeSpaceId: context?.state.spaceId ?? this.persisted.activeSpaceId,
      reducedEffects: this.speedLimited || this.thermalLimited,
      overlayGeneration: this.overlayGeneration,
      overlay: isActive ? this.overlay : context?.overlay ?? this.overlay,
      downloads: this.downloadManager.getDownloads(),
      blockedRequestsCount: this.shieldsCoordinator.getTotalBlockedCount(),
      shieldsRuntime: {
        updatingLists: this.updatingShieldsLists,
        needsReloadByTabId: Object.fromEntries(Array.from(this.needsReloadByTabId).map((id) => [id, true])),
        tabStats: this.shieldsCoordinator.getTabStatsMap(),
        totalRuleCount: this.shieldsEngine.getTotalRuleCount(),
        engineReady: this.shieldsEngine.isReady(),
        engineError: this.shieldsEngine.getError(),
        pickerActiveTabId: this.pickerActiveTabId,
      },
      zapperActiveTabId: this.tabManager.getZapperActiveTabId(),
      toastMessage: this.toastMessage,
      isDefaultBrowser: this.cachedIsDefaultBrowser,
      appVersion: app.getVersion(),
      updateStatus: this.updateStatus,
      findStatus: this.findStatus,
      duplicatePrompt: isActive ? this.duplicatePrompt : context?.duplicatePrompt ?? this.duplicatePrompt,
      readerTabIds: Array.from(this.readerDocsByTabId.keys()),
    };
  }

  getSnapshot(senderId?: number): KinexStateSnapshot {
    return this.buildSnapshot(this.contextForSender(senderId));
  }

  private syncWindowState(): void {
    const context = this.getActiveContext();
    if (!context || context.win.isDestroyed()) return;
    const otherOwner = [...this.contexts.values()].find((item) =>
      item.state.id !== context.state.id && item.state.spaceId === this.persisted.activeSpaceId
    );
    if (otherOwner) {
      this.persisted = { ...this.persisted, activeSpaceId: context.state.spaceId };
    }
    for (const other of this.contexts.values()) {
      const focused = other.state.id === context.state.id && other.win.isFocused();
      this.windowRegistry.update(other.state.id, { isFocused: focused });
      other.state = { ...other.state, isFocused: focused };
    }
    this.windowRegistry.update(context.state.id, {
      spaceId: this.persisted.activeSpaceId,
      isFocused: context.win.isFocused(),
    });
    context.state = { ...context.state, spaceId: this.persisted.activeSpaceId };
    this.persisted = { ...this.persisted, windows: this.windowRegistry.states() };
  }

  private syncWindowGeometry(id = this.currentWindowId): void {
    const record = this.windowRegistry.get(id);
    if (!record || record.win.isDestroyed()) return;
    this.windowRegistry.capture(id);
    this.persisted = { ...this.persisted, windows: this.windowRegistry.states() };
    this.persistence.scheduleSave(this.persisted);
  }

  private persistAndBroadcast(immediateBroadcast = true): void {
    if (this.disposed) return;
    this.syncWindowState();
    this.persistence.scheduleSave(this.persisted);
    if (immediateBroadcast) {
      this.broadcastState();
    } else {
      this.scheduleBroadcast();
    }
  }

  private scheduleBroadcast(): void {
    if (this.disposed || this.broadcastTimer) return;
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = null;
      this.broadcastState();
    }, 16);
    this.broadcastTimer.unref?.();
  }

  private broadcastState(): void {
    if (this.disposed) return;
    if (this.broadcastTimer) {
      clearTimeout(this.broadcastTimer);
      this.broadcastTimer = null;
    }
    for (const context of this.contexts.values()) {
      if (context.win.isDestroyed()) continue;
      const snapshot = this.buildSnapshot(context);
      if (!context.shellView.webContents.isDestroyed()) {
        context.shellView.webContents.send('kinex:state-updated', snapshot);
      }
      const overlayState = context.state.id === this.currentWindowId ? this.overlay : context.overlay;
      const prompt = context.state.id === this.currentWindowId ? this.duplicatePrompt : context.duplicatePrompt;
      const shouldUpdateOverlay =
        overlayState.mode !== 'none' || Boolean(prompt) || this.overlayNeedsCloseSync;
      if (shouldUpdateOverlay && context.overlayView && !context.overlayView.webContents.isDestroyed()) {
        context.overlayView.webContents.send('kinex:state-updated', snapshot);
      }
    }
    this.overlayNeedsCloseSync = this.overlay.mode !== 'none' || Boolean(this.duplicatePrompt) ||
      [...this.contexts.values()].some(
        (context) => context.state.id !== this.currentWindowId &&
          (context.overlay.mode !== 'none' || Boolean(context.duplicatePrompt))
      );
  }

  private syncBackgroundThrottling(): void {
    if (this.disposed) return;
    const visibleIds = new Set(getActiveSplit(this.persisted).tabIds);
    this.tabManager.syncBackgroundThrottling(
      visibleIds,
      this.isWindowOccluded,
      (wcId) =>
        this.downloadManager.hasActiveDownloadForWebContents(wcId) ||
        this.permissionManager.hasActiveMediaCapture(wcId)
    );
  }

  private async tryDiscardTab(tabId: string, bypassTimeout = false): Promise<boolean> {
    if (this.disposed) return false;
    const tab = this.persisted.tabs.find((t) => t.id === tabId);
    if (!tab) return false;

    const view = this.tabManager.getView(tabId);
    const wc = view && !view.webContents.isDestroyed() ? view.webContents : null;
    const visibleIds = new Set(getActiveSplit(this.persisted).tabIds);
    const thresholdMs = MEMORY_SAVER_TIMEOUT_MS[this.persisted.memorySaverTimeout];
    const idleMs = Date.now() - (tab.lastActiveAt || 0);

    const fastCheck = evaluateDiscardEligibility({
      tab,
      isVisible: visibleIds.has(tabId),
      hasLiveView: Boolean(wc),
      isCurrentlyAudible: wc ? wc.isCurrentlyAudible() : false,
      hasActiveDownload: wc ? this.downloadManager.hasActiveDownloadForWebContents(wc.id) : false,
      hasActiveMediaCapture: wc ? this.permissionManager.hasActiveMediaCapture(wc.id) : false,
      hasUnsavedFormData: false,
      pinnedExempt: this.persisted.memorySaverExemptPinned,
      idleMs,
      thresholdMs,
      bypassTimeout,
    });
    if (!fastCheck.eligible) return false;

    const dirtyForm = await this.tabManager.hasPotentiallyUnsavedFormData(tabId);
    if (this.disposed) return false;

    const refreshedTab = this.persisted.tabs.find((t) => t.id === tabId);
    const refreshedView = this.tabManager.getView(tabId);
    const refreshedWc =
      refreshedView && !refreshedView.webContents.isDestroyed() ? refreshedView.webContents : null;
    const currentVisible = new Set(getActiveSplit(this.persisted).tabIds);

    if (!refreshedTab || !refreshedWc) return false;

    const finalCheck = evaluateDiscardEligibility({
      tab: refreshedTab,
      isVisible: currentVisible.has(tabId),
      hasLiveView: true,
      isCurrentlyAudible: refreshedWc.isCurrentlyAudible(),
      hasActiveDownload: this.downloadManager.hasActiveDownloadForWebContents(refreshedWc.id),
      hasActiveMediaCapture: this.permissionManager.hasActiveMediaCapture(refreshedWc.id),
      hasUnsavedFormData: dirtyForm,
      pinnedExempt: this.persisted.memorySaverExemptPinned,
      idleMs: Date.now() - (refreshedTab.lastActiveAt || 0),
      thresholdMs,
      bypassTimeout,
    });
    if (!finalCheck.eligible) return false;

    return this.tabManager.discardTabView(tabId);
  }

  private async runMemorySaverSweep(): Promise<void> {
    if (this.disposed) return;
    if (this.persisted.memorySaverTimeout === 'disabled') return;
    const liveIds = Array.from(this.tabManager.getAllViews().keys());
    for (const tabId of liveIds) {
      if (this.disposed) break;
      await this.tryDiscardTab(tabId, false);
    }
  }

  private cancelPendingFocus(): void {
    if (this.focusRetryTimer) {
      clearTimeout(this.focusRetryTimer);
      this.focusRetryTimer = null;
    }
    this.pendingFocus = null;
  }

  private requestNativeFocus(target: () => WebContents | null, attempts = 4): void {
    if (this.disposed) return;
    this.cancelPendingFocus();
    this.pendingFocus = { target, remaining: attempts };
    this.applyPendingFocus();
  }

  private applyPendingFocus(): void {
    this.focusRetryTimer = null;
    const request = this.pendingFocus;
    if (!request || this.disposed) return;
    const win = this.mainWindow;
    if (!win || win.isDestroyed()) {
      this.pendingFocus = null;
      return;
    }
    if (this.overlay.mode !== 'none' && !this.overlayClosing) {
      this.pendingFocus = null;
      return;
    }
    const wc = request.target();
    if (wc && !wc.isDestroyed() && win.isFocused() && !wc.isFocused()) {
      wc.focus();
    }
    if (wc && !wc.isDestroyed() && wc.isFocused()) {
      this.pendingFocus = null;
      return;
    }
    if (request.remaining <= 0) {
      this.pendingFocus = null;
      return;
    }
    request.remaining -= 1;
    this.focusRetryTimer = setTimeout(() => this.applyPendingFocus(), 25);
    this.focusRetryTimer.unref?.();
  }

  private getFocusedTabWebContents(): WebContents | null {
    const focused = getFocusedTab(this.persisted);
    const view = focused && this.tabManager.getView(focused.id);
    return view && !view.webContents.isDestroyed() ? view.webContents : null;
  }

  private focusActiveTabView(explicitTabId?: string): void {
    if (this.disposed || this.overlay.mode !== 'none' || Boolean(this.duplicatePrompt)) return;
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
    const tabId = explicitTabId ?? getFocusedTab(this.persisted)?.id;
    if (!tabId) return;
    this.requestNativeFocus(() => {
      const view = this.tabManager.getView(tabId);
      return view && !view.webContents.isDestroyed() ? view.webContents : null;
    });
  }

  private ensureActiveViewsLoaded(): void {
    const context = this.getActiveContext();
    const spaceId = this.currentWindowId === context?.state.id ? this.persisted.activeSpaceId : context?.state.spaceId;
    const split = getActiveSplit(this.persisted, spaceId ?? this.persisted.activeSpaceId);
    for (const tabId of split.tabIds) {
      const view = this.tabManager.ensureTabView(tabId);
      if (view && context) this.tabOwnerByTabId.set(tabId, context.state.id);
    }
  }

  private layoutContext(context: BrowserWindowContext): void {
    const isActive = context.state.id === this.currentWindowId;
    const htmlFullscreenTabId = isActive ? this.htmlFullscreenTabId : context.htmlFullscreenTabId;
    const overlayState = isActive ? this.overlay : context.overlay;
    const prompt = isActive ? this.duplicatePrompt : context.duplicatePrompt;
    const closing = isActive ? this.overlayClosing : context.overlayClosing;
    const split = getActiveSplit(this.persisted, context.state.spaceId);
    const focusedId = split.tabIds[split.focusedIndex] ?? split.tabIds[0];
    const focused = this.persisted.tabs.find((tab) => tab.id === focusedId);
    if (htmlFullscreenTabId && !split.tabIds.includes(htmlFullscreenTabId)) {
      const staleId = htmlFullscreenTabId;
      context.htmlFullscreenTabId = null;
      if (isActive) this.htmlFullscreenTabId = null;
      const staleView = this.tabManager.getView(staleId);
      if (staleView && !staleView.webContents.isDestroyed()) {
        void staleView.webContents
          .executeJavaScript('if (document.fullscreenElement) { void document.exitFullscreen?.(); }')
          .catch(() => {});
      }
    }
    const spaceTabIds = new Set(
      this.persisted.tabs.filter((tab) => tab.spaceId === context.state.spaceId).map((tab) => tab.id)
    );
    const tabViews = new Map(
      [...this.tabManager.getAllViews()].filter(([tabId]) => spaceTabIds.has(tabId))
    );
    this.layoutManager.applyLayout({
      mainWindow: context.win,
      shellView: context.shellView,
      overlayView: context.overlayView,
      allTabViews: tabViews,
      activeTabIds: split.tabIds,
      sidebarOpen: this.persisted.sidebarOpen,
      sidebarWidth: this.persisted.sidebarWidth,
      splitRatio: split.splitRatio || 0.5,
      toolbarVisible: Boolean(focused && (this.readerDocsByTabId.has(focused.id) || (focused.zoomFactor ?? 1) !== 1)),
      hasOverlay: overlayState.mode !== 'none' || Boolean(prompt) || closing,
      htmlFullscreenTabId,
    });
  }

  private layoutViews(): void {
    const context = this.getActiveContext();
    if (!context) return;
    this.layoutContext(context);
    this.syncBackgroundThrottling();
  }

  private handleAirTrafficRouting(tabId: string, url: string): boolean {
    const routedSpaceId = matchAirTrafficSpace(url, this.persisted.airTrafficRules);
    const currentTab = this.persisted.tabs.find((t) => t.id === tabId);
    if (
      !routedSpaceId ||
      !currentTab ||
      currentTab.location !== 'unpinned' ||
      routedSpaceId === currentTab.spaceId ||
      !this.persisted.spaces.some((s) => s.id === routedSpaceId)
    ) {
      return false;
    }

    const routedSpace = this.persisted.spaces.find((s) => s.id === routedSpaceId);
    const nextTabId = `tab-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const newTab: TabItem = {
      ...currentTab,
      id: nextTabId,
      spaceId: routedSpaceId,
      url,
      lastActiveAt: Date.now(),
    };
    this.persisted = {
      ...this.persisted,
      activeSpaceId: routedSpaceId,
      tabs: [...this.persisted.tabs.filter((t) => t.id !== tabId), newTab],
      splitsBySpace: {
        ...this.persisted.splitsBySpace,
        [routedSpaceId]: { tabIds: [nextTabId], focusedIndex: 0, splitRatio: 0.5 },
      },
    };
    this.tabManager.destroyTabView(tabId);
    this.ensureActiveViewsLoaded();
    this.layoutViews();
    this.persistAndBroadcast();
    this.showToast(`Air Traffic routed to ${routedSpace?.name ?? 'Space'}`);
    return true;
  }

  private recordHistory(url: string, title: string): void {
    if (!url || url.startsWith('kinex://') || url.startsWith('nook://') || url === 'about:blank') {
      return;
    }
    const existing = this.persisted.history.find((h) => h.url === url);
    const nextHistory = [
      {
        url,
        title: title || url,
        visitedAt: Date.now(),
        visitCount: (existing?.visitCount ?? 0) + 1,
      },
      ...this.persisted.history.filter((h) => h.url !== url),
    ].slice(0, 250);
    this.persisted = { ...this.persisted, history: nextHistory };
  }

  openUrl(
    rawInput: string,
    target: 'current' | 'new-tab' | 'new-tab-background' | 'split' | 'little-kinex' | 'little-nook',
    explicitSpaceId?: string,
    duplicatePolicy: 'prompt' | 'allow' = 'allow'
  ): void {
    const normalized = normalizeNavigationInput(rawInput, this.persisted.searchEngine);
    if (target === 'little-kinex' || target === 'little-nook') {
      this.auxiliaryWindows.openLittleKinex(normalized);
      return;
    }

    if (
      duplicatePolicy === 'prompt' &&
      (target === 'new-tab' || target === 'split') &&
      !normalized.startsWith('kinex://')
    ) {
      const existing = findDuplicateOpenTab(this.persisted, normalized);
      if (existing) {
        this.captureOverlayOrigin();
        this.duplicatePrompt = {
          url: normalized,
          existingTabId: existing.id,
          existingTabTitle: existing.title || existing.url,
          existingSpaceId: existing.spaceId,
          target,
          requestedSpaceId: explicitSpaceId,
        };
        this.ensureOverlayView();
        this.layoutViews();
        this.broadcastState();
        this.overlayView?.webContents.focus();
        return;
      }
    }

    this.duplicatePrompt = null;

    const routedSpaceId =
      explicitSpaceId ?? matchAirTrafficSpace(normalized, this.persisted.airTrafficRules) ?? this.persisted.activeSpaceId;
    const spaceId = this.persisted.spaces.some((s) => s.id === routedSpaceId)
      ? routedSpaceId
      : this.persisted.activeSpaceId;

    if (target === 'current') {
      const focused = getFocusedTab(this.persisted);
      if (focused) {
        this.persisted = {
          ...this.persisted,
          tabs: this.persisted.tabs.map((t) =>
            t.id === focused.id ? { ...t, url: normalized, isCrashed: false, lastActiveAt: Date.now() } : t
          ),
        };
        this.tabManager.navigateTab(focused.id, normalized);
        this.focusActiveTabView(focused.id);
        this.persistAndBroadcast();
        return;
      }
    }

    const newTab: TabItem = {
      id: `tab-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      spaceId,
      location: 'unpinned',
      url: normalized,
      title: normalized,
      isLoading: true,
      canGoBack: false,
      canGoForward: false,
      isMuted: false,
      isAudible: false,
      securityState: classifySecurityState(normalized, false),
      lastActiveAt: Date.now(),
    };

    const currentSplit = getActiveSplit(this.persisted, spaceId);
    const nextSplitIds =
      target === 'split'
        ? [currentSplit.tabIds[0] ?? newTab.id, newTab.id].slice(0, 2)
        : target === 'new-tab-background' && currentSplit.tabIds.length > 0
          ? currentSplit.tabIds
          : [newTab.id];

    const nextFocusedIdx =
      target === 'split' ? nextSplitIds.length - 1 : currentSplit.focusedIndex;

    this.persisted = {
      ...this.persisted,
      activeSpaceId: target === 'new-tab-background' ? this.persisted.activeSpaceId : spaceId,
      tabs: [...this.persisted.tabs, newTab],
      splitsBySpace: {
        ...this.persisted.splitsBySpace,
        [spaceId]: {
          ...currentSplit,
          tabIds: nextSplitIds,
          focusedIndex: target === 'new-tab-background' ? Math.min(nextFocusedIdx, nextSplitIds.length - 1) : nextFocusedIdx,
        },
      },
    };
    this.ensureActiveViewsLoaded();
    this.layoutViews();
    if (target !== 'new-tab-background') {
      this.focusActiveTabView(newTab.id);
    }
    this.persistAndBroadcast();
  }

  async handleIntent(intent: KinexIntent, senderId?: number): Promise<void> {
    if (this.disposed) return;
    this.contextForSender(senderId);

    switch (intent.type) {
      case 'run-command':
        if (intent.commandId === 'new-window') {
          this.openNewWindow();
          return;
        }
        await this.executeCommand(intent.commandId);
        return;
      case 'focus-region':
        this.focusBrowserRegion(intent.region);
        return;

      case 'select-space': {
        if (!this.persisted.spaces.some((s) => s.id === intent.spaceId)) return;
        const now = Date.now();
        const nextSplitIds = new Set(getActiveSplit(this.persisted, intent.spaceId).tabIds);
        const owningWindow = [...this.contexts.values()].find((context) => context.state.spaceId === intent.spaceId);
        if (owningWindow && owningWindow.state.id !== this.currentWindowId) {
          this.activateContext(owningWindow.state.id);
          owningWindow.win.focus();
          return;
        }
        const currentContext = this.getActiveContext();
        if (currentContext) {
          this.windowRegistry.update(currentContext.state.id, { spaceId: intent.spaceId });
          this.persisted = { ...this.persisted, windows: this.windowRegistry.states() };
        }
        this.persisted = {
          ...this.persisted,
          activeSpaceId: intent.spaceId,
          tabs: this.persisted.tabs.map((t) =>
            nextSplitIds.has(t.id) ? { ...t, lastActiveAt: now } : t
          ),
        };
        this.ensureActiveViewsLoaded();
        this.refreshVisibleInternalPages();
        this.layoutViews();
        this.focusActiveTabView();
        this.persistAndBroadcast();
        return;
      }

      case 'create-space': {
        if (intent.profilePartition && !this.persisted.profiles.some((p) => p.partition === intent.profilePartition)) {
          this.showToast('Select an existing Profile');
          return;
        }
        const id = `space-${Date.now()}`;
        const partition = intent.profilePartition || this.persisted.profiles[0]?.partition || 'persist:nook-default';
        const welcomeTab: TabItem = {
          id: `tab-${Date.now()}-w`,
          spaceId: id,
          location: 'unpinned',
          url: 'kinex://newtab',
          title: 'New Tab — Kinex',
          isLoading: false,
          canGoBack: false,
          canGoForward: false,
          isMuted: false,
          isAudible: false,
          securityState: 'internal',
          lastActiveAt: Date.now(),
        };
        this.persisted = {
          ...this.persisted,
          spaces: [...this.persisted.spaces, { id, name: intent.name, icon: intent.icon, theme: intent.theme, profilePartition: partition }],
          activeSpaceId: id,
          tabs: [...this.persisted.tabs, welcomeTab],
          splitsBySpace: {
            ...this.persisted.splitsBySpace,
            [id]: { tabIds: [welcomeTab.id], focusedIndex: 0, splitRatio: 0.5 },
          },
        };
        this.overlay = { mode: 'none' };
        this.ensureActiveViewsLoaded();
        this.layoutViews();
        this.focusActiveTabView(welcomeTab.id);
        this.persistAndBroadcast();
        return;
      }

      case 'update-space': {
        if (intent.profilePartition && !this.persisted.profiles.some((p) => p.partition === intent.profilePartition)) {
          this.showToast('Select an existing Profile');
          return;
        }
        const previousSpace = this.persisted.spaces.find((s) => s.id === intent.spaceId);
        const profileChanged = Boolean(intent.profilePartition && previousSpace?.profilePartition !== intent.profilePartition);
        this.persisted = {
          ...this.persisted,
          spaces: this.persisted.spaces.map((s) =>
            s.id === intent.spaceId
              ? {
                  ...s,
                  name: intent.name,
                  icon: intent.icon,
                  theme: intent.theme,
                  profilePartition: intent.profilePartition || s.profilePartition,
                }
              : s
          ),
        };
        this.overlay = { mode: 'none' };
        this.refreshVisibleInternalPages();
        if (profileChanged) {
          for (const tab of this.persisted.tabs.filter((t) => t.spaceId === intent.spaceId)) this.tabManager.destroyTabView(tab.id);
          this.ensureActiveViewsLoaded();
        }
        this.layoutViews();
        this.persistAndBroadcast();
        return;
      }

      case 'delete-space': {
        if (this.persisted.spaces.length <= 1) {
          this.showToast('Keep at least one Space');
          return;
        }
        const removedTabs = this.persisted.tabs.filter((t) => t.spaceId === intent.spaceId);
        for (const t of removedTabs) this.tabManager.destroyTabView(t.id);
        const remainingSpaces = this.persisted.spaces.filter((s) => s.id !== intent.spaceId);
        const nextActive =
          this.persisted.activeSpaceId === intent.spaceId ? remainingSpaces[0].id : this.persisted.activeSpaceId;
        this.persisted = {
          ...this.persisted,
          spaces: remainingSpaces,
          activeSpaceId: nextActive,
          tabs: this.persisted.tabs.filter((t) => t.spaceId !== intent.spaceId),
          folders: this.persisted.folders.filter((f) => f.spaceId !== intent.spaceId),
        };
        this.overlay = { mode: 'none' };
        this.ensureActiveViewsLoaded();
        this.refreshVisibleInternalPages();
        this.layoutViews();
        this.focusActiveTabView();
        this.persistAndBroadcast();
        return;
      }

      case 'rename-space': {
        this.persisted = {
          ...this.persisted,
          spaces: this.persisted.spaces.map((s) =>
            s.id === intent.spaceId ? { ...s, name: intent.name } : s
          ),
        };
        this.refreshVisibleInternalPages();
        this.persistAndBroadcast();
        return;
      }

      case 'reorder-space': {
        this.persisted = reorderSpaces(this.persisted, intent.sourceSpaceId, intent.targetSpaceId);
        this.persistAndBroadcast();
        return;
      }

      case 'create-profile': {
        const clean = intent.name.trim();
        if (!clean) return;
        const id = `prof-${Date.now()}`;
        const partition = `persist:kinex-${id}`;
        this.persisted = {
          ...this.persisted,
          profiles: [...this.persisted.profiles, { id, name: clean, partition }],
        };
        this.persistAndBroadcast();
        this.showToast(`Created profile "${clean}"`);
        return;
      }

      case 'create-folder': {
        const clean = intent.name.trim();
        if (!clean) return;
        const id = `fld-${Date.now()}`;
        this.persisted = {
          ...this.persisted,
          folders: [...this.persisted.folders, { id, spaceId: intent.spaceId, name: clean, collapsed: false }],
        };
        this.persistAndBroadcast();
        return;
      }

      case 'toggle-folder': {
        this.persisted = {
          ...this.persisted,
          folders: this.persisted.folders.map((f) =>
            f.id === intent.folderId ? { ...f, collapsed: !f.collapsed } : f
          ),
        };
        this.persistAndBroadcast();
        return;
      }

      case 'rename-folder': {
        this.persisted = {
          ...this.persisted,
          folders: this.persisted.folders.map((f) =>
            f.id === intent.folderId ? { ...f, name: intent.name } : f
          ),
        };
        this.persistAndBroadcast();
        return;
      }

      case 'delete-folder': {
        this.persisted = {
          ...this.persisted,
          folders: this.persisted.folders.filter((f) => f.id !== intent.folderId),
          tabs: this.persisted.tabs.map((t) =>
            t.folderId === intent.folderId ? { ...t, folderId: undefined } : t
          ),
        };
        this.persistAndBroadcast();
        return;
      }

      case 'move-tab-to-folder': {
        if (this.overlay.mode === 'command-bar') await this.handleIntent({ type: 'set-overlay', overlay: { mode: 'none' } });
        this.persisted = {
          ...this.persisted,
          tabs: this.persisted.tabs.map((t) =>
            t.id === intent.tabId ? { ...t, folderId: intent.folderId, location: 'pinned', pinnedUrl: t.pinnedUrl ?? t.url } : t
          ),
        };
        this.persistAndBroadcast();
        return;
      }

      case 'move-tab-to-space': {
        if (this.overlay.mode === 'command-bar') await this.handleIntent({ type: 'set-overlay', overlay: { mode: 'none' } });
        const moved = moveTabToSpace(this.persisted, intent.tabId, intent.spaceId);
        this.persisted = moved.next;
        if (moved.profileChanged) {
          this.tabManager.destroyTabView(intent.tabId);
        }
        this.ensureActiveViewsLoaded();
        this.refreshVisibleInternalPages();
        this.layoutViews();
        this.focusActiveTabView(intent.tabId);
        this.persistAndBroadcast();
        if (moved.profileChanged) {
          this.showToast('Moved tab using isolated destination Space profile');
        }
        return;
      }

      case 'reorder-tab': {
        this.persisted = reorderTabs(this.persisted, intent.sourceTabId, intent.targetTabId);
        this.persistAndBroadcast();
        return;
      }

      case 'select-tab': {
        const tab = this.persisted.tabs.find((t) => t.id === intent.tabId);
        if (!tab) return;
        const targetSpaceId = tab.spaceId;
        const split = getActiveSplit(this.persisted, targetSpaceId);
        let nextIds = split.tabIds;
        let nextFocus = split.focusedIndex;
        if (typeof intent.paneIndex === 'number') {
          nextIds = [...split.tabIds];
          nextIds[intent.paneIndex] = tab.id;
          nextFocus = intent.paneIndex;
        } else if (split.tabIds.includes(tab.id)) {
          nextFocus = split.tabIds.indexOf(tab.id);
        } else {
          nextIds = split.tabIds.length === 2
            ? split.tabIds.map((id, i) => (i === split.focusedIndex ? tab.id : id))
            : [tab.id];
          nextFocus = Math.min(nextFocus, nextIds.length - 1);
        }
        this.persisted = {
          ...this.persisted,
          activeSpaceId: targetSpaceId,
          tabs: this.persisted.tabs.map((t) =>
            t.id === tab.id ? { ...t, lastActiveAt: Date.now() } : t
          ),
          splitsBySpace: {
            ...this.persisted.splitsBySpace,
            [targetSpaceId]: { ...split, tabIds: nextIds.slice(0, 2), focusedIndex: nextFocus },
          },
        };
        this.overlay = { mode: 'none' };
        this.ensureActiveViewsLoaded();
        this.layoutViews();
        this.focusActiveTabView(tab.id);
        this.persistAndBroadcast();
        return;
      }

      case 'duplicate-tab': {
        const src = this.persisted.tabs.find((t) => t.id === intent.tabId);
        if (src) this.openUrl(src.url, 'new-tab', src.spaceId);
        return;
      }

      case 'open-url': {
        this.overlay = { mode: 'none' };
        this.openUrl(intent.url, intent.target, intent.spaceId, intent.duplicatePolicy ?? 'allow');
        return;
      }

      case 'resolve-duplicate-open': {
        const prompt = this.duplicatePrompt;
        this.duplicatePrompt = null;
        if (!prompt || intent.decision === 'cancel') {
          this.layoutViews();
          this.broadcastState();
          this.restoreOverlayFocus();
          return;
        }
        if (intent.decision === 'switch-existing') {
          await this.handleIntent({ type: 'select-tab', tabId: prompt.existingTabId });
          return;
        }
        this.openUrl(prompt.url, prompt.target, prompt.requestedSpaceId, 'allow');
        this.layoutViews();
        return;
      }

      case 'close-tab': {
        const result = closeOrResetTab(this.persisted, intent.tabId);
        this.persisted = result.next;
        if (result.destroyedTabId) {
          this.needsReloadByTabId.delete(result.destroyedTabId);
          this.shieldsCoordinator.clearTabStats(result.destroyedTabId);
          this.readerDocsByTabId.delete(result.destroyedTabId);
          this.findQueryByTabId.delete(result.destroyedTabId);
          this.tabManager.destroyTabView(result.destroyedTabId);
        } else if (result.resetTab) {
          this.readerDocsByTabId.delete(result.resetTab.id);
          this.tabManager.navigateTab(result.resetTab.id, result.resetTab.url);
        }
        this.ensureActiveViewsLoaded();
        this.refreshVisibleInternalPages();
        this.layoutViews();
        this.focusActiveTabView();
        this.persistAndBroadcast();
        return;
      }

      case 'close-other-tabs': {
        const res = closeOtherTabsForSpace(this.persisted, intent.tabId);
        this.persisted = res.next;
        for (const id of res.destroyedTabIds) {
          this.needsReloadByTabId.delete(id);
          this.shieldsCoordinator.clearTabStats(id);
          this.readerDocsByTabId.delete(id);
          this.findQueryByTabId.delete(id);
          this.tabManager.destroyTabView(id);
        }
        this.ensureActiveViewsLoaded();
        this.refreshVisibleInternalPages();
        this.layoutViews();
        this.focusActiveTabView();
        this.persistAndBroadcast();
        return;
      }

      case 'close-tabs-to-right': {
        const res = closeTabsToRightForSpace(this.persisted, intent.tabId);
        this.persisted = res.next;
        for (const id of res.destroyedTabIds) {
          this.needsReloadByTabId.delete(id);
          this.shieldsCoordinator.clearTabStats(id);
          this.readerDocsByTabId.delete(id);
          this.findQueryByTabId.delete(id);
          this.tabManager.destroyTabView(id);
        }
        this.ensureActiveViewsLoaded();
        this.refreshVisibleInternalPages();
        this.layoutViews();
        this.focusActiveTabView();
        this.persistAndBroadcast();
        return;
      }

      case 'reopen-closed-tab': {
        const res = restoreClosedTabs(this.persisted, { closedId: intent.closedId });
        if (res.restoredTabs.length === 0) {
          this.showToast('No recently closed tabs');
          return;
        }
        this.persisted = res.next;
        this.overlay = { mode: 'none' };
        this.ensureActiveViewsLoaded();
        this.refreshVisibleInternalPages();
        this.layoutViews();
        this.focusActiveTabView(res.restoredTabs[0].id);
        this.persistAndBroadcast();
        return;
      }

      case 'restore-closed-group': {
        const res = restoreClosedTabs(this.persisted, { groupId: intent.groupId });
        if (res.restoredTabs.length === 0) return;
        this.persisted = res.next;
        this.overlay = { mode: 'none' };
        this.ensureActiveViewsLoaded();
        this.refreshVisibleInternalPages();
        this.layoutViews();
        this.focusActiveTabView(res.restoredTabs[0].id);
        this.persistAndBroadcast();
        this.showToast(`Restored ${res.restoredTabs.length} tabs`);
        return;
      }

      case 'clear-closed-tabs': {
        this.persisted = { ...this.persisted, closedTabs: [] };
        this.persistAndBroadcast();
        return;
      }

      case 'reset-pinned-tab': {
        const tab = this.persisted.tabs.find((t) => t.id === intent.tabId);
        if (!tab) return;
        const resetUrl = tab.pinnedUrl ?? tab.url;
        this.persisted = {
          ...this.persisted,
          tabs: this.persisted.tabs.map((t) => (t.id === tab.id ? { ...t, url: resetUrl } : t)),
        };
        this.tabManager.navigateTab(tab.id, resetUrl);
        this.persistAndBroadcast();
        return;
      }

      case 'set-tab-location': {
        this.persisted = setTabLocation(this.persisted, intent.tabId, intent.location);
        this.persistAndBroadcast();
        return;
      }

      case 'clear-today-tabs': {
        const cleared = clearTodayTabsForSpace(this.persisted, intent.spaceId);
        this.persisted = cleared.next;
        for (const id of cleared.destroyedTabIds) {
          this.tabManager.destroyTabView(id);
        }
        this.ensureActiveViewsLoaded();
        this.refreshVisibleInternalPages();
        this.layoutViews();
        this.focusActiveTabView();
        this.persistAndBroadcast();
        return;
      }

      case 'restore-archived-tab': {
        const archived = this.persisted.archivedTabs.find((a) => a.id === intent.archivedId);
        if (!archived) return;
        this.persisted = {
          ...this.persisted,
          archivedTabs: this.persisted.archivedTabs.filter((a) => a.id !== intent.archivedId),
        };
        this.overlay = { mode: 'none' };
        this.openUrl(archived.url, 'new-tab', archived.spaceId);
        return;
      }

      case 'toggle-split': {
        const split = getActiveSplit(this.persisted);
        if (split.tabIds.length > 1 && !intent.tabId) {
          this.persisted = {
            ...this.persisted,
            splitsBySpace: {
              ...this.persisted.splitsBySpace,
              [this.persisted.activeSpaceId]: { ...split, tabIds: [split.tabIds[0]], focusedIndex: 0 },
            },
          };
        } else {
          const requestedTab =
            intent.tabId &&
            intent.tabId !== split.tabIds[0] &&
            this.persisted.tabs.some((t) => t.id === intent.tabId)
              ? intent.tabId
              : undefined;
          const secondId =
            requestedTab ??
            this.persisted.tabs.find(
              (t) =>
                t.id !== split.tabIds[0] &&
                (t.spaceId === this.persisted.activeSpaceId || t.location === 'topApp')
            )?.id;
          if (!secondId) {
            this.openUrl('kinex://newtab', 'split');
            return;
          }
          this.persisted = {
            ...this.persisted,
            splitsBySpace: {
              ...this.persisted.splitsBySpace,
              [this.persisted.activeSpaceId]: {
                ...split,
                tabIds: [split.tabIds[0], secondId].filter(Boolean).slice(0, 2),
                focusedIndex: 1,
              },
            },
          };
        }
        this.ensureActiveViewsLoaded();
        this.refreshVisibleInternalPages();
        this.layoutViews();
        this.focusActiveTabView();
        this.persistAndBroadcast();
        return;
      }

      case 'close-split-pane': {
        const split = getActiveSplit(this.persisted);
        const remaining = split.tabIds.filter((_, idx) => idx !== intent.paneIndex);
        this.persisted = {
          ...this.persisted,
          splitsBySpace: {
            ...this.persisted.splitsBySpace,
            [this.persisted.activeSpaceId]: {
              ...split,
              tabIds: remaining.length > 0 ? remaining : split.tabIds.slice(0, 1),
              focusedIndex: 0,
            },
          },
        };
        this.layoutViews();
        this.focusActiveTabView();
        this.persistAndBroadcast();
        return;
      }

      case 'set-split-ratio': {
        const split = getActiveSplit(this.persisted);
        this.persisted = {
          ...this.persisted,
          splitsBySpace: {
            ...this.persisted.splitsBySpace,
            [this.persisted.activeSpaceId]: { ...split, splitRatio: intent.ratio },
          },
        };
        this.layoutViews();
        this.persistAndBroadcast();
        return;
      }

      case 'focus-pane': {
        const split = getActiveSplit(this.persisted);
        this.persisted = {
          ...this.persisted,
          splitsBySpace: {
            ...this.persisted.splitsBySpace,
            [this.persisted.activeSpaceId]: {
              ...split,
              focusedIndex: Math.min(intent.paneIndex, Math.max(0, split.tabIds.length - 1)),
            },
          },
        };
        this.focusActiveTabView();
        this.persistAndBroadcast();
        return;
      }

      case 'nav-back':
      case 'nav-forward':
      case 'nav-reload':
      case 'nav-stop': {
        const targetId = intent.tabId ?? getFocusedTab(this.persisted)?.id;
        if (!targetId) return;
        if (intent.type === 'nav-reload') {
          this.tabManager.reloadTab(targetId);
          this.focusActiveTabView(targetId);
          return;
        }
        const view = this.tabManager.getView(targetId);
        if (!view || view.webContents.isDestroyed()) return;
        const wc = view.webContents;
        if (intent.type === 'nav-back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
        if (intent.type === 'nav-forward' && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
        if (intent.type === 'nav-stop') wc.stop();
        this.focusActiveTabView(targetId);
        return;
      }

      case 'set-zoom': {
        const targetTab = intent.tabId
          ? this.persisted.tabs.find((t) => t.id === intent.tabId)
          : getFocusedTab(this.persisted);
        if (!targetTab) return;
        const current = targetTab.zoomFactor ?? 1;
        const nextZoom =
          intent.delta === 'reset'
            ? 1
            : intent.delta === 'in'
              ? Math.min(2.5, Number((current + 0.1).toFixed(2)))
              : Math.max(0.5, Number((current - 0.1).toFixed(2)));
        const view = this.tabManager.getView(targetTab.id);
        if (view && !view.webContents.isDestroyed()) {
          view.webContents.setZoomFactor(nextZoom);
        }
        const host = extractHostname(targetTab.url);
        const nextZoomByHost = { ...this.persisted.zoomByHost };
        if (host && !targetTab.url.startsWith('kinex://')) {
          if (nextZoom === 1) {
            delete nextZoomByHost[host];
          } else {
            nextZoomByHost[host] = nextZoom;
          }
        }
        this.persisted = {
          ...this.persisted,
          zoomByHost: nextZoomByHost,
          tabs: this.persisted.tabs.map((t) => (t.id === targetTab.id ? { ...t, zoomFactor: nextZoom } : t)),
        };
        this.layoutViews();
        this.persistAndBroadcast();
        return;
      }

      case 'toggle-mute': {
        const target = this.persisted.tabs.find((t) => t.id === intent.tabId);
        if (!target) return;
        const nextMuted = !target.isMuted;
        const view = this.tabManager.getView(target.id);
        if (view && !view.webContents.isDestroyed()) {
          view.webContents.setAudioMuted(nextMuted);
        }
        this.persisted = {
          ...this.persisted,
          tabs: this.persisted.tabs.map((t) => (t.id === target.id ? { ...t, isMuted: nextMuted } : t)),
        };
        this.persistAndBroadcast();
        return;
      }

      case 'toggle-sidebar': {
        this.persisted = {
          ...this.persisted,
          sidebarOpen: intent.open ?? !this.persisted.sidebarOpen,
        };
        this.layoutViews();
        this.persistAndBroadcast();
        return;
      }

      case 'set-sidebar-width': {
        this.persisted = { ...this.persisted, sidebarWidth: intent.width };
        this.layoutViews();
        this.persistAndBroadcast();
        return;
      }

      case 'set-overlay': {
        if (intent.overlay.mode !== 'none') {
          this.captureOverlayOrigin();
          this.overlayGeneration += 1;
        }
        const wasOpen = this.overlay.mode !== 'none';
        this.overlay = intent.overlay;
        if (this.overlayCloseTimer) clearTimeout(this.overlayCloseTimer);
        this.overlayCloseTimer = null;
        this.overlayClosing = false;
        if (this.overlay.mode !== 'none') {
          this.ensureOverlayView();
          if (this.overlay.mode === 'settings') this.refreshDefaultBrowserFlag(false);
        } else if (wasOpen) {
          this.overlayClosing = true;
          this.overlayFocusRedirects = 0;
          this.overlayCloseTimer = setTimeout(() => {
            this.overlayCloseTimer = null;
            this.overlayClosing = false;
            if (!this.disposed) {
              this.layoutViews();
              const focused = webContents.getFocusedWebContents();
              if (this.mainWindow?.isFocused() && (!focused || focused.id === this.overlayView?.webContents.id)) {
                this.restoreOverlayFocus();
              }
            }
          }, systemPreferences.getAnimationSettings().prefersReducedMotion || this.speedLimited || this.thermalLimited ? 0 : 140);
        }
        this.layoutViews();
        this.broadcastState();
        if (this.overlay.mode !== 'none') this.overlayView?.webContents.focus();
        else this.restoreOverlayFocus();
        return;
      }

      case 'set-search-engine': {
        this.persisted = { ...this.persisted, searchEngine: intent.engine };
        this.refreshVisibleInternalPages();
        this.persistAndBroadcast();
        return;
      }

      case 'set-https-only': {
        this.persisted = { ...this.persisted, httpsOnly: intent.enabled };
        this.persistAndBroadcast();
        return;
      }

      case 'set-clean-copy-url': {
        this.persisted = { ...this.persisted, cleanCopyUrl: intent.enabled };
        this.persistAndBroadcast();
        return;
      }

      case 'revoke-site-permission': {
        this.permissionManager.revoke(intent.partition, intent.origin, intent.permission);
        return;
      }

      case 'save-air-traffic-rule': {
        const exists = this.persisted.airTrafficRules.some((r) => r.id === intent.rule.id);
        this.persisted = {
          ...this.persisted,
          airTrafficRules: exists
            ? this.persisted.airTrafficRules.map((r) => (r.id === intent.rule.id ? intent.rule : r))
            : [...this.persisted.airTrafficRules, intent.rule],
        };
        this.persistAndBroadcast();
        return;
      }

      case 'delete-air-traffic-rule': {
        this.persisted = {
          ...this.persisted,
          airTrafficRules: this.persisted.airTrafficRules.filter((r) => r.id !== intent.ruleId),
        };
        this.persistAndBroadcast();
        return;
      }

      case 'clear-browsing-data': {
        const partitions = Array.from(
          new Set([
            ...this.persisted.profiles.map((p) => p.partition),
            ...this.persisted.spaces.map((s) => s.profilePartition),
          ])
        );
        await this.sessionManager.clearRegularSessionData(partitions, {
          cookies: intent.scopes.includes('cookies'),
          cache: intent.scopes.includes('cache'),
        });
        this.persisted = {
          ...this.persisted,
          history: intent.scopes.includes('history') ? [] : this.persisted.history,
          archivedTabs: intent.scopes.includes('archived') ? [] : this.persisted.archivedTabs,
        };
        this.persistAndBroadcast();
        this.showToast('Cleared selected browsing data');
        return;
      }

      case 'save-boost': {
        const exists = this.persisted.boosts.some((b) => b.id === intent.boost.id);
        this.persisted = {
          ...this.persisted,
          boosts: exists
            ? this.persisted.boosts.map((b) => (b.id === intent.boost.id ? intent.boost : b))
            : [...this.persisted.boosts, intent.boost],
        };
        this.tabManager.applyBoostsToActiveViews();
        this.persistAndBroadcast();
        return;
      }

      case 'delete-boost': {
        this.persisted = {
          ...this.persisted,
          boosts: this.persisted.boosts.filter((b) => b.id !== intent.boostId),
        };
        this.tabManager.applyBoostsToActiveViews();
        this.persistAndBroadcast();
        return;
      }

      case 'toggle-boost-enabled': {
        this.persisted = {
          ...this.persisted,
          boosts: this.persisted.boosts.map((b) =>
            b.id === intent.boostId ? { ...b, enabled: !b.enabled } : b
          ),
        };
        this.tabManager.applyBoostsToActiveViews();
        this.persistAndBroadcast();
        return;
      }

      case 'start-zapper': {
        const focused = getFocusedTab(this.persisted);
        if (!focused) return;
        this.overlay = { mode: 'none' };
        this.layoutViews();
        this.broadcastState();
        this.focusActiveTabView();
        const selector = await this.tabManager.startZapperOnTab(focused.id);
        if (selector && !this.disposed) {
          let host = '*';
          try {
            host = new URL(focused.url).hostname.replace(/^www\./, '');
          } catch {
            host = '*';
          }
          const existing = this.persisted.boosts.find((b) => b.domainPattern === host);
          if (existing) {
            this.persisted = {
              ...this.persisted,
              boosts: this.persisted.boosts.map((b) =>
                b.id === existing.id
                  ? { ...b, enabled: true, zappedSelectors: [...b.zappedSelectors, selector] }
                  : b
              ),
            };
          } else {
            this.persisted = {
              ...this.persisted,
              boosts: [
                ...this.persisted.boosts,
                {
                  id: `boost-${Date.now()}`,
                  name: `${host} Zaps`,
                  domainPattern: host,
                  enabled: true,
                  css: '',
                  js: '',
                  zappedSelectors: [selector],
                },
              ],
            };
          }
          this.tabManager.applyBoostsToActiveViews();
          this.persistAndBroadcast();
          this.showToast(`Zapped ${selector}`);
        }
        return;
      }

      case 'stop-zapper': {
        this.tabManager.stopZapperOnActiveTab();
        return;
      }

      case 'toggle-adblock': {
        const current = this.persisted.shields;
        const nextMode = current.globalMode === 'disabled' ? current.lastActiveMode || 'standard' : 'disabled';
        this.applyShieldsUpdate({
          ...current,
          globalMode: nextMode,
          ...(nextMode !== 'disabled' ? { lastActiveMode: nextMode } : {}),
        });
        return;
      }

      case 'set-shields-global-mode': {
        const current = this.persisted.shields;
        this.applyShieldsUpdate({
          ...current,
          globalMode: intent.mode,
          ...(intent.mode !== 'disabled' ? { lastActiveMode: intent.mode } : {}),
        });
        return;
      }

      case 'set-shields-site-mode': {
        const current = this.persisted.shields;
        const key = normalizeShieldsSiteKey(intent.domain);
        if (!key) return;
        const nextOverrides = { ...current.siteOverrides };
        if (intent.mode === 'inherit') {
          delete nextOverrides[key];
        } else {
          nextOverrides[key] = intent.mode;
        }
        this.applyShieldsUpdate({ ...current, siteOverrides: nextOverrides }, key);
        return;
      }

      case 'set-shields-strip-params': {
        const current = this.persisted.shields;
        this.applyShieldsUpdate({ ...current, stripTrackingParams: intent.enabled });
        return;
      }

      case 'set-shields-cosmetic-enabled': {
        const current = this.persisted.shields;
        this.applyShieldsUpdate({ ...current, cosmeticFilteringEnabled: intent.enabled });
        return;
      }

      case 'toggle-filter-list': {
        const current = this.persisted.shields;
        const nextLists = current.filterLists.map((l) =>
          l.id === intent.listId ? { ...l, enabled: intent.enabled } : l
        );
        this.applyShieldsUpdate({ ...current, filterLists: nextLists });
        return;
      }

      case 'update-filter-lists': {
        if (this.updatingShieldsLists) return;
        this.updatingShieldsLists = true;
        this.broadcastState();
        try {
          const { lists, updatedCount } = await this.shieldsEngine.updateAllEnabledLists();
          if (this.disposed) return;
          this.persisted = {
            ...this.persisted,
            shields: {
              ...this.persisted.shields,
              filterLists: lists,
              lastGlobalUpdateAt: Date.now(),
            },
          };
          this.applyCosmeticsToVisibleTabs();
          this.persistAndBroadcast();
          this.showToast(`Updated ${updatedCount} filter list${updatedCount === 1 ? '' : 's'}`);
        } finally {
          this.updatingShieldsLists = false;
          if (!this.disposed) this.broadcastState();
        }
        return;
      }

      case 'restore-default-filter-lists': {
        const defaults = this.shieldsEngine.restoreDefaultLists();
        this.applyShieldsUpdate({ ...this.persisted.shields, filterLists: defaults });
        this.showToast('Restored default Shields filter lists');
        return;
      }

      case 'add-shields-cosmetic-rule': {
        const key = normalizeShieldsSiteKey(intent.domain);
        const sel = intent.selector.trim();
        if (!key || !sel) return;
        const current = this.persisted.shields;
        const existing = current.customCosmeticRules[key] ?? [];
        if (existing.includes(sel)) return;
        this.applyShieldsUpdate(
          {
            ...current,
            customCosmeticRules: {
              ...current.customCosmeticRules,
              [key]: [...existing, sel],
            },
          },
          key
        );
        return;
      }

      case 'remove-shields-cosmetic-rule': {
        const key = normalizeShieldsSiteKey(intent.domain);
        const sel = intent.selector.trim();
        if (!key || !sel) return;
        const current = this.persisted.shields;
        const remaining = (current.customCosmeticRules[key] ?? []).filter((s) => s !== sel);
        const nextMap = { ...current.customCosmeticRules };
        if (remaining.length > 0) nextMap[key] = remaining;
        else delete nextMap[key];
        this.applyShieldsUpdate(
          {
            ...current,
            customCosmeticRules: nextMap,
          },
          key
        );
        return;
      }

      case 'start-element-picker': {
        const focused = getFocusedTab(this.persisted);
        const view = focused ? this.tabManager.getView(focused.id) : undefined;
        if (!focused || !view || view.webContents.isDestroyed()) return;
        this.overlay = { mode: 'none' };
        this.pickerActiveTabId = focused.id;
        this.layoutViews();
        this.broadcastState();
        this.focusActiveTabView();
        const selector = await runShieldsElementPicker(view.webContents);
        this.pickerActiveTabId = null;
        if (selector && !this.disposed) {
          const domainKey = normalizeShieldsSiteKey(focused.url) || '*';
          const current = this.persisted.shields;
          const existing = current.customCosmeticRules[domainKey] ?? [];
          if (!existing.includes(selector)) {
            this.applyShieldsUpdate(
              {
                ...current,
                customCosmeticRules: {
                  ...current.customCosmeticRules,
                  [domainKey]: [...existing, selector],
                },
              },
              domainKey
            );
          }
          this.showToast(`Shields hid ${selector}`);
        } else if (!this.disposed) {
          this.broadcastState();
        }
        return;
      }

      case 'stop-element-picker': {
        if (this.pickerActiveTabId) {
          const view = this.tabManager.getView(this.pickerActiveTabId);
          stopShieldsElementPicker(view?.webContents);
          this.pickerActiveTabId = null;
          this.broadcastState();
        }
        return;
      }

      case 'copy-current-url': {
        const tab = intent.tabId
          ? this.persisted.tabs.find((t) => t.id === intent.tabId)
          : getFocusedTab(this.persisted);
        if (!tab) return;
        const clean = this.persisted.cleanCopyUrl ? stripTrackingParams(tab.url) : tab.url;
        try {
          await clipboard.writeText(clean);
        } catch {
          this.showToast('Unable to copy URL');
          return;
        }
        this.showToast(
          clean !== tab.url ? 'Copied clean URL (tracking stripped)' : 'Copied URL'
        );
        return;
      }

      case 'open-devtools': {
        const focused = getFocusedTab(this.persisted);
        if (!focused) return;
        const view = this.tabManager.getView(focused.id);
        if (view && !view.webContents.isDestroyed()) {
          view.webContents.openDevTools({ mode: 'right' });
        }
        return;
      }

      case 'print-page': {
        const focused = getFocusedTab(this.persisted);
        if (!focused) return;
        const view = this.tabManager.getView(focused.id);
        if (view && !view.webContents.isDestroyed()) {
          view.webContents.print({}, (success, failureReason) => {
            if (!success && failureReason && failureReason !== 'cancelled') {
              this.showToast(`Print failed: ${failureReason}`);
            }
          });
        }
        return;
      }

      case 'save-page-pdf': {
        const focused = getFocusedTab(this.persisted);
        const view = focused ? this.tabManager.getView(focused.id) : undefined;
        if (!focused || !view || view.webContents.isDestroyed() || !this.mainWindow || this.mainWindow.isDestroyed()) {
          return;
        }
        const safeStem = (focused.title || extractHostname(focused.url) || 'page')
          .replace(/[^a-zA-Z0-9._-]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .slice(0, 48) || 'page';
        const saveRes = await dialog.showSaveDialog(this.mainWindow, {
          title: 'Save Page as PDF',
          defaultPath: path.join(app.getPath('documents'), `${safeStem}.pdf`),
          filters: [{ name: 'PDF Document', extensions: ['pdf'] }],
        });
        if (saveRes.canceled || !saveRes.filePath) return;
        try {
          const pdfData = await view.webContents.printToPDF({ printBackground: true });
          await fs.promises.writeFile(saveRes.filePath, pdfData);
          this.showToast(`Saved PDF: ${path.basename(saveRes.filePath)}`);
        } catch {
          this.showToast('Unable to export PDF from this page');
        }
        return;
      }

      case 'toggle-reader-mode': {
        const targetTab = intent.tabId
          ? this.persisted.tabs.find((t) => t.id === intent.tabId)
          : getFocusedTab(this.persisted);
        if (!targetTab) return;
        const view = this.tabManager.getView(targetTab.id);
        if (!view || view.webContents.isDestroyed()) return;

        const cachedDoc = this.readerDocsByTabId.get(targetTab.id);
        if (cachedDoc) {
          this.readerDocsByTabId.delete(targetTab.id);
          this.layoutViews();
          const originalUrl = cachedDoc.originalUrl;
          this.persisted = {
            ...this.persisted,
            tabs: this.persisted.tabs.map((t) =>
              t.id === targetTab.id ? { ...t, url: originalUrl, isLoading: true } : t
            ),
          };
          this.tabManager.navigateTab(targetTab.id, originalUrl);
          this.persistAndBroadcast();
          return;
        }

        if (targetTab.url.startsWith('kinex://') || targetTab.url.startsWith('nook://')) {
          this.showToast('Reader Mode applies to article web pages');
          return;
        }

        const extracted = await extractArticleFromWebContents(view.webContents, targetTab.url);
        if (!extracted.ok) {
          this.showToast(extracted.reason);
          return;
        }

        this.readerDocsByTabId.set(targetTab.id, extracted.doc);
        this.layoutViews();
        const readerUrl = `kinex://reader?tabId=${encodeURIComponent(targetTab.id)}`;
        void view.webContents.loadURL(readerUrl).catch(() => {});
        this.broadcastState();
        return;
      }

      case 'set-reader-options': {
        const nextFont =
          typeof intent.options.fontSize === 'number'
            ? Math.min(28, Math.max(12, Math.round(intent.options.fontSize)))
            : this.persisted.readerOptions.fontSize;
        const nextTheme = intent.options.theme ?? this.persisted.readerOptions.theme;
        this.persisted = {
          ...this.persisted,
          readerOptions: { fontSize: nextFont, theme: nextTheme },
        };
        for (const tabId of this.readerDocsByTabId.keys()) {
          const view = this.tabManager.getView(tabId);
          if (view && !view.webContents.isDestroyed()) {
            void view.webContents.reloadIgnoringCache();
          }
        }
        this.persistAndBroadcast();
        return;
      }

      case 'open-incognito': {
        this.auxiliaryWindows.openPrivateWindow(intent.url);
        return;
      }

      case 'find-in-page': {
        const focused = getFocusedTab(this.persisted);
        const view = focused ? this.tabManager.getView(focused.id) : undefined;
        if (!focused || !view || view.webContents.isDestroyed()) return;
        if (!intent.text) {
          this.findQueryByTabId.delete(focused.id);
          this.findStatus = null;
          view.webContents.stopFindInPage('clearSelection');
          this.scheduleBroadcast();
        } else {
          this.findQueryByTabId.set(focused.id, intent.text);
          view.webContents.findInPage(intent.text, {
            forward: intent.forward ?? true,
            findNext: intent.findNext ?? false,
          });
        }
        return;
      }

      case 'stop-find-in-page': {
        const focused = getFocusedTab(this.persisted);
        const view = focused ? this.tabManager.getView(focused.id) : undefined;
        if (focused) {
          this.findQueryByTabId.delete(focused.id);
        }
        this.findStatus = null;
        if (view && !view.webContents.isDestroyed()) {
          view.webContents.stopFindInPage('clearSelection');
        }
        await this.handleIntent({ type: 'set-overlay', overlay: { mode: 'none' } });
        return;
      }

      case 'promote-little-nook': {
        this.openUrl(intent.url, 'new-tab');
        return;
      }

      case 'import-browser-data': {
        const res = await runBrowserImport(intent.source, this.persisted.activeSpaceId, this.mainWindow);
        if ('cancelled' in res) return;
        if ('error' in res) {
          this.showToast(res.error);
          return;
        }
        if (res.imported.tabs.length === 0) {
          this.showToast('No bookmarks found to import');
          return;
        }
        this.persisted = {
          ...this.persisted,
          folders: [...this.persisted.folders, ...res.imported.folders],
          tabs: [...this.persisted.tabs, ...res.imported.tabs],
        };
        this.persistAndBroadcast();
        this.showToast(`Imported ${res.imported.tabs.length} bookmarks from ${res.label}`);
        return;
      }

      case 'set-default-browser': {
        app.setAsDefaultProtocolClient('http');
        app.setAsDefaultProtocolClient('https');
        this.cachedIsDefaultBrowser =
          app.isDefaultProtocolClient('http') && app.isDefaultProtocolClient('https');
        this.lastDefaultCheckAt = Date.now();
        this.broadcastState();
        this.showToast('Requested default browser permission in macOS');
        return;
      }

      case 'show-download-in-finder': {
        if (!this.downloadManager.showInFinder(intent.savePath)) {
          this.showToast('Download file not available in tracked downloads');
        }
        return;
      }

      case 'pause-download': {
        if (!this.downloadManager.pauseDownload(intent.downloadId)) {
          this.showToast('Download cannot be paused');
        }
        return;
      }

      case 'resume-download': {
        if (!this.downloadManager.resumeDownload(intent.downloadId)) {
          this.showToast('Server or session does not support resuming this download');
        }
        return;
      }

      case 'cancel-download': {
        this.downloadManager.cancelDownload(intent.downloadId);
        return;
      }

      case 'open-download': {
        if (!this.downloadManager.openCompletedDownload(intent.downloadId)) {
          this.showToast('Completed download file could not be opened');
        }
        return;
      }

      case 'clear-completed-downloads': {
        this.downloadManager.clearCompleted();
        return;
      }

      case 'set-update-feed-url': {
        this.persisted = { ...this.persisted, updateFeedUrl: intent.url };
        this.persistAndBroadcast();
        return;
      }

      case 'check-for-updates': {
        await this.updater.checkForUpdates(false);
        return;
      }

      case 'download-update': {
        await this.updater.downloadUpdate();
        return;
      }

      case 'install-update': {
        this.updater.quitAndInstall();
        return;
      }

      case 'set-memory-saver-timeout': {
        this.persisted = { ...this.persisted, memorySaverTimeout: intent.timeout };
        this.persistAndBroadcast();
        if (intent.timeout !== 'disabled') {
          void this.runMemorySaverSweep();
        }
        return;
      }

      case 'set-memory-saver-exempt-pinned': {
        this.persisted = { ...this.persisted, memorySaverExemptPinned: intent.exempt };
        this.persistAndBroadcast();
        return;
      }

      case 'discard-tab': {
        const discarded = await this.tryDiscardTab(intent.tabId, true);
        if (!discarded) {
          this.showToast('Tab cannot be put to sleep while active, playing media, or holding form input');
        }
        return;
      }

      case 'set-new-tab-config': {
        this.persisted = {
          ...this.persisted,
          newTabConfig: { ...this.persisted.newTabConfig, ...intent.config },
        };
        this.refreshVisibleInternalPages();
        this.persistAndBroadcast();
        return;
      }
    }
  }

  private applyCosmeticsToVisibleTabs(): void {
    const activeIds = getActiveSplit(this.persisted).tabIds;
    for (const tabId of activeIds) {
      const view = this.tabManager.getView(tabId);
      const tab = this.persisted.tabs.find((t) => t.id === tabId);
      if (view && !view.webContents.isDestroyed()) {
        void this.shieldsCosmetics.applyForWebContents(view.webContents, tab?.url);
      }
    }
  }

  private applyShieldsUpdate(
    nextShields: PersistedKinexData['shields'],
    affectedDomainKey?: string
  ): void {
    const prevModeByTab = new Map<string, string>();
    const activeIds = getActiveSplit(this.persisted).tabIds;
    for (const id of activeIds) {
      const t = this.persisted.tabs.find((tab) => tab.id === id);
      if (t) {
        prevModeByTab.set(id, this.shieldsEngine.resolveModeForPage(t.url).mode);
      }
    }

    this.shieldsEngine.updateSettings(nextShields);
    const updatedMeta = this.shieldsEngine.getSettings().filterLists;
    const syncedShields = { ...nextShields, filterLists: updatedMeta };

    this.persisted = {
      ...this.persisted,
      shields: syncedShields,
      adBlockEnabled: syncedShields.globalMode !== 'disabled',
    };

    for (const id of activeIds) {
      const t = this.persisted.tabs.find((tab) => tab.id === id);
      if (!t || t.url.startsWith('kinex://') || t.url.startsWith('nook://')) continue;
      const nextResolved = this.shieldsEngine.resolveModeForPage(t.url);
      if (
        prevModeByTab.get(id) !== nextResolved.mode ||
        (affectedDomainKey && normalizeShieldsSiteKey(t.url) === affectedDomainKey && prevModeByTab.get(id) !== nextResolved.mode)
      ) {
        this.needsReloadByTabId.add(id);
      }
    }

    this.applyCosmeticsToVisibleTabs();
    this.persistAndBroadcast();
  }

  private buildNewTabContext(): NewTabRenderContext {
    const activeSpace =
      this.persisted.spaces.find((s) => s.id === this.persisted.activeSpaceId) ??
      this.persisted.spaces[0];
    const engine = SEARCH_ENGINES[this.persisted.searchEngine] ?? SEARCH_ENGINES.google;
    const favorites = this.persisted.tabs
      .filter(
        (t) =>
          t.spaceId === activeSpace?.id &&
          (t.location === 'topApp' || t.location === 'pinned') &&
          /^https?:\/\//i.test(t.url)
      )
      .slice(0, 6)
      .map((t) => ({
        title: t.title || extractHostname(t.url) || t.url,
        url: t.url,
        host: extractHostname(t.url),
      }));
    const frequent = [...this.persisted.history]
      .filter((h) => /^https?:\/\//i.test(h.url))
      .sort((a, b) => b.visitCount - a.visitCount || b.visitedAt - a.visitedAt)
      .slice(0, 6)
      .map((h) => ({
        title: h.title || extractHostname(h.url) || h.url,
        url: h.url,
        host: extractHostname(h.url),
      }));

    return {
      isDark: activeSpace?.theme.isDark ?? true,
      spaceName: activeSpace?.name,
      accent: activeSpace?.theme.accent,
      searchEngineName: engine.name,
      searchEngineTemplate: engine.template,
      config: this.persisted.newTabConfig,
      favorites,
      frequent,
      getReaderHtml: (readerUrl: string) => {
        try {
          const parsed = new URL(readerUrl);
          const tabId = parsed.searchParams.get('tabId') ?? '';
          const doc = this.readerDocsByTabId.get(tabId);
          return doc ? renderReaderHtml(doc, this.persisted.readerOptions) : null;
        } catch {
          return null;
        }
      },
    };
  }

  private refreshVisibleInternalPages(): void {
    const activeIds = getActiveSplit(this.persisted).tabIds;
    for (const tabId of activeIds) {
      const tab = this.persisted.tabs.find((t) => t.id === tabId);
      if (
        tab &&
        (tab.url.startsWith('kinex://newtab') ||
          tab.url.startsWith('kinex://welcome') ||
          tab.url.startsWith('nook://newtab') ||
          tab.url.startsWith('nook://welcome'))
      ) {
        const view = this.tabManager.getView(tabId);
        if (view && !view.webContents.isDestroyed()) {
          void view.webContents.reloadIgnoringCache();
        }
      }
    }
  }

  showTabContextMenu(tabId: string): void {
    const tab = this.persisted.tabs.find((t) => t.id === tabId);
    if (!tab || !this.mainWindow || this.mainWindow.isDestroyed()) return;

    const spaceFolders = this.persisted.folders.filter((f) => f.spaceId === tab.spaceId);
    const otherSpaces = this.persisted.spaces.filter((s) => s.id !== tab.spaceId);
    const otherUnpinnedCount = this.persisted.tabs.filter(
      (t) => t.spaceId === tab.spaceId && t.location === 'unpinned' && t.id !== tabId
    ).length;
    const unpinnedInSpace = this.persisted.tabs.filter(
      (t) => t.spaceId === tab.spaceId && t.location === 'unpinned'
    );
    const tabIdxInSpace = unpinnedInSpace.findIndex((t) => t.id === tabId);
    const hasTabsToRight = tab.location === 'unpinned' && tabIdxInSpace >= 0 && tabIdxInSpace < unpinnedInSpace.length - 1;

    const orderedTabs = this.persisted.tabs.filter((t) => t.spaceId === tab.spaceId && t.location === tab.location);
    const position = orderedTabs.findIndex((t) => t.id === tabId);
    const reorder = (direction: -1 | 1) => {
      const target = orderedTabs[position + direction];
      if (target) void this.handleIntent({ type: 'reorder-tab', sourceTabId: tabId, targetTabId: target.id });
    };

    const menu = Menu.buildFromTemplate([
      {
        label: 'Reload Tab',
        click: () => this.tabManager.reloadTab(tabId),
      },
      {
        label: 'Duplicate Tab',
        click: () => void this.handleIntent({ type: 'duplicate-tab', tabId }),
      },
      {
        label: 'Open in Split View',
        click: () => void this.handleIntent({ type: 'toggle-split', tabId }),
      },
      {
        label: 'Open in Little Kinex',
        click: () => void this.handleIntent({ type: 'open-url', url: tab.url, target: 'little-kinex' }),
      },
      { type: 'separator' },
      {
        label: tab.location === 'pinned' ? 'Unpin Tab' : 'Pin Tab',
        click: () =>
          void this.handleIntent({
            type: 'set-tab-location',
            tabId,
            location: tab.location === 'pinned' ? 'unpinned' : 'pinned',
          }),
      },
      {
        label: tab.location === 'topApp' ? 'Remove from Favorites' : 'Add to Favorites',
        click: () =>
          void this.handleIntent({
            type: 'set-tab-location',
            tabId,
            location: tab.location === 'topApp' ? 'unpinned' : 'topApp',
          }),
      },
      ...(otherSpaces.length > 0
        ? [
            {
              label: 'Move to Space',
              submenu: otherSpaces.map((sp) => ({
                label: `${sp.icon} ${sp.name}`,
                click: () => void this.handleIntent({ type: 'move-tab-to-space', tabId, spaceId: sp.id }),
              })),
            },
          ]
        : []),
      ...(spaceFolders.length > 0
        ? [
            {
              label: 'Move to Folder',
              submenu: spaceFolders.map((f) => ({
                label: f.name,
                click: () => void this.handleIntent({ type: 'move-tab-to-folder', tabId, folderId: f.id }),
              })),
            },
          ]
        : []),
      ...(tab.folderId ? [{
        label: 'Remove from Folder',
        click: () => void this.handleIntent({ type: 'move-tab-to-folder', tabId }),
      }] : []),
      { label: 'Move Tab Up', enabled: position > 0, click: () => reorder(-1) },
      { label: 'Move Tab Down', enabled: position >= 0 && position < orderedTabs.length - 1, click: () => reorder(1) },
      { type: 'separator' },
      {
        label: tab.isMuted ? 'Unmute Tab' : 'Mute Tab',
        click: () => void this.handleIntent({ type: 'toggle-mute', tabId }),
      },
      {
        label: 'Copy Clean URL',
        click: () => void this.handleIntent({ type: 'copy-current-url', tabId }),
      },
      ...(this.tabManager.getView(tabId) && !tab.isDiscarded
        ? [
            {
              label: 'Put Tab to Sleep',
              click: () => void this.handleIntent({ type: 'discard-tab', tabId }),
            },
          ]
        : []),
      { type: 'separator' },
      {
        label: tab.location === 'unpinned' ? 'Close Tab' : 'Reset to Pinned URL',
        click: () => void this.handleIntent({ type: 'close-tab', tabId }),
      },
      {
        label: 'Close Other Tabs',
        enabled: otherUnpinnedCount > 0,
        click: () => void this.handleIntent({ type: 'close-other-tabs', tabId }),
      },
      {
        label: 'Close Tabs to the Right',
        enabled: hasTabsToRight,
        click: () => void this.handleIntent({ type: 'close-tabs-to-right', tabId }),
      },
      {
        label: 'Reopen Closed Tab',
        enabled: this.persisted.closedTabs.length > 0,
        click: () => void this.handleIntent({ type: 'reopen-closed-tab' }),
      },
    ]);
    menu.popup({ window: this.mainWindow });
  }

  getLittleKinexInfo(senderId: number): LittleKinexInfo {
    return this.auxiliaryWindows.getInfo(senderId);
  }

  handleLittleKinexAction(senderId: number, action: LittleKinexAction, url?: string): void {
    this.auxiliaryWindows.handleAction(senderId, action, url);
  }

  // Backward-compatible method aliases during transition
  getLittleNookInfo(senderId: number): LittleKinexInfo {
    return this.getLittleKinexInfo(senderId);
  }

  handleLittleNookAction(senderId: number, action: LittleKinexAction, url?: string): void {
    this.handleLittleKinexAction(senderId, action, url);
  }

  private installApplicationMenu(): void {
    buildAndInstallApplicationMenu({ executeCommand: (id) => void this.executeCommand(id) });
  }

  private attachKeyboard(wc: WebContents): void {
    wc.on('before-input-event', (event, input) => {
      const command = matchShortcut(input, process.platform);
      if (!command) return;
      event.preventDefault();
      if (input.isAutoRepeat && !['next-tab', 'previous-tab', 'zoom-in', 'zoom-out'].includes(command)) return;
      void this.executeCommand(command, wc);
    });
  }

  private attachOverlayFocusGuard(wc: WebContents): void {
    wc.on('focus', () => {
      if (this.enforcingOverlayFocus || this.disposed) return;
      if (this.overlayClosing) {
        if (wc.id !== this.overlayView?.webContents.id) return;
        if (!this.mainWindow || this.mainWindow.isDestroyed() || !this.mainWindow.isFocused()) return;
        if (this.overlayFocusRedirects >= 3) return;
        this.overlayFocusRedirects += 1;
        this.enforcingOverlayFocus = true;
        try {
          this.restoreOverlayFocus();
        } finally {
          this.enforcingOverlayFocus = false;
        }
        return;
      }
      if (this.overlay.mode === 'none' && !this.duplicatePrompt) return;
      if (!this.mainWindow || this.mainWindow.isDestroyed() || !this.mainWindow.isFocused()) return;
      const overlayWc = this.overlayView?.webContents;
      if (!overlayWc || overlayWc.isDestroyed() || overlayWc.id === wc.id || overlayWc.isFocused()) return;
      this.enforcingOverlayFocus = true;
      try {
        overlayWc.focus();
      } finally {
        this.enforcingOverlayFocus = false;
      }
    });
  }

  private captureOverlayOrigin(): void {
    if (this.overlay.mode !== 'none' || this.duplicatePrompt) return;
    const focused = webContents.getFocusedWebContents();
    this.overlayOrigin = focused?.id === this.shellView?.webContents.id ? 'shell' : 'content';
  }

  private restoreOverlayFocus(): void {
    if (this.overlayOrigin === 'shell' && this.shellView && !this.shellView.webContents.isDestroyed()) {
      this.shellView.webContents.send('kinex:focus-requested', 'restore');
      this.requestNativeFocus(() => this.shellView?.webContents ?? null);
    } else this.focusActiveTabView();
  }

  private focusBrowserRegion(region: FocusRegion): void {
    if (region === 'content') {
      this.focusActiveTabView();
      return;
    }
    if (region === 'sidebar' && !this.persisted.sidebarOpen) {
      this.persisted = { ...this.persisted, sidebarOpen: true };
      this.layoutViews();
      this.persistAndBroadcast();
    }
    this.shellRegion = region;
    const wc = this.shellView?.webContents;
    if (wc && !wc.isDestroyed()) {
      wc.send('kinex:focus-requested', region);
      this.requestNativeFocus(() => this.shellView?.webContents ?? null);
    }
  }

  async executeCommand(commandId: CommandId, source = webContents.getFocusedWebContents()): Promise<void> {
    if (this.disposed) return;
    if (this.auxiliaryWindows.executeCommand(commandId, source ?? undefined)) return;
    const popup = source && this.tabManager.getPopupWindow(source.id);
    if (popup && source) {
      switch (commandId) {
        case 'close-tab': case 'close-window': popup.close(); break;
        case 'reload': source.reload(); break;
        case 'stop-loading': source.stop(); break;
        case 'back': if (source.navigationHistory.canGoBack()) source.navigationHistory.goBack(); break;
        case 'forward': if (source.navigationHistory.canGoForward()) source.navigationHistory.goForward(); break;
        case 'copy-url': await clipboard.writeText(source.getURL()).catch(() => this.showToast('Unable to copy URL')); break;
        case 'print-page': source.print({ printBackground: true }); break;
        case 'devtools': source.openDevTools({ mode: 'detach' }); break;
      }
      return;
    }
    const state = this.persisted;
    const tab = getFocusedTab(state);
    const split = getActiveSplit(state);
    const overlay = (value: OverlayState) => this.handleIntent({ type: 'set-overlay', overlay: value });
    const closeOverlay = async () => {
      if (this.overlay.mode !== 'none') await overlay({ mode: 'none' });
    };
    if (commandId.startsWith('select-tab-')) {
      const visible = state.tabs.filter((t) => t.spaceId === state.activeSpaceId);
      const index = Number(commandId.slice(-1));
      const target = visible[index === 9 ? visible.length - 1 : index - 1];
      await closeOverlay();
      if (target) await this.handleIntent({ type: 'select-tab', tabId: target.id });
      return;
    }
    if (commandId.startsWith('select-space-')) {
      const target = state.spaces[Number(commandId.slice(-1)) - 1];
      await closeOverlay();
      if (target) await this.handleIntent({ type: 'select-space', spaceId: target.id });
      return;
    }
    switch (commandId) {
      case 'new-tab':
      case 'edit-url':
        await overlay({ mode: 'command-bar', initialQuery: commandId === 'edit-url' && tab && /^https?:/.test(tab.url) ? tab.url : '', targetMode: commandId === 'edit-url' ? 'edit-url' : 'new-tab' });
        return;
      case 'open-settings': await overlay({ mode: 'settings' }); return;
      case 'open-shortcuts': await overlay({ mode: 'settings', section: 'shortcuts' }); return;
      case 'clear-history': await overlay({ mode: 'settings', section: 'privacy' }); return;
      case 'check-updates':
        await overlay({ mode: 'settings', section: 'updates' });
        await this.handleIntent({ type: 'check-for-updates' }); return;
      case 'open-downloads': await overlay({ mode: 'downloads' }); return;
      case 'open-history': await overlay({ mode: 'history' }); return;
      case 'open-archive': await overlay({ mode: 'archive' }); return;
      case 'find-in-page': await overlay({ mode: 'find' }); return;
      case 'new-space': await overlay({ mode: 'space-editor' }); return;
      case 'rename-space': await overlay({ mode: 'space-editor', spaceId: state.activeSpaceId }); return;
      case 'open-shields': await overlay({ mode: 'shields' }); return;
      case 'toggle-boosts': await overlay({ mode: 'boosts', domain: extractHostname(tab?.url ?? '') || '*' }); return;
    }
    await closeOverlay();
    switch (commandId) {
      case 'close-tab': if (tab) await this.handleIntent({ type: 'close-tab', tabId: tab.id }); break;
      case 'duplicate-current-tab': if (tab) await this.handleIntent({ type: 'duplicate-tab', tabId: tab.id }); break;
      case 'close-other-tabs': if (tab) await this.handleIntent({ type: 'close-other-tabs', tabId: tab.id }); break;
      case 'pin-tab': if (tab) await this.handleIntent({ type: 'set-tab-location', tabId: tab.id, location: tab.location === 'pinned' ? 'unpinned' : 'pinned' }); break;
      case 'favorite-tab': if (tab) await this.handleIntent({ type: 'set-tab-location', tabId: tab.id, location: tab.location === 'topApp' ? 'pinned' : 'topApp' }); break;
      case 'reopen-closed-tab': await this.handleIntent({ type: 'reopen-closed-tab' }); break;
      case 'reload': await this.handleIntent({ type: 'nav-reload' }); break;
      case 'stop-loading': await this.handleIntent({ type: 'nav-stop' }); break;
      case 'back': await this.handleIntent({ type: 'nav-back' }); break;
      case 'forward': await this.handleIntent({ type: 'nav-forward' }); break;
      case 'print-page': await this.handleIntent({ type: 'print-page' }); break;
      case 'save-page-pdf': await this.handleIntent({ type: 'save-page-pdf' }); break;
      case 'toggle-reader-mode': await this.handleIntent({ type: 'toggle-reader-mode' }); break;
      case 'toggle-sidebar': await this.handleIntent({ type: 'toggle-sidebar' }); break;
      case 'new-split': await this.handleIntent({ type: 'toggle-split' }); break;
      case 'next-pane': await this.handleIntent({ type: 'focus-pane', paneIndex: (split.focusedIndex + 1) % split.tabIds.length }); break;
      case 'toggle-adblock': await this.handleIntent({ type: 'toggle-adblock' }); break;
      case 'activate-element-picker': await this.handleIntent({ type: 'start-element-picker' }); break;
      case 'copy-url': await this.handleIntent({ type: 'copy-current-url' }); break;
      case 'zoom-in': await this.handleIntent({ type: 'set-zoom', delta: 'in' }); break;
      case 'zoom-out': await this.handleIntent({ type: 'set-zoom', delta: 'out' }); break;
      case 'zoom-reset': await this.handleIntent({ type: 'set-zoom', delta: 'reset' }); break;
      case 'devtools': await this.handleIntent({ type: 'open-devtools' }); break;
      case 'open-private-window': await this.handleIntent({ type: 'open-incognito' }); break;
      case 'little-kinex': await this.handleIntent({ type: 'open-url', url: 'kinex://newtab', target: 'little-kinex' }); break;
      case 'close-window': BrowserWindow.getFocusedWindow()?.close(); break;
      case 'toggle-dark-mode': {
        const space = state.spaces.find((s) => s.id === state.activeSpaceId);
        if (space) await this.handleIntent({ type: 'update-space', ...space, spaceId: space.id,
          theme: { ...space.theme, isDark: !space.theme.isDark, tintRgba: space.theme.isDark ? 'rgba(240, 241, 245, 0.94)' : 'rgba(26, 27, 33, 0.94)' } });
        break;
      }
      case 'next-tab':
      case 'previous-tab': {
        const tabs = state.tabs.filter((t) => t.spaceId === state.activeSpaceId);
        const index = tabs.findIndex((t) => t.id === tab?.id);
        const next = tabs[(index + (commandId === 'next-tab' ? 1 : -1) + tabs.length) % tabs.length];
        if (next) await this.handleIntent({ type: 'select-tab', tabId: next.id });
        break;
      }
      case 'next-space':
      case 'previous-space': {
        const index = state.spaces.findIndex((s) => s.id === state.activeSpaceId);
        const next = state.spaces[(index + (commandId === 'next-space' ? 1 : -1) + state.spaces.length) % state.spaces.length];
        if (next) await this.handleIntent({ type: 'select-space', spaceId: next.id });
        break;
      }
      case 'focus-content': this.focusBrowserRegion('content'); break;
      case 'focus-sidebar': this.focusBrowserRegion('sidebar'); break;
      case 'focus-toolbar': this.focusBrowserRegion('toolbar'); break;
      case 'focus-next':
      case 'focus-previous': {
        const regions: FocusRegion[] = ['content', 'sidebar', 'toolbar'];
        const current = source?.id === this.shellView?.webContents.id ? this.shellRegion : 'content';
        const index = (regions.indexOf(current) + (commandId === 'focus-next' ? 1 : -1) + regions.length) % regions.length;
        this.focusBrowserRegion(regions[index]); break;
      }
    }
  }

  cleanupWindowResources(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelPendingFocus();
    this.focusOnWindowActivation = false;
    this.runtimeListenersActive = false;
    powerMonitor.removeListener('speed-limit-change', this.onSpeedLimit);
    powerMonitor.removeListener('thermal-state-change', this.onThermalState);
    if (this.overlayCloseTimer) clearTimeout(this.overlayCloseTimer);
    this.overlayCloseTimer = null;
    this.overlayClosing = false;

    this.persistence.flushPendingSave(this.persisted);

    if (this.toastTimer) {
      clearTimeout(this.toastTimer);
      this.toastTimer = null;
    }
    if (this.broadcastTimer) {
      clearTimeout(this.broadcastTimer);
      this.broadcastTimer = null;
    }
    if (this.memorySaverTimer) {
      clearInterval(this.memorySaverTimer);
      this.memorySaverTimer = null;
    }
    if (this.startupUpdateTimer) {
      clearTimeout(this.startupUpdateTimer);
      this.startupUpdateTimer = null;
    }
    if (this.periodicUpdateTimer) {
      clearInterval(this.periodicUpdateTimer);
      this.periodicUpdateTimer = null;
    }

    this.tabManager.disposeAll();
    this.auxiliaryWindows.disposeAll();
    this.tabOwnerByTabId.clear();
    this.windowIdBySenderId.clear();
    for (const context of this.contexts.values()) {
      if (context.overlayCloseTimer) clearTimeout(context.overlayCloseTimer);
    }
    this.contexts.clear();
    this.windowRegistry.list().forEach((record) => this.windowRegistry.unregister(record.id));
    this.tabIdByWcId.clear();
    this.needsReloadByTabId.clear();
    this.pickerActiveTabId = null;
    this.findQueryByTabId.clear();
    this.readerDocsByTabId.clear();
    this.findStatus = null;
    this.duplicatePrompt = null;
    this.htmlFullscreenTabId = null;

    if (this.shellView) {
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        try {
          this.mainWindow.contentView.removeChildView(this.shellView);
        } catch {
          // Ignore already removed view
        }
      }
      if (!this.shellView.webContents.isDestroyed()) {
        this.ipcRegistry.unregister(this.shellView.webContents.id);
        this.shellView.webContents.close();
      }
    }
    if (this.overlayView) {
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        try {
          this.mainWindow.contentView.removeChildView(this.overlayView);
        } catch {
          // Ignore already removed view
        }
      }
      if (!this.overlayView.webContents.isDestroyed()) {
        this.ipcRegistry.unregister(this.overlayView.webContents.id);
        this.overlayView.webContents.close();
      }
    }

    this.shellView = null;
    this.overlayView = null;
    this.mainWindow = null;
  }

  dispose(): void {
    this.cleanupWindowResources();
    this.downloadManager.dispose();
    this.updater.dispose();
    this.shieldsEngine.dispose();
  }
}

export function registerKinexProtocol(protocolObj: Electron.Protocol): void {
  registerDefaultAppProtocols(protocolObj);
}

/** @deprecated Use KinexWindowManager */
export const NookWindowManager = KinexWindowManager;
/** @deprecated Use registerKinexProtocol */
export const registerNookProtocol = registerKinexProtocol;
/** @deprecated Use registerKinexProtocolOnSession */
export const registerNookProtocolOnSession = registerKinexProtocolOnSession;
