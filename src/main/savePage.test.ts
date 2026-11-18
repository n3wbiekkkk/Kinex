import { describe, expect, it, vi } from 'vitest';
import {
  SavePageController,
  buildMhtmlSaveDialogOptions,
  checkMhtmlEligibility,
  sanitizeMhtmlFilename,
  validateMhtmlPath,
  type SavePageCapabilities,
} from './savePage';

describe('checkMhtmlEligibility', () => {
  it('allows real http(s) pages', () => {
    expect(checkMhtmlEligibility('https://example.com/a')).toEqual({ allowed: true });
    expect(checkMhtmlEligibility('http://example.com')).toEqual({ allowed: true });
  });

  it('rejects internal, privileged and non-web schemes', () => {
    for (const url of [
      'kinex://settings',
      'nook://history',
      'chrome://settings',
      'chrome-extension://abc/panel.html',
      'devtools://devtools/bundled/inspector.html',
      'file:///etc/passwd',
      'view-source:https://example.com',
      'about:blank',
      'javascript:alert(1)',
      'data:text/html,hi',
      'blob:https://example.com/uuid',
    ]) {
      expect(checkMhtmlEligibility(url)).toEqual({ allowed: false, reason: 'internal' });
    }
    expect(checkMhtmlEligibility('mailto:a@example.com')).toEqual({
      allowed: false,
      reason: 'non-http',
    });
    expect(checkMhtmlEligibility('ftp://example.com/f')).toEqual({
      allowed: false,
      reason: 'non-http',
    });
  });

  it('rejects malformed hostile values', () => {
    expect(checkMhtmlEligibility(null)).toEqual({ allowed: false, reason: 'invalid' });
    expect(checkMhtmlEligibility('')).toEqual({ allowed: false, reason: 'invalid' });
    expect(checkMhtmlEligibility('https://example.com/\u0000x')).toEqual({
      allowed: false,
      reason: 'invalid',
    });
    expect(checkMhtmlEligibility('https://example.com/' + 'a'.repeat(8200))).toEqual({
      allowed: false,
      reason: 'invalid',
    });
  });
});

describe('sanitizeMhtmlFilename', () => {
  it('strips path separators and dangerous characters, bounding length', () => {
    expect(sanitizeMhtmlFilename('  A/B\\C:*?"<>|\u0000Page  ')).toBe('A B C Page.mhtml');
    expect(sanitizeMhtmlFilename('a'.repeat(300)).length).toBeLessThanOrEqual(126);
  });

  it('keeps an existing mhtml/mht extension and supplies a fallback', () => {
    expect(sanitizeMhtmlFilename('Report.MHT')).toBe('Report.MHT');
    expect(sanitizeMhtmlFilename('Report.html')).toBe('Report.html.mhtml');
    expect(sanitizeMhtmlFilename('   ')).toBe('kinex-page.mhtml');
  });
});

describe('validateMhtmlPath', () => {
  it('accepts absolute mhtml and mht paths', () => {
    expect(validateMhtmlPath('/Users/me/Page.mhtml')).toEqual({
      ok: true,
      path: '/Users/me/Page.mhtml',
    });
    expect(validateMhtmlPath('/Users/me/Page.MHT').ok).toBe(true);
  });

  it('rejects unsafe or wrong-shaped paths', () => {
    expect(validateMhtmlPath(null)).toEqual({ ok: false, reason: 'not-a-string' });
    expect(validateMhtmlPath('   ')).toEqual({ ok: false, reason: 'empty' });
    expect(validateMhtmlPath('/tmp/' + 'a'.repeat(5000) + '.mhtml')).toEqual({
      ok: false,
      reason: 'too-long',
    });
    expect(validateMhtmlPath('/tmp/a\u0000b.mhtml')).toEqual({
      ok: false,
      reason: 'control-characters',
    });
    expect(validateMhtmlPath('file:///tmp/a.mhtml')).toEqual({
      ok: false,
      reason: 'file-url',
    });
    expect(validateMhtmlPath('relative.mhtml')).toEqual({ ok: false, reason: 'not-absolute' });
    expect(validateMhtmlPath('/tmp/a.pdf')).toEqual({ ok: false, reason: 'wrong-extension' });
  });

  it('keeps a resolved path inside an allowed root', () => {
    expect(validateMhtmlPath('/tmp/kinex/a.mhtml', '/tmp/kinex').ok).toBe(true);
    expect(validateMhtmlPath('/tmp/kinex/../secret.mhtml', '/tmp/kinex')).toEqual({
      ok: false,
      reason: 'outside-root',
    });
  });
});

