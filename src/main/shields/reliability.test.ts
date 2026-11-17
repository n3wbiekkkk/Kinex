import fs from 'node:fs';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import type { Session, WebContents } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultShieldsSettings } from '../../shared/domain';
import { KinexShieldsCoordinator } from './coordinator';
import { ShieldsCosmeticInjector } from './cosmetics';
import { KinexShieldsEngine } from './engine';
import { downloadAndVerifyFilterList, MAX_FILTER_LIST_BYTES, validateAndNormalizeFilterText, writeFilterListAtomically } from './lists';

const directories: string[] = [];
function fixture(writeRules = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kinex-shields-recovery-'));
  directories.push(dir);
  const settings = createDefaultShieldsSettings();
  settings.filterLists = [{
    ...settings.filterLists[5], id: 'fixture', bundledFile: 'missing-fixture.gz',
    sourceUrl: 'https://filters.fixture.test/list.txt', enabled: true,
  }];
  if (writeRules) writeFilterListAtomically(dir, 'fixture', '||ads.fixture.test^$third-party\n||socket.fixture.test^$websocket\n##.ad-token\n');
  const engine = new KinexShieldsEngine(dir, settings);
  return { dir, settings, engine };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('Shields startup and update recovery', () => {
  it('reports native addon loading failure without throwing out of browser initialization', () => {
    const loader = Module as unknown as { _load: (name: string, ...args: unknown[]) => unknown };
    const original = loader._load;
    vi.spyOn(loader, '_load').mockImplementation(function (name, ...args) {
      if (name === 'adblock-rs') throw new Error('native binary unavailable');
      return original.call(this, name, ...args);
    });
    const { engine } = fixture();
    expect(() => engine.initializeSync()).not.toThrow();
    expect(engine.isReady()).toBe(false);
    expect(engine.getError()).toContain('native binary unavailable');
    expect(engine.evaluateNetworkRequest({ url: 'https://ads.fixture.test/pixel', sourceUrl: 'https://page.test', resourceType: 'image' }).blocked).toBe(false);
  });

  it('reports enabled lists missing instead of reporting an empty engine as healthy', () => {
    const { engine } = fixture(false);
    engine.initializeSync();
    expect(engine.isReady()).toBe(false);
    expect(engine.getError()).toContain('Unable to load filter lists');
    expect(engine.getTotalRuleCount()).toBe(0);
    expect(engine.getSettings().filterLists[0].lastError).toBe('Filter list unavailable');
  });

  it('recovers a corrupted compiled cache using persisted filters', () => {
    const { dir, settings, engine } = fixture();
    engine.initializeSync();
    const cache = fs.readdirSync(path.join(dir, 'shields-cache')).find((file) => file.endsWith('.bin'))!;
    fs.writeFileSync(path.join(dir, 'shields-cache', cache), 'corrupted cache');
    const restored = new KinexShieldsEngine(dir, settings);
    restored.initializeSync();
    expect(restored.isReady()).toBe(true);
    expect(restored.evaluateNetworkRequest({ url: 'https://ads.fixture.test/pixel', sourceUrl: 'https://page.test', resourceType: 'image' }).blocked).toBe(true);
  });

  it('keeps list toggles and current site policy when a pending download completes', async () => {
    const { engine } = fixture();
    engine.initializeSync();
    let complete!: (response: Response) => void;
    const pending = engine.updateAllEnabledLists((() => new Promise<Response>((resolve) => { complete = resolve; })) as typeof fetch);
    engine.updateSettings({
      ...engine.getSettings(), siteOverrides: { 'page.test': 'disabled' },
      filterLists: engine.getSettings().filterLists.map((list) => ({ ...list, enabled: false })),
    });
    complete(new Response('||new.fixture.test^\n'));
    const result = await pending;
    expect(result.updatedCount).toBe(0);
    expect(result.lists[0].enabled).toBe(false);
    expect(engine.resolveModeForPage('https://page.test').mode).toBe('disabled');
  });

  it('records a per-list disk failure and retains working filtering', async () => {
    const { dir, engine } = fixture();
    engine.initializeSync();
    fs.renameSync(path.join(dir, 'shields-lists'), path.join(dir, 'saved-lists'));
    fs.writeFileSync(path.join(dir, 'shields-lists'), 'not a directory');
    const result = await engine.updateAllEnabledLists((async () => new Response('||new.fixture.test^\n')) as typeof fetch);
    expect(result.updatedCount).toBe(0);
    expect(result.lists[0].lastError).toBeTruthy();
    expect(engine.evaluateNetworkRequest({ url: 'https://ads.fixture.test/pixel', sourceUrl: 'https://page.test', resourceType: 'image' }).blocked).toBe(true);
  });

  it.each(['dispose', 'restoreDefaultLists'] as const)('cancels a pending update on %s without installing the response', async (action) => {
    const { dir, engine } = fixture();
    engine.initializeSync();
    const before = fs.readFileSync(path.join(dir, 'shields-lists', 'fixture.txt.gz'));
    let signal: AbortSignal | undefined;
    let complete!: (response: Response) => void;
    const pending = engine.updateAllEnabledLists(((_url, options) => {
      signal = options?.signal as AbortSignal;
      return new Promise<Response>((resolve) => { complete = resolve; });
    }) as typeof fetch);
    engine[action]();
    expect(signal?.aborted).toBe(true);
    complete(new Response('||new.fixture.test^\n'));
    await pending;
    expect(fs.readFileSync(path.join(dir, 'shields-lists', 'fixture.txt.gz'))).toEqual(before);
    if (action === 'dispose') expect(engine.isReady()).toBe(false);
    else expect(engine.getSettings().filterLists.some((list) => list.id === 'fixture')).toBe(false);
  });
});

describe('Shields subscription trust boundary', () => {
  it('rejects HTTPS downgrade before fetching the insecure destination', async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL, _options?: RequestInit) => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/list' } }));
    const result = await downloadAndVerifyFilterList('https://filters.fixture.test/list', fetcher as typeof fetch);
    expect(result.ok).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][1]?.redirect).toBe('manual');
  });

  it('follows a relative HTTPS redirect and validates the final rules', async () => {
    const fetcher = vi.fn(async (url: string) => url.endsWith('/first')
      ? new Response(null, { status: 307, headers: { location: '/next' } })
      : new Response('||ads.fixture.test^\n'));
    const result = await downloadAndVerifyFilterList('https://filters.fixture.test/first', fetcher as typeof fetch);
    expect(result.ok).toBe(true);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(['https://filters.fixture.test/first', 'https://filters.fixture.test/next']);
  });

  it('bounds redirect loops and checks UTF-8 bytes', async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 302, headers: { location: '/loop' } }));
    const result = await downloadAndVerifyFilterList('https://filters.fixture.test/list', fetcher as typeof fetch);
    expect(result.ok).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(6);
    expect(validateAndNormalizeFilterText('é'.repeat(MAX_FILTER_LIST_BYTES / 2 + 1)).ok).toBe(false);
  });
});

