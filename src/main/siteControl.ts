/**
 * Pure site-control policy. Derives a display/validation model from a URL plus
 * injected security state; no Electron import at module scope.
 */
import {
  extractHostname,
  normalizeShieldsSiteKey,
  resolveEffectiveShieldsMode,
} from '../shared/domain';
import type {
  PersistedShieldsSettings,
  SecurityState,
  ShieldsMode,
  SitePermissionDecision,
} from '../shared/types';

export type CookiePolicy = 'allow' | 'block-third-party' | 'block-all';

export const COOKIE_POLICIES: readonly CookiePolicy[] = ['allow', 'block-third-party', 'block-all'];

export const MANAGEABLE_PERMISSIONS: readonly string[] = [
  'camera',
  'microphone',
  'geolocation',
  'notifications',
  'midi',
  'fullscreen',
  'clipboard-read',
  'clipboard-sanitized-write',
  'idle-detection',
  'screen-wake-lock',
  'background-sync',
  'persistent-storage',
];

const PERMISSION_SET = new Set<string>(MANAGEABLE_PERMISSIONS);
const MAX_URL_LEN = 8192;
const MAX_LABEL_LEN = 256;

export type TlsLabel = 'secure' | 'insecure' | 'warning' | 'internal';

export interface SitePermissionStatus {
  permission: string;
  status: 'allowed' | 'denied';
  origin: string;
}

export interface SiteControlModel {
  url: string;
  origin: string;
  host: string;
  isInternal: boolean;
  tls: { state: SecurityState; secure: boolean; label: TlsLabel };
  shields: {
    mode: ShieldsMode;
    source: 'internal' | 'site' | 'domain' | 'global';
    domainKey: string;
  };
  cookiePolicy: { effective: CookiePolicy; source: 'site' | 'global'; origin: string };
  permissions: SitePermissionStatus[];
}

export interface SiteControlInput {
  url: string;
  securityState?: SecurityState;
  shields: Pick<PersistedShieldsSettings, 'globalMode' | 'siteOverrides'>;
  permissions: readonly SitePermissionDecision[];
  registrableDomain?: string | null;
  defaultCookiePolicy?: CookiePolicy;
  cookiePolicyByOrigin?: Readonly<Record<string, CookiePolicy>>;
}

export type UrlValidation =
  | { ok: true; url: string; origin: string; host: string }
  | { ok: false; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasControlChars(value: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(value);
}

/** Only http(s) origins without credentials/control characters are manageable. */
export function validateSiteControlUrl(raw: unknown): UrlValidation {
  if (typeof raw !== 'string') return { ok: false, reason: 'URL must be a string' };
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, reason: 'URL is empty' };
  if (trimmed.length > MAX_URL_LEN) return { ok: false, reason: 'URL is too long' };
  if (hasControlChars(trimmed)) return { ok: false, reason: 'URL contains control characters' };
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, reason: 'URL is malformed' };
  }
  const protocol = parsed.protocol.toLowerCase();
  if (protocol !== 'http:' && protocol !== 'https:') {
    return { ok: false, reason: 'Only http(s) origins are supported' };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, reason: 'URLs with credentials are not allowed' };
  }
  const host = parsed.hostname.toLowerCase();
  if (!host) return { ok: false, reason: 'URL has no host' };
  return { ok: true, url: parsed.href, origin: parsed.origin, host };
}

/** Internal/privileged schemes are described but never accepted as mutations. */
export function isInternalControlUrl(rawUrl: string): boolean {
  const lower = rawUrl.trim().toLowerCase();
  return (
    lower.startsWith('kinex://') ||
    lower.startsWith('nook://') ||
    lower.startsWith('about:') ||
    lower.startsWith('devtools:') ||
    lower.startsWith('chrome:') ||
    lower.startsWith('file:')
  );
}

function tlsFromState(state: SecurityState): { state: SecurityState; secure: boolean; label: TlsLabel } {
  if (state === 'internal') return { state, secure: false, label: 'internal' };
  if (state === 'cert-warning') return { state, secure: false, label: 'warning' };
  if (state === 'insecure') return { state, secure: false, label: 'insecure' };
  return { state: 'secure', secure: true, label: 'secure' };
}

