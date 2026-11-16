import { describe, expect, it } from 'vitest';
import {
  TrustedIpcRegistry,
  validateIntent,
  validateLittleKinexActionInput,
  validateTabContextMenuInput,
} from './ipcValidation';

describe('IPC runtime validation and sender verification', () => {
  it('verifies trusted sender IDs, roles, and local frame URLs', () => {
    const registry = new TrustedIpcRegistry();
    registry.addAllowedBaseUrl('file:///app/dist/index.html');
    registry.register(10, 'shell');
    registry.register(11, 'overlay');
    registry.register(12, 'private-header');

    expect(registry.isTrusted(10, 'file:///app/dist/index.html?view=shell', ['shell', 'overlay'])).toBe(true);
    expect(registry.isTrusted(11, 'file:///app/dist/index.html?view=overlay', ['shell', 'overlay'])).toBe(true);
    expect(registry.isTrusted(12, 'file:///app/dist/index.html?view=private', ['private-header'])).toBe(true);

    // Reject wrong role
    expect(registry.isTrusted(12, 'file:///app/dist/index.html?view=private', ['shell', 'overlay'])).toBe(false);
    // Reject unregistered WebContents (e.g., remote tab)
    expect(registry.isTrusted(999, 'https://evil.example', ['shell', 'overlay'])).toBe(false);
    // Reject spoofed remote frame URL even if sender ID matches
    expect(registry.isTrusted(10, 'https://evil.example/exploit.html', ['shell', 'overlay'])).toBe(false);
  });

  it('validates legitimate intents and clamps numeric bounds', () => {
    expect(validateIntent({ type: 'select-space', spaceId: 'space-work' })).toEqual({
      ok: true,
      value: { type: 'select-space', spaceId: 'space-work' },
    });

    const ratioRes = validateIntent({ type: 'set-split-ratio', ratio: 0.99 });
    expect(ratioRes).toEqual({
      ok: true,
      value: { type: 'set-split-ratio', ratio: 0.8 },
    });

    const sidebarRes = validateIntent({ type: 'set-sidebar-width', width: 999 });
    expect(sidebarRes).toEqual({
      ok: true,
      value: { type: 'set-sidebar-width', width: 380 },
    });

    const openRes = validateIntent({
      type: 'open-url',
      url: 'https://example.org',
      target: 'new-tab',
    });
    expect(openRes.ok).toBe(true);

    const feedRes = validateIntent({
      type: 'set-update-feed-url',
      url: 'https://github.com/n3wbiekkkk/Kinex/releases/latest/download',
    });
    expect(feedRes.ok).toBe(true);
  });

  it('rejects malformed payloads and unsafe URL/protocol schemes', () => {
    expect(validateIntent(null).ok).toBe(false);
    expect(validateIntent('open-url').ok).toBe(false);
    expect(validateIntent({ type: 'unknown-action' }).ok).toBe(false);
    expect(validateIntent({ type: 'select-tab', tabId: '' }).ok).toBe(false);
    expect(validateIntent({ type: 'set-split-ratio', ratio: Number.NaN }).ok).toBe(false);

    // Unsafe schemes blocked at IPC boundary
    expect(validateIntent({ type: 'open-url', url: 'javascript:alert(1)', target: 'current' }).ok).toBe(false);
    expect(validateIntent({ type: 'open-url', url: 'file:///etc/passwd', target: 'new-tab' }).ok).toBe(false);
    expect(validateIntent({ type: 'open-url', url: 'data:text/html,<script>', target: 'split' }).ok).toBe(false);
    expect(validateIntent({ type: 'open-incognito', url: 'javascript:alert(1)' }).ok).toBe(false);
    expect(
      validateIntent({ type: 'promote-little-nook', url: 'javascript:alert(1)', title: 'Bad' }).ok
    ).toBe(false);

    // Unsafe remote HTTP update feed rejected
    expect(
      validateIntent({ type: 'set-update-feed-url', url: 'http://attacker.example/updates' }).ok
    ).toBe(false);

    // Malformed clear-browsing-data scope rejected
    expect(validateIntent({ type: 'clear-browsing-data', scopes: ['everything'] }).ok).toBe(false);

    // Reject AI search preset & validate New Tab customization config
    expect(validateIntent({ type: 'set-search-engine', engine: 'perplexity' }).ok).toBe(false);
    expect(validateIntent({ type: 'set-search-engine', engine: 'startpage' })).toEqual({
      ok: true,
      value: { type: 'set-search-engine', engine: 'startpage' },
    });
    expect(
      validateIntent({
        type: 'set-new-tab-config',
        config: { preset: 'focus', background: 'mist', showClock: false },
      })
    ).toEqual({
      ok: true,
      value: {
        type: 'set-new-tab-config',
        config: { preset: 'focus', background: 'mist', showClock: false },
      },
    });
    expect(
      validateIntent({
        type: 'set-new-tab-config',
        config: { preset: 'ai-dashboard' },
      }).ok
    ).toBe(false);

    // Context menu & little-kinex checks
    expect(validateTabContextMenuInput('').ok).toBe(false);
    expect(validateTabContextMenuInput('tab-1').ok).toBe(true);
    expect(validateLittleKinexActionInput('navigate', 'javascript:alert(1)').ok).toBe(false);
    expect(validateLittleKinexActionInput('invalid-act').ok).toBe(false);
    expect(validateLittleKinexActionInput('reload').ok).toBe(true);
  });
});
