import { describe, expect, it, vi } from 'vitest';
import {
  WebContextMenuController,
  buildContextMenuTemplate,
  escapeMenuLabel,
  isContextMenuEntry,
  parseMediaFlags,
  sanitizeContextUrl,
  sanitizeImageDataUrl,
  sanitizeMenuText,
  type ContextMenuEntry,
  type ContextMenuItem,
} from './contextMenu';

function actions(entries: ContextMenuEntry[]): string[] {
  return entries.filter((entry): entry is ContextMenuItem => !entry.separator).map((e) => e.action);
}

function find(entries: ContextMenuEntry[], action: string): ContextMenuItem | undefined {
  return entries.find((entry): entry is ContextMenuItem => !entry.separator && entry.action === action);
}

describe('sanitizeContextUrl', () => {
  it('allows only the navigation scheme allowlist', () => {
    expect(sanitizeContextUrl('https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
    expect(sanitizeContextUrl('http://example.com')).toBe('http://example.com/');
    expect(sanitizeContextUrl('kinex://settings')).toBe('kinex://settings');
    expect(sanitizeContextUrl('nook://history')).toBe('nook://history');
    expect(sanitizeContextUrl('about:blank')).toBe('about:blank');
  });

  it('rejects dangerous and non-navigation schemes', () => {
    for (const url of [
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
      'blob:https://example.com/abcd',
      'chrome://settings',
      'chrome-extension://abc/panel.html',
      'devtools://devtools/bundled/inspector.html',
      'view-source:https://example.com',
      'ftp://example.com/file',
    ]) {
      expect(sanitizeContextUrl(url)).toBeNull();
    }
  });

  it('accepts mailto/tel only for copyable URLs', () => {
    expect(sanitizeContextUrl('mailto:a@example.com', 'copyable')).toBe('mailto:a@example.com');
    expect(sanitizeContextUrl('tel:+15551234', 'copyable')).toBe('tel:+15551234');
    expect(sanitizeContextUrl('mailto:a@example.com', 'navigation')).toBeNull();
    expect(sanitizeContextUrl('tel:+15551234', 'navigation')).toBeNull();
  });

  it('rejects credentials, control characters, non-strings and oversized input', () => {
    expect(sanitizeContextUrl('https://user:pass@example.com')).toBeNull();
    expect(sanitizeContextUrl('https://example.com/\u0000evil')).toBeNull();
    expect(sanitizeContextUrl('  javascript:alert(1)  ')).toBeNull();
    expect(sanitizeContextUrl(42)).toBeNull();
    expect(sanitizeContextUrl(null)).toBeNull();
    expect(sanitizeContextUrl('https://example.com/' + 'a'.repeat(8200))).toBeNull();
  });
});

describe('sanitizeImageDataUrl', () => {
  it('accepts small base64 raster images only', () => {
    expect(sanitizeImageDataUrl('data:image/png;base64,iVBORw0KGgo=')).toBe(
      'data:image/png;base64,iVBORw0KGgo='
    );
  });

  it('rejects non-image data and active content', () => {
    expect(sanitizeImageDataUrl('data:text/html;base64,PHNjcmlwdD4=')).toBeNull();
    expect(sanitizeImageDataUrl('data:image/svg+xml;base64,PHN2Zz4=')).toBeNull();
    expect(sanitizeImageDataUrl('data:image/png;base64,AAAA\u0000BB')).toBeNull();
    expect(sanitizeImageDataUrl('data:image/png;base64,' + 'A'.repeat(1_048_600))).toBeNull();
  });
});

describe('sanitizeMenuText / escapeMenuLabel', () => {
  it('strips control characters, collapses whitespace and bounds length', () => {
    expect(sanitizeMenuText('  hello\u0000\n\tworld  ')).toBe('hello world');
    expect(sanitizeMenuText('a'.repeat(500), 200)).toHaveLength(200);
    expect(sanitizeMenuText('   \n\u0000  ')).toBeNull();
    expect(sanitizeMenuText(123)).toBeNull();
  });

  it('escapes native-menu mnemonic characters', () => {
    expect(escapeMenuLabel('Copy & Paste')).toBe('Copy && Paste');
  });
});

describe('parseMediaFlags', () => {
  it('only trusts explicit booleans from a hostile object', () => {
    expect(parseMediaFlags({ isImage: true, isVideo: 'yes', hasAudio: 1 })).toEqual({
      isImage: true,
      isVideo: false,
      isAudio: false,
      hasVideo: false,
      hasAudio: false,
    });
    expect(parseMediaFlags('nope')).toEqual({
      isImage: false,
      isVideo: false,
      isAudio: false,
      hasVideo: false,
      hasAudio: false,
    });
  });
});

describe('buildContextMenuTemplate', () => {
  it('emits safe link actions for an allowlisted link', () => {
    const entries = buildContextMenuTemplate({
      linkUrl: 'https://example.com/page',
      pageUrl: 'https://example.com/',
    });
    const list = actions(entries);
    expect(list).toContain('open-link-new-tab');
    expect(list).toContain('open-link-split');
    expect(list).toContain('save-link');
    expect(list).toContain('copy-link');
    expect(list).toContain('copy-page-url');
    expect(find(entries, 'open-link-new-tab')?.args).toBe('https://example.com/page');
  });

  it('drops link/image affordances entirely for hostile payloads', () => {
    const entries = buildContextMenuTemplate({
      linkUrl: 'javascript:alert(document.cookie)',
      imageUrl: 'data:text/html,<script>bad()</script>',
      pageUrl: 'https://example.com/',
    });
    const list = actions(entries);
    expect(list).not.toContain('open-link-new-tab');
    expect(list).not.toContain('open-link-split');
    expect(list).not.toContain('save-link');
    expect(list).not.toContain('copy-link');
    expect(list).not.toContain('save-image');
    expect(list).not.toContain('copy-image');
    expect(list).not.toContain('open-image-new-tab');
    expect(list).toContain('inspect');
    expect(list).toContain('reload');
  });

  it('does not offer navigation for mailto links but still allows copying', () => {
    const list = actions(buildContextMenuTemplate({ linkUrl: 'mailto:someone@example.com' }));
    expect(list).toContain('copy-link');
    expect(list).not.toContain('open-link-new-tab');
    expect(list).not.toContain('open-link-split');
    expect(list).not.toContain('save-link');
  });

  it('gates image actions on media flags and never navigates to data images', () => {
    const base = { pageUrl: 'https://example.com/' };
    const withFlag = buildContextMenuTemplate({
      ...base,
      imageUrl: 'data:image/png;base64,iVBORw0KGgo=',
      mediaFlags: { isImage: true },
    });
    expect(actions(withFlag)).toContain('save-image');
    expect(actions(withFlag)).toContain('copy-image');
    expect(actions(withFlag)).not.toContain('open-image-new-tab');

    const withoutFlag = buildContextMenuTemplate({
      ...base,
      imageUrl: 'https://example.com/pic.png',
      mediaFlags: { isImage: false },
    });
    expect(actions(withoutFlag)).not.toContain('save-image');

    const withNavImage = buildContextMenuTemplate({
      ...base,
      imageUrl: 'https://example.com/pic.png',
    });
    expect(actions(withNavImage)).toContain('open-image-new-tab');
  });

  it('offers copy and bounded search for sanitized selections', () => {
    const entries = buildContextMenuTemplate({
      selectionText: '  a\u0000b   c  ',
      pageUrl: 'https://example.com/',
    });
    expect(find(entries, 'copy-selection')?.args).toBe('a b c');
    const search = find(entries, 'search-selection');
    expect(search?.args).toBe('a b c');
    expect(search?.label).toContain('a b c');
  });

  it('escapes ampersands in labels derived from page text', () => {
    const entries = buildContextMenuTemplate({
      selectionText: 'Tom & Jerry',
      pageUrl: 'https://example.com/',
    });
    expect(find(entries, 'search-selection')?.label).toContain('Tom && Jerry');
  });

  it('handles a completely empty or malformed payload', () => {
    expect(actions(buildContextMenuTemplate(undefined))).toEqual(['reload', 'inspect']);
    expect(actions(buildContextMenuTemplate(['not', 'an', 'object']))).toEqual(['reload', 'inspect']);
  });
});

describe('WebContextMenuController', () => {
  it('invokes only registered allowlisted actions with their sanitized args', async () => {
    const copy = vi.fn();
    const controller = new WebContextMenuController({ 'copy-link': copy });
    const entry = find(
      buildContextMenuTemplate({ linkUrl: 'https://example.com/x' }),
      'copy-link'
    )!;
    expect(await controller.invoke(entry)).toBe(true);
    expect(copy).toHaveBeenCalledWith('https://example.com/x');
  });

  it('refuses missing handlers, separators and spoofed actions', async () => {
    const controller = new WebContextMenuController({});
    expect(await controller.invoke({ label: 'x', action: 'reload', enabled: true })).toBe(false);
    expect(await controller.invoke({ separator: true } as never)).toBe(false);
    expect(
      await controller.invoke({
        label: 'evil',
        action: 'run-command' as never,
        enabled: true,
      })
    ).toBe(false);
    expect(isContextMenuEntry({ separator: true })).toBe(false);
    expect(isContextMenuEntry({ label: 'x', action: 'inspect', enabled: true })).toBe(true);
  });
});
