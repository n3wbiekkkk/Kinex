import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createDefaultShieldsSettings,
  normalizeShieldsSiteKey,
  resolveEffectiveShieldsMode,
} from '../../shared/domain';
import { validateIntent } from '../ipcValidation';
import { buildCosmeticCss } from './cosmetics';
import { KinexShieldsEngine } from './engine';
import { downloadAndVerifyFilterList, MAX_FILTER_LIST_BYTES, validateAndNormalizeFilterText } from './lists';
import { ALLOWLISTED_SCRIPTLET_NAMES, buildVettedAdblockResources } from './scriptlets';

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe('Kinex Shields engine, filter lists, precedence, and security', () => {
  it('enforces per-site > registrable domain > global mode precedence and skips internal pages', () => {
    const settings = {
      globalMode: 'standard' as const,
      siteOverrides: {
        'google.com': 'aggressive' as const,
        'mail.google.com': 'disabled' as const,
        'youtube.com': 'disabled' as const,
      },
    };

    expect(resolveEffectiveShieldsMode(settings, 'kinex://newtab')).toEqual({
      mode: 'disabled',
      source: 'internal',
      domainKey: '',
    });
    expect(resolveEffectiveShieldsMode(settings, 'https://mail.google.com/mail/u/0/', 'google.com').mode).toBe(
      'disabled'
    );
    expect(resolveEffectiveShieldsMode(settings, 'https://docs.google.com/document/d/1', 'google.com').mode).toBe(
      'aggressive'
    );
    expect(resolveEffectiveShieldsMode(settings, 'https://www.youtube.com/watch?v=1', 'youtube.com').mode).toBe(
      'disabled'
    );
    expect(resolveEffectiveShieldsMode(settings, 'https://github.com/n3wbiekkkk/Kinex', 'github.com').mode).toBe(
      'standard'
    );
    expect(normalizeShieldsSiteKey('https://www.Reddit.com/r/mac')).toBe('reddit.com');
  });

  it('blocks third-party ads and trackers, honors 1p/exceptions, and classifies categories with adblock-rs', () => {
    const tmpDir = makeTempDir('kinex-shields-unit-');
    try {
      const engine = new KinexShieldsEngine(tmpDir, createDefaultShieldsSettings());
      const init = engine.initializeSync();
      expect(engine.isReady()).toBe(true);
      expect(init.updatedLists.some((l) => l.ruleCount > 10000)).toBe(true);

      const adRes = engine.evaluateNetworkRequest({
        url: 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js',
        sourceUrl: 'https://www.nytimes.com/',
        resourceType: 'script',
      });
      expect(adRes.blocked).toBe(true);
      expect(adRes.category).toBe('ad');

      const trackerRes = engine.evaluateNetworkRequest({
        url: 'https://www.google-analytics.com/analytics.js',
        sourceUrl: 'https://example.org/post',
        resourceType: 'script',
      });
      expect(trackerRes.blocked).toBe(true);
      expect(trackerRes.category).toBe('tracker');

      const firstParty = engine.evaluateNetworkRequest({
        url: 'https://github.githubassets.com/assets/app.js',
        sourceUrl: 'https://github.com/n3wbiekkkk/Kinex',
        resourceType: 'script',
      });
      expect(firstParty.blocked).toBe(false);

      // Per-site disabled override stops blocking immediately on that site
      engine.updateSettings({
        ...engine.getSettings(),
        siteOverrides: { 'example.org': 'disabled' },
      });
      const disabledSiteRes = engine.evaluateNetworkRequest({
        url: 'https://www.google-analytics.com/analytics.js',
        sourceUrl: 'https://example.org/post',
        resourceType: 'script',
      });
      expect(disabledSiteRes.blocked).toBe(false);
      expect(disabledSiteRes.mode).toBe('disabled');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('applies aggressive lists only in aggressive mode and returns vetted redirects/scriptlets', () => {
    const tmpDir = makeTempDir('kinex-shields-aggr-');
    try {
      const resources = buildVettedAdblockResources();
      expect(resources.length).toBeGreaterThan(10);
      expect(ALLOWLISTED_SCRIPTLET_NAMES.has('nobab.js')).toBe(true);
      expect(ALLOWLISTED_SCRIPTLET_NAMES.has('evil-arbitrary-script')).toBe(false);

      const settings = createDefaultShieldsSettings();
      const engine = new KinexShieldsEngine(tmpDir, settings);
      engine.initializeSync();

      // Switch to aggressive globally and inspect cookie-banner cosmetic rule from Fanboy Cookie list
      engine.updateSettings({ ...engine.getSettings(), globalMode: 'aggressive' });
      const stdRes = engine.evaluateNetworkRequest({
        url: 'https://securepubads.g.doubleclick.net/tag/js/gpt.js',
        sourceUrl: 'https://example.com/',
        resourceType: 'script',
      });
      expect(stdRes.blocked).toBe(true);
      expect(stdRes.mode).toBe('aggressive');

      // Custom cosmetic rule merges cleanly
      engine.updateSettings({
        ...engine.getSettings(),
        customCosmeticRules: { 'example.com': ['.custom-nag-box'] },
      });
      const cos = engine.evaluateCosmeticsForUrl('https://example.com/news');
      expect(cos.hideSelectors).toContain('.custom-nag-box');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('rejects insecure, corrupted, HTML, oversized filter updates and preserves last-known-good state', async () => {
    const tmpDir = makeTempDir('kinex-shields-upd-');
    try {
      expect(validateAndNormalizeFilterText('<!DOCTYPE html><html>error</html>').ok).toBe(false);
      expect(validateAndNormalizeFilterText('||ok.com^\0evil').ok).toBe(false);
      expect(validateAndNormalizeFilterText('! comments only').ok).toBe(false);
      expect(validateAndNormalizeFilterText('||ads.example.com^').ok).toBe(true);

      const httpDenied = await downloadAndVerifyFilterList('http://untrusted.example/list.txt');
      expect(httpDenied.ok).toBe(false);

      const oversized = await downloadAndVerifyFilterList('https://filters.example.test/huge.txt', (async () =>
        new Response('||a.com^\n', {
          status: 200,
          headers: { 'content-length': String(MAX_FILTER_LIST_BYTES + 1024) },
        })) as typeof fetch);
      expect(oversized.ok).toBe(false);

      const settings = createDefaultShieldsSettings();
      // Keep only one small list enabled for fast deterministic update test
      settings.filterLists = settings.filterLists.map((l, idx) => ({ ...l, enabled: idx === 5 }));
      const engine = new KinexShieldsEngine(tmpDir, settings);
      engine.initializeSync();
      const baselineRuleCount = engine.getSettings().filterLists[5].ruleCount;
      expect(baselineRuleCount).toBeGreaterThan(100);

      // Failed remote update (HTTP 503) leaves existing bundled rules active without corruption
      const failUpdate = await engine.updateAllEnabledLists((async () =>
        new Response('Service Unavailable', { status: 503 })) as typeof fetch);
      expect(failUpdate.updatedCount).toBe(0);
      expect(failUpdate.lists[5].lastError).toContain('HTTP 503');
      expect(
        engine.evaluateNetworkRequest({
          url: 'https://doubleclick.net/pixel.js',
          sourceUrl: 'https://example.com',
          resourceType: 'script',
        }).blocked
      ).toBe(true);

      // Concurrent update coalesces cleanly and succeeds atomically
      const validPayload = '! Title: Updated List\n||newtracker.test^$third-party\n||ads.example.test^\n';
      const [u1, u2] = await Promise.all([
        engine.updateAllEnabledLists((async () => new Response(validPayload, { status: 200 })) as typeof fetch),
        engine.updateAllEnabledLists((async () => new Response(validPayload, { status: 200 })) as typeof fetch),
      ]);
      expect(u1.updatedCount).toBe(1);
      expect(u2.updatedCount).toBe(1);
      expect(
        engine.evaluateNetworkRequest({
          url: 'https://newtracker.test/beacon.js',
          sourceUrl: 'https://example.org',
          resourceType: 'script',
        }).blocked
      ).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('rejects malformed CSS selectors in cosmetic sanitizer and IPC validator', () => {
    expect(buildCosmeticCss(['.ad-box', 'body { background: red }', '#banner;x'])).toBe(
      '.ad-box { display: none !important; visibility: hidden !important; }'
    );
    expect(
      validateIntent({ type: 'add-shields-cosmetic-rule', domain: 'example.com', selector: '.bad { color: red }' }).ok
    ).toBe(false);
    expect(
      validateIntent({ type: 'add-shields-cosmetic-rule', domain: 'example.com', selector: '.promo-slot' }).ok
    ).toBe(true);
    expect(validateIntent({ type: 'set-shields-global-mode', mode: 'aggressive' }).ok).toBe(true);
    expect(validateIntent({ type: 'set-shields-site-mode', domain: 'youtube.com', mode: 'inherit' }).ok).toBe(true);
  });
});
