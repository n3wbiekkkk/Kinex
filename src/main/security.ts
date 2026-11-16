import { matchesDomainPattern } from '../shared/domain';
import type { AirTrafficRule, SecurityState } from '../shared/types';

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
