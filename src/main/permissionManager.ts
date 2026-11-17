import { dialog, type BrowserWindow, type Session } from 'electron';
import type { SitePermissionDecision } from '../shared/types';
import { isDangerousPermission, isLoopbackHostname } from './security';

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

const PROMPT_PERMISSIONS = new Set([
  'media', 'geolocation', 'notifications', 'clipboard-read', 'display-capture',
  'mediaKeySystem', 'midi', 'speaker-selection', 'window-management',
  'storage-access', 'top-level-storage-access',
]);

const configuredSessions = new WeakSet<Session>();

export function isWebOriginEligible(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol === 'https:') return true;
    if (parsed.protocol === 'http:' && isLoopbackHostname(parsed.hostname)) return true;
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
  return PROMPT_PERMISSIONS.has(permission) ? 'prompt' : 'deny';
}

export function formatPermissionLabel(permission: string): string {
  switch (permission) {
    case 'media':
      return 'camera and microphone';
    case 'media:audio':
      return 'microphone';
    case 'media:video':
      return 'camera';
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
  recordDecision: (partition: string, origin: string, permission: string, decision: 'allow' | 'deny') => void;
  revokeDecision: (partition: string, origin: string, permission: string) => void;
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
        wc.removeListener('destroyed', cleanup);
        wc.removeListener('did-navigate', cleanup);
        wc.removeListener('render-process-gone', cleanup);
      };
      wc.once('destroyed', cleanup);
      wc.once('did-navigate', cleanup);
      wc.once('render-process-gone', cleanup);
    }
  }

  attachToSession(sess: Session, options: { isPrivate: boolean; partition: string }): void {
    if (configuredSessions.has(sess)) return;
    configuredSessions.add(sess);

    const { isPrivate, partition } = options;
    const findDecision = (origin: string, permission: string) => this.host.getDecisions()
      .find((p) => p.partition === partition && p.origin === origin && p.permission === permission);

    sess.setPermissionCheckHandler((_wc, permission, requestingOrigin, details) => {
      const originUrl = permission === 'media' ? details.securityOrigin || requestingOrigin : requestingOrigin;
      const staticDecision = evaluateStaticPermissionPolicy(permission, originUrl, isPrivate);
      if (staticDecision === 'deny') return false;
      if (staticDecision === 'allow') return true;
      if (isPrivate) return false;

      let origin: string;
      try {
        origin = new URL(originUrl).origin;
      } catch {
        return false;
      }
      if (permission === 'media' && details.mediaType !== 'audio' && details.mediaType !== 'video') return false;
      const key = permission === 'media' ? `media:${details.mediaType}` : permission;
      return findDecision(origin, key)?.decision === 'allow';
    });

    sess.setPermissionRequestHandler(async (wc, permission, callback, details) => {
      const requestingUrl = details.requestingUrl || '';
      const staticDecision = evaluateStaticPermissionPolicy(permission, requestingUrl, isPrivate);
      if (staticDecision !== 'prompt') {
        callback(staticDecision === 'allow');
        return;
      }
      if (isPrivate || wc.isDestroyed()) {
        callback(false);
        return;
      }

      let origin: string;
      try {
        origin = new URL(requestingUrl).origin;
      } catch {
        callback(false);
        return;
      }
      const mediaTypes = 'mediaTypes' in details ? details.mediaTypes : undefined;
      if (permission === 'media' && (!mediaTypes?.length ||
        mediaTypes.some((type) => type !== 'audio' && type !== 'video'))) {
        callback(false);
        return;
      }
      const keys = permission === 'media' ? [...new Set(mediaTypes!.map((type) => `media:${type}`))] : [permission];
      const existing = keys.map((key) => findDecision(origin, key));
      if (existing.some((decision) => decision?.decision === 'deny') || existing.every(Boolean)) {
        const allow = existing.every((decision) => decision?.decision === 'allow');
        this.trackMediaGrantIfApplicable(wc, permission, allow);
        callback(allow);
        return;
      }

      let invalidated = false;
      const invalidate = () => { invalidated = true; };
      wc.on('did-start-navigation', invalidate);
      wc.once('destroyed', invalidate);
      wc.once('render-process-gone', invalidate);
      let allow = false;
      try {
        const win = this.host.getMainWindow();
        const label = permission === 'media'
          ? mediaTypes!.map((type) => type === 'audio' ? 'microphone' : 'camera').join(' and ')
          : formatPermissionLabel(permission);
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
        if (!invalidated && !wc.isDestroyed()) {
          allow = res.response === 1;
          for (const key of keys) this.host.recordDecision(partition, origin, key, allow ? 'allow' : 'deny');
          this.trackMediaGrantIfApplicable(wc, permission, allow);
        }
      } catch {
        allow = false;
      } finally {
        wc.removeListener('did-start-navigation', invalidate);
        wc.removeListener('destroyed', invalidate);
        wc.removeListener('render-process-gone', invalidate);
      }
      callback(allow);
    });
  }

  revoke(partition: string, origin: string, permission: string): void {
    this.host.revokeDecision(partition, origin, permission);
  }
}
