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
  'mediaKeySystem', 'protectedMediaIdentifier', 'midi', 'speaker-selection', 'window-management',
  'storage-access', 'top-level-storage-access',
]);

const PROTECTED_MEDIA_PERMISSIONS = new Set(['mediaKeySystem', 'protectedMediaIdentifier']);
for (const permission of PROTECTED_MEDIA_PERMISSIONS) PRIVATE_SENSITIVE_DENIED.add(permission);

/** Electron names WebAuthn/passkey capabilities several ways; normalize them. */
export const PASSKEY_PERMISSIONS = new Set([
  'webauthn',
  'publickey-credentials-get',
  'publickey-credentials-create',
  'passkey',
]);
for (const permission of PASSKEY_PERMISSIONS) PROMPT_PERMISSIONS.add(permission);

const CAPABILITY_ALIASES: Record<string, string> = {
  camera: 'media:video',
  microphone: 'media:audio',
  'publickey-credentials-get': 'webauthn',
  'publickey-credentials-create': 'webauthn',
  passkey: 'webauthn',
};

/** Resolve a capability name to its canonical form. */
export function resolveCapability(permission: string): string {
  return CAPABILITY_ALIASES[permission] ?? permission;
}

export function isPasskeyCapability(permission: string): boolean {
  return PASSKEY_PERMISSIONS.has(resolveCapability(permission));
}

/**
 * Capability-specific storage key. Granting the microphone never grants the
 * camera: each media type is recorded and checked independently.
 */
export function capabilityKey(permission: string, details: { mediaType?: string } = {}): string {
  const canonical = resolveCapability(permission);
  if (canonical === 'media' && (details.mediaType === 'audio' || details.mediaType === 'video')) {
    return `media:${details.mediaType}`;
  }
  return canonical;
}

/** A stored grant only satisfies the exact capability it was recorded for. */
export function grantCoversCapability(grantedPermission: string, requestedCapability: string): boolean {
  return resolveCapability(grantedPermission) === resolveCapability(requestedCapability);
}

/** Scope key for passkey verification rate limiting. */
export function passkeyScope(partition: string, spaceId: string | undefined, origin: string): string {
  return `${partition}|${spaceId ?? ''}|${origin}`;
}

export interface PasskeyLimitConfig {
  maxVerifications: number;
  windowMs: number;
}

export const DEFAULT_PASSKEY_LIMIT: PasskeyLimitConfig = {
  maxVerifications: 5,
  windowMs: 5 * 60 * 1000,
};

/** Time-windowed, per-scope WebAuthn/passkey verification limiter. */
export class PasskeyVerificationLimiter {
  private readonly events = new Map<string, number[]>();

  constructor(private readonly config: PasskeyLimitConfig = DEFAULT_PASSKEY_LIMIT) {}

  private active(key: string, now: number): number[] {
    const cutoff = now - this.config.windowMs;
    const kept = (this.events.get(key) ?? []).filter((timestamp) => timestamp > cutoff);
    if (kept.length > 0) this.events.set(key, kept);
    else this.events.delete(key);
    return kept;
  }

  isLimited(key: string, now = Date.now()): boolean {
    return this.active(key, now).length >= this.config.maxVerifications;
  }

  remaining(key: string, now = Date.now()): number {
    return Math.max(0, this.config.maxVerifications - this.active(key, now).length);
  }

  record(key: string, now = Date.now()): void {
    const timestamps = this.active(key, now);
    timestamps.push(now);
    this.events.set(key, timestamps);
  }

  reset(key?: string): void {
    if (key === undefined) this.events.clear();
    else this.events.delete(key);
  }
}

/** A decision may carry a Space id; legacy profile-wide grants omit it. */
type ScopedDecision = SitePermissionDecision & { spaceId?: string };

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
  if (!isWebOriginEligible(requestingOrigin) || (PROTECTED_MEDIA_PERMISSIONS.has(permission) && !requestingOrigin.startsWith('https:'))) {
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
      return 'capture your screen';
    case 'mediaKeySystem':
    case 'protectedMediaIdentifier':
      return 'protected media content';
    default:
      return permission;
  }
}

