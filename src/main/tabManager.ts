import { clipboard, Menu, WebContentsView, type BrowserWindow, type MenuItemConstructorOptions, type Session, type WebContents } from 'electron';
import { applyBoostsToWebContents, runElementZapper } from './boosts';
import type { BoostRule, TabItem } from '../shared/types';
import type { NavigationManager } from './navigationManager';
import { classifySecurityState, isSafeNavigationUrl } from './security';

export type PageContextAction =
  | { type: 'open-link'; url: string; target: 'new-tab' | 'new-tab-background' | 'split' | 'little-kinex' | 'private'; spaceId?: string }
  | { type: 'find' }
  | { type: 'print' }
  | { type: 'save-pdf' }
  | { type: 'toggle-reader'; tabId: string };

export interface TabManagerHost {
  onWebContentsCreated: (wc: WebContents) => void;
  onTabWebContentsCreated?: (tabId: string, wc: WebContents) => void;
  onTabWebContentsDestroyed?: (wcId: number) => void;
  onApplyShieldsCosmetics?: (wc: WebContents, url?: string) => Promise<void> | void;
  getMainWindow: () => BrowserWindow | null;
  getTabById: (tabId: string) => TabItem | undefined;
  updateTab: (tabId: string, patch: Partial<TabItem>, persist?: boolean) => void;
  getSessionForTab: (tab: TabItem) => Session;
  getPartitionForTab: (tab: TabItem) => string;
  getBoosts: () => BoostRule[];
  getZoomForUrl: (url: string) => number | undefined;
  onNavigationFinished: (tabId: string, url: string, title: string) => void;
  onOpenPopupInTab: (sourceTabId: string, url: string, disposition: 'foreground' | 'background') => void;
  onSpaceMismatchCheck: (tabId: string, url: string) => boolean;
  onFoundInPage: (tabId: string, result: { activeMatchOrdinal: number; matches: number; finalUpdate: boolean }) => void;
  onPageContextAction: (action: PageContextAction) => void;
  onHtmlFullscreenChanged?: (tabId: string, isFullscreen: boolean) => void;
  onStateChanged: () => void;
  onShowToast: (message: string) => void;
}

export class TabManager {
  private readonly popupWindows = new Set<BrowserWindow>();
  private readonly tabViews = new Map<string, WebContentsView>();
  private readonly injectedCssKeys = new Map<number, string[]>();
  private readonly certErrorTabIds = new Set<string>();
  private readonly throttlingStateByWc = new Map<number, boolean>();
  private zapperActiveTabId: string | null = null;
  private disposed = false;

  constructor(
    private readonly host: TabManagerHost,
    private readonly navigationManager: NavigationManager
  ) {}

  getPopupWindow(webContentsId: number): BrowserWindow | undefined {
    return [...this.popupWindows].find((win) => !win.isDestroyed() && win.webContents.id === webContentsId);
  }

  getView(tabId: string): WebContentsView | undefined {
    return this.tabViews.get(tabId);
  }

  getAllViews(): Map<string, WebContentsView> {
    return this.tabViews;
  }

  getZapperActiveTabId(): string | null {
    return this.zapperActiveTabId;
  }

  hasCertError(tabId: string): boolean {
    return this.certErrorTabIds.has(tabId);
  }

  getActiveViewCount(): number {
    return this.tabViews.size;
  }

  resetForNewWindow(): void {
    this.disposed = false;
  }

