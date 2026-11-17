import { dialog, shell, type BrowserWindow, type WebContents, type Session } from 'electron';
import {
  classifyLoadError,
  isAllowedExternalProtocol,
  isSafeNavigationUrl,
  isSameOriginBlobUrl,
  shouldOfferInsecureHttpFallback,
  upgradeUrlToHttpsIfNeeded,
} from './security';

export interface NavigationGuardOptions {
  isPrivate: boolean;
  partitionKey?: string;
  tabId?: string;
  onTitleUpdated?: (title: string) => void;
  onNavigationStateChanged?: (url: string) => void;
  onLoadingChanged?: (isLoading: boolean) => void;
  onCertErrorChanged?: (hasCertError: boolean) => void;
  onWillNavigateRoute?: (url: string) => boolean;
  onOpenInTab?: (url: string, disposition: 'foreground' | 'background') => void;
  onDidFinishNavigation?: (url: string, title: string) => void;
  onDidCreatePopupWindow?: (popup: BrowserWindow) => void;
  onFoundInPage?: (result: { activeMatchOrdinal: number; matches: number; finalUpdate: boolean }) => void;
}

export interface NavigationHost {
  getDialogParentWindow: () => BrowserWindow | null;
  isHttpsOnly: () => boolean;
  onBlockedNavigation?: (url: string, reason: string) => void;
}

interface PendingUpgrade {
  host: string;
  originalHttpUrl: string;
}

export class NavigationManager {
  private readonly approvedCertKeys = new WeakMap<Session, Set<string>>();
  private readonly pendingUpgradesByWc = new Map<number, PendingUpgrade>();
  private readonly certDialogInFlight = new Set<string>();
  private readonly fallbackBySession = new WeakMap<Session, Set<string>>();

  constructor(private readonly host: NavigationHost) {}

  private getFallbackSet(wc: WebContents): Set<string> {
    let set = this.fallbackBySession.get(wc.session);
    if (!set) {
      set = new Set<string>();
      this.fallbackBySession.set(wc.session, set);
    }
    return set;
  }

