import { describe, expect, it, vi } from 'vitest';
import { initializeMediaComponents, summarizeComponentStatus } from './mediaComponents';

describe('Widevine component initialization', () => {
  it('awaits the CDM before resolving and logs only bounded status fields', async () => {
    let ready = false;
    const log = vi.fn();
    await expect(initializeMediaComponents({
      whenReady: async () => { ready = true; },
      status: () => ({ widevinecdm: {
        status: 'installed', version: '4.10.0',
        path: '/private/profile/WidevineCdm', license: 'do-not-log',
        error: { code: 'update-check', details: '/private/license-response' },
      } }),
    }, log)).resolves.toBe(true);
    expect(ready).toBe(true);
    expect(log).toHaveBeenCalledWith('Widevine components {"widevinecdm":{"status":"installed","version":"4.10.0","error":"update-check"}}');
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining('/private/'));
  });

  it('continues ordinary browsing after a component failure', async () => {
    const log = vi.fn();
    await expect(initializeMediaComponents({ whenReady: async () => { throw new Error('network unavailable'); }, status: vi.fn() }, log)).resolves.toBe(false);
    expect(log).toHaveBeenCalledWith('Widevine initialization failed; continuing with ordinary playback');
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining('network unavailable'));
  });

  it('reports unavailable components without failing startup', async () => {
    const log = vi.fn();
    await expect(initializeMediaComponents(undefined, log)).resolves.toBe(false);
    expect(log).toHaveBeenCalledWith('Widevine components API unavailable; continuing with ordinary playback');
  });

  it('limits status to allowlisted component ids and fields', () => {
    expect(summarizeComponentStatus({ widevinecdm: { status: 'ready', token: 'private' } })).toEqual({ widevinecdm: { status: 'ready' } });
    expect(summarizeComponentStatus({ widevinecdm: { status: 'ready' } }).widevinecdm).toEqual({ status: 'ready' });
  });
});