  ensureTabView(tabId: string): WebContentsView | null {
    if (this.disposed) return null;
    const existing = this.tabViews.get(tabId);
    if (existing) {
      if (!existing.webContents.isDestroyed()) {
        return existing;
      }
      this.tabViews.delete(tabId);
    }

    const tab = this.host.getTabById(tabId);
    const mainWindow = this.host.getMainWindow();
    if (!tab || !mainWindow || mainWindow.isDestroyed()) return null;

    const sess = this.host.getSessionForTab(tab);
    if (tab.isDiscarded) {
      this.host.updateTab(tabId, { isDiscarded: false, isLoading: true }, false);
    }
    const view = new WebContentsView({
      webPreferences: {
        session: sess,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        navigateOnDragDrop: false,
        backgroundThrottling: true,
        scrollBounce: true,
      },
    });

    view.setBackgroundColor('#00000000');
    view.setVisible(false);
    view.setBounds({ x: -10000, y: -10000, width: 100, height: 100 });
    mainWindow.contentView.addChildView(view);
    this.tabViews.set(tabId, view);

    const wc = view.webContents;
    this.host.onWebContentsCreated(wc);
    this.host.onTabWebContentsCreated?.(tabId, wc);
    wc.on('dom-ready', () => {
      if (!this.disposed && !wc.isDestroyed()) {
        void this.host.onApplyShieldsCosmetics?.(wc);
      }
    });
    wc.setAudioMuted(tab.isMuted);
    const savedZoom = tab.zoomFactor ?? this.host.getZoomForUrl(tab.url);
    if (savedZoom) {
      wc.setZoomFactor(savedZoom);
    }

    this.navigationManager.attachWebContentsGuards(wc, {
      isPrivate: false,
      partitionKey: this.host.getPartitionForTab(tab),
      tabId,
      onWillNavigateRoute: (targetUrl) => this.host.onSpaceMismatchCheck(tabId, targetUrl),
      onTitleUpdated: (title) => {
        if (this.disposed) return;
        const currentUrl = wc.isDestroyed() ? '' : wc.getURL();
        if (currentUrl.startsWith('kinex://crashed') || currentUrl.startsWith('nook://crashed')) {
          return;
        }
        this.host.updateTab(tabId, { title: title || tab.url }, true);
      },
      onLoadingChanged: (isLoading) => {
        if (this.disposed) return;
        this.host.updateTab(tabId, { isLoading }, false);
      },
      onCertErrorChanged: (hasError) => {
        if (hasError) {
          this.certErrorTabIds.add(tabId);
        } else {
          this.certErrorTabIds.delete(tabId);
        }
        const cur = this.host.getTabById(tabId);
        if (cur) {
          this.host.updateTab(
            tabId,
            { securityState: classifySecurityState(cur.url, hasError) },
            false
          );
        }
      },
      onNavigationStateChanged: (url) => {
        if (this.disposed || wc.isDestroyed()) return;
        if (url.startsWith('kinex://crashed') || url.startsWith('nook://crashed')) {
          this.host.updateTab(tabId, { isCrashed: true, isLoading: false }, false);
          return;
        }
        const canGoBack = wc.navigationHistory.canGoBack();
        const canGoForward = wc.navigationHistory.canGoForward();
        const hasCert = this.certErrorTabIds.has(tabId);
        this.host.updateTab(
          tabId,
          {
            url,
            isCrashed: false,
            canGoBack,
            canGoForward,
            securityState: classifySecurityState(url, hasCert),
          },
          true
        );
        void this.host.onApplyShieldsCosmetics?.(wc, url);
      },
      onDidFinishNavigation: (url, title) => {
        if (this.disposed || wc.isDestroyed()) return;
        if (url.startsWith('kinex://crashed') || url.startsWith('nook://crashed')) {
          this.host.updateTab(tabId, { isCrashed: true, isLoading: false }, false);
          return;
        }
        const canGoBack = wc.navigationHistory.canGoBack();
        const canGoForward = wc.navigationHistory.canGoForward();
        const hasCert = this.certErrorTabIds.has(tabId);
        const hostZoom = this.host.getZoomForUrl(url);
        if (hostZoom !== undefined && Math.abs(wc.getZoomFactor() - hostZoom) > 0.01) {
          wc.setZoomFactor(hostZoom);
        }
        this.host.updateTab(
          tabId,
          {
            url,
            title: title || url,
            isLoading: false,
            isCrashed: false,
            canGoBack,
            canGoForward,
            zoomFactor: hostZoom ?? this.host.getTabById(tabId)?.zoomFactor,
            securityState: classifySecurityState(url, hasCert),
          },
          true
        );
        void applyBoostsToWebContents(wc, this.host.getBoosts(), this.injectedCssKeys);
        void this.host.onApplyShieldsCosmetics?.(wc, url);
        this.host.onNavigationFinished(tabId, url, title);
      },
      onFoundInPage: (result) => {
        if (!this.disposed) {
          this.host.onFoundInPage(tabId, result);
        }
      },
      onDidCreatePopupWindow: (popup) => {
        this.popupWindows.add(popup);
        this.host.onWebContentsCreated(popup.webContents);
        popup.once('closed', () => this.popupWindows.delete(popup));
      },
      onOpenInTab: (url, disposition) => {
        if (!this.disposed) {
          this.host.onOpenPopupInTab(tabId, url, disposition);
        }
      },
    });

    wc.on('context-menu', (_event, params) => {
      if (this.disposed || wc.isDestroyed()) return;
      const parentWin = this.host.getMainWindow();
      if (!parentWin || parentWin.isDestroyed()) return;
      const currentTab = this.host.getTabById(tabId);
      const safeLink = params.linkURL && isSafeNavigationUrl(params.linkURL) ? params.linkURL : '';
      const items: MenuItemConstructorOptions[] = [];

      if (safeLink) {
        items.push(
          {
            label: 'Open Link in New Tab',
            click: () =>
              this.host.onPageContextAction({
                type: 'open-link',
                url: safeLink,
                target: 'new-tab',
                spaceId: currentTab?.spaceId,
              }),
          },
          {
            label: 'Open Link in Background Tab',
            click: () =>
              this.host.onPageContextAction({
                type: 'open-link',
                url: safeLink,
                target: 'new-tab-background',
                spaceId: currentTab?.spaceId,
              }),
          },
          {
            label: 'Open Link in Split View',
            click: () =>
              this.host.onPageContextAction({
                type: 'open-link',
                url: safeLink,
                target: 'split',
                spaceId: currentTab?.spaceId,
              }),
          },
          {
            label: 'Open Link in Little Kinex',
            click: () =>
              this.host.onPageContextAction({
                type: 'open-link',
                url: safeLink,
                target: 'little-kinex',
              }),
          },
          {
            label: 'Open Link in Private Window',
            click: () =>
              this.host.onPageContextAction({
                type: 'open-link',
                url: safeLink,
                target: 'private',
              }),
          },
          {
            label: 'Copy Link Address',
            click: () => clipboard.writeText(safeLink),
          },
          { type: 'separator' }
        );
      }

      if (params.isEditable) {
        items.push(
          { role: 'cut', enabled: params.editFlags.canCut },
          { role: 'copy', enabled: params.editFlags.canCopy },
          { role: 'paste', enabled: params.editFlags.canPaste },
          { role: 'selectAll' },
          { type: 'separator' }
        );
      } else if (params.selectionText) {
        items.push({ role: 'copy' }, { type: 'separator' });
      }

      items.push(
        {
          label: 'Back',
          enabled: wc.navigationHistory.canGoBack(),
          click: () => wc.navigationHistory.goBack(),
        },
        {
          label: 'Forward',
          enabled: wc.navigationHistory.canGoForward(),
          click: () => wc.navigationHistory.goForward(),
        },
        {
          label: wc.isLoading() ? 'Stop Loading' : 'Reload',
          click: () => (wc.isLoading() ? wc.stop() : wc.reload()),
        },
        { type: 'separator' },
        {
          label: 'Toggle Reader Mode',
          click: () => this.host.onPageContextAction({ type: 'toggle-reader', tabId }),
        },
        {
          label: 'Find in Page...',
          click: () => this.host.onPageContextAction({ type: 'find' }),
        },
        {
          label: 'Print...',
          click: () => this.host.onPageContextAction({ type: 'print' }),
        },
        {
          label: 'Save Page as PDF...',
          click: () => this.host.onPageContextAction({ type: 'save-pdf' }),
        },
        { type: 'separator' },
        {
          label: 'Inspect Element',
          click: () => {
            if (!wc.isDestroyed()) {
              wc.inspectElement(params.x, params.y);
            }
          },
        }
      );

      Menu.buildFromTemplate(items).popup({ window: parentWin });
    });

    wc.on('page-favicon-updated', (_e, favicons) => {
      if (this.disposed) return;
      if (favicons.length > 0) {
        this.host.updateTab(tabId, { favicon: favicons[0] }, true);
      }
    });

    wc.on('media-started-playing', () => {
      if (!this.disposed) this.host.updateTab(tabId, { isAudible: true }, false);
    });

    wc.on('media-paused', () => {
      if (!this.disposed) this.host.updateTab(tabId, { isAudible: false }, false);
    });

    wc.on('enter-html-full-screen', () => {
      if (!this.disposed) this.host.onHtmlFullscreenChanged?.(tabId, true);
    });

    wc.on('leave-html-full-screen', () => {
      if (!this.disposed) this.host.onHtmlFullscreenChanged?.(tabId, false);
    });

    wc.on('unresponsive', () => {
      if (!this.disposed) {
        this.host.onShowToast('A background or active tab became unresponsive');
      }
    });

    wc.on('responsive', () => {
      if (!this.disposed) {
        this.host.onStateChanged();
      }
    });

    wc.on('render-process-gone', (_event, details) => {
      if (this.disposed) return;
      this.host.onHtmlFullscreenChanged?.(tabId, false);
      this.injectedCssKeys.delete(wc.id);
      if (this.zapperActiveTabId === tabId) {
        this.zapperActiveTabId = null;
      }
      const currentTab = this.host.getTabById(tabId);
      const lastUrl = currentTab?.url || '';
      this.host.updateTab(
        tabId,
        {
          isLoading: false,
          isCrashed: true,
        },
        false
      );
      this.host.onShowToast(`Tab stopped unexpectedly (${details.reason})`);
      if (!wc.isDestroyed() && lastUrl && !lastUrl.startsWith('kinex://crashed')) {
        const crashUrl = `kinex://crashed?url=${encodeURIComponent(lastUrl)}&reason=${encodeURIComponent(details.reason)}`;
        void wc.loadURL(crashUrl).catch(() => {});
      }
    });

    wc.once('destroyed', () => {
      if (!this.disposed) {
        this.host.onHtmlFullscreenChanged?.(tabId, false);
      }
      this.host.onTabWebContentsDestroyed?.(wc.id);
      this.injectedCssKeys.delete(wc.id);
      this.certErrorTabIds.delete(tabId);
      this.throttlingStateByWc.delete(wc.id);
      if (this.tabViews.get(tabId) === view) {
        this.tabViews.delete(tabId);
      }
      if (this.zapperActiveTabId === tabId) {
        this.zapperActiveTabId = null;
      }
    });

    void this.navigationManager.navigateWebContents(wc, tab.url);
    return view;
  }