export interface PermissionManagerHost {
  getMainWindow: () => BrowserWindow | null;
  getDecisions: () => SitePermissionDecision[];
  recordDecision: (partition: string, origin: string, permission: string, decision: 'allow' | 'deny') => void;
  revokeDecision: (partition: string, origin: string, permission: string) => void;
  /** Optional Space-aware persistence hooks; when absent, decisions stay profile-wide. */
  recordDecisionForSpace?: (
    partition: string,
    spaceId: string,
    origin: string,
    permission: string,
    decision: 'allow' | 'deny'
  ) => void;
  revokeDecisionForSpace?: (partition: string, spaceId: string, origin: string, permission: string) => void;
}

export class PermissionManager {
  private readonly activeMediaCaptureWcIds = new Set<number>();
  private readonly passkeyLimiter = new PasskeyVerificationLimiter();

  constructor(private readonly host: PermissionManagerHost) {}

  hasActiveMediaCapture(wcId: number): boolean {
    return this.activeMediaCaptureWcIds.has(wcId);
  }

  isPasskeyVerificationAllowed(key: string): boolean {
    return !this.passkeyLimiter.isLimited(key);
  }

  recordPasskeyVerification(key: string): void {
    this.passkeyLimiter.record(key);
  }

  resetPasskeyVerification(key?: string): void {
    this.passkeyLimiter.reset(key);
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

  attachToSession(sess: Session, options: { isPrivate: boolean; partition: string; spaceId?: string }): void {
    if (configuredSessions.has(sess)) return;
    configuredSessions.add(sess);

    const { isPrivate, partition, spaceId } = options;

    /**
     * Scope matching: a Space-scoped grant is visible only inside that Space,
     * while legacy profile-wide grants (no spaceId) remain valid everywhere.
     * An unscoped session never consumes a Space-scoped grant.
     */
    const matchesScope = (decision: ScopedDecision): boolean =>
      spaceId ? (!decision.spaceId || decision.spaceId === spaceId) : !decision.spaceId;

    const findDecision = (origin: string, permission: string) => (this.host.getDecisions() as ScopedDecision[])
      .find((p) => p.partition === partition && p.origin === origin &&
        p.permission === permission && matchesScope(p));

    const record = (origin: string, permission: string, decision: 'allow' | 'deny') => {
      if (spaceId && this.host.recordDecisionForSpace) {
        this.host.recordDecisionForSpace(partition, spaceId, origin, permission, decision);
      } else {
        this.host.recordDecision(partition, origin, permission, decision);
      }
    };

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
      const key = capabilityKey(permission, details as { mediaType?: string });
      if (isPasskeyCapability(key) &&
          this.passkeyLimiter.isLimited(passkeyScope(partition, spaceId, origin))) {
        return false;
      }
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

      const passkey = isPasskeyCapability(permission);
      const scopeKey = passkeyScope(partition, spaceId, origin);
      if (passkey && this.passkeyLimiter.isLimited(scopeKey)) {
        callback(false);
        return;
      }
      const noteVerification = (allowed: boolean) => {
        if (allowed && passkey) this.passkeyLimiter.record(scopeKey);
      };

      const keys = permission === 'media' ? [...new Set(mediaTypes!.map((type) => `media:${type}`))] : [capabilityKey(permission)];
      const existing = keys.map((key) => findDecision(origin, key));
      if (existing.some((decision) => decision?.decision === 'deny') || existing.every(Boolean)) {
        const allow = existing.every((decision) => decision?.decision === 'allow');
        this.trackMediaGrantIfApplicable(wc, permission, allow);
        noteVerification(allow);
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
          for (const key of keys) record(origin, key, allow ? 'allow' : 'deny');
          this.trackMediaGrantIfApplicable(wc, permission, allow);
          noteVerification(allow);
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

  revoke(partition: string, origin: string, permission: string, spaceId?: string): void {
    if (spaceId && this.host.revokeDecisionForSpace) {
      this.host.revokeDecisionForSpace(partition, spaceId, origin, permission);
    } else {
      this.host.revokeDecision(partition, origin, permission);
    }
  }
}