export function buildSiteControlModel(input: SiteControlInput): SiteControlModel {
  const raw = typeof input.url === 'string' ? input.url : '';
  const checked = validateSiteControlUrl(raw);
  const isInternal = isInternalControlUrl(raw) || !checked.ok;
  const host = checked.ok ? checked.host.replace(/^www\./, '') : extractHostname(raw) || normalizeShieldsSiteKey(raw);
  const origin = checked.ok ? checked.origin : '';
  const shields = resolveEffectiveShieldsMode(
    input.shields,
    raw,
    input.registrableDomain ?? normalizeShieldsSiteKey(raw)
  );

  let state: SecurityState;
  if (isInternal) {
    state = 'internal';
  } else if (input.securityState) {
    state = input.securityState;
  } else {
    try {
      state = new URL(raw).protocol === 'https:' ? 'secure' : 'insecure';
    } catch {
      state = 'insecure';
    }
  }

  const overrides = input.cookiePolicyByOrigin ?? {};
  const cookieSource: 'site' | 'global' = origin in overrides ? 'site' : 'global';
  const cookieEffective = cookieSource === 'site' ? overrides[origin]! : input.defaultCookiePolicy ?? 'block-third-party';

  const seen = new Set<string>();
  const permissions: SitePermissionStatus[] = [];
  for (let i = input.permissions.length - 1; i >= 0; i -= 1) {
    const decision = input.permissions[i]!;
    if (decision.origin !== origin || seen.has(decision.permission)) continue;
    seen.add(decision.permission);
    permissions.push({
      permission: decision.permission,
      status: decision.decision === 'allow' ? 'allowed' : 'denied',
      origin: decision.origin,
    });
  }
  permissions.sort((a, b) => a.permission.localeCompare(b.permission));

  return {
    url: checked.ok ? checked.url : raw,
    origin,
    host,
    isInternal,
    tls: tlsFromState(state),
    shields: { mode: shields.mode, source: shields.source, domainKey: shields.domainKey },
    cookiePolicy: { effective: cookieEffective, source: cookieSource, origin },
    permissions,
  };
}

export type SiteControlMutation =
  | { type: 'set-site-cookie-policy'; origin: string; policy: CookiePolicy }
  | { type: 'set-site-permission'; origin: string; permission: string; decision: 'allow' | 'deny' };

export type MutationValidation =
  | { ok: true; mutation: SiteControlMutation }
  | { ok: false; reason: string };

/** Validate every site-control mutation payload at the IPC boundary. */
export function validateSiteControlMutation(value: unknown): MutationValidation {
  if (!isRecord(value)) return { ok: false, reason: 'Mutation must be an object' };
  const type = value.type;
  const originCheck = validateSiteControlUrl(value.origin);
  if (!originCheck.ok) return { ok: false, reason: `Invalid origin: ${originCheck.reason}` };
  const origin = originCheck.origin;

  if (type === 'set-site-cookie-policy') {
    if (typeof value.policy !== 'string' || !(COOKIE_POLICIES as readonly string[]).includes(value.policy)) {
      return { ok: false, reason: 'Invalid cookie policy' };
    }
    return { ok: true, mutation: { type, origin, policy: value.policy as CookiePolicy } };
  }

  if (type === 'set-site-permission') {
    if (typeof value.permission !== 'string' || value.permission.length > MAX_LABEL_LEN || !PERMISSION_SET.has(value.permission)) {
      return { ok: false, reason: 'Invalid permission' };
    }
    if (value.decision !== 'allow' && value.decision !== 'deny') {
      return { ok: false, reason: 'Invalid permission decision' };
    }
    return {
      ok: true,
      mutation: { type, origin, permission: value.permission, decision: value.decision },
    };
  }

  return { ok: false, reason: 'Unknown site-control mutation' };
}

/** Pure reducer for permission mutations (returns a new array). */
export function applySitePermissionMutation(
  decisions: readonly SitePermissionDecision[],
  mutation: SiteControlMutation,
  partition: string,
  now: number
): SitePermissionDecision[] {
  if (mutation.type !== 'set-site-permission') return decisions.slice();
  const next = decisions.filter(
    (d) => !(d.origin === mutation.origin && d.permission === mutation.permission)
  );
  return [
    ...next,
    {
      partition,
      origin: mutation.origin,
      permission: mutation.permission,
      decision: mutation.decision,
      updatedAt: now,
    },
  ];
}
