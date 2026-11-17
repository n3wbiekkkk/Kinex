import type { CommandId } from '../shared/commands';
import path from 'node:path';
import { BrowserWindow, clipboard, Menu, WebContentsView, type MenuItemConstructorOptions, type Session, type WebContents } from 'electron';
import { normalizeNavigationInput } from '../shared/domain';
import type { LittleKinexAction, LittleKinexInfo, SearchEngineId } from '../shared/types';
import type { TrustedIpcRegistry } from './ipcValidation';
import type { NavigationManager } from './navigationManager';
import { classifySecurityState, isSafeNavigationUrl } from './security';
import type { SessionManager } from './sessionManager';

interface ManagedAuxiliaryWindow {
  win: BrowserWindow;
  headerView: WebContentsView;
  webView: WebContentsView;
  popupWindows: Set<BrowserWindow>;
  isPrivate: boolean;
  privSession?: Session;
  currentUrl: string;
  title: string;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  hasCertError: boolean;
}

export interface AuxiliaryWindowHost {
  onWebContentsCreated: (wc: WebContents) => void;
  onApplyShieldsCosmetics?: (wc: WebContents, url?: string) => Promise<void> | void;
  getRendererUrl: (view: 'shell' | 'overlay' | 'little' | 'private') => string;
  getSearchEngine: () => SearchEngineId;
  getRegularSessionForActiveSpace: () => Session;
  onPromoteUrl: (url: string, title: string) => void;
}

export class AuxiliaryWindowManager {
  private littleWindow: ManagedAuxiliaryWindow | null = null;
  private readonly auxByHeaderWcId = new Map<number, ManagedAuxiliaryWindow>();
  private readonly privateWindows = new Set<ManagedAuxiliaryWindow>();
  private readonly privateWcIds = new Set<number>();
  private disposed = false;

  isPrivateWebContents(wcId: number): boolean {
    return this.privateWcIds.has(wcId);
  }

  constructor(
    private readonly host: AuxiliaryWindowHost,
    private readonly ipcRegistry: TrustedIpcRegistry,
    private readonly sessionManager: SessionManager,
    private readonly navigationManager: NavigationManager
  ) {}

  getPrivateWindowCount(): number {
    return this.privateWindows.size;
  }

  hasLittleWindow(): boolean {
    return Boolean(this.littleWindow && !this.littleWindow.win.isDestroyed());
  }

  resetForNewWindow(): void {
    this.disposed = false;
  }

  openLittleKinex(rawUrl: string): void {
    if (this.disposed) return;
    const normalized = rawUrl.trim()
      ? normalizeNavigationInput(rawUrl, this.host.getSearchEngine())
      : 'kinex://newtab';

    const sess = this.host.getRegularSessionForActiveSpace();
    if (this.littleWindow && !this.littleWindow.win.isDestroyed() &&
      this.littleWindow.webView.webContents.session !== sess) {
      this.littleWindow.win.close();
      if (this.littleWindow && !this.littleWindow.win.isDestroyed()) return;
    }
    if (this.littleWindow && !this.littleWindow.win.isDestroyed()) {
      this.littleWindow.win.show();
      this.littleWindow.win.focus();
      void this.navigationManager.navigateWebContents(this.littleWindow.webView.webContents, normalized);
      return;
    }

    const state = this.createAuxWindow({
      isPrivate: false,
      sess,
      initialUrl: normalized,
      title: 'Little Kinex',
      width: 480,
      height: 660,
    });
    this.littleWindow = state;
  }

  openPrivateWindow(rawUrl?: string): void {
    if (this.disposed) return;
    const { sess } = this.sessionManager.createPrivateSession();
    const target = rawUrl?.trim()
      ? normalizeNavigationInput(rawUrl, this.host.getSearchEngine())
      : 'kinex://private';

    const state = this.createAuxWindow({
      isPrivate: true,
      sess,
      privSession: sess,
      initialUrl: target,
      title: 'Kinex — Private Window',
      width: 1080,
      height: 740,
    });
    this.privateWindows.add(state);
  }

