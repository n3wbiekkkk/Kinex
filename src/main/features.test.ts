import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDefaultShieldsSettings } from '../shared/domain';
import { KinexShieldsEngine } from './shields/engine';
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
import { renderKinexInternalHtml } from './internalPages';
import { renderReaderHtml, sanitizeExtractedArticle } from './readerMode';
import { getUniqueDownloadSavePath } from './downloadManager';
import { validateIntent } from './ipcValidation';
import { computeViewRects } from './viewLayoutManager';
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
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kinex-features-shields-'));
    try {
      const engine = new KinexShieldsEngine(tmpDir, createDefaultShieldsSettings());
      engine.initializeSync();
      expect(
        engine.evaluateNetworkRequest({
          url: 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js',
          sourceUrl: 'https://example.org',
          resourceType: 'script',
        }).blocked
      ).toBe(true);
      expect(
        engine.evaluateNetworkRequest({
          url: 'https://www.google-analytics.com/analytics.js',
          sourceUrl: 'https://example.org',
          resourceType: 'script',
        }).blocked
      ).toBe(true);
      expect(
        engine.evaluateNetworkRequest({
          url: 'https://github.com/n3wbiekkkk/Kinex',
          sourceUrl: 'https://github.com/n3wbiekkkk',
          resourceType: 'script',
        }).blocked
      ).toBe(false);
      expect(
        engine.evaluateNetworkRequest({
          url: 'http://localhost:3000/doubleclick.net',
          sourceUrl: 'http://localhost:3000/',
          resourceType: 'script',
        }).blocked
      ).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
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

  it('renders Light/Dark New Tab presets safely without unescaped HTML', () => {
    const lightHtml = renderKinexInternalHtml('kinex://newtab', {
      isDark: false,
      spaceName: 'Work <Team>',
      searchEngineName: 'DuckDuckGo',
      searchEngineTemplate: 'https://duckduckgo.com/?q=%s',
      config: {
        preset: 'personal',
        background: 'sage',
        showClock: true,
        showFavorites: true,
        showFrequent: true,
      },
      favorites: [{ title: 'GitHub', url: 'https://github.com', host: 'github.com' }],
      frequent: [{ title: 'Bad <xss>', url: 'javascript:alert(1)', host: 'evil' }],
    });
    expect(lightHtml).toContain('color-scheme" content="light"');
    expect(lightHtml).toContain('Work &lt;Team&gt;');
    expect(lightHtml).toContain('Search DuckDuckGo');
    expect(lightHtml).not.toContain('javascript:alert(1)');

    const privHtml = renderKinexInternalHtml('kinex://private');
    expect(privHtml).toContain('Private Browsing');
    expect(privHtml).toContain('Isolated');
  });

  it('sanitizes Reader Mode content, locks CSP, and validates v0.7.0 intents', () => {
    const shortRes = sanitizeExtractedArticle(
      { title: 'Tiny', blocks: [{ tag: 'p', text: 'Too short.' }] },
      'https://example.org/tiny'
    );
    expect(shortRes.ok).toBe(false);

    const validRes = sanitizeExtractedArticle(
      {
        title: 'Engineering <script>alert(1)</script>',
        byline: 'Kinex Author',
        siteName: 'example.org',
        blocks: [
          { tag: 'h2', text: 'Architecture Fundamentals' },
          {
            tag: 'p',
            text: 'Sandboxed views isolate untrusted web content while preserving crisp typography and deterministic resource cleanup across tabs and spaces.',
          },
          {
            tag: 'p',
            text: 'Reader Mode extracts only safe text paragraphs and locks rendering with script-disabled Content Security Policy headers.',
          },
        ],
      },
      'https://example.org/article'
    );
    expect(validRes.ok).toBe(true);
    if (validRes.ok) {
      const html = renderReaderHtml(validRes.doc, { fontSize: 18, theme: 'sepia' });
      expect(html).toContain("default-src 'none'; style-src 'unsafe-inline';");
      expect(html).not.toContain('<script>alert(1)</script>');
      expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    }

    // Download path collision utility
    const uniquePath = getUniqueDownloadSavePath('/tmp', '../../evil/report.pdf');
    expect(uniquePath.startsWith('/tmp/')).toBe(true);
    expect(uniquePath.endsWith('report.pdf') || uniquePath.includes('report (')).toBe(true);

    // v0.7.0 IPC intent validation
    expect(validateIntent({ type: 'move-tab-to-space', tabId: 'tab-1', spaceId: 'space-work' }).ok).toBe(true);
    expect(validateIntent({ type: 'reopen-closed-tab' }).ok).toBe(true);
    expect(validateIntent({ type: 'pause-download', downloadId: 'dl-1' }).ok).toBe(true);
    expect(validateIntent({ type: 'set-reader-options', options: { fontSize: 20, theme: 'sepia' } }).ok).toBe(true);
    expect(validateIntent({ type: 'set-reader-options', options: { fontSize: 99 } }).ok).toBe(false);
    expect(validateIntent({ type: 'resolve-duplicate-open', decision: 'switch-existing' }).ok).toBe(true);
  });

  it('expands HTML5 fullscreen panes edge-to-edge without sidebar or split insets', () => {
    const single = computeViewRects({
      windowWidth: 1440,
      windowHeight: 900,
      sidebarOpen: true,
      sidebarWidth: 260,
      paneCount: 1,
      splitRatio: 0.5,
      toolbarVisible: true,
      htmlFullscreenPaneIndex: 0,
    });
    expect(single.panes).toEqual([{ x: 0, y: 0, width: 1440, height: 900 }]);

    const split = computeViewRects({
      windowWidth: 1440,
      windowHeight: 900,
      sidebarOpen: true,
      sidebarWidth: 260,
      paneCount: 2,
      splitRatio: 0.5,
      toolbarVisible: true,
      htmlFullscreenPaneIndex: 1,
    });
    expect(split.panes[0]).toEqual({ x: -10000, y: -10000, width: 100, height: 100 });
    expect(split.panes[1]).toEqual({ x: 0, y: 0, width: 1440, height: 900 });
  });
});
