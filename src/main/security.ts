import path from 'node:path';
import { matchesDomainPattern } from '../shared/domain';
import type { AirTrafficRule, SecurityState } from '../shared/types';

export type LoadErrorCategory =
  | 'aborted'
  | 'cert-error'
  | 'dns-error'
  | 'offline'
  | 'timeout'
  | 'https-unavailable'
  | 'network-error';

const ALLOWED_EXTERNAL_PROTOCOLS = new Set(['mailto:', 'tel:']);

const HTTPS_UNAVAILABLE_ERROR_CODES = new Set([
  -100, // ERR_CONNECTION_CLOSED
  -101, // ERR_CONNECTION_RESET
  -102, // ERR_CONNECTION_REFUSED
  -107, // ERR_SSL_PROTOCOL_ERROR
  -113, // ERR_SSL_VERSION_OR_CIPHER_MISMATCH
  -114, // ERR_SSL_RENEGOTIATION_REQUESTED
  -126, // ERR_SSL_BAD_RECORD_MAC_ALERT
]);

const DNS_ERROR_CODES = new Set([
  -105, // ERR_NAME_NOT_RESOLVED
  -137, // ERR_NAME_RESOLUTION_FAILED
]);

const TIMEOUT_ERROR_CODES = new Set([
  -7, // ERR_TIMED_OUT
  -118, // ERR_CONNECTION_TIMED_OUT
]);

export function classifyLoadError(errorCode: number): LoadErrorCategory {
  if (errorCode === -3) return 'aborted';
  if ((errorCode <= -200 && errorCode >= -217) || errorCode === -501) return 'cert-error';
  if (DNS_ERROR_CODES.has(errorCode)) return 'dns-error';
  if (errorCode === -106) return 'offline';
  if (TIMEOUT_ERROR_CODES.has(errorCode)) return 'timeout';
  if (HTTPS_UNAVAILABLE_ERROR_CODES.has(errorCode)) return 'https-unavailable';
  return 'network-error';
}

export function shouldOfferInsecureHttpFallback(
  errorCode: number,
  rawUrl: string,
  httpsOnly: boolean,
  wasUpgradedFromHttp: boolean
): boolean {
  if (!httpsOnly || !wasUpgradedFromHttp) return false;
  if (classifyLoadError(errorCode) !== 'https-unavailable') return false;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'https:') return false;
    return !isLocalHostname(parsed.hostname);
  } catch {
    return false;
  }
}

export function isAllowedExternalProtocol(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    return ALLOWED_EXTERNAL_PROTOCOLS.has(parsed.protocol.toLowerCase());
  } catch {
    return false;
  }
}

export function isSafeUpdateFeedUrl(rawFeed: string): boolean {
  const trimmed = rawFeed.trim();
  if (!trimmed) return true;
  if (trimmed.includes('\0')) return false;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol === 'https:' && parsed.hostname.length > 0) return true;
      if (parsed.protocol === 'http:' && isLocalHostname(parsed.hostname)) return true;
      return false;
    } catch {
      return false;
    }
  }
  const resolved = path.resolve(trimmed);
  return path.isAbsolute(resolved);
}

const TRACKING_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'fbclid',
  'gclid',
  'dclid',
  'gbraid',
  'wbraid',
  'mc_cid',
  'mc_eid',
  'igshid',
  'si',
  '_hsenc',
  '_hsmi',
  'yclid',
]);

const DANGEROUS_PERMISSIONS = new Set([
  'midiSysex',
  'hid',
  'serial',
  'usb',
  'openExternal',
  'idle-detection',
  'keyboardLock',
]);

export function isSafeNavigationUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    return (
      parsed.protocol === 'http:' ||
      parsed.protocol === 'https:' ||
      parsed.protocol === 'kinex:' ||
      parsed.protocol === 'nook:' ||
      rawUrl === 'about:blank'
    );
  } catch {
    return false;
  }
}

export function isLocalHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '[::1]' ||
    host === '::1' ||
    host.endsWith('.local')
  );
}

export function upgradeUrlToHttpsIfNeeded(
  rawUrl: string,
  httpsOnly: boolean,
  exemptHosts: Set<string>
): string {
  if (!httpsOnly) return rawUrl;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'http:') return rawUrl;
    if (isLocalHostname(parsed.hostname)) return rawUrl;
    if (exemptHosts.has(parsed.hostname.toLowerCase())) return rawUrl;
    parsed.protocol = 'https:';
    return parsed.toString();
  } catch {
    return rawUrl;
  }
}

export function stripTrackingParams(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return rawUrl;
    }
    let changed = false;
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (TRACKING_PARAMS.has(key.toLowerCase())) {
        parsed.searchParams.delete(key);
        changed = true;
      }
    }
    return changed ? parsed.toString() : rawUrl;
  } catch {
    return rawUrl;
  }
}

export function classifySecurityState(rawUrl: string, hasCertError: boolean): SecurityState {
  if (hasCertError) return 'cert-warning';
  if (rawUrl.startsWith('kinex://') || rawUrl.startsWith('nook://') || rawUrl === 'about:blank') {
    return 'internal';
  }
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol === 'https:') return 'secure';
    if (parsed.protocol === 'http:' && isLocalHostname(parsed.hostname)) return 'secure';
    return 'insecure';
  } catch {
    return 'insecure';
  }
}

export function isDangerousPermission(permission: string): boolean {
  return DANGEROUS_PERMISSIONS.has(permission);
}

export function matchAirTrafficSpace(rawUrl: string, rules: AirTrafficRule[]): string | null {
  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (matchesDomainPattern(rawUrl, rule.pattern)) {
      return rule.spaceId;
    }
  }
  return null;
}
