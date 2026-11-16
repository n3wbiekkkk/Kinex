import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  Menu,
  session,
  shell,
  WebContentsView,
} from 'electron';
import {
  clearTodayTabsForSpace,
  closeOrResetTab,
  extractHostname,
  getActiveSplit,
  getFocusedTab,
  normalizeNavigationInput,
  reorderTabs,
  setTabLocation,
} from '../shared/domain';
import {
  parseArcStorableSidebarJson,
  parseChromeBookmarksJson,
  parseHtmlBookmarks,
} from '../shared/importer';
import type {
  BoostRule,
  DownloadItem,
  NookIntent,
  NookStateSnapshot,
  OverlayState,
  PersistedNookData,
  Space,
  TabItem,
} from '../shared/types';
import { attachAdBlocker } from './adblock';
import { applyBoostsToWebContents, runElementZapper } from './boosts';
import { NookPersistence } from './persistence';
import {
  classifySecurityState,
  isDangerousPermission,
  isSafeNavigationUrl,
  matchAirTrafficSpace,
  stripTrackingParams,
  upgradeUrlToHttpsIfNeeded,
} from './security';
import { NookAutoUpdater } from './updater';

const FRAME_PAD = 8;
const TOP_BAR_HEIGHT = 42;
const SPLIT_GAP = 6;

interface LittleNookWindowState {
  win: BrowserWindow;
  webView: WebContentsView;
  url: string;
  title: string;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

const registeredNookProtocolSessions = new WeakSet<Electron.Session>();
const configuredPermissionSessions = new WeakSet<Electron.Session>();

export function registerNookProtocolOnSession(sess: Electron.Session): void {
  if (registeredNookProtocolSessions.has(sess)) return;
  registeredNookProtocolSessions.add(sess);
  const { renderNookInternalHtml } = require('./internalPages') as typeof import('./internalPages');
  const handler = (request: { url: string }) => {
    const html = renderNookInternalHtml(request.url);
    return new Response(html, {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  };
  sess.protocol.handle('kinex', handler);
  sess.protocol.handle('nook', handler);
}

export class NookWindowManager {
  private readonly persistence: NookPersistence;
  private data: PersistedNookData;
  private overlay: OverlayState = { mode: 'none' };
  private downloads: DownloadItem[] = [];
  private blockedRequestsCount = 0;
  private zapperActiveTabId: string | null = null;
  private toastMessage: string | null = null;
  private toastTimer: NodeJS.Timeout | null = null;
  private htmlFullscreenTabId: string | null = null;

  private mainWindow: BrowserWindow | null = null;
  private overlayView: WebContentsView | null = null;
  private readonly tabViews = new Map<string, WebContentsView>();
  private readonly injectedCssKeys = new Map<number, string[]>();
  private littleNook: LittleNookWindowState | null = null;
  private readonly miniWindows = new Map<number, LittleNookWindowState>();
  private readonly devServerUrl: string | undefined;
  private readonly updater: NookAutoUpdater;
  private updateCheckTimer: NodeJS.Timeout | null = null;

  private readonly insecureFallbackHosts = new Set<string>();
  private readonly certErrorTabIds = new Set<string>();
  private readonly allowedCertOrigins = new Set<string>();
  private manualUpdateCheck = false;

  constructor(userDataDir: string, devServerUrl?: string) {
    this.persistence = new NookPersistence(userDataDir);
    this.data = this.persistence.load();
    this.devServerUrl = devServerUrl;
    this.updater = new NookAutoUpdater(
      () => this.data.updateFeedUrl,
      (status) => {
        if (status.state === 'downloaded') {
          this.manualUpdateCheck = false;
          this.showToast(`Kinex v${status.version} ready — click Restart to update`);
        } else if (this.manualUpdateCheck && status.state === 'up-to-date') {
          this.manualUpdateCheck = false;
          this.showToast(`Kinex v${status.version} is up to date`);
        } else if (this.manualUpdateCheck && status.state === 'error') {
          this.manualUpdateCheck = false;
          this.showToast(`Update error: ${status.message}`);
        }
        this.broadcastState();
      }
    );
  }

  focusMainWindow(): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      if (this.mainWindow.isMinimized()) this.mainWindow.restore();
      this.mainWindow.show();
      this.mainWindow.focus();
    } else {
      void this.createMainWindow();
    }
  }

  getSnapshot(): NookStateSnapshot {
    return {
      ...this.data,
      overlay: this.overlay,
      downloads: this.downloads,
      blockedRequestsCount: this.blockedRequestsCount,
      zapperActiveTabId: this.zapperActiveTabId,
      toastMessage: this.toastMessage,
      isDefaultBrowser: app.isDefaultProtocolClient('https'),
      appVersion: app.getVersion(),
      updateStatus: this.updater.getStatus(),
    };
  }

  getLittleNookInfo(senderId?: number) {
    const target = (senderId ? this.miniWindows.get(senderId) : undefined) ?? this.littleNook;
    if (!target) {
      return { url: '', title: 'Little Kinex', isLoading: false, canGoBack: false, canGoForward: false };
    }
    return {
      url: target.url,
      title: target.title,
      isLoading: target.isLoading,
      canGoBack: target.canGoBack,
      canGoForward: target.canGoForward,
    };
  }

  private getPreloadPath(): string {
    return path.join(__dirname, '../preload/shell.js');
  }

  private getRendererUrl(viewQuery?: string): string {
    if (this.devServerUrl) {
      return viewQuery ? `${this.devServerUrl}?view=${viewQuery}` : this.devServerUrl;
    }
    const indexPath = path.join(__dirname, '../../dist/index.html');
    const url = new URL(`file://${indexPath}`);
    if (viewQuery) url.searchParams.set('view', viewQuery);
    return url.toString();
  }

  async createMainWindow(): Promise<BrowserWindow> {
    const preloadPath = this.getPreloadPath();
    this.mainWindow = new BrowserWindow({
      width: 1360,
      height: 860,
      minWidth: 880,
      minHeight: 580,
      title: 'Kinex',
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 14, y: 15 },
      backgroundColor: '#00000000',
      vibrancy: 'under-window',
      visualEffectState: 'active',
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    this.overlayView = new WebContentsView({
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        transparent: true,
      },
    });
    this.overlayView.setBackgroundColor('#00000000');
    await this.overlayView.webContents.loadURL(this.getRendererUrl('overlay'));

    await this.mainWindow.loadURL(this.getRendererUrl());

    this.mainWindow.on('resize', () => this.layoutViews());
    this.mainWindow.on('closed', () => {
      if (this.updateCheckTimer) clearInterval(this.updateCheckTimer);
      this.updater.dispose();
      this.mainWindow = null;
      this.overlayView = null;
      this.tabViews.clear();
    });

    this.installApplicationMenu();
    this.syncActiveTabViews();
    this.layoutViews();
    this.broadcastState();

    setTimeout(() => {
      void this.updater.checkForUpdates(true);
    }, 8000);
    this.updateCheckTimer = setInterval(() => {
      void this.updater.checkForUpdates(true);
    }, 4 * 60 * 60 * 1000);

    return this.mainWindow;
  }

  private broadcastState(): void {
    const snapshot = this.getSnapshot();
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('nook:state-updated', snapshot);
    }
    if (this.overlayView && !this.overlayView.webContents.isDestroyed()) {
      this.overlayView.webContents.send('nook:state-updated', snapshot);
    }
  }

  private persistAndBroadcast(): void {
    this.persistence.save(this.data);
    this.broadcastState();
  }

