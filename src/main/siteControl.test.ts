import { describe, expect, it } from 'vitest';
import type { PersistedShieldsSettings, SitePermissionDecision } from '../shared/types';
import {
  applySitePermissionMutation,
  buildSiteControlModel,
  isInternalControlUrl,
  validateSiteControlMutation,
  validateSiteControlUrl,
  type SiteControlInput,
} from './siteControl';

const shields: Pick<PersistedShieldsSettings, 'globalMode' | 'siteOverrides'> = {
  globalMode: 'standard',
  siteOverrides: { 'example.com': 'aggressive' },
};

function input(overrides: Partial<SiteControlInput> = {}): SiteControlInput {
  return {
    url: 'https://www.example.com/path',
    shields,
    permissions: [],
    ...overrides,
  };
}

describe('siteControl URL validation', () => {
  it('accepts clean http(s) origins and rejects hostile/internal ones', () => {
    expect(validateSiteControlUrl('https://example.com/a').ok).toBe(true);
    expect(validateSiteControlUrl('http://example.com').ok).toBe(true);
    expect(validateSiteControlUrl('file:///etc/passwd').ok).toBe(false);
    expect(validateSiteControlUrl('javascript:alert(1)').ok).toBe(false);
    expect(validateSiteControlUrl('kinex://welcome').ok).toBe(false);
    expect(validateSiteControlUrl('about:blank').ok).toBe(false);
    expect(validateSiteControlUrl('https://user:pass@example.com').ok).toBe(false);
    expect(validateSiteControlUrl('https://example.com/\u0000x').ok).toBe(false);
    expect(validateSiteControlUrl(42).ok).toBe(false);
    expect(isInternalControlUrl('nook://foo')).toBe(true);
    expect(isInternalControlUrl('https://example.com')).toBe(false);
  });
});

describe('siteControl model building', () => {
  it('derives TLS state, shields override, host and origin for a secure page', () => {
    const model = buildSiteControlModel(input());
    expect(model.isInternal).toBe(false);
    expect(model.host).toBe('example.com');
    expect(model.origin).toBe('https://www.example.com');
    expect(model.tls).toEqual({ state: 'secure', secure: true, label: 'secure' });
    expect(model.shields).toMatchObject({ mode: 'aggressive', source: 'site' });
    expect(model.cookiePolicy.effective).toBe('block-third-party');
  });

  it('maps insecure / cert-warning / internal security states', () => {
    expect(buildSiteControlModel(input({ securityState: 'insecure' })).tls.label).toBe('insecure');
    expect(buildSiteControlModel(input({ securityState: 'cert-warning' })).tls).toEqual({
      state: 'cert-warning',
      secure: false,
      label: 'warning',
    });
    const internal = buildSiteControlModel(input({ url: 'kinex://settings' }));
    expect(internal.isInternal).toBe(true);
    expect(internal.tls.label).toBe('internal');
    expect(internal.shields.mode).toBe('disabled');
    expect(internal.origin).toBe('');
  });

  it('uses per-origin cookie overrides and lists active permissions', () => {
    const decisions: SitePermissionDecision[] = [
      { partition: 'persist:default', origin: 'https://www.example.com', permission: 'camera', decision: 'allow', updatedAt: 1 },
      { partition: 'persist:default', origin: 'https://www.example.com', permission: 'microphone', decision: 'deny', updatedAt: 2 },
      { partition: 'persist:default', origin: 'https://other.example', permission: 'geolocation', decision: 'allow', updatedAt: 3 },
    ];
    const model = buildSiteControlModel(
      input({
        permissions: decisions,
        defaultCookiePolicy: 'block-all',
        cookiePolicyByOrigin: { 'https://www.example.com': 'allow' },
      })
    );
    expect(model.cookiePolicy).toEqual({
      effective: 'allow',
      source: 'site',
      origin: 'https://www.example.com',
    });
    expect(model.permissions).toEqual([
      { permission: 'camera', status: 'allowed', origin: 'https://www.example.com' },
      { permission: 'microphone', status: 'denied', origin: 'https://www.example.com' },
    ]);
  });
});

describe('siteControl mutation validation', () => {
  it('accepts valid cookie and permission mutations', () => {
    expect(
      validateSiteControlMutation({
        type: 'set-site-cookie-policy',
        origin: 'https://example.com',
        policy: 'block-all',
      }).ok
    ).toBe(true);
    expect(
      validateSiteControlMutation({
        type: 'set-site-permission',
        origin: 'https://example.com',
        permission: 'camera',
        decision: 'deny',
      })
    ).toMatchObject({ ok: true });
  });

  it('rejects internal/hostile origins and malformed payloads', () => {
    expect(
      validateSiteControlMutation({
        type: 'set-site-cookie-policy',
        origin: 'file:///etc/passwd',
        policy: 'allow',
      }).ok
    ).toBe(false);
    expect(
      validateSiteControlMutation({
        type: 'set-site-cookie-policy',
        origin: 'https://u:p@example.com',
        policy: 'allow',
      }).ok
    ).toBe(false);
    expect(
      validateSiteControlMutation({
        type: 'set-site-cookie-policy',
        origin: 'https://example.com',
        policy: 'sometimes',
      }).ok
    ).toBe(false);
    expect(
      validateSiteControlMutation({
        type: 'set-site-permission',
        origin: 'https://example.com',
        permission: 'openExternal',
        decision: 'allow',
      }).ok
    ).toBe(false);
    expect(
      validateSiteControlMutation({
        type: 'set-site-permission',
        origin: 'https://example.com',
        permission: 'camera',
        decision: 'maybe',
      }).ok
    ).toBe(false);
    expect(validateSiteControlMutation(null).ok).toBe(false);
  });

  it('applies permission decisions immutably', () => {
    const mutation = validateSiteControlMutation({
      type: 'set-site-permission',
      origin: 'https://example.com',
      permission: 'camera',
      decision: 'deny',
    });
    expect(mutation.ok).toBe(true);
    if (!mutation.ok) return;
    const original: SitePermissionDecision[] = [
      { partition: 'p', origin: 'https://example.com', permission: 'camera', decision: 'allow', updatedAt: 1 },
    ];
    const next = applySitePermissionMutation(original, mutation.mutation, 'p', 99);
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ decision: 'deny', updatedAt: 99 });
    expect(original[0]!.decision).toBe('allow');
  });
});
