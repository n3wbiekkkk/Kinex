import { describe, expect, it } from 'vitest';
import {
  buildLinkPeekViewOptions,
  clampPreviewRect,
  isLinkPeekAction,
  isLinkPeekUrl,
  LINK_PEEK_MAX_HEIGHT,
  LINK_PEEK_MAX_WIDTH,
  LINK_PEEK_MIN_HEIGHT,
  LINK_PEEK_MIN_WIDTH,
  type PreviewRect,
} from './linkPeek';

const rect: PreviewRect = { x: 100, y: 80, width: 600, height: 400 };

describe('linkPeek URL policy', () => {
  it('allows public http(s) URLs only', () => {
    expect(isLinkPeekUrl('https://example.com/article')).toBe(true);
    expect(isLinkPeekUrl('http://example.com')).toBe(true);
    for (const bad of [
      'file:///etc/passwd',
      'kinex://welcome',
      'nook://settings',
      'about:blank',
      'devtools://devtools',
      'javascript:alert(1)',
      'data:text/html,<h1>x</h1>',
      'blob:https://example.com/uuid',
      'vbscript:msgbox(1)',
      'https://user:pass@example.com',
      'https://example.com/\u0000',
      '',
    ]) {
      expect(isLinkPeekUrl(bad)).toBe(false);
    }
  });
});

describe('linkPeek rect bounds', () => {
  it('clamps width/height and keeps the rect inside the display', () => {
    const bounds: PreviewRect = { x: 0, y: 0, width: 1000, height: 700 };
    expect(clampPreviewRect({ x: 900, y: 650, width: 5000, height: 5000 }, bounds)).toEqual({
      x: 40,
      y: 0,
      width: Math.min(LINK_PEEK_MAX_WIDTH, 1000),
      height: Math.min(LINK_PEEK_MAX_HEIGHT, 700),
    });
    expect(clampPreviewRect({ x: -20, y: -30, width: 10, height: 10 }, bounds)).toEqual({
      x: 0,
      y: 0,
      width: LINK_PEEK_MIN_WIDTH,
      height: LINK_PEEK_MIN_HEIGHT,
    });
    expect(clampPreviewRect({ x: Number.NaN, y: 0, width: 400, height: 300 }, bounds)).toBeNull();
  });
});

describe('linkPeek view options', () => {
  it('forces sandbox/contextIsolation and file access off', () => {
    const result = buildLinkPeekViewOptions('https://example.com/a', { rect });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.options).toEqual({
      url: 'https://example.com/a',
      rect: { x: 100, y: 80, width: 600, height: 400 },
      sandbox: true,
      contextIsolation: true,
      webSecurity: true,
      nodeIntegration: false,
      allowFileAccess: false,
      partition: '',
    });
  });

  it('rejects privileged URLs and persistent partitions', () => {
    expect(buildLinkPeekViewOptions('file:///etc/passwd', { rect }).ok).toBe(false);
    expect(buildLinkPeekViewOptions('kinex://welcome', { rect }).ok).toBe(false);
    expect(
      buildLinkPeekViewOptions('https://example.com', {
        rect,
        partition: 'persist:default',
      }).ok
    ).toBe(false);
    expect(
      buildLinkPeekViewOptions('https://example.com', { rect, partition: 'peek-1' }).ok
    ).toBe(true);
  });

  it('exposes a bounded action set', () => {
    expect(['expand', 'split', 'close', 'backdrop'].every(isLinkPeekAction)).toBe(true);
    expect(isLinkPeekAction('navigate')).toBe(false);
    expect(isLinkPeekAction('file-open')).toBe(false);
  });
});
