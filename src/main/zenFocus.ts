/**
 * Per-Space Zen Focus distraction blocker. Pure state transitions + a
 * navigation predicate; no Electron import at module scope.
 */
import { matchesDomainPattern } from '../shared/domain';

export type FocusRuleKind = 'allow' | 'deny';

export interface FocusDomainRule {
  id: string;
  pattern: string;
  kind: FocusRuleKind;
  enabled: boolean;
}

export interface FocusSessionState {
  active: boolean;
  spaceId: string;
  startedAt: number | null;
  endedAt: number | null;
}

export interface FocusConfig {
  rulesBySpace: Record<string, FocusDomainRule[]>;
  sessions: Record<string, FocusSessionState>;
  /** Private spaces are exempt: no focus session can block them. */
  privateSpaceIds?: ReadonlySet<string>;
}

export type FocusActionType = 'start' | 'end' | 'toggle';

export interface FocusAction {
  type: FocusActionType;
  spaceId: string;
  now: number;
}

const RULE_KINDS = new Set<FocusRuleKind>(['allow', 'deny']);
const MAX_ID = 128;
const MAX_PATTERN = 512;

export function emptyFocusConfig(): FocusConfig {
  return { rulesBySpace: {}, sessions: {} };
}

export function inactiveSession(spaceId: string): FocusSessionState {
  return { active: false, spaceId, startedAt: null, endedAt: null };
}

export function getFocusSession(config: FocusConfig, spaceId: string): FocusSessionState {
  return config.sessions[spaceId] ?? inactiveSession(spaceId);
}

function isPrivate(config: FocusConfig, spaceId: string): boolean {
  return config.privateSpaceIds?.has(spaceId) ?? false;
}

/** Pure reducer for focus-session transitions; private spaces are a no-op. */
export function reduceFocusSession(config: FocusConfig, action: FocusAction): FocusConfig {
  if (!action.spaceId || isPrivate(config, action.spaceId) || !Number.isFinite(action.now)) {
    return config;
  }
  const current = getFocusSession(config, action.spaceId);
  const type: FocusActionType =
    action.type === 'toggle' ? (current.active ? 'end' : 'start') : action.type;
  if (type !== 'start' && type !== 'end') return config;

  let next: FocusSessionState;
  if (type === 'start') {
    next = current.active
      ? current
      : { active: true, spaceId: action.spaceId, startedAt: action.now, endedAt: null };
  } else {
    next = current.active
      ? { ...current, active: false, endedAt: action.now }
      : current;
  }
  return { ...config, sessions: { ...config.sessions, [action.spaceId]: next } };
}

/**
 * Whether a navigation should be blocked. Only an active, non-private session
 * blocks. Matching allow rules win over deny rules; denied-by-default is not
 * assumed, so a session with no matching rules is permissive.
 */
export function isNavigationBlocked(
  config: FocusConfig,
  spaceId: string,
  url: string
): boolean {
  if (isPrivate(config, spaceId)) return false;
  if (!getFocusSession(config, spaceId).active) return false;
  const rules = config.rulesBySpace[spaceId] ?? [];
  let hasAllow = false;
  let hasDeny = false;
  for (const rule of rules) {
    if (!rule.enabled || !matchesDomainPattern(url, rule.pattern)) continue;
    if (rule.kind === 'allow') hasAllow = true;
    else hasDeny = true;
  }
  if (hasAllow) return false;
  return hasDeny;
}

export type RuleValidation =
  | { ok: true; rule: FocusDomainRule }
  | { ok: false; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateFocusRule(value: unknown): RuleValidation {
  if (!isRecord(value)) return { ok: false, reason: 'Rule must be an object' };
  if (typeof value.id !== 'string' || !value.id.trim() || value.id.length > MAX_ID) {
    return { ok: false, reason: 'Invalid rule id' };
  }
  if (
    typeof value.pattern !== 'string' ||
    !value.pattern.trim() ||
    value.pattern.length > MAX_PATTERN ||
    /[\u0000-\u001f\u007f]/.test(value.pattern)
  ) {
    return { ok: false, reason: 'Invalid rule pattern' };
  }
  if (typeof value.kind !== 'string' || !RULE_KINDS.has(value.kind as FocusRuleKind)) {
    return { ok: false, reason: 'Invalid rule kind' };
  }
  if (typeof value.enabled !== 'boolean') {
    return { ok: false, reason: 'Invalid rule enabled flag' };
  }
  return {
    ok: true,
    rule: {
      id: value.id,
      pattern: value.pattern.trim(),
      kind: value.kind as FocusRuleKind,
      enabled: value.enabled,
    },
  };
}