describe('Shields site policy and cleanup', () => {
  it('uses top-page exceptions for third-party iframe requests and intercepts WebSockets', () => {
    const { engine } = fixture();
    engine.initializeSync();
    engine.updateSettings({ ...engine.getSettings(), siteOverrides: { 'page.test': 'disabled' } });
    let listener!: Parameters<Session['webRequest']['onBeforeRequest']>[1];
    let patterns: string[] = [];
    const session = { webRequest: { onBeforeRequest: (filter: { urls: string[] }, callback: typeof listener) => {
      patterns = filter.urls; listener = callback;
    } } } as unknown as Session;
    const coordinator = new KinexShieldsCoordinator(engine, {
      resolveTabIdByWebContentsId: () => 'tab', isPrivateWebContents: () => false, onStatsChanged: () => {},
    });
    coordinator.attachSession(session);
    coordinator.updateTopPageUrl(123, 'https://page.test');
    const request = { id: 1, webContentsId: 123, url: 'https://ads.fixture.test/pixel', referrer: 'https://iframe.test', resourceType: 'image', method: 'GET' };
    const response = vi.fn();
    listener!(request as Parameters<NonNullable<typeof listener>>[0], response);
    expect(response).toHaveBeenCalledWith({ cancel: false });
    expect(patterns).toContain('ws://*/*');
    expect(patterns).toContain('wss://*/*');
    engine.updateSettings({ ...engine.getSettings(), siteOverrides: {} });
    expect(engine.evaluateNetworkRequest({
      url: 'https://ads.fixture.test/pixel', sourceUrl: 'https://ads.fixture.test/frame',
      pageUrl: 'https://page.test', resourceType: 'image',
    }).blocked).toBe(false);
    response.mockClear();
    listener!({ ...request, id: 2, url: 'wss://socket.fixture.test/socket', resourceType: 'webSocket' } as Parameters<NonNullable<typeof listener>>[0], response);
    expect(response).toHaveBeenCalledWith({ cancel: true });
  });

  it('contains cosmetic native evaluation errors without rejecting the browser callback', async () => {
    const { engine } = fixture();
    engine.initializeSync();
    const native = require('adblock-rs') as typeof import('adblock-rs');
    vi.spyOn(native.Engine.prototype, 'urlCosmeticResources').mockImplementation(() => { throw new Error('invalid cosmetic rules'); });
    expect(() => engine.evaluateCosmeticsForUrl('https://page.test')).not.toThrow();
    expect(engine.getError()).toBe('invalid cosmetic rules');
  });

  it('cancels delayed cosmetic scans when a WebContents is forgotten', async () => {
    const { engine } = fixture();
    engine.initializeSync();
    vi.useFakeTimers();
    const scan = vi.fn(async () => ({ classes: ['ad-token'], ids: [] }));
    const contents = {
      id: 123, isDestroyed: () => false, getURL: () => 'https://page.test',
      removeInsertedCSS: async () => {}, insertCSS: async () => 'key',
      executeJavaScriptInIsolatedWorld: scan,
    } as unknown as WebContents;
    const injector = new ShieldsCosmeticInjector(engine);
    await injector.applyForWebContents(contents);
    expect(scan).toHaveBeenCalledTimes(1);
    injector.forgetWebContents(contents.id);
    await vi.advanceTimersByTimeAsync(1000);
    expect(scan).toHaveBeenCalledTimes(1);
  });
});