  navigateTab(tabId: string, rawUrl: string): void {
    const view = this.ensureTabView(tabId);
    if (!view || view.webContents.isDestroyed()) return;
    void this.navigationManager.navigateWebContents(view.webContents, rawUrl);
  }

  reloadTab(tabId: string): void {
    const tab = this.host.getTabById(tabId);
    const existing = this.tabViews.get(tabId);
    if (!existing || existing.webContents.isDestroyed()) {
      this.tabViews.delete(tabId);
      this.ensureTabView(tabId);
      return;
    }
    const currentWcUrl = existing.webContents.getURL();
    if (tab?.isCrashed || currentWcUrl.startsWith('kinex://crashed')) {
      if (existing.webContents.isLoading()) existing.webContents.stop();
      this.host.updateTab(tabId, { isCrashed: false }, false);
      if (tab && !tab.url.startsWith('kinex://crashed')) {
        void this.navigationManager.navigateWebContents(existing.webContents, tab.url);
        return;
      }
    }
    existing.webContents.reload();
  }

  applyBoostsToActiveViews(): void {
    const boosts = this.host.getBoosts();
    for (const view of this.tabViews.values()) {
      if (!view.webContents.isDestroyed()) {
        void applyBoostsToWebContents(view.webContents, boosts, this.injectedCssKeys);
      }
    }
  }

