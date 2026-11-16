import { dialog, type BrowserWindow, type Session } from 'electron';
import type { SitePermissionDecision } from '../shared/types';
import { isDangerousPermission, isLocalHostname } from './security';

const PRIVATE_SENSITIVE_DENIED = new Set([
  'notifications',
  'geolocation',
  'media',
  'mediaKeySystem',
  'clipboard-read',
  'display-capture',
  'background-sync',
  'periodic-background-sync',
  'speaker-selection',
  'window-management',
]);

const HARMLESS_PERMISSIONS = new Set([
  'fullscreen',
  'pointerLock',
  'clipboard-sanitized-write',
]);

const configuredSessions = new WeakSet<Session>();

export function isWebOriginEligible(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol === 'https:') return true;
    if (parsed.protocol === 'http:' && isLocalHostname(parsed.hostname)) return true;
    return false;
  } catch {
    return false;
  }
}

export function evaluateStaticPermissionPolicy(
  permission: string,
  requestingOrigin: string,
  isPrivate: boolean
): 'allow' | 'deny' | 'prompt' {
  if (isDangerousPermission(permission)) {
    return 'deny';
  }
  if (HARMLESS_PERMISSIONS.has(permission)) {
    return 'allow';
  }
  if (!isWebOriginEligible(requestingOrigin)) {
    return 'deny';
  }
  if (isPrivate && PRIVATE_SENSITIVE_DENIED.has(permission)) {
    return 'deny';
  }
  return 'prompt';
}

export function formatPermissionLabel(permission: string): string {
  switch (permission) {
    case 'media':
      return 'camera and microphone';
    case 'geolocation':
      return 'precise location';
    case 'notifications':
      return 'desktop notifications';
    case 'clipboard-read':
      return 'read your clipboard';
    case 'display-capture':
      return 'capture your screen';
    default:
      return permission;
  }
}

export interface PermissionManagerHost {
  getMainWindow: () => BrowserWindow | null;
  getDecisions: () => SitePermissionDecision[];
  recordDecision: (origin: string, permission: string, decision: 'allow' | 'deny') => void;
  revokeDecision: (origin: string, permission: string) => void;
}

export class PermissionManager {
  private readonly activeMediaCaptureWcIds = new Set<number>();

  constructor(private readonly host: PermissionManagerHost) {}

  hasActiveMediaCapture(wcId: number): boolean {
    return this.activeMediaCaptureWcIds.has(wcId);
  }

  private trackMediaGrantIfApplicable(wc: Electron.WebContents | null | undefined, permission: string, allowed: boolean): void {
    if (!wc || wc.isDestroyed()) return;
    if (permission !== 'media' && permission !== 'display-capture') return;
    if (!allowed) return;
    const wcId = wc.id;
    if (!this.activeMediaCaptureWcIds.has(wcId)) {
      this.activeMediaCaptureWcIds.add(wcId);
      const cleanup = () => {
        this.activeMediaCaptureWcIds.delete(wcId);
      };
      wc.once('destroyed', cleanup);
      wc.once('did-navigate', cleanup);
    }
  }

  attachToSession(sess: Session, options: { isPrivate: boolean }): void {
    if (configuredSessions.has(sess)) return;
    configuredSessions.add(sess);

    const { isPrivate } = options;

    sess.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
      const staticDecision = evaluateStaticPermissionPolicy(permission, requestingOrigin, isPrivate);
      if (staticDecision === 'deny') return false;
      if (staticDecision === 'allow') return true;
      if (isPrivate) return false;

      let origin = '';
      try {
        origin = new URL(requestingOrigin).origin;
      } catch {
        return false;
      }

      const existing = this.host
        .getDecisions()
        .find((p) => p.origin === origin && p.permission === permission);
      return existing?.decision === 'allow';
    });

    sess.setPermissionRequestHandler(async (wc, permission, callback, details) => {
      const requestingUrl = details.requestingUrl || '';
      const staticDecision = evaluateStaticPermissionPolicy(permission, requestingUrl, isPrivate);
      if (staticDecision === 'deny') {
        callback(false);
        return;
      }
      if (staticDecision === 'allow') {
        callback(true);
        return;
      }
      if (isPrivate) {
        callback(false);
        return;
      }

      let origin = '';
      try {
        origin = new URL(requestingUrl).origin;
      } catch {
        callback(false);
        return;
      }

      const existing = this.host
        .getDecisions()
        .find((p) => p.origin === origin && p.permission === permission);
      if (existing) {
        const allow = existing.decision === 'allow';
        this.trackMediaGrantIfApplicable(wc, permission, allow);
        callback(allow);
        return;
      }

      const win = this.host.getMainWindow();
      const label = formatPermissionLabel(permission);
      const res = win && !win.isDestroyed()
        ? await dialog.showMessageBox(win, {
            type: 'question',
            buttons: ['Block', 'Allow'],
            defaultId: 0,
            cancelId: 0,
            title: 'Site Permission Request',
            message: `${origin} wants to access ${label}`,
            detail: 'You can change or revoke site permissions anytime in Settings > Privacy & Security.',
          })
        : { response: 0 };

      const allow = res.response === 1;
      this.host.recordDecision(origin, permission, allow ? 'allow' : 'deny');
      this.trackMediaGrantIfApplicable(wc, permission, allow);
      callback(allow);
    });
  }

  revoke(origin: string, permission: string): void {
    this.host.revokeDecision(origin, permission);
  }
}