  private showToast(message: string): void {
    this.toastMessage = message;
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      this.toastMessage = null;
      this.broadcastState();
    }, 2400);
    this.broadcastState();
  }

  private getSessionForSpace(spaceId: string): Electron.Session {
    const space = this.data.spaces.find((s) => s.id === spaceId);
    const partition = space?.profilePartition || 'persist:nook-default';
    const sess = session.fromPartition(partition);
    registerNookProtocolOnSession(sess);
    this.attachPermissions(sess);
    attachAdBlocker(
      sess,
      () => this.data.adBlockEnabled,
      () => {
        this.blockedRequestsCount += 1;
        this.broadcastState();
      }
    );
    this.attachDownloadTracker(sess);
    return sess;
  }

  private attachPermissions(sess: Electron.Session): void {
    if (configuredPermissionSessions.has(sess)) return;
    configuredPermissionSessions.add(sess);

    const autoAllow = new Set(['fullscreen', 'clipboard-sanitized-write', 'mediaKeySystem']);
    sess.setPermissionRequestHandler((wc, permission, callback) => {
      if (isDangerousPermission(permission)) {
        callback(false);
        return;
      }
      if (autoAllow.has(permission)) {
        callback(true);
        return;
      }
      let origin = '';
      try {
        origin = new URL(wc.getURL()).origin;
      } catch {
        callback(false);
        return;
      }
      const existing = this.data.sitePermissions.find(
        (p) => p.origin === origin && p.permission === permission
      );
      if (existing) {
        callback(existing.decision === 'allow');
        return;
      }
      if (!this.mainWindow || this.mainWindow.isDestroyed()) {
        callback(false);
        return;
      }
      void dialog
        .showMessageBox(this.mainWindow, {
          type: 'question',
          buttons: ['Allow', 'Block'],
          defaultId: 1,
          cancelId: 1,
          title: 'Site Permission Request',
          message: `${origin} wants to access "${permission}"`,
        })
        .then((res) => {
          const decision = res.response === 0 ? 'allow' : 'deny';
          this.data = {
            ...this.data,
            sitePermissions: [
              ...this.data.sitePermissions.filter(
                (p) => !(p.origin === origin && p.permission === permission)
              ),
              { origin, permission, decision, updatedAt: Date.now() },
            ],
          };
          this.persistAndBroadcast();
          callback(decision === 'allow');
        })
        .catch(() => callback(false));
    });
  }

  private readonly trackedDownloadSessions = new WeakSet<Electron.Session>();
  private attachDownloadTracker(sess: Electron.Session): void {
    if (this.trackedDownloadSessions.has(sess)) return;
    this.trackedDownloadSessions.add(sess);

    sess.on('will-download', (_event, item) => {
      const id = `dl-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const entry: DownloadItem = {
        id,
        filename: item.getFilename(),
        url: item.getURL(),
        savePath: item.getSavePath(),
        receivedBytes: 0,
        totalBytes: item.getTotalBytes(),
        state: 'progressing',
        startedAt: Date.now(),
      };
      this.downloads = [entry, ...this.downloads].slice(0, 30);
      this.showToast(`Downloading ${entry.filename}`);

      item.on('updated', () => {
        this.downloads = this.downloads.map((d) =>
          d.id === id
            ? {
                ...d,
                savePath: item.getSavePath() || d.savePath,
                receivedBytes: item.getReceivedBytes(),
                totalBytes: item.getTotalBytes(),
              }
            : d
        );
        this.broadcastState();
      });

      item.once('done', (_e, state) => {
        this.downloads = this.downloads.map((d) =>
          d.id === id
            ? {
                ...d,
                savePath: item.getSavePath() || d.savePath,
                receivedBytes: item.getReceivedBytes(),
                totalBytes: item.getTotalBytes(),
                state,
              }
            : d
        );
        if (state === 'completed') {
          this.showToast(`Downloaded ${entry.filename}`);
        }
        this.broadcastState();
      });
    });
  }

  private attachWebContentsContextMenu(wc: WebContentsView['webContents'], tabId: string): void {
    wc.on('context-menu', (_event, params) => {
      const items: Electron.MenuItemConstructorOptions[] = [];

      if (params.linkURL) {
        items.push(
          {
            label: 'Open Link in New Tab',
            click: () => void this.handleIntent({ type: 'open-url', url: params.linkURL, target: 'new-tab' }),
          },
          {
            label: 'Open Link in Split View',
            click: () => void this.handleIntent({ type: 'open-url', url: params.linkURL, target: 'split' }),
          },
          {
            label: 'Open Link in Little Kinex',
            click: () => void this.handleIntent({ type: 'open-url', url: params.linkURL, target: 'little-nook' }),
          },
          {
            label: 'Copy Link Address',
            click: () => {
              clipboard.writeText(params.linkURL);
              this.showToast('Copied Link Address');
            },
          },
          { type: 'separator' }
        );
      }

      if (params.mediaType === 'image' && params.srcURL) {
        items.push(
          {
            label: 'Save Image As...',
            click: () => wc.downloadURL(params.srcURL),
          },
          {
            label: 'Copy Image',
            click: () => wc.copyImageAt(params.x, params.y),
          },
          { type: 'separator' }
        );
      }

      if (params.isEditable) {
        items.push(
          { role: 'cut', enabled: params.editFlags.canCut },
          { role: 'copy', enabled: params.editFlags.canCopy },
          { role: 'paste', enabled: params.editFlags.canPaste },
          { role: 'selectAll', enabled: params.editFlags.canSelectAll },
          { type: 'separator' }
        );
      } else if (params.selectionText) {
        const snippet = params.selectionText.trim().slice(0, 40);
        items.push(
          { role: 'copy' },
          {
            label: `Search for "${snippet}${params.selectionText.length > 40 ? '...' : ''}"`,
            click: () =>
              void this.handleIntent({
                type: 'open-url',
                url: params.selectionText.trim(),
                target: 'new-tab',
              }),
          },
          { type: 'separator' }
        );
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
          label: 'Reload',
          click: () => wc.reload(),
        },
        { type: 'separator' },
        {
          label: 'Zap Element (Boost)',
          click: () => {
            void this.handleIntent({ type: 'select-tab', tabId }).then(() =>
              this.handleIntent({ type: 'start-zapper' })
            );
          },
        },
        {
          label: 'Inspect Element',
          click: () => wc.inspectElement(params.x, params.y),
        }
      );

      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        Menu.buildFromTemplate(items).popup({ window: this.mainWindow });
      }
    });
  }

  private ensureTabView(tab: TabItem): WebContentsView {
    const existing = this.tabViews.get(tab.id);
    if (existing && !existing.webContents.isDestroyed()) {
      return existing;
    }

    const sess = this.getSessionForSpace(tab.spaceId);
    const view = new WebContentsView({
      webPreferences: {
        session: sess,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        navigateOnDragDrop: false,
      },
    });
    view.setBorderRadius(10);
    view.setBackgroundColor('#ffffff');

    const wc = view.webContents;
    if (typeof tab.zoomFactor === 'number' && tab.zoomFactor > 0) {
      wc.setZoomFactor(tab.zoomFactor);
    }

    const syncNavMeta = () => {
      const url = wc.getURL() || tab.url;
      const title = wc.getTitle() || url;
      const securityState = classifySecurityState(url, this.certErrorTabIds.has(tab.id));
      this.updateTab(tab.id, {
        url,
        title,
        isLoading: wc.isLoading(),
        canGoBack: wc.navigationHistory.canGoBack(),
        canGoForward: wc.navigationHistory.canGoForward(),
        securityState,
      });
    };

    wc.on('will-navigate', (event, targetUrl) => {
      if (!isSafeNavigationUrl(targetUrl)) {
        event.preventDefault();
        this.showToast('Blocked unsafe navigation protocol');
        return;
      }
      const upgraded = upgradeUrlToHttpsIfNeeded(
        targetUrl,
        this.data.httpsOnly,
        this.insecureFallbackHosts
      );
      if (upgraded !== targetUrl) {
        event.preventDefault();
        void wc.loadURL(upgraded);
      }
    });

    wc.on('did-fail-load', (_e, errorCode, _desc, validatedURL, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return;
      if (this.data.httpsOnly && validatedURL.startsWith('https://')) {
        try {
          const parsed = new URL(validatedURL);
          if (!this.insecureFallbackHosts.has(parsed.hostname.toLowerCase())) {
            this.insecureFallbackHosts.add(parsed.hostname.toLowerCase());
            parsed.protocol = 'http:';
            this.showToast(`HTTPS unavailable for ${parsed.hostname} — falling back to HTTP`);
            void wc.loadURL(parsed.toString());
          }
        } catch {
          // Ignore malformed fallback URL
        }
      }
    });

    wc.on('certificate-error', (event, url, error, _cert, callback) => {
      event.preventDefault();
      let origin = url;
      try {
        origin = new URL(url).origin;
      } catch {
        // Keep raw URL
      }
      if (this.allowedCertOrigins.has(origin)) {
        callback(true);
        return;
      }
      this.certErrorTabIds.add(tab.id);
      this.updateTab(tab.id, { securityState: 'cert-warning' });
      if (!this.mainWindow || this.mainWindow.isDestroyed()) {
        callback(false);
        return;
      }
      void dialog
        .showMessageBox(this.mainWindow, {
          type: 'warning',
          buttons: ['Go Back (Safe)', 'Proceed Anyway'],
          defaultId: 0,
          cancelId: 0,
          title: 'Certificate Warning',
          message: `Kinex cannot verify the identity of ${origin} (${error}).`,
        })
        .then((res) => {
          const proceed = res.response === 1;
          if (proceed) this.allowedCertOrigins.add(origin);
          callback(proceed);
        })
        .catch(() => callback(false));
    });

    wc.on('did-start-loading', () => {
      this.certErrorTabIds.delete(tab.id);
      this.updateTab(tab.id, { isLoading: true });
    });
    wc.on('did-stop-loading', syncNavMeta);
    wc.on('did-navigate', (_e, url) => {
      syncNavMeta();
      this.recordHistory(url, wc.getTitle() || url);
    });
    wc.on('did-navigate-in-page', syncNavMeta);
    wc.on('page-title-updated', (_e, title) => {
      this.updateTab(tab.id, { title });
      this.recordHistory(wc.getURL(), title);
    });
    wc.on('page-favicon-updated', (_e, favicons) => {
      if (favicons.length > 0) {
        this.updateTab(tab.id, { favicon: favicons[0] });
      }
    });
    wc.on('media-started-playing', () => this.updateTab(tab.id, { isAudible: true }));
    wc.on('media-paused', () => this.updateTab(tab.id, { isAudible: false }));
    wc.on('did-finish-load', () => {
      void applyBoostsToWebContents(wc, this.data.boosts, this.injectedCssKeys);
    });
    wc.on('dom-ready', () => {
      void applyBoostsToWebContents(wc, this.data.boosts, this.injectedCssKeys);
    });
    wc.on('enter-html-full-screen', () => {
      this.htmlFullscreenTabId = tab.id;
      this.layoutViews();
    });
    wc.on('leave-html-full-screen', () => {
      this.htmlFullscreenTabId = null;
      this.layoutViews();
    });
    wc.on('render-process-gone', (_e, details) => {
      this.showToast(`Tab crashed (${details.reason}) — click Reload to recover`);
      this.updateTab(tab.id, { isLoading: false });
    });

    this.attachWebContentsContextMenu(wc, tab.id);

    wc.setWindowOpenHandler(({ url, disposition, features }) => {
      if (features && (features.includes('width=') || features.includes('popup'))) {
        return { action: 'allow' };
      }
      if (disposition === 'new-window') {
        void this.openLittleNook(url);
        return { action: 'deny' };
      }
      void this.handleIntent({ type: 'open-url', url, target: 'new-tab' });
      return { action: 'deny' };
    });

    this.tabViews.set(tab.id, view);
    void wc.loadURL(tab.url);
    return view;
  }

  private updateTab(tabId: string, patch: Partial<TabItem>): void {
    let changed = false;
    this.data = {
      ...this.data,
      tabs: this.data.tabs.map((t) => {
        if (t.id !== tabId) return t;
        changed = true;
        return { ...t, ...patch };
      }),
    };
    if (changed) {
      this.persistAndBroadcast();
    }
  }

  private recordHistory(url: string, title: string): void {
    if (!url || url.startsWith('kinex://') || url.startsWith('nook://') || url.startsWith('about:')) return;
    const existing = this.data.history.find((h) => h.url === url);
    const now = Date.now();
    const updated = existing
      ? [
          { ...existing, title: title || existing.title, visitedAt: now, visitCount: existing.visitCount + 1 },
          ...this.data.history.filter((h) => h.url !== url),
        ]
      : [{ url, title: title || url, visitedAt: now, visitCount: 1 }, ...this.data.history];
    this.data = {
      ...this.data,
      history: updated.slice(0, 300),
    };
    this.persistence.save(this.data);
  }

  private syncActiveTabViews(): void {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
    const contentView = this.mainWindow.contentView;
    const split = getActiveSplit(this.data);
    const activeSet = new Set(split.tabIds);

    for (const [id, view] of this.tabViews.entries()) {
      if (!activeSet.has(id)) {
        try {
          contentView.removeChildView(view);
        } catch {
          // Not attached
        }
      }
    }

    for (const tabId of split.tabIds) {
      const tab = this.data.tabs.find((t) => t.id === tabId);
      if (!tab) continue;
      const view = this.ensureTabView(tab);
      if (!contentView.children.includes(view)) {
        contentView.addChildView(view);
      }
    }

    if (this.overlayView) {
      try {
        contentView.removeChildView(this.overlayView);
      } catch {
        // Not attached
      }
      if (this.overlay.mode !== 'none') {
        contentView.addChildView(this.overlayView);
      }
    }
  }

  private layoutViews(): void {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
    const [width, height] = this.mainWindow.getContentSize();

    if (this.htmlFullscreenTabId) {
      const fsView = this.tabViews.get(this.htmlFullscreenTabId);
      if (fsView) {
        fsView.setBounds({ x: 0, y: 0, width, height });
        if (this.overlayView) this.overlayView.setBounds({ x: 0, y: 0, width: 0, height: 0 });
        return;
      }
    }

    const split = getActiveSplit(this.data);
    const showTopBar = !this.data.sidebarOpen || split.tabIds.length > 1;
    const sidebarW = this.data.sidebarOpen ? this.data.sidebarWidth : 0;
    const areaX = this.data.sidebarOpen ? sidebarW + 4 : FRAME_PAD;
    const areaY = showTopBar ? TOP_BAR_HEIGHT : FRAME_PAD;
    const areaW = Math.max(200, width - areaX - FRAME_PAD);
    const areaH = Math.max(200, height - areaY - FRAME_PAD);

    if (split.tabIds.length === 1) {
      const view = this.tabViews.get(split.tabIds[0]);
      view?.setBounds({ x: areaX, y: areaY, width: areaW, height: areaH });
    } else if (split.tabIds.length === 2) {
      const leftW = Math.max(160, Math.round((areaW - SPLIT_GAP) * (split.splitRatio || 0.5)));
      const rightW = Math.max(160, areaW - SPLIT_GAP - leftW);
      const v0 = this.tabViews.get(split.tabIds[0]);
      const v1 = this.tabViews.get(split.tabIds[1]);
      v0?.setBounds({ x: areaX, y: areaY, width: leftW, height: areaH });
      v1?.setBounds({ x: areaX + leftW + SPLIT_GAP, y: areaY, width: rightW, height: areaH });
    }

    if (this.overlayView) {
      if (this.overlay.mode === 'none') {
        this.overlayView.setBounds({ x: 0, y: 0, width: 0, height: 0 });
      } else {
        this.overlayView.setBounds({ x: 0, y: 0, width, height });
      }
    }
  }

  async handleIntent(intent: NookIntent): Promise<void> {
    switch (intent.type) {
      case 'select-space': {
        if (!this.data.spaces.some((s) => s.id === intent.spaceId)) return;
        this.data = { ...this.data, activeSpaceId: intent.spaceId };
        this.syncActiveTabViews();
        this.layoutViews();
        this.persistAndBroadcast();
        return;
      }

      case 'create-space': {
        const id = `space-${Date.now()}`;
        const newSpace: Space = {
          id,
          name: intent.name.trim() || 'New Space',
          icon: intent.icon || '✦',
          theme: intent.theme,
          profilePartition: intent.profilePartition || 'persist:nook-default',
        };
        const tabId = `tab-${Date.now()}`;
        const welcomeTab: TabItem = {
          id: tabId,
          spaceId: id,
          location: 'unpinned',
          url: 'kinex://newtab',
          title: 'New Tab',
          isLoading: false,
          canGoBack: false,
          canGoForward: false,
          isMuted: false,
          isAudible: false,
          lastActiveAt: Date.now(),
        };
        this.data = {
          ...this.data,
          spaces: [...this.data.spaces, newSpace],
          activeSpaceId: id,
          tabs: [...this.data.tabs, welcomeTab],
          splitsBySpace: {
            ...this.data.splitsBySpace,
            [id]: { tabIds: [tabId], focusedIndex: 0, splitRatio: 0.5 },
          },
        };
        this.overlay = { mode: 'none' };
        this.syncActiveTabViews();
        this.layoutViews();
        this.persistAndBroadcast();
        return;
      }

      case 'update-space': {
        const prevSpace = this.data.spaces.find((s) => s.id === intent.spaceId);
        const nextPartition = intent.profilePartition || prevSpace?.profilePartition || 'persist:nook-default';
        const partitionChanged = prevSpace && prevSpace.profilePartition !== nextPartition;
        this.data = {
          ...this.data,
          spaces: this.data.spaces.map((s) =>
            s.id === intent.spaceId
              ? {
                  ...s,
                  name: intent.name.trim() || s.name,
                  icon: intent.icon || s.icon,
                  theme: intent.theme,
                  profilePartition: nextPartition,
                }
              : s
          ),
        };
        if (partitionChanged) {
          for (const tab of this.data.tabs.filter((t) => t.spaceId === intent.spaceId)) {
            this.destroyTabView(tab.id);
          }
        }
        this.overlay = { mode: 'none' };
        this.syncActiveTabViews();
        this.layoutViews();
        this.persistAndBroadcast();
        return;
      }

      case 'delete-space': {
        if (this.data.spaces.length <= 1) {
          this.showToast('Cannot delete the last Space');
          return;
        }
        const removedTabs = this.data.tabs.filter((t) => t.spaceId === intent.spaceId);
        for (const t of removedTabs) {
          this.destroyTabView(t.id);
        }
        const remainingSpaces = this.data.spaces.filter((s) => s.id !== intent.spaceId);
        const nextActive =
          this.data.activeSpaceId === intent.spaceId ? remainingSpaces[0].id : this.data.activeSpaceId;
        const nextSplits = { ...this.data.splitsBySpace };
        delete nextSplits[intent.spaceId];
        this.data = {
          ...this.data,
          spaces: remainingSpaces,
          folders: this.data.folders.filter((f) => f.spaceId !== intent.spaceId),
          activeSpaceId: nextActive,
          tabs: this.data.tabs.filter((t) => t.spaceId !== intent.spaceId),
          splitsBySpace: nextSplits,
        };
        this.overlay = { mode: 'none' };
        this.syncActiveTabViews();
        this.layoutViews();
        this.persistAndBroadcast();
        return;
      }

      case 'create-profile': {
        const clean = intent.name.trim();
        if (!clean) return;
        const id = `prof-${Date.now()}`;
        const partition = `persist:nook-${id}`;
        this.data = {
          ...this.data,
          profiles: [...this.data.profiles, { id, name: clean, partition }],
        };
        this.persistAndBroadcast();
        this.showToast(`Created profile "${clean}"`);
        return;
      }

      case 'create-folder': {
        const name = intent.name.trim() || 'New Folder';
        const folder = { id: `fld-${Date.now()}`, spaceId: intent.spaceId, name, collapsed: false };
        this.data = { ...this.data, folders: [...this.data.folders, folder] };
        this.persistAndBroadcast();
        return;
      }

      case 'toggle-folder': {
        this.data = {
          ...this.data,
          folders: this.data.folders.map((f) =>
            f.id === intent.folderId ? { ...f, collapsed: !f.collapsed } : f
          ),
        };
        this.persistAndBroadcast();
        return;
      }

      case 'rename-folder': {
        this.data = {
          ...this.data,
          folders: this.data.folders.map((f) =>
            f.id === intent.folderId ? { ...f, name: intent.name.trim() || f.name } : f
          ),
        };
        this.persistAndBroadcast();
        return;
      }

      case 'delete-folder': {
        this.data = {
          ...this.data,
          folders: this.data.folders.filter((f) => f.id !== intent.folderId),
          tabs: this.data.tabs.map((t) =>
            t.folderId === intent.folderId ? { ...t, folderId: undefined } : t
          ),
        };
        this.persistAndBroadcast();
        return;
      }

      case 'move-tab-to-folder': {
        this.data = {
          ...this.data,
          tabs: this.data.tabs.map((t) =>
            t.id === intent.tabId
              ? { ...t, location: 'pinned', pinnedUrl: t.pinnedUrl ?? t.url, folderId: intent.folderId }
              : t
          ),
        };
        this.persistAndBroadcast();
        return;
      }

      case 'reorder-tab': {
        this.data = reorderTabs(this.data, intent.sourceTabId, intent.targetTabId);
        this.persistAndBroadcast();
        return;
      }

      case 'select-tab': {
        const tab = this.data.tabs.find((t) => t.id === intent.tabId);
        if (!tab) return;
        const targetSpaceId = tab.location === 'topApp' ? this.data.activeSpaceId : tab.spaceId;
        const currentSplit = getActiveSplit(this.data, targetSpaceId);
        const nextIds = [...currentSplit.tabIds];
        const existingIdx = nextIds.indexOf(tab.id);
        let nextFocused = currentSplit.focusedIndex;

        if (existingIdx !== -1) {
          nextFocused = existingIdx;
        } else if (typeof intent.paneIndex === 'number' && nextIds.length === 2) {
          nextIds[intent.paneIndex] = tab.id;
          nextFocused = intent.paneIndex;
        } else {
          const replaceIdx = Math.min(currentSplit.focusedIndex, Math.max(0, nextIds.length - 1));
          nextIds[replaceIdx] = tab.id;
          nextFocused = replaceIdx;
        }

        this.data = {
          ...this.data,
          activeSpaceId: targetSpaceId,
          tabs: this.data.tabs.map((t) => (t.id === tab.id ? { ...t, lastActiveAt: Date.now() } : t)),
          splitsBySpace: {
            ...this.data.splitsBySpace,
            [targetSpaceId]: {
              ...currentSplit,
              tabIds: nextIds,
              focusedIndex: nextFocused,
            },
          },
        };
        this.overlay = { mode: 'none' };
        this.syncActiveTabViews();
        this.layoutViews();
        this.persistAndBroadcast();
        return;
      }

      case 'open-url': {
        let normalized = normalizeNavigationInput(intent.url, this.data.searchEngine);
        if (!isSafeNavigationUrl(normalized)) {
          this.showToast('Blocked unsafe URL');
          return;
        }
        normalized = upgradeUrlToHttpsIfNeeded(
          normalized,
          this.data.httpsOnly,
          this.insecureFallbackHosts
        );
        if (intent.target === 'little-nook') {
          this.overlay = { mode: 'none' };
          this.syncActiveTabViews();
          this.layoutViews();
          await this.openLittleNook(normalized);
          this.broadcastState();
          return;
        }

        const routedSpace = intent.spaceId ? null : matchAirTrafficSpace(normalized, this.data.airTrafficRules);
        const spaceId = intent.spaceId ?? routedSpace ?? this.data.activeSpaceId;
        if (intent.target === 'current') {
          const focused = getFocusedTab(this.data);
          if (focused) {
            const view = this.ensureTabView(focused);
            this.overlay = { mode: 'none' };
            this.syncActiveTabViews();
            this.layoutViews();
            await view.webContents.loadURL(normalized);
            this.broadcastState();
            return;
          }
        }

        const newId = `tab-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        const newTab: TabItem = {
          id: newId,
          spaceId,
          location: 'unpinned',
          url: normalized,
          title: normalized,
          isLoading: true,
          canGoBack: false,
          canGoForward: false,
          isMuted: false,
          isAudible: false,
          lastActiveAt: Date.now(),
        };

        const currentSplit = getActiveSplit(this.data, spaceId);
        let nextTabIds: string[];
        let nextFocus: number;

        if (intent.target === 'split') {
          if (currentSplit.tabIds.length === 0) {
            nextTabIds = [newId];
            nextFocus = 0;
          } else {
            nextTabIds = [currentSplit.tabIds[0], newId];
            nextFocus = 1;
          }
        } else {
          nextTabIds = [newId];
          nextFocus = 0;
        }

        this.data = {
          ...this.data,
          activeSpaceId: spaceId,
          tabs: [newTab, ...this.data.tabs],
          splitsBySpace: {
            ...this.data.splitsBySpace,
            [spaceId]: {
              ...currentSplit,
              tabIds: nextTabIds,
              focusedIndex: nextFocus,
            },
          },
        };
        this.overlay = { mode: 'none' };
        this.syncActiveTabViews();
        this.layoutViews();
        this.persistAndBroadcast();
        return;
      }

      case 'close-tab': {
        const res = closeOrResetTab(this.data, intent.tabId);
        this.data = res.next;
        if (res.destroyedTabId) {
          this.destroyTabView(res.destroyedTabId);
        } else if (res.resetTab) {
          const view = this.tabViews.get(res.resetTab.id);
          if (view && !view.webContents.isDestroyed()) {
            void view.webContents.loadURL(res.resetTab.url);
          }
        }
        this.syncActiveTabViews();
        this.layoutViews();
        this.persistAndBroadcast();
        return;
      }

      case 'reset-pinned-tab': {
        const tab = this.data.tabs.find((t) => t.id === intent.tabId);
        if (!tab || !tab.pinnedUrl) return;
        this.updateTab(tab.id, { url: tab.pinnedUrl });
        const view = this.tabViews.get(tab.id);
        if (view && !view.webContents.isDestroyed()) {
          void view.webContents.loadURL(tab.pinnedUrl);
        }
        return;
      }

      case 'set-tab-location': {
        this.data = setTabLocation(this.data, intent.tabId, intent.location);
        this.persistAndBroadcast();
        return;
      }

      case 'clear-today-tabs': {
        const res = clearTodayTabsForSpace(this.data, intent.spaceId);
        this.data = res.next;
        for (const id of res.destroyedTabIds) {
          this.destroyTabView(id);
        }
        this.syncActiveTabViews();
        this.layoutViews();
        this.persistAndBroadcast();
        this.showToast(`Archived ${res.destroyedTabIds.length} Today tab(s)`);
        return;
      }

      case 'restore-archived-tab': {
        const archived = this.data.archivedTabs.find((a) => a.id === intent.archivedId);
        if (!archived) return;
        this.data = {
          ...this.data,
          archivedTabs: this.data.archivedTabs.filter((a) => a.id !== intent.archivedId),
        };
        await this.handleIntent({
          type: 'open-url',
          url: archived.url,
          target: 'new-tab',
          spaceId: this.data.activeSpaceId,
        });
        return;
      }

      case 'toggle-split': {
        const spaceId = this.data.activeSpaceId;
        const current = getActiveSplit(this.data, spaceId);
        if (current.tabIds.length === 2 && !intent.tabId) {
          const keep = current.tabIds[current.focusedIndex] ?? current.tabIds[0];
          this.data = {
            ...this.data,
            splitsBySpace: {
              ...this.data.splitsBySpace,
              [spaceId]: { ...current, tabIds: [keep], focusedIndex: 0 },
            },
          };
          this.syncActiveTabViews();
          this.layoutViews();
          this.persistAndBroadcast();
          return;
        }
        if (intent.tabId) {
          const base = current.tabIds[0];
          const second = intent.tabId === base ? current.tabIds[1] : intent.tabId;
          if (second && second !== base) {
            this.data = {
              ...this.data,
              splitsBySpace: {
                ...this.data.splitsBySpace,
                [spaceId]: { ...current, tabIds: [base, second], focusedIndex: 1 },
              },
            };
            this.syncActiveTabViews();
            this.layoutViews();
            this.persistAndBroadcast();
            return;
          }
        }
        const otherTab = this.data.tabs.find(
          (t) => t.spaceId === spaceId && !current.tabIds.includes(t.id)
        );
        if (otherTab) {
          this.data = {
            ...this.data,
            splitsBySpace: {
              ...this.data.splitsBySpace,
              [spaceId]: { ...current, tabIds: [current.tabIds[0], otherTab.id], focusedIndex: 1 },
            },
          };
          this.syncActiveTabViews();
          this.layoutViews();
          this.persistAndBroadcast();
          return;
        }
        await this.handleIntent({ type: 'open-url', url: 'kinex://newtab', target: 'split' });
        return;
      }

      case 'close-split-pane': {
        const spaceId = this.data.activeSpaceId;
        const current = getActiveSplit(this.data, spaceId);
        if (current.tabIds.length < 2) return;
        const nextIds = current.tabIds.filter((_, idx) => idx !== intent.paneIndex);
        this.data = {
          ...this.data,
          splitsBySpace: {
            ...this.data.splitsBySpace,
            [spaceId]: { ...current, tabIds: nextIds, focusedIndex: 0 },
          },
        };
        this.syncActiveTabViews();
        this.layoutViews();
        this.persistAndBroadcast();
        return;
      }

      case 'set-split-ratio': {
        const spaceId = this.data.activeSpaceId;
        const current = getActiveSplit(this.data, spaceId);
        const clamped = Math.min(0.78, Math.max(0.22, intent.ratio));
        this.data = {
          ...this.data,
          splitsBySpace: {
            ...this.data.splitsBySpace,
            [spaceId]: { ...current, splitRatio: clamped },
          },
        };
        this.layoutViews();
        this.persistAndBroadcast();
        return;
      }

      case 'focus-pane': {
        const spaceId = this.data.activeSpaceId;
        const current = getActiveSplit(this.data, spaceId);
        if (intent.paneIndex < 0 || intent.paneIndex >= current.tabIds.length) return;
        this.data = {
          ...this.data,
          splitsBySpace: {
            ...this.data.splitsBySpace,
            [spaceId]: { ...current, focusedIndex: intent.paneIndex },
          },
        };
        this.persistAndBroadcast();
        return;
      }

      case 'nav-back':
      case 'nav-forward':
      case 'nav-reload':
      case 'nav-stop': {
        const tab = intent.tabId
          ? this.data.tabs.find((t) => t.id === intent.tabId)
          : getFocusedTab(this.data);
        if (!tab) return;
        const wc = this.tabViews.get(tab.id)?.webContents;
        if (!wc || wc.isDestroyed()) return;
        if (intent.type === 'nav-back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
        if (intent.type === 'nav-forward' && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
        if (intent.type === 'nav-reload') wc.reload();
        if (intent.type === 'nav-stop') wc.stop();
        return;
      }

      case 'set-zoom': {
        const tab = intent.tabId
          ? this.data.tabs.find((t) => t.id === intent.tabId)
          : getFocusedTab(this.data);
        if (!tab) return;
        const wc = this.tabViews.get(tab.id)?.webContents;
        if (!wc || wc.isDestroyed()) return;
        const cur = wc.getZoomFactor();
        const next =
          intent.delta === 'reset'
            ? 1
            : intent.delta === 'in'
              ? Math.min(3, Math.round((cur + 0.1) * 10) / 10)
              : Math.max(0.4, Math.round((cur - 0.1) * 10) / 10);
        wc.setZoomFactor(next);
        this.updateTab(tab.id, { zoomFactor: next });
        this.showToast(`Zoom ${Math.round(next * 100)}%`);
        return;
      }

      case 'toggle-mute': {
        const tab = this.data.tabs.find((t) => t.id === intent.tabId);
        if (!tab) return;
        const nextMuted = !tab.isMuted;
        const wc = this.tabViews.get(tab.id)?.webContents;
        if (wc && !wc.isDestroyed()) wc.setAudioMuted(nextMuted);
        this.updateTab(tab.id, { isMuted: nextMuted });
        return;
      }

      case 'toggle-sidebar': {
        const nextOpen = typeof intent.open === 'boolean' ? intent.open : !this.data.sidebarOpen;
        this.data = { ...this.data, sidebarOpen: nextOpen };
        this.layoutViews();
        this.persistAndBroadcast();
        return;
      }

      case 'set-sidebar-width': {
        const width = Math.min(380, Math.max(200, intent.width));
        this.data = { ...this.data, sidebarWidth: width };
        this.layoutViews();
        this.persistAndBroadcast();
        return;
      }

      case 'set-overlay': {
        this.overlay = intent.overlay;
        this.syncActiveTabViews();
        this.layoutViews();
        this.broadcastState();
        if (this.overlay.mode !== 'none' && this.overlayView && !this.overlayView.webContents.isDestroyed()) {
          this.overlayView.webContents.focus();
        } else {
          const focused = getFocusedTab(this.data);
          if (focused) this.tabViews.get(focused.id)?.webContents.focus();
        }
        return;
      }

      case 'set-search-engine': {
        this.data = { ...this.data, searchEngine: intent.engine };
        this.persistAndBroadcast();
        return;
      }

      case 'save-boost': {
        const exists = this.data.boosts.some((b) => b.id === intent.boost.id);
        this.data = {
          ...this.data,
          boosts: exists
            ? this.data.boosts.map((b) => (b.id === intent.boost.id ? intent.boost : b))
            : [intent.boost, ...this.data.boosts],
        };
        this.persistAndBroadcast();
        await this.reapplyBoostsAcrossOpenTabs();
        this.showToast(`Saved Boost for ${intent.boost.domainPattern}`);
        return;
      }

      case 'delete-boost': {
        this.data = {
          ...this.data,
          boosts: this.data.boosts.filter((b) => b.id !== intent.boostId),
        };
        this.persistAndBroadcast();
        await this.reapplyBoostsAcrossOpenTabs();
        return;
      }

      case 'toggle-boost-enabled': {
        this.data = {
          ...this.data,
          boosts: this.data.boosts.map((b) => (b.id === intent.boostId ? { ...b, enabled: !b.enabled } : b)),
        };
        this.persistAndBroadcast();
        await this.reapplyBoostsAcrossOpenTabs();
        return;
      }

      case 'start-zapper': {
        const focused = getFocusedTab(this.data);
        if (!focused || focused.url.startsWith('kinex://') || focused.url.startsWith('nook://')) {
          this.showToast('Open a website first to Zap elements');
          return;
        }
        const view = this.ensureTabView(focused);
        this.overlay = { mode: 'none' };
        this.zapperActiveTabId = focused.id;
        this.syncActiveTabViews();
        this.layoutViews();
        this.broadcastState();
        view.webContents.focus();

        const selector = await runElementZapper(view.webContents);
        this.zapperActiveTabId = null;
        if (selector) {
          const host = extractHostname(focused.url) || '*';
          const existing = this.data.boosts.find(
            (b) => b.domainPattern.toLowerCase() === host.toLowerCase()
          );
          const updatedBoost: BoostRule = existing
            ? {
                ...existing,
                enabled: true,
                zappedSelectors: Array.from(new Set([...existing.zappedSelectors, selector])),
              }
            : {
                id: `boost-${Date.now()}`,
                name: `${host} Boost`,
                domainPattern: host,
                enabled: true,
                css: '',
                js: '',
                zappedSelectors: [selector],
              };
          await this.handleIntent({ type: 'save-boost', boost: updatedBoost });
          this.showToast(`Zapped ${selector}`);
        } else {
          this.broadcastState();
        }
        return;
      }

      case 'stop-zapper': {
        if (this.zapperActiveTabId) {
          const wc = this.tabViews.get(this.zapperActiveTabId)?.webContents;
          if (wc && !wc.isDestroyed()) {
            void wc.executeJavaScript('window.__nookZapperCleanup && window.__nookZapperCleanup(null);');
          }
          this.zapperActiveTabId = null;
          this.broadcastState();
        }
        return;
      }

      case 'toggle-adblock': {
        this.data = { ...this.data, adBlockEnabled: !this.data.adBlockEnabled };
        this.persistAndBroadcast();
        this.showToast(this.data.adBlockEnabled ? 'Shields On' : 'Shields Off');
        return;
      }

      case 'copy-current-url': {
        const targetTab = intent.tabId
          ? this.data.tabs.find((t) => t.id === intent.tabId)
          : getFocusedTab(this.data);
        if (targetTab?.url) {
          const text = this.data.cleanCopyUrl ? stripTrackingParams(targetTab.url) : targetTab.url;
          clipboard.writeText(text);
          this.showToast(text !== targetTab.url ? 'Copied Clean URL' : 'Copied Current URL');
        }
        return;
      }

      case 'set-https-only': {
        this.data = { ...this.data, httpsOnly: intent.enabled };
        this.persistAndBroadcast();
        return;
      }

      case 'set-clean-copy-url': {
        this.data = { ...this.data, cleanCopyUrl: intent.enabled };
        this.persistAndBroadcast();
        return;
      }

      case 'revoke-site-permission': {
        this.data = {
          ...this.data,
          sitePermissions: this.data.sitePermissions.filter(
            (p) => !(p.origin === intent.origin && p.permission === intent.permission)
          ),
        };
        this.persistAndBroadcast();
        return;
      }

      case 'save-air-traffic-rule': {
        const exists = this.data.airTrafficRules.some((r) => r.id === intent.rule.id);
        this.data = {
          ...this.data,
          airTrafficRules: exists
            ? this.data.airTrafficRules.map((r) => (r.id === intent.rule.id ? intent.rule : r))
            : [...this.data.airTrafficRules, intent.rule],
        };
        this.persistAndBroadcast();
        return;
      }

      case 'delete-air-traffic-rule': {
        this.data = {
          ...this.data,
          airTrafficRules: this.data.airTrafficRules.filter((r) => r.id !== intent.ruleId),
        };
        this.persistAndBroadcast();
        return;
      }

      case 'clear-browsing-data': {
        const scopes = new Set(intent.scopes);
        if (scopes.has('history')) {
          this.data = { ...this.data, history: [] };
        }
        if (scopes.has('archived')) {
          this.data = { ...this.data, archivedTabs: [] };
        }
        if (scopes.has('cookies') || scopes.has('cache')) {
          const partitions = new Set(this.data.spaces.map((s) => s.profilePartition));
          for (const part of partitions) {
            const sess = session.fromPartition(part);
            if (scopes.has('cache')) await sess.clearCache();
            if (scopes.has('cookies')) {
              await sess.clearStorageData({ storages: ['cookies', 'localstorage', 'indexdb', 'serviceworkers'] });
            }
          }
        }
        this.persistAndBroadcast();
        this.showToast('Cleared selected browsing data');
        return;
      }

      case 'duplicate-tab': {
        const source = this.data.tabs.find((t) => t.id === intent.tabId);
        if (!source) return;
        await this.handleIntent({
          type: 'open-url',
          url: source.url,
          target: 'new-tab',
          spaceId: source.spaceId,
        });
        return;
      }

      case 'open-incognito': {
        await this.openIncognitoWindow(intent.url || 'kinex://newtab');
        return;
      }

      case 'set-update-feed-url': {
        this.data = { ...this.data, updateFeedUrl: intent.url.trim() };
        this.persistAndBroadcast();
        this.showToast('Saved update feed');
        return;
      }

      case 'check-for-updates': {
        this.manualUpdateCheck = true;
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

      case 'open-devtools': {
        const focused = getFocusedTab(this.data);
        if (!focused) return;
        const wc = this.tabViews.get(focused.id)?.webContents;
        if (!wc || wc.isDestroyed()) return;
        if (wc.isDevToolsOpened()) wc.closeDevTools();
        else wc.openDevTools({ mode: 'detach' });
        return;
      }

      case 'print-page': {
        const focused = getFocusedTab(this.data);
        const wc = focused ? this.tabViews.get(focused.id)?.webContents : null;
        if (wc && !wc.isDestroyed()) wc.print();
        return;
      }

      case 'find-in-page': {
        const focused = getFocusedTab(this.data);
        if (!focused) return;
        const wc = this.tabViews.get(focused.id)?.webContents;
        if (!wc || wc.isDestroyed()) return;
        if (!intent.text) {
          wc.stopFindInPage('clearSelection');
          return;
        }
        wc.findInPage(intent.text, {
          forward: intent.forward ?? true,
          findNext: intent.findNext ?? false,
        });
        return;
      }

      case 'stop-find-in-page': {
        const focused = getFocusedTab(this.data);
        if (focused) {
          this.tabViews.get(focused.id)?.webContents.stopFindInPage('clearSelection');
        }
        this.overlay = { mode: 'none' };
        this.syncActiveTabViews();
        this.layoutViews();
        this.broadcastState();
        return;
      }

      case 'promote-little-nook': {
        await this.handleIntent({ type: 'open-url', url: intent.url, target: 'new-tab' });
        if (this.littleNook && !this.littleNook.win.isDestroyed()) {
          this.littleNook.win.close();
        }
        this.mainWindow?.focus();
        return;
      }

      case 'import-browser-data': {
        await this.importBrowserBookmarks(intent.source);
        return;
      }

      case 'set-default-browser': {
        app.setAsDefaultProtocolClient('http');
        app.setAsDefaultProtocolClient('https');
        this.broadcastState();
        this.showToast('Requested Kinex as default HTTP/HTTPS handler');
        return;
      }

      case 'show-download-in-finder': {
        if (intent.savePath) {
          shell.showItemInFolder(intent.savePath);
        }
        return;
      }
    }
  }

  private async importBrowserBookmarks(source: 'arc' | 'chrome' | 'file'): Promise<void> {
    const spaceId = this.data.activeSpaceId;
    let filePath: string | null = null;
    if (source === 'arc') {
      filePath = path.join(os.homedir(), 'Library/Application Support/Arc/StorableSidebar.json');
    } else if (source === 'chrome') {
      filePath = path.join(os.homedir(), 'Library/Application Support/Google/Chrome/Default/Bookmarks');
    } else if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      const res = await dialog.showOpenDialog(this.mainWindow, {
        title: 'Import Bookmarks (JSON or HTML)',
        properties: ['openFile'],
        filters: [{ name: 'Bookmarks', extensions: ['json', 'html', 'htm'] }],
      });
      if (!res.canceled && res.filePaths[0]) {
        filePath = res.filePaths[0];
      }
    }

    if (!filePath || !fs.existsSync(filePath)) {
      this.showToast(
        source === 'file' ? 'Import cancelled' : `No ${source === 'arc' ? 'Arc' : 'Chrome'} data file found`
      );
      return;
    }

    try {
      const content = fs.readFileSync(filePath, 'utf8');
      let imported;
      if (filePath.endsWith('.html') || filePath.endsWith('.htm')) {
        imported = parseHtmlBookmarks(content, spaceId);
      } else if (content.includes('"sidebar"') && content.includes('"containers"')) {
        imported = parseArcStorableSidebarJson(content, spaceId);
      } else {
        imported = parseChromeBookmarksJson(content, spaceId);
      }

      const existingUrls = new Set(this.data.tabs.map((t) => t.url));
      const freshTabs = imported.tabs.filter((t) => !existingUrls.has(t.url));
      this.data = {
        ...this.data,
        folders: [...this.data.folders, ...imported.folders],
        tabs: [...this.data.tabs, ...freshTabs],
      };
      this.persistAndBroadcast();
      this.showToast(`Imported ${freshTabs.length} pinned item(s)`);
    } catch {
      this.showToast('Failed to parse selected bookmark file');
    }
  }

  private async reapplyBoostsAcrossOpenTabs(): Promise<void> {
    for (const view of this.tabViews.values()) {
      if (!view.webContents.isDestroyed()) {
        await applyBoostsToWebContents(view.webContents, this.data.boosts, this.injectedCssKeys);
      }
    }
  }

  private destroyTabView(tabId: string): void {
    const view = this.tabViews.get(tabId);
    if (!view) return;
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      try {
        this.mainWindow.contentView.removeChildView(view);
      } catch {
        // Not attached
      }
    }
    if (!view.webContents.isDestroyed()) {
      view.webContents.close();
    }
    this.tabViews.delete(tabId);
  }

  async openLittleNook(rawUrl: string): Promise<void> {
    const url = normalizeNavigationInput(rawUrl, this.data.searchEngine);
    if (this.littleNook && !this.littleNook.win.isDestroyed()) {
      this.littleNook.win.show();
      this.littleNook.win.focus();
      await this.littleNook.webView.webContents.loadURL(url);
      return;
    }

    const preloadPath = this.getPreloadPath();
    const win = new BrowserWindow({
      width: 560,
      height: 700,
      minWidth: 400,
      minHeight: 420,
      title: 'Little Kinex',
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 12, y: 14 },
      backgroundColor: '#181a2b',
      alwaysOnTop: false,
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    const sess = this.getSessionForSpace(this.data.activeSpaceId);
    const webView = new WebContentsView({
      webPreferences: {
        session: sess,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    webView.setBorderRadius(8);
    webView.setBackgroundColor('#ffffff');

    const state: LittleNookWindowState = {
      win,
      webView,
      url,
      title: url,
      isLoading: true,
      canGoBack: false,
      canGoForward: false,
    };
    this.littleNook = state;
    this.miniWindows.set(win.webContents.id, state);

    const layoutLittle = () => {
      if (win.isDestroyed()) return;
      const [w, h] = win.getContentSize();
      webView.setBounds({ x: 8, y: 46, width: Math.max(100, w - 16), height: Math.max(100, h - 54) });
    };

    const syncLittle = () => {
      if (win.isDestroyed() || webView.webContents.isDestroyed()) return;
      const wc = webView.webContents;
      state.url = wc.getURL() || state.url;
      state.title = wc.getTitle() || state.url;
      state.isLoading = wc.isLoading();
      state.canGoBack = wc.navigationHistory.canGoBack();
      state.canGoForward = wc.navigationHistory.canGoForward();
      win.webContents.send('nook:little-updated', this.getLittleNookInfo(win.webContents.id));
    };

    webView.webContents.on('did-start-loading', syncLittle);
    webView.webContents.on('did-stop-loading', syncLittle);
    webView.webContents.on('did-navigate', syncLittle);
    webView.webContents.on('page-title-updated', syncLittle);
    webView.webContents.on('did-finish-load', () => {
      void applyBoostsToWebContents(webView.webContents, this.data.boosts, this.injectedCssKeys);
    });

    win.contentView.addChildView(webView);
    win.on('resize', layoutLittle);
    win.on('closed', () => {
      this.miniWindows.delete(win.webContents.id);
      if (!webView.webContents.isDestroyed()) webView.webContents.close();
      this.littleNook = null;
    });

    await win.loadURL(this.getRendererUrl('little'));
    layoutLittle();
    await webView.webContents.loadURL(url);
  }

  async handleLittleNookAction(
    senderId: number,
    action: 'back' | 'forward' | 'reload' | 'navigate' | 'promote' | 'close',
    url?: string
  ): Promise<void> {
    const target = this.miniWindows.get(senderId) ?? this.littleNook;
    if (!target || target.win.isDestroyed()) return;
    const wc = target.webView.webContents;
    if (action === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
    if (action === 'forward' && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
    if (action === 'reload') wc.reload();
    if (action === 'navigate' && url) await wc.loadURL(normalizeNavigationInput(url, this.data.searchEngine));
    if (action === 'promote') {
      await this.handleIntent({ type: 'open-url', url: target.url, target: 'new-tab' });
      if (!target.win.isDestroyed()) target.win.close();
      this.mainWindow?.focus();
    }
    if (action === 'close') target.win.close();
  }

  showTabContextMenu(tabId: string): void {
    const tab = this.data.tabs.find((t) => t.id === tabId);
    if (!tab || !this.mainWindow || this.mainWindow.isDestroyed()) return;
    const folders = this.data.folders.filter((f) => f.spaceId === tab.spaceId);

    const template: Electron.MenuItemConstructorOptions[] = [
      {
        label: 'Open in Split View',
        click: () => void this.handleIntent({ type: 'toggle-split', tabId: tab.id }),
      },
      {
        label: 'Open in Little Kinex',
        click: () =>
          void this.handleIntent({ type: 'open-url', url: tab.url, target: 'little-nook' }),
      },
      {
        label: 'Duplicate Tab',
        click: () => void this.handleIntent({ type: 'duplicate-tab', tabId: tab.id }),
      },
      { type: 'separator' },
      {
        label: tab.location === 'unpinned' ? 'Pin Tab' : 'Unpin Tab',
        click: () =>
          void this.handleIntent({
            type: 'set-tab-location',
            tabId: tab.id,
            location: tab.location === 'unpinned' ? 'pinned' : 'unpinned',
          }),
      },
      {
        label: tab.location === 'topApp' ? 'Remove from Favorites' : 'Add to Favorites',
        click: () =>
          void this.handleIntent({
            type: 'set-tab-location',
            tabId: tab.id,
            location: tab.location === 'topApp' ? 'pinned' : 'topApp',
          }),
      },
      ...(folders.length > 0
        ? [
            {
              label: 'Move to Folder',
              submenu: [
                ...folders.map((f) => ({
                  label: f.name,
                  click: () =>
                    void this.handleIntent({
                      type: 'move-tab-to-folder',
                      tabId: tab.id,
                      folderId: f.id,
                    }),
                })),
                { type: 'separator' as const },
                {
                  label: 'No Folder',
                  click: () =>
                    void this.handleIntent({
                      type: 'move-tab-to-folder',
                      tabId: tab.id,
                      folderId: undefined,
                    }),
                },
              ],
            },
          ]
        : []),
      { type: 'separator' },
      {
        label: 'Copy URL',
        click: () => void this.handleIntent({ type: 'copy-current-url', tabId: tab.id }),
      },
      {
        label: tab.isMuted ? 'Unmute Tab' : 'Mute Tab',
        click: () => void this.handleIntent({ type: 'toggle-mute', tabId: tab.id }),
      },
      ...(tab.location !== 'unpinned' && tab.pinnedUrl && tab.url !== tab.pinnedUrl
        ? [
            {
              label: 'Reset to Pinned URL',
              click: () => void this.handleIntent({ type: 'reset-pinned-tab', tabId: tab.id }),
            },
          ]
        : []),
      { type: 'separator' },
      {
        label: tab.location === 'unpinned' ? 'Close Tab' : 'Close & Reset Tab',
        click: () => void this.handleIntent({ type: 'close-tab', tabId: tab.id }),
      },
    ];

    Menu.buildFromTemplate(template).popup({ window: this.mainWindow });
  }

  async openIncognitoWindow(rawUrl: string): Promise<void> {
    const url = normalizeNavigationInput(rawUrl, this.data.searchEngine);
    const preloadPath = this.getPreloadPath();
    const privPartition = `nook-incognito-${Date.now()}`;
    const privSess = session.fromPartition(privPartition);
    registerNookProtocolOnSession(privSess);
    attachAdBlocker(privSess, () => this.data.adBlockEnabled, () => {});

    const win = new BrowserWindow({
      width: 1120,
      height: 760,
      minWidth: 520,
      minHeight: 420,
      title: 'Private Kinex',
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 12, y: 14 },
      backgroundColor: '#121218',
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    const webView = new WebContentsView({
      webPreferences: {
        session: privSess,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    webView.setBorderRadius(8);
    webView.setBackgroundColor('#ffffff');
    win.contentView.addChildView(webView);

    const privState: LittleNookWindowState = {
      win,
      webView,
      url,
      title: 'Private Kinex',
      isLoading: true,
      canGoBack: false,
      canGoForward: false,
    };
    this.miniWindows.set(win.webContents.id, privState);

    const layout = () => {
      if (win.isDestroyed()) return;
      const [w, h] = win.getContentSize();
      webView.setBounds({ x: 8, y: 46, width: Math.max(100, w - 16), height: Math.max(100, h - 54) });
    };

    const sync = () => {
      if (win.isDestroyed() || webView.webContents.isDestroyed()) return;
      const wc = webView.webContents;
      privState.url = wc.getURL() || privState.url;
      privState.title = `Private — ${wc.getTitle() || privState.url}`;
      privState.isLoading = wc.isLoading();
      privState.canGoBack = wc.navigationHistory.canGoBack();
      privState.canGoForward = wc.navigationHistory.canGoForward();
      win.webContents.send('nook:little-updated', this.getLittleNookInfo(win.webContents.id));
    };

    webView.webContents.on('did-start-loading', sync);
    webView.webContents.on('did-stop-loading', sync);
    webView.webContents.on('did-navigate', sync);
    webView.webContents.on('page-title-updated', sync);
    win.on('resize', layout);
    win.on('closed', () => {
      this.miniWindows.delete(win.webContents.id);
      if (!webView.webContents.isDestroyed()) webView.webContents.close();
      void privSess.clearStorageData();
    });

    await win.loadURL(this.getRendererUrl('little'));
    layout();
    await webView.webContents.loadURL(url);
  }

  private cycleSpace(delta: number): void {
    const spaces = this.data.spaces;
    if (spaces.length <= 1) return;
    const idx = spaces.findIndex((s) => s.id === this.data.activeSpaceId);
    const nextIdx = (idx + delta + spaces.length) % spaces.length;
    void this.handleIntent({ type: 'select-space', spaceId: spaces[nextIdx].id });
  }

  private jumpToSidebarIndex(zeroBasedIndex: number): void {
    const spaceId = this.data.activeSpaceId;
    const ordered = [
      ...this.data.tabs.filter((t) => t.location === 'topApp'),
      ...this.data.tabs.filter((t) => t.spaceId === spaceId && t.location === 'pinned'),
      ...this.data.tabs.filter((t) => t.spaceId === spaceId && t.location === 'unpinned'),
    ];
    const target = ordered[zeroBasedIndex];
    if (target) {
      void this.handleIntent({ type: 'select-tab', tabId: target.id });
    }
  }

  private installApplicationMenu(): void {
    const isMac = process.platform === 'darwin';
    const template: Electron.MenuItemConstructorOptions[] = [
      ...(isMac
        ? [
            {
              label: 'Kinex',
              submenu: [
                { role: 'about' as const },
                { type: 'separator' as const },
                {
                  label: 'Check for Updates...',
                  click: () => {
                    void this.handleIntent({ type: 'check-for-updates' });
                    void this.handleIntent({ type: 'set-overlay', overlay: { mode: 'settings', section: 'updates' } });
                  },
                },
                {
                  label: 'Settings & Import...',
                  accelerator: 'CmdOrCtrl+,',
                  click: () =>
                    void this.handleIntent({ type: 'set-overlay', overlay: { mode: 'settings' } }),
                },
                { type: 'separator' as const },
                { role: 'hide' as const },
                { role: 'hideOthers' as const },
                { role: 'unhide' as const },
                { type: 'separator' as const },
                { role: 'quit' as const },
              ],
            },
          ]
        : []),
      {
        label: 'File',
        submenu: [
          {
            label: 'New Tab (Command Bar)',
            accelerator: 'CmdOrCtrl+T',
            click: () =>
              void this.handleIntent({
                type: 'set-overlay',
                overlay: { mode: 'command-bar', initialQuery: '', targetMode: 'new-tab' },
              }),
          },
          {
            label: 'Open Location',
            accelerator: 'CmdOrCtrl+L',
            click: () => {
              const focused = getFocusedTab(this.data);
              void this.handleIntent({
                type: 'set-overlay',
                overlay: {
                  mode: 'command-bar',
                  initialQuery:
                    focused?.url && !focused.url.startsWith('kinex://') && !focused.url.startsWith('nook://')
                      ? focused.url
                      : '',
                  targetMode: 'edit-url',
                },
              });
            },
          },
          {
            label: 'Little Kinex',
            accelerator: 'Alt+CmdOrCtrl+N',
            click: () => void this.openLittleNook('kinex://newtab'),
          },
          {
            label: 'New Private Window',
            accelerator: 'CmdOrCtrl+Shift+N',
            click: () => void this.openIncognitoWindow('kinex://newtab'),
          },
          {
            label: 'Pin / Unpin Current Tab',
            accelerator: 'CmdOrCtrl+D',
            click: () => {
              const focused = getFocusedTab(this.data);
              if (!focused) return;
              void this.handleIntent({
                type: 'set-tab-location',
                tabId: focused.id,
                location: focused.location === 'unpinned' ? 'pinned' : 'unpinned',
              });
            },
          },
          {
            label: 'Print...',
            accelerator: 'CmdOrCtrl+P',
            click: () => void this.handleIntent({ type: 'print-page' }),
          },
          { type: 'separator' },
          {
            label: 'Close Tab',
            accelerator: 'CmdOrCtrl+W',
            click: () => {
              if (this.overlay.mode !== 'none') {
                void this.handleIntent({ type: 'set-overlay', overlay: { mode: 'none' } });
                return;
              }
              const focused = getFocusedTab(this.data);
              if (focused) void this.handleIntent({ type: 'close-tab', tabId: focused.id });
            },
          },
        ],
      },
      {
        label: 'Edit',
        submenu: [
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'selectAll' },
          { type: 'separator' },
          {
            label: 'Copy Current URL',
            accelerator: 'CmdOrCtrl+Shift+C',
            click: () => void this.handleIntent({ type: 'copy-current-url' }),
          },
          {
            label: 'Find in Page',
            accelerator: 'CmdOrCtrl+F',
            click: () => void this.handleIntent({ type: 'set-overlay', overlay: { mode: 'find' } }),
          },
        ],
      },
      {
        label: 'View',
        submenu: [
          {
            label: 'Toggle Sidebar',
            accelerator: 'CmdOrCtrl+S',
            click: () => void this.handleIntent({ type: 'toggle-sidebar' }),
          },
          {
            label: 'Toggle Split View',
            accelerator: 'CmdOrCtrl+Shift+\\',
            click: () => void this.handleIntent({ type: 'toggle-split' }),
          },
          {
            label: 'Reload Page',
            accelerator: 'CmdOrCtrl+R',
            click: () => void this.handleIntent({ type: 'nav-reload' }),
          },
          { type: 'separator' },
          {
            label: 'Zoom In',
            accelerator: 'CmdOrCtrl+=',
            click: () => void this.handleIntent({ type: 'set-zoom', delta: 'in' }),
          },
          {
            label: 'Zoom Out',
            accelerator: 'CmdOrCtrl+-',
            click: () => void this.handleIntent({ type: 'set-zoom', delta: 'out' }),
          },
          {
            label: 'Actual Size',
            accelerator: 'CmdOrCtrl+0',
            click: () => void this.handleIntent({ type: 'set-zoom', delta: 'reset' }),
          },
          { type: 'separator' },
          {
            label: 'Boosts Studio',
            accelerator: 'CmdOrCtrl+Shift+B',
            click: () => {
              const focused = getFocusedTab(this.data);
              const domain = focused ? extractHostname(focused.url) || '*' : '*';
              void this.handleIntent({ type: 'set-overlay', overlay: { mode: 'boosts', domain } });
            },
          },
          {
            label: 'Developer Tools',
            accelerator: 'Alt+CmdOrCtrl+I',
            click: () => void this.handleIntent({ type: 'open-devtools' }),
          },
        ],
      },
      {
        label: 'Navigate',
        submenu: [
          {
            label: 'Back',
            accelerator: 'CmdOrCtrl+[',
            click: () => void this.handleIntent({ type: 'nav-back' }),
          },
          {
            label: 'Forward',
            accelerator: 'CmdOrCtrl+]',
            click: () => void this.handleIntent({ type: 'nav-forward' }),
          },
          { type: 'separator' },
          {
            label: 'Previous Space',
            accelerator: 'Ctrl+CmdOrCtrl+Left',
            click: () => this.cycleSpace(-1),
          },
          {
            label: 'Next Space',
            accelerator: 'Ctrl+CmdOrCtrl+Right',
            click: () => this.cycleSpace(1),
          },
          { type: 'separator' },
          ...Array.from({ length: 9 }, (_, i) => ({
            label: `Tab ${i + 1}`,
            accelerator: `CmdOrCtrl+${i + 1}`,
            click: () => this.jumpToSidebarIndex(i),
          })),
        ],
      },
      {
        label: 'Window',
        submenu: [{ role: 'minimize' }, { role: 'zoom' }],
      },
    ];

    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  }
}

export function registerNookProtocol(protocol: Electron.Protocol): void {
  const { renderNookInternalHtml } = require('./internalPages') as typeof import('./internalPages');
  const handler = (request: { url: string }) => {
    const html = renderNookInternalHtml(request.url);
    return new Response(html, {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  };
  protocol.handle('kinex', handler);
  protocol.handle('nook', handler);
}

export function ensureAppName(): void {
  app.setName('Kinex');
}
