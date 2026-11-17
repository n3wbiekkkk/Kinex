import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { Session, WebContents } from 'electron';

const { prompt, openExternal } = vi.hoisted(() => ({ prompt: vi.fn(), openExternal: vi.fn() }));
vi.mock('electron', () => ({ dialog: { showMessageBox: prompt }, shell: { openExternal } }));
import { NavigationManager } from './navigationManager';
import { isAllowedExternalProtocol, isSafeUpdateFeedUrl, isSameOriginBlobUrl } from './security';

function contents(session: Session = {} as Session) {
  let currentUrl = 'https://example.com/';
  let openHandler: any;
  const wc = Object.assign(new EventEmitter(), {
    id: Math.random(), session,
    isDestroyed: () => false,
    getURL: () => currentUrl,
    getTitle: () => 'Example',
    isLoading: () => false,
    loadURL: vi.fn(async (url: string) => { currentUrl = url; }),
    setWindowOpenHandler: (handler: any) => { openHandler = handler; },
  }) as unknown as WebContents;
  return { wc, setUrl: (url: string) => { currentUrl = url; }, open: (url: string) => openHandler({ url, features: '', disposition: 'foreground-tab' }) };
}

function manager() {
  return new NavigationManager({
    getDialogParentWindow: () => ({ isDestroyed: () => false }) as any,
    isHttpsOnly: () => true,
  });
}

async function certificate(wc: WebContents, url: string, fingerprint: string) {
  const callback = vi.fn();
  wc.emit('certificate-error', { preventDefault() {} }, url, 'ERR_CERT_AUTHORITY_INVALID', { fingerprint }, callback);
  await Promise.resolve();
  await Promise.resolve();
  return callback;
}

describe('navigation trust boundaries', () => {
  it('requires HTTPS for LAN update feeds and rejects credentials or protocol control characters', () => {
    expect(isSafeUpdateFeedUrl('http://updater.local')).toBe(false);
    expect(isSafeUpdateFeedUrl('http://127.0.0.1:8123')).toBe(true);
    expect(isSafeUpdateFeedUrl('https://username:password@example.com')).toBe(false);
    expect(isAllowedExternalProtocol('mailto:a@example.com\n')).toBe(false);
  });

  it('allows same-origin blob previews only in sandboxed popups in the owning session', () => {
    const nav = manager();
    const page = contents();
    nav.attachWebContentsGuards(page.wc, { isPrivate: false });
    const result = page.open('blob:https://example.com/id');
    expect(result.action).toBe('allow');
    expect(result.overrideBrowserWindowOptions.webPreferences).toMatchObject({
      session: page.wc.session, nodeIntegration: false, nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false, webviewTag: false, contextIsolation: true, sandbox: true, webSecurity: true,
    });
    expect(page.open('blob:https://attacker.example/id').action).toBe('deny');
    expect(page.open('blob:null/id').action).toBe('deny');
    expect(page.open('javascript:alert(1)').action).toBe('deny');
    expect(isSameOriginBlobUrl('blob:file:///id', 'file:///page')).toBe(false);
    expect(nav.prepareSafeNavigationUrl('blob:https://example.com/id').safe).toBe(false);
  });

  it('binds TLS approval to the exact certificate, origin, and session', async () => {
    prompt.mockReset();
    prompt.mockResolvedValue({ response: 1 });
    const nav = manager();
    const page = contents();
    nav.attachWebContentsGuards(page.wc, { isPrivate: false });
    expect(await certificate(page.wc, 'https://example.com/', 'cert-a')).toHaveBeenCalledWith(true);
    expect(await certificate(page.wc, 'https://example.com/next', 'cert-a')).toHaveBeenCalledWith(true);
    expect(prompt).toHaveBeenCalledTimes(1);
    await certificate(page.wc, 'https://example.com/', 'cert-b');
    expect(prompt).toHaveBeenCalledTimes(2);
    await certificate(page.wc, 'https://example.com:8443/', 'cert-a');
    expect(prompt).toHaveBeenCalledTimes(3);
    const other = contents();
    nav.attachWebContentsGuards(other.wc, { isPrivate: false });
    await certificate(other.wc, 'https://example.com/', 'cert-a');
    expect(prompt).toHaveBeenCalledTimes(4);
  });

  it('keeps HTTP fallback consent within the owning session', async () => {
    prompt.mockResolvedValueOnce({ response: 1 });
    const nav = manager();
    const page = contents();
    const other = contents();
    nav.attachWebContentsGuards(page.wc, { isPrivate: false });
    await nav.navigateWebContents(page.wc, 'http://legacy.example/');
    page.wc.emit('did-fail-load', {}, -102, 'refused', 'https://legacy.example/', true);
    await Promise.resolve();
    expect(nav.prepareSafeNavigationUrl('http://legacy.example/', { wc: page.wc }).targetUrl).toBe('http://legacy.example/');
    expect(nav.prepareSafeNavigationUrl('http://legacy.example/', { wc: other.wc }).targetUrl).toBe('https://legacy.example/');
  });

  it('does not load an old HTTP fallback after another navigation starts', async () => {
    let resolve: (value: { response: number }) => void = () => {};
    prompt.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    const nav = manager();
    const page = contents();
    nav.attachWebContentsGuards(page.wc, { isPrivate: false });
    await nav.navigateWebContents(page.wc, 'http://legacy.example/');
    page.wc.emit('did-fail-load', {}, -102, 'refused', 'https://legacy.example/', true);
    page.wc.emit('did-start-navigation', {}, 'https://other.example/', false, true);
    resolve({ response: 1 });
    await Promise.resolve();
    expect(page.wc.loadURL).toHaveBeenCalledTimes(1);
    expect(nav.prepareSafeNavigationUrl('http://legacy.example/', { wc: page.wc }).targetUrl).toBe('https://legacy.example/');
  });

  it('does not grant a stale TLS dialog after another navigation starts', async () => {
    let resolve: (value: { response: number }) => void = () => {};
    prompt.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    const nav = manager();
    const page = contents();
    nav.attachWebContentsGuards(page.wc, { isPrivate: true });
    const callback = vi.fn();
    page.wc.emit('certificate-error', { preventDefault() {} }, 'https://example.com/', 'ERR_CERT_AUTHORITY_INVALID', { fingerprint: 'cert-a' }, callback);
    page.wc.emit('did-start-navigation', {}, 'https://other.example', false, true);
    resolve({ response: 1 });
    await Promise.resolve();
    expect(callback).toHaveBeenCalledWith(false);
  });
});