  async startZapperOnTab(tabId: string): Promise<string | null> {
    const view = this.ensureTabView(tabId);
    if (!view || view.webContents.isDestroyed()) return null;
    this.zapperActiveTabId = tabId;
    this.host.onStateChanged();
    try {
      return await runElementZapper(view.webContents);
    } finally {
      if (this.zapperActiveTabId === tabId) {
        this.zapperActiveTabId = null;
        this.host.onStateChanged();
      }
    }
  }

  stopZapperOnActiveTab(): void {
    if (!this.zapperActiveTabId) return;
    const view = this.tabViews.get(this.zapperActiveTabId);
    if (view && !view.webContents.isDestroyed()) {
      void view.webContents
        .executeJavaScript('window.__kinexZapperCleanup?.(null) || window.__nookZapperCleanup?.(null)')
        .catch(() => {});
    }
    this.zapperActiveTabId = null;
    this.host.onStateChanged();
  }

  destroyTabView(tabId: string): void {
    this.certErrorTabIds.delete(tabId);
    if (this.zapperActiveTabId === tabId) {
      this.zapperActiveTabId = null;
    }
    const view = this.tabViews.get(tabId);
    if (!view) return;
    this.tabViews.delete(tabId);

    const wcId = view.webContents.isDestroyed() ? null : view.webContents.id;
    if (wcId !== null) {
      this.injectedCssKeys.delete(wcId);
      this.throttlingStateByWc.delete(wcId);
      this.navigationManager.clearWcTracking(wcId);
    }

    const mainWindow = this.host.getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      try {
        mainWindow.contentView.removeChildView(view);
      } catch {
        // Ignore already removed view
      }
    }
    if (!view.webContents.isDestroyed()) {
      view.webContents.close();
    }
  }

  syncBackgroundThrottling(
    _visibleTabIds: Set<string>,
    isWindowHidden: boolean,
    hasProtectedActivity: (wcId: number) => boolean
  ): void {
    // Electron docs: disabling backgroundThrottling on ANY WebContents in a BrowserWindow forces
    // frame swaps for the whole window & all sibling views. Keep backgroundThrottling enabled (true)
    // everywhere so Chromium throttles only truly backgrounded views natively, and unthrottle
    // exclusively for active media-capture/download tabs when the window is occluded.
    for (const view of this.tabViews.values()) {
      const wc = view.webContents;
      if (wc.isDestroyed()) continue;
      if (typeof wc.setBackgroundThrottling === 'function') {
        const forceKeepAwake = isWindowHidden && hasProtectedActivity(wc.id);
        const nextAllowed = !forceKeepAwake;
        const prevAllowed = this.throttlingStateByWc.get(wc.id) ?? true;
        if (prevAllowed !== nextAllowed) {
          this.throttlingStateByWc.set(wc.id, nextAllowed);
          wc.setBackgroundThrottling(nextAllowed);
        }
      }
    }
  }

  async hasPotentiallyUnsavedFormData(tabId: string): Promise<boolean> {
    const view = this.tabViews.get(tabId);
    if (!view || view.webContents.isDestroyed()) return false;
    const wc = view.webContents;
    if (wc.isLoading()) return true;

    const checkScript = `(() => {
      try {
        if (typeof window.onbeforeunload === 'function') return true;
        const fields = document.querySelectorAll('input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]), textarea, [contenteditable="true"], [contenteditable=""]');
        for (let i = 0; i < fields.length && i < 150; i++) {
          const el = fields[i];
          if (el.isContentEditable) {
            if ((el.textContent || '').trim().length > 0) return true;
          } else if ('value' in el && 'defaultValue' in el && el.value !== el.defaultValue) {
            return true;
          }
        }
        return false;
      } catch {
        return true;
      }
    })()`;

    try {
      const result = await Promise.race<boolean>([
        wc.executeJavaScript(checkScript, false).then((v) => Boolean(v)),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 250)),
      ]);
      return result;
    } catch {
      return true;
    }
  }

  discardTabView(tabId: string): boolean {
    if (!this.tabViews.has(tabId)) return false;
    this.destroyTabView(tabId);
    this.host.updateTab(
      tabId,
      { isDiscarded: true, isLoading: false, isAudible: false },
      true
    );
    return true;
  }

  disposeAll(): void {
    for (const popup of this.popupWindows) if (!popup.isDestroyed()) popup.close();
    this.popupWindows.clear();
    this.disposed = true;
    const ids = Array.from(this.tabViews.keys());
    for (const id of ids) {
      this.destroyTabView(id);
    }
    this.tabViews.clear();
    this.injectedCssKeys.clear();
    this.certErrorTabIds.clear();
    this.throttlingStateByWc.clear();
    this.zapperActiveTabId = null;
  }
}