  prepareSafeNavigationUrl(
    rawUrl: string,
    opts: { skipHttpsUpgrade?: boolean; isPrivate?: boolean; wc?: WebContents } = {}
  ): { safe: boolean; targetUrl: string; upgradedFromHttp: boolean } {
    const candidate = rawUrl.trim().replace(/^nook:\/\//i, 'kinex://');
    if (!isSafeNavigationUrl(candidate)) {
      return { safe: false, targetUrl: 'kinex://welcome', upgradedFromHttp: false };
    }
    if (opts.skipHttpsUpgrade) {
      return { safe: true, targetUrl: candidate, upgradedFromHttp: false };
    }
    const exemptHosts = opts.wc ? this.getFallbackSet(opts.wc) : new Set<string>();
    const upgraded = upgradeUrlToHttpsIfNeeded(candidate, this.host.isHttpsOnly(), exemptHosts);
    return {
      safe: true,
      targetUrl: upgraded,
      upgradedFromHttp: upgraded !== candidate && candidate.startsWith('http://'),
    };
  }

  async navigateWebContents(
    wc: WebContents,
    rawUrl: string,
    opts: { isPrivate?: boolean } = {}
  ): Promise<boolean> {
    if (wc.isDestroyed()) return false;
    const { safe, targetUrl, upgradedFromHttp } = this.prepareSafeNavigationUrl(rawUrl, {
      isPrivate: opts.isPrivate,
      wc,
    });
    if (!safe) {
      this.host.onBlockedNavigation?.(rawUrl, 'Blocked unsafe URL scheme');
      return false;
    }
    if (upgradedFromHttp) {
      try {
        const parsed = new URL(rawUrl);
        this.pendingUpgradesByWc.set(wc.id, {
          host: parsed.hostname.toLowerCase(),
          originalHttpUrl: rawUrl,
        });
      } catch {
        this.pendingUpgradesByWc.delete(wc.id);
      }
    } else {
      this.pendingUpgradesByWc.delete(wc.id);
    }

    try {
      if (wc.isLoading()) {
        wc.stop();
      }
      await wc.loadURL(targetUrl);
      return true;
    } catch {
      return false;
    }
  }

  clearWcTracking(wcId: number): void {
    this.pendingUpgradesByWc.delete(wcId);
  }

  attachWebContentsGuards(wc: WebContents, options: NavigationGuardOptions): void {
    let approvedCerts = this.approvedCertKeys.get(wc.session);
    if (!approvedCerts) {
      approvedCerts = new Set<string>();
      this.approvedCertKeys.set(wc.session, approvedCerts);
    }
    const sessionApprovedCerts = approvedCerts;
    let bypassedOrigin = '';
    let navigationGeneration = 0;
    wc.on('did-start-navigation', (_event, _url, _isInPlace, isMainFrame) => {
      if (isMainFrame !== false) {
        navigationGeneration += 1;
        bypassedOrigin = '';
      }
    });
    const fallbackHosts = this.getFallbackSet(wc);

    const enforceNavOrRedirect = (event: Electron.Event, targetUrl: string, isMainFrame: boolean) => {
      if (!isSafeNavigationUrl(targetUrl) && !isSameOriginBlobUrl(targetUrl, wc.getURL())) {
        event.preventDefault();
        if (isAllowedExternalProtocol(targetUrl)) {
          void this.confirmAndOpenExternal(targetUrl).catch(() => {});
        } else {
          this.host.onBlockedNavigation?.(targetUrl, 'Blocked unsafe navigation protocol');
        }
        return false;
      }

      if (isMainFrame && options.onWillNavigateRoute && options.onWillNavigateRoute(targetUrl)) {
        event.preventDefault();
        return false;
      }

      if (isMainFrame && this.host.isHttpsOnly() && targetUrl.startsWith('http://')) {
        const upgraded = upgradeUrlToHttpsIfNeeded(targetUrl, true, fallbackHosts);
        if (upgraded !== targetUrl) {
          event.preventDefault();
          try {
            const parsed = new URL(targetUrl);
            this.pendingUpgradesByWc.set(wc.id, {
              host: parsed.hostname.toLowerCase(),
              originalHttpUrl: targetUrl,
            });
          } catch {
            // Ignore malformed host
          }
          void wc.loadURL(upgraded).catch(() => {});
          return false;
        }
      }
      return true;
    };

    wc.on('will-navigate', (event, targetUrl, _isInPlace, isMainFrame) => {
      enforceNavOrRedirect(event, targetUrl, isMainFrame !== false);
    });

    wc.on('will-redirect', (event, targetUrl, _isInPlace, isMainFrame) => {
      enforceNavOrRedirect(event, targetUrl, isMainFrame !== false);
    });

    wc.on('did-fail-load', (_event, errorCode, _errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || wc.isDestroyed()) return;
      const category = classifyLoadError(errorCode);
      if (category === 'aborted') return;

      const pending = this.pendingUpgradesByWc.get(wc.id);
      this.pendingUpgradesByWc.delete(wc.id);

      let matchesUpgrade = false;
      let fallbackHttpUrl = '';
      let host = '';
      try {
        const parsed = new URL(validatedURL);
        host = parsed.hostname.toLowerCase();
        if (pending && pending.host === host) {
          matchesUpgrade = true;
          fallbackHttpUrl = pending.originalHttpUrl;
        } else if (parsed.protocol === 'https:') {
          parsed.protocol = 'http:';
          fallbackHttpUrl = parsed.toString();
        }
      } catch {
        return;
      }

      if (!shouldOfferInsecureHttpFallback(errorCode, validatedURL, this.host.isHttpsOnly(), matchesUpgrade)) {
        return;
      }

      void this.promptForHttpFallback(wc, host, fallbackHttpUrl, fallbackHosts).catch(() => {});
    });

    wc.on('certificate-error', (event, url, error, certificate, callback) => {
      event.preventDefault();
      options.onCertErrorChanged?.(true);

      let host = url;
      try {
        host = new URL(url).hostname.toLowerCase();
      } catch {
        // Keep raw string as fallback label
      }

      let origin: string;
      try {
        origin = new URL(url).origin;
      } catch {
        callback(false);
        return;
      }
      const certKey = `${origin}::${certificate.fingerprint}::${error}`;
      const promptKey = `${wc.id}::${certKey}`;
      const generation = navigationGeneration;
      if (certificate.fingerprint && sessionApprovedCerts.has(certKey)) {
        bypassedOrigin = origin;
        callback(true);
        return;
      }

      if (this.certDialogInFlight.has(promptKey)) {
        callback(false);
        return;
      }
      this.certDialogInFlight.add(promptKey);

      const parentWin = this.host.getDialogParentWindow();
      const show = parentWin && !parentWin.isDestroyed()
        ? dialog.showMessageBox(parentWin, {
            type: 'warning',
            buttons: ['Go Back Safely', 'Proceed Anyway (Unsafe)'],
            defaultId: 0,
            cancelId: 0,
            title: 'Your connection is not private',
            message: `${host} presented an untrusted TLS certificate`,
            detail: `Error: ${error}\nIssuer: ${certificate.issuerName || 'Unknown'}\n\nAttackers may be attempting to intercept information on this connection.`,
          })
        : Promise.resolve({ response: 0 });

      void show
        .then((res) => {
          const allow = res.response === 1 && !wc.isDestroyed() && generation === navigationGeneration;
          if (allow) {
            bypassedOrigin = origin;
            if (certificate.fingerprint) sessionApprovedCerts.add(certKey);
          }
          callback(allow);
        })
        .catch(() => {
          callback(false);
        })
        .finally(() => {
          this.certDialogInFlight.delete(promptKey);
        });
    });

    wc.on('did-finish-load', () => {
      if (wc.isDestroyed()) return;
      this.pendingUpgradesByWc.delete(wc.id);
      options.onLoadingChanged?.(false);
      const currentUrl = wc.getURL();
      if (currentUrl.startsWith('https://')) {
        try {
          const isBypassed = new URL(currentUrl).origin === bypassedOrigin;
          if (!isBypassed) {
            options.onCertErrorChanged?.(false);
          }
        } catch {
          // Ignore malformed URL
        }
      } else {
        options.onCertErrorChanged?.(false);
      }
      options.onDidFinishNavigation?.(currentUrl, wc.getTitle());
    });

    wc.on('did-start-loading', () => {
      if (!wc.isDestroyed()) options.onLoadingChanged?.(true);
    });

    wc.on('did-stop-loading', () => {
      if (!wc.isDestroyed() && !wc.isLoadingMainFrame()) {
        options.onLoadingChanged?.(false);
      }
    });

    wc.on('found-in-page', (_event, result) => {
      if (!wc.isDestroyed()) {
        options.onFoundInPage?.({
          activeMatchOrdinal: result.activeMatchOrdinal,
          matches: result.matches,
          finalUpdate: result.finalUpdate,
        });
      }
    });

    wc.on('did-navigate', (_e, url) => {
      if (wc.isDestroyed()) return;
      this.pendingUpgradesByWc.delete(wc.id);
      options.onNavigationStateChanged?.(url);
    });

    wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
      if (isMainFrame && !wc.isDestroyed()) options.onNavigationStateChanged?.(url);
    });

    wc.on('page-title-updated', (_e, title) => {
      if (!wc.isDestroyed()) options.onTitleUpdated?.(title);
    });

    wc.setWindowOpenHandler(({ url, disposition, features }) => {
      const isBlobPreview = isSameOriginBlobUrl(url, wc.getURL());
      if (!isSafeNavigationUrl(url) && !isBlobPreview) {
        if (isAllowedExternalProtocol(url)) {
          void this.confirmAndOpenExternal(url).catch(() => {});
        } else {
          this.host.onBlockedNavigation?.(url, 'Blocked unsafe popup URL');
        }
        return { action: 'deny' };
      }

      if (isBlobPreview || (features && features.trim().length > 0)) {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            autoHideMenuBar: true,
            webPreferences: {
              session: wc.session,
              preload: undefined,
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
          },
        };
      }

      const mode = disposition === 'background-tab' ? 'background' : 'foreground';
      if (options.onOpenInTab) {
        options.onOpenInTab(url, mode);
      } else {
        void this.navigateWebContents(wc, url, { isPrivate: options.isPrivate });
      }
      return { action: 'deny' };
    });

    wc.on('did-create-window', (popupWindow) => {
      if (popupWindow.isDestroyed()) return;
      options.onDidCreatePopupWindow?.(popupWindow);
      this.attachWebContentsGuards(popupWindow.webContents, {
        isPrivate: options.isPrivate,
        partitionKey: options.partitionKey,
        onDidCreatePopupWindow: options.onDidCreatePopupWindow,
      });
    });

    wc.once('destroyed', () => {
      this.clearWcTracking(wc.id);
    });
  }

  private async promptForHttpFallback(
    wc: WebContents,
    host: string,
    httpUrl: string,
    fallbackHosts: Set<string>
  ): Promise<void> {
    const parentWin = this.host.getDialogParentWindow();
    if (!parentWin || parentWin.isDestroyed() || wc.isDestroyed()) return;

    let invalidated = false;
    const invalidate = () => { invalidated = true; };
    wc.on('did-start-navigation', invalidate);
    wc.once('destroyed', invalidate);
    try {
      const res = await dialog.showMessageBox(parentWin, {
        type: 'warning',
        buttons: ['Cancel', 'Load Unencrypted HTTP'],
        defaultId: 0,
        cancelId: 0,
        title: 'HTTPS-Only Mode',
        message: `${host} does not appear to support a secure HTTPS connection.`,
        detail: `Your connection to ${httpUrl} would not be encrypted. Do you want to continue using insecure HTTP for ${host}?`,
      });

      if (res.response === 1 && !invalidated && !wc.isDestroyed()) {
        fallbackHosts.add(host);
        await wc.loadURL(httpUrl).catch(() => {});
      }
    } finally {
      wc.removeListener('did-start-navigation', invalidate);
      wc.removeListener('destroyed', invalidate);
    }
  }

  private async confirmAndOpenExternal(rawUrl: string): Promise<void> {
    const parentWin = this.host.getDialogParentWindow();
    if (!parentWin || parentWin.isDestroyed()) return;
    let scheme = 'external app';
    try {
      scheme = new URL(rawUrl).protocol.replace(':', '');
    } catch {
      return;
    }
    const res = await dialog.showMessageBox(parentWin, {
      type: 'question',
      buttons: ['Cancel', 'Open External App'],
      defaultId: 0,
      cancelId: 0,
      title: 'Open External Application',
      message: `Allow Kinex to open a "${scheme}" link?`,
      detail: rawUrl,
    });
    if (res.response === 1) {
      await shell.openExternal(rawUrl);
    }
  }
}