  private createAuxWindow(opts: {
    isPrivate: boolean;
    sess: Session;
    privSession?: Session;
    initialUrl: string;
    title: string;
    width: number;
    height: number;
  }): ManagedAuxiliaryWindow {
    const win = new BrowserWindow({
      width: opts.width,
      height: opts.height,
      minWidth: opts.isPrivate ? 620 : 360,
      minHeight: opts.isPrivate ? 440 : 400,
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 14, y: 14 },
      backgroundColor: '#13151d',
      title: opts.title,
    });

    const headerView = new WebContentsView({
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
    headerView.setBackgroundColor('#161722');

    const webView = new WebContentsView({
      webPreferences: {
        session: opts.sess,
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

    win.contentView.addChildView(headerView);
    win.contentView.addChildView(webView);

    const state: ManagedAuxiliaryWindow = {
      win,
      headerView,
      webView,
      popupWindows: new Set<BrowserWindow>(),
      isPrivate: opts.isPrivate,
      privSession: opts.privSession,
      currentUrl: opts.initialUrl,
      title: opts.title,
      isLoading: false,
      canGoBack: false,
      canGoForward: false,
      hasCertError: false,
    };

    const headerWc = headerView.webContents;
    const contentWcId = webView.webContents.id;
    if (opts.isPrivate) {
      this.privateWcIds.add(contentWcId);
    }
    this.host.onWebContentsCreated(headerWc);
    this.host.onWebContentsCreated(webView.webContents);
    webView.webContents.on('dom-ready', () => {
      if (!this.disposed && !webView.webContents.isDestroyed()) {
        void this.host.onApplyShieldsCosmetics?.(webView.webContents);
      }
    });
    webView.webContents.once('destroyed', () => {
      this.privateWcIds.delete(contentWcId);
    });
    const headerId = headerWc.id;
    this.auxByHeaderWcId.set(headerId, state);
    this.ipcRegistry.register(headerId, opts.isPrivate ? 'private-header' : 'little-kinex');

    let htmlFullscreen = false;
    const relayout = () => {
      if (win.isDestroyed()) return;
      const { width, height } = win.getContentBounds();
      if (htmlFullscreen) {
        headerView.setVisible(false);
        headerView.setBounds({ x: -10000, y: -10000, width: 100, height: 42 });
        webView.setBounds({ x: 0, y: 0, width, height });
      } else {
        headerView.setVisible(true);
        headerView.setBounds({ x: 0, y: 0, width, height: 42 });
        webView.setBounds({ x: 0, y: 42, width, height: Math.max(100, height - 42) });
      }
    };
    win.on('resize', relayout);
    win.on('leave-full-screen', () => {
      if (htmlFullscreen) {
        htmlFullscreen = false;
        relayout();
      }
    });
    webView.webContents.on('enter-html-full-screen', () => {
      if (win.isDestroyed()) return;
      htmlFullscreen = true;
      relayout();
    });
    webView.webContents.on('leave-html-full-screen', () => {
      if (win.isDestroyed()) return;
      htmlFullscreen = false;
      relayout();
    });
    relayout();

    const syncHeader = () => {
      if (win.isDestroyed() || headerWc.isDestroyed()) return;
      headerWc.send('kinex:little-updated', this.buildInfoPayload(state));
    };

    this.navigationManager.attachWebContentsGuards(webView.webContents, {
      isPrivate: opts.isPrivate,
      onDidCreatePopupWindow: (popup) => {
        state.popupWindows.add(popup);
        const popupWcId = popup.webContents.id;
        if (opts.isPrivate) {
          this.privateWcIds.add(popupWcId);
        }
        this.host.onWebContentsCreated(popup.webContents);
        popup.webContents.on('dom-ready', () => {
          if (!this.disposed && !popup.isDestroyed() && !popup.webContents.isDestroyed()) {
            void this.host.onApplyShieldsCosmetics?.(popup.webContents);
          }
        });
        popup.once('closed', () => {
          this.privateWcIds.delete(popupWcId);
          state.popupWindows.delete(popup);
        });
      },
      onTitleUpdated: (title) => {
        state.title = title || state.currentUrl;
        syncHeader();
      },
      onLoadingChanged: (isLoading) => {
        state.isLoading = isLoading;
        syncHeader();
      },
      onCertErrorChanged: (hasError) => {
        state.hasCertError = hasError;
        syncHeader();
      },
      onNavigationStateChanged: (url) => {
        const wc = webView.webContents;
        if (wc.isDestroyed()) return;
        state.currentUrl = url;
        state.canGoBack = wc.navigationHistory.canGoBack();
        state.canGoForward = wc.navigationHistory.canGoForward();
        void this.host.onApplyShieldsCosmetics?.(wc, url);
        syncHeader();
      },
      onDidFinishNavigation: (url, title) => {
        const wc = webView.webContents;
        if (wc.isDestroyed()) return;
        state.currentUrl = url;
        state.title = title || url;
        state.isLoading = false;
        state.canGoBack = wc.navigationHistory.canGoBack();
        state.canGoForward = wc.navigationHistory.canGoForward();
        void this.host.onApplyShieldsCosmetics?.(wc, url);
        syncHeader();
      },
    });

    headerWc.setWindowOpenHandler(() => ({ action: 'deny' }));
    const guardHeaderNavigation = (event: Electron.Event, targetUrl: string) => {
      const base = this.host.getRendererUrl(opts.isPrivate ? 'private' : 'little').split('?')[0].split('#')[0];
      if (targetUrl.split('?')[0].split('#')[0] !== base) event.preventDefault();
    };
    headerWc.on('will-navigate', guardHeaderNavigation);
    headerWc.on('will-redirect', guardHeaderNavigation);

    webView.webContents.on('context-menu', (_event, params) => {
      const wc = webView.webContents;
      if (win.isDestroyed() || wc.isDestroyed()) return;
      const safeLink = params.linkURL && isSafeNavigationUrl(params.linkURL) ? params.linkURL : '';
      const items: MenuItemConstructorOptions[] = [];
      if (safeLink) {
        items.push(
          {
            label: opts.isPrivate ? 'Open Link in Private Window' : 'Open Link',
            click: () => {
              void this.navigationManager.navigateWebContents(wc, safeLink, { isPrivate: opts.isPrivate });
            },
          },
          {
            label: 'Copy Link Address',
            click: () => { void clipboard.writeText(safeLink).catch(() => console.warn('Kinex could not copy the link.')); },
          },
          { type: 'separator' }
        );
      }
      if (params.selectionText) {
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
        }
      );
      Menu.buildFromTemplate(items).popup({ window: win });
    });

    void headerWc.loadURL(this.host.getRendererUrl(opts.isPrivate ? 'private' : 'little'));
    void this.navigationManager.navigateWebContents(webView.webContents, opts.initialUrl, {
      isPrivate: opts.isPrivate,
    });

    win.on('closed', () => {
      this.auxByHeaderWcId.delete(headerId);
      this.ipcRegistry.unregister(headerId);
      if (this.littleWindow === state) {
        this.littleWindow = null;
      }
      this.privateWindows.delete(state);

      for (const popup of state.popupWindows) {
        if (!popup.isDestroyed()) {
          popup.destroy();
        }
      }
      state.popupWindows.clear();

      if (!webView.webContents.isDestroyed()) {
        webView.webContents.close();
      }
      if (!headerView.webContents.isDestroyed()) {
        headerView.webContents.close();
      }
      if (opts.isPrivate && opts.privSession) {
        void this.sessionManager.destroyPrivateSession(opts.privSession);
      }
    });

    return state;
  }

  private buildInfoPayload(state: ManagedAuxiliaryWindow): LittleKinexInfo {
    return {
      url: state.currentUrl,
      title: state.title,
      isLoading: state.isLoading,
      canGoBack: state.canGoBack,
      canGoForward: state.canGoForward,
      isPrivate: state.isPrivate,
      securityState: classifySecurityState(state.currentUrl, state.hasCertError),
    };
  }

  getInfo(senderId: number): LittleKinexInfo {
    const state = this.auxByHeaderWcId.get(senderId);
    if (!state) {
      return {
        url: '',
        title: 'Little Kinex',
        isLoading: false,
        canGoBack: false,
        canGoForward: false,
        isPrivate: false,
        securityState: 'internal',
      };
    }
    return this.buildInfoPayload(state);
  }

  handleAction(senderId: number, action: LittleKinexAction, url?: string): void {
    const state = this.auxByHeaderWcId.get(senderId);
    if (!state || state.win.isDestroyed()) return;
    const wc = state.webView.webContents;
    if (wc.isDestroyed()) return;

    switch (action) {
      case 'focus-content':
        wc.focus();
        break;
      case 'back':
        if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
        break;
      case 'forward':
        if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
        break;
      case 'reload':
        wc.reload();
        break;
      case 'navigate':
        if (url) {
          const normalized = normalizeNavigationInput(url, this.host.getSearchEngine());
          void this.navigationManager.navigateWebContents(wc, normalized, { isPrivate: state.isPrivate });
          wc.focus();
        }
        break;
      case 'promote':
        // Security boundary: private windows may never silently promote URLs into persisted regular state
        if (state.isPrivate) return;
        this.host.onPromoteUrl(wc.getURL() || state.currentUrl, wc.getTitle() || state.title);
        state.win.close();
        break;
      case 'close':
        state.win.close();
        break;
    }
  }

  executeCommand(command: CommandId, source?: WebContents): boolean {
    const popup = [...this.auxByHeaderWcId.values()].flatMap((s) => [...s.popupWindows])
      .find((win) => !win.isDestroyed() && win.webContents.id === source?.id);
    if (popup) {
      const wc = popup.webContents;
      switch (command) {
        case 'close-tab': case 'close-window': popup.close(); break;
        case 'reload': wc.reload(); break;
        case 'stop-loading': wc.stop(); break;
        case 'back': if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack(); break;
        case 'forward': if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward(); break;
        case 'copy-url': void clipboard.writeText(wc.getURL()).catch(() => console.warn('Kinex could not copy the URL.')); break;
        case 'print-page': wc.print({ printBackground: true }); break;
        case 'devtools': wc.openDevTools({ mode: 'detach' }); break;
      }
      return true;
    }
    const state = [...this.auxByHeaderWcId.values()].find((s) =>
      !s.win.isDestroyed() && (s.headerView.webContents.id === source?.id || s.webView.webContents.id === source?.id ||
        (!source && s.win.isFocused())));
    if (!state) return false;
    const wc = state.webView.webContents;
    const header = state.headerView.webContents;
    if (wc.isDestroyed() || header.isDestroyed()) return true;
    switch (command) {
      case 'new-tab':
      case 'edit-url':
        header.focus(); header.send('kinex:focus-requested', 'address'); break;
      case 'focus-next':
      case 'focus-previous':
        if (source?.id === header.id) wc.focus();
        else { header.focus(); header.send('kinex:focus-requested', 'toolbar'); }
        break;
      case 'focus-content': wc.focus(); break;
      case 'focus-sidebar':
      case 'focus-toolbar': header.focus(); header.send('kinex:focus-requested', 'toolbar'); break;
      case 'close-tab':
      case 'close-window': state.win.close(); break;
      case 'reload': wc.reload(); break;
      case 'stop-loading': wc.stop(); break;
      case 'back': if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack(); break;
      case 'forward': if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward(); break;
      case 'copy-url': void clipboard.writeText(wc.getURL()).catch(() => console.warn('Kinex could not copy the URL.')); break;
      case 'zoom-in': wc.setZoomFactor(Math.min(3, wc.getZoomFactor() + 0.1)); break;
      case 'zoom-out': wc.setZoomFactor(Math.max(0.25, wc.getZoomFactor() - 0.1)); break;
      case 'zoom-reset': wc.setZoomFactor(1); break;
      case 'print-page': wc.print({ printBackground: true }); break;
      case 'devtools': wc.openDevTools({ mode: 'detach' }); break;
      case 'open-private-window': this.openPrivateWindow(); break;
      // Commands without an auxiliary-window implementation must not act on a regular tab behind it.
    }
    return true;
  }

  disposeAll(): void {
    this.disposed = true;
    const wins: BrowserWindow[] = [];
    if (this.littleWindow && !this.littleWindow.win.isDestroyed()) {
      wins.push(this.littleWindow.win);
    }
    for (const priv of this.privateWindows) {
      if (!priv.win.isDestroyed()) {
        wins.push(priv.win);
      }
    }
    for (const win of wins) {
      win.close();
    }
    this.littleWindow = null;
    this.privateWindows.clear();
    this.auxByHeaderWcId.clear();
  }
}
