import { describe, expect, it } from 'vitest';
import { isBlockedAdOrTrackerUrl } from './adblock';
import { compileBoostCss } from './boosts';
import {
  classifySecurityState,
  isDangerousPermission,
  isSafeNavigationUrl,
  matchAirTrafficSpace,
  stripTrackingParams,
  upgradeUrlToHttpsIfNeeded,
} from './security';
import { classifyUpdateFeedSource } from './updater';
import type { BoostRule } from '../shared/types';

describe('NOOK adblock, boosts, security, and updater', () => {
  it('classifies remote HTTPS and local update feed directories', () => {
    expect(classifyUpdateFeedSource('https://releases.nook.dev/mac/')).toEqual({
      kind: 'remote',
      url: 'https://releases.nook.dev/mac',
    });
    expect(classifyUpdateFeedSource('/tmp/nook-releases')).toEqual({
      kind: 'local-dir',
      dir: '/tmp/nook-releases',
    });
    expect(classifyUpdateFeedSource('   ')).toEqual({ kind: 'none' });
  });

  it('blocks known tracker hosts while allowing normal content and localhost', () => {
    expect(isBlockedAdOrTrackerUrl('https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js')).toBe(true);
    expect(isBlockedAdOrTrackerUrl('https://www.google-analytics.com/analytics.js')).toBe(true);
    expect(isBlockedAdOrTrackerUrl('https://github.com/morluto/rea')).toBe(false);
    expect(isBlockedAdOrTrackerUrl('http://localhost:3000/doubleclick.net')).toBe(false);
  });

  it('compiles matching boost rules into CSS including zapped selectors', () => {
    const boosts: BoostRule[] = [
      {
        id: 'b1',
        name: 'GitHub Clean',
        domainPattern: 'github.com',
        enabled: true,
        css: 'body { letter-spacing: 0.01em; }',
        js: '',
        zappedSelectors: ['.ad-banner', '#promo'],
        filterInvert: true,
        fontFamily: 'Inter',
      },
      {
        id: 'b2',
        name: 'Disabled',
        domainPattern: 'github.com',
        enabled: false,
        css: 'body { display: none; }',
        js: '',
        zappedSelectors: [],
      },
    ];

    const compiled = compileBoostCss(boosts, 'https://github.com/morluto/rea');
    expect(compiled).toContain('.ad-banner, #promo { display: none !important; }');
    expect(compiled).toContain('font-family: Inter');
    expect(compiled).toContain('invert(0.92)');
    expect(compiled).not.toContain('display: none;');
  });

  it('enforces safe navigation protocols, HTTPS-only upgrades, tracking stripping, and Air Traffic', () => {
    expect(isSafeNavigationUrl('https://github.com')).toBe(true);
    expect(isSafeNavigationUrl('nook://welcome')).toBe(true);
    expect(isSafeNavigationUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeNavigationUrl('file:///etc/passwd')).toBe(false);

    expect(upgradeUrlToHttpsIfNeeded('http://example.com/a', true, new Set())).toBe(
      'https://example.com/a'
    );
    expect(upgradeUrlToHttpsIfNeeded('http://localhost:3000/a', true, new Set())).toBe(
      'http://localhost:3000/a'
    );
    expect(upgradeUrlToHttpsIfNeeded('http://legacy.local', true, new Set())).toBe(
      'http://legacy.local'
    );

    expect(
      stripTrackingParams('https://example.com/post?id=42&utm_source=x&fbclid=123')
    ).toBe('https://example.com/post?id=42');

    expect(classifySecurityState('https://github.com', false)).toBe('secure');
    expect(classifySecurityState('http://example.com', false)).toBe('insecure');
    expect(classifySecurityState('https://badssl.com', true)).toBe('cert-warning');
    expect(classifySecurityState('nook://welcome', false)).toBe('internal');

    expect(isDangerousPermission('midiSysex')).toBe(true);
    expect(isDangerousPermission('notifications')).toBe(false);

    expect(
      matchAirTrafficSpace('https://app.slack.com/client', [
        { id: 'r1', pattern: 'slack.com', spaceId: 'space-work', enabled: true },
      ])
    ).toBe('space-work');
  });
});