describe('buildMhtmlSaveDialogOptions', () => {
  it('produces a fixed safe options object', () => {
    expect(buildMhtmlSaveDialogOptions({ title: 'Save it', filename: 'My/Page' })).toEqual({
      title: 'Save it',
      defaultPath: 'My Page.mhtml',
      filters: [{ name: 'MHTML Webpage', extensions: ['mhtml', 'mht'] }],
      properties: ['createDirectory', 'showOverwriteConfirmation'],
      buttonLabel: 'Save',
    });
  });

  it('ignores hostile titles and non-absolute directories', () => {
    const options = buildMhtmlSaveDialogOptions({ title: { evil: true }, directory: 'relative' });
    expect(options.title).toBe('Save Page as MHTML');
    expect(options.defaultPath).toBe('kinex-page.mhtml');
    options.filters.forEach((filter) => expect(filter.extensions).toEqual(['mhtml', 'mht']));
  });

  it('uses an absolute download directory when provided', () => {
    expect(buildMhtmlSaveDialogOptions({ directory: '/Users/me/Downloads' }).defaultPath).toBe(
      '/Users/me/Downloads/kinex-page.mhtml'
    );
  });
});

function fixture(pageUrl: unknown): {
  caps: SavePageCapabilities;
  saved: string[];
} {
  const saved: string[] = [];
  const caps: SavePageCapabilities = {
    getPageUrl: () => pageUrl,
    getPageTitle: () => 'Example Page',
    showSaveDialog: vi.fn(async () => ({ canceled: false, filePath: '/tmp/Example Page.mhtml' })),
    saveMhtml: vi.fn(async (filePath) => {
      saved.push(filePath);
    }),
    getDownloadsDir: () => '/tmp',
  };
  return { caps, saved };
}

describe('SavePageController', () => {
  it('saves an eligible web page after dialog and path validation', async () => {
    const { caps, saved } = fixture('https://example.com/');
    const result = await new SavePageController(caps).saveAsMhtml();
    expect(result).toEqual({ ok: true, filePath: '/tmp/Example Page.mhtml' });
    expect(saved).toEqual(['/tmp/Example Page.mhtml']);
  });

  it('refuses internal pages before opening any dialog', async () => {
    const { caps } = fixture('devtools://devtools/x');
    const result = await new SavePageController(caps).saveAsMhtml();
    expect(result).toEqual({ ok: false, reason: 'internal' });
    expect(caps.showSaveDialog).not.toHaveBeenCalled();
  });

  it('handles cancelation and invalid dialog paths', async () => {
    const canceled = fixture('https://example.com/');
    canceled.caps.showSaveDialog = vi.fn(async () => ({ canceled: true }));
    expect(await new SavePageController(canceled.caps).saveAsMhtml()).toEqual({
      ok: false,
      reason: 'canceled',
    });

    const invalid = fixture('https://example.com/');
    invalid.caps.showSaveDialog = vi.fn(async () => ({
      canceled: false,
      filePath: '/tmp/evil.exe',
    }));
    expect(await new SavePageController(invalid.caps).saveAsMhtml()).toEqual({
      ok: false,
      reason: 'wrong-extension',
    });
    expect(invalid.caps.saveMhtml).not.toHaveBeenCalled();
  });

  it('reports save failures without throwing', async () => {
    const { caps } = fixture('https://example.com/');
    caps.saveMhtml = vi.fn(async () => {
      throw new Error('disk full');
    });
    expect(await new SavePageController(caps).saveAsMhtml()).toEqual({
      ok: false,
      reason: 'save-failed',
    });
  });
});
