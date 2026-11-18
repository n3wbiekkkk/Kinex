import { describe, expect, it } from 'vitest';
import {
  emptyFocusConfig,
  getFocusSession,
  isNavigationBlocked,
  reduceFocusSession,
  validateFocusRule,
  type FocusConfig,
} from './zenFocus';

function withRules(config: FocusConfig): FocusConfig {
  return {
    ...config,
    rulesBySpace: {
      work: [
        { id: 'r1', pattern: '*.social.example', kind: 'deny', enabled: true },
        { id: 'r2', pattern: 'docs.example.com', kind: 'deny', enabled: true },
        { id: 'r3', pattern: 'allowed.docs.example.com', kind: 'allow', enabled: true },
        { id: 'r4', pattern: 'mail.example.com', kind: 'deny', enabled: false },
      ],
    },
  };
}

describe('zenFocus session transitions', () => {
  it('starts, ends, and toggles a session', () => {
    let config = emptyFocusConfig();
    config = reduceFocusSession(config, { type: 'start', spaceId: 'work', now: 10 });
    expect(getFocusSession(config, 'work')).toEqual({
      active: true,
      spaceId: 'work',
      startedAt: 10,
      endedAt: null,
    });
    // starting twice preserves the original start time
    config = reduceFocusSession(config, { type: 'start', spaceId: 'work', now: 20 });
    expect(getFocusSession(config, 'work').startedAt).toBe(10);
    config = reduceFocusSession(config, { type: 'toggle', spaceId: 'work', now: 30 });
    expect(getFocusSession(config, 'work')).toMatchObject({ active: false, endedAt: 30 });
    config = reduceFocusSession(config, { type: 'toggle', spaceId: 'work', now: 40 });
    expect(getFocusSession(config, 'work')).toMatchObject({ active: true, startedAt: 40 });
    config = reduceFocusSession(config, { type: 'end', spaceId: 'work', now: 50 });
    expect(getFocusSession(config, 'work').active).toBe(false);
  });

  it('does not start or block in private spaces', () => {
    const privateConfig: FocusConfig = {
      ...withRules(emptyFocusConfig()),
      privateSpaceIds: new Set(['work']),
    };
    const next = reduceFocusSession(privateConfig, { type: 'start', spaceId: 'work', now: 1 });
    expect(next).toBe(privateConfig);
    expect(isNavigationBlocked(next, 'work', 'https://social.example/feed')).toBe(false);
  });

  it('ignores invalid actions', () => {
    const config = emptyFocusConfig();
    expect(reduceFocusSession(config, { type: 'start', spaceId: '', now: 1 })).toBe(config);
    expect(reduceFocusSession(config, { type: 'start', spaceId: 'work', now: Number.NaN })).toBe(config);
  });
});

describe('zenFocus navigation predicate', () => {
  it('blocks only when the session is active', () => {
    const inactive = withRules(emptyFocusConfig());
    expect(isNavigationBlocked(inactive, 'work', 'https://social.example/feed')).toBe(false);
    const active = reduceFocusSession(inactive, { type: 'start', spaceId: 'work', now: 1 });
    expect(isNavigationBlocked(active, 'work', 'https://social.example/feed')).toBe(true);
    expect(isNavigationBlocked(active, 'work', 'https://news.example')).toBe(false);
    expect(isNavigationBlocked(active, 'other', 'https://social.example')).toBe(false);
  });

  it('handles wildcard, exact, allow-override and disabled rules', () => {
    const active = reduceFocusSession(withRules(emptyFocusConfig()), {
      type: 'start',
      spaceId: 'work',
      now: 1,
    });
    expect(isNavigationBlocked(active, 'work', 'https://cdn.social.example/x')).toBe(true);
    expect(isNavigationBlocked(active, 'work', 'https://www.docs.example.com/x')).toBe(true);
    expect(isNavigationBlocked(active, 'work', 'https://allowed.docs.example.com')).toBe(false);
    expect(isNavigationBlocked(active, 'work', 'https://mail.example.com')).toBe(false);
  });
});

describe('zenFocus rule validation', () => {
  it('accepts valid rules and rejects hostile payloads', () => {
    expect(
      validateFocusRule({ id: 'r', pattern: '*.social.example', kind: 'deny', enabled: true }).ok
    ).toBe(true);
    expect(validateFocusRule({ id: '', pattern: 'x', kind: 'deny', enabled: true }).ok).toBe(false);
    expect(
      validateFocusRule({ id: 'r', pattern: 'x\u0000', kind: 'deny', enabled: true }).ok
    ).toBe(false);
    expect(
      validateFocusRule({ id: 'r', pattern: 'x', kind: 'block', enabled: true }).ok
    ).toBe(false);
    expect(validateFocusRule(null).ok).toBe(false);
  });
});
