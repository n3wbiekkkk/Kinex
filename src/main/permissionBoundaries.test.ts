import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { Session, WebContents } from 'electron';
import type { SitePermissionDecision } from '../shared/types';

const { prompt } = vi.hoisted(() => ({ prompt: vi.fn() }));
vi.mock('electron', () => ({ dialog: { showMessageBox: prompt } }));
import { PermissionManager, evaluateStaticPermissionPolicy, isWebOriginEligible } from './permissionManager';

function setup(decisions: SitePermissionDecision[] = []) {
  const recordDecision = vi.fn((partition, origin, permission, decision) => {
    decisions.push({ partition, origin, permission, decision, updatedAt: 0 });
  });
  const manager = new PermissionManager({
    getMainWindow: () => ({ isDestroyed: () => false }) as any,
    getDecisions: () => decisions,
    recordDecision,
    revokeDecision: vi.fn(),
  });
  function attach(partition: string, isPrivate = false) {
    let check: any;
    let request: any;
    manager.attachToSession({
      setPermissionCheckHandler: (handler: any) => { check = handler; },
      setPermissionRequestHandler: (handler: any) => { request = handler; },
    } as Session, { partition, isPrivate });
    return { check, request };
  }
  const wc = Object.assign(new EventEmitter(), { id: 1, isDestroyed: () => false }) as unknown as WebContents;
  return { manager, attach, wc, recordDecision };
}

describe('permission trust boundaries', () => {
  it('keeps grants within their profile and rejects legacy unscoped grants', () => {
    const { attach } = setup([
      { partition: 'persist:personal', origin: 'https://example.com', permission: 'geolocation', decision: 'allow', updatedAt: 0 },
      { origin: 'https://example.com', permission: 'notifications', decision: 'allow', updatedAt: 0 } as SitePermissionDecision,
    ]);
    const personal = attach('persist:personal');
    const work = attach('persist:work');
    expect(personal.check(null, 'geolocation', 'https://example.com', {})).toBe(true);
    expect(work.check(null, 'geolocation', 'https://example.com', {})).toBe(false);
    expect(personal.check(null, 'notifications', 'https://example.com', {})).toBe(false);
  });

  it('grants microphone without also granting camera and denies ambiguous media checks', async () => {
    prompt.mockResolvedValueOnce({ response: 1 });
    const { attach, wc, recordDecision } = setup();
    const { request, check } = attach('persist:personal');
    const reply = vi.fn();
    await request(wc, 'media', reply, { requestingUrl: 'https://example.com/call', mediaTypes: ['audio'] });
    expect(reply).toHaveBeenCalledWith(true);
    expect(recordDecision).toHaveBeenCalledWith('persist:personal', 'https://example.com', 'media:audio', 'allow');
    expect(check(wc, 'media', 'https://example.com', { mediaType: 'audio' })).toBe(true);
    expect(check(wc, 'media', 'https://example.com', { mediaType: 'video' })).toBe(false);
    expect(check(wc, 'media', 'https://example.com', { mediaType: 'unknown' })).toBe(false);
    expect(wc.listenerCount('destroyed')).toBe(1);
    wc.emit('did-navigate');
    expect(wc.listenerCount('destroyed')).toBe(0);
  });

  it('denies private sensitive requests even when another profile has a grant', async () => {
    const { attach, wc } = setup([
      { partition: 'persist:personal', origin: 'https://example.com', permission: 'geolocation', decision: 'allow', updatedAt: 0 },
    ]);
    const { request, check } = attach('private-test', true);
    const reply = vi.fn();
    await request(wc, 'geolocation', reply, { requestingUrl: 'https://example.com' });
    expect(reply).toHaveBeenCalledWith(false);
    expect(check(wc, 'geolocation', 'https://example.com', {})).toBe(false);
  });

  it.each(['did-start-navigation', 'render-process-gone', 'destroyed'])('invalidates a pending grant after %s', async (event) => {
    let resolve: (result: { response: number }) => void = () => {};
    prompt.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    const { attach, wc, recordDecision } = setup();
    const { request } = attach('persist:personal');
    const reply = vi.fn();
    const pending = request(wc, 'geolocation', reply, { requestingUrl: 'https://example.com' });
    wc.emit(event);
    resolve({ response: 1 });
    await pending;
    expect(reply).toHaveBeenCalledWith(false);
    expect(recordDecision).not.toHaveBeenCalled();
    expect(wc.listenerCount('did-start-navigation')).toBe(0);
    expect(wc.listenerCount('destroyed')).toBe(0);
  });

  it('replies deny and removes temporary listeners when a permission dialog fails', async () => {
    prompt.mockRejectedValueOnce(new Error('window destroyed'));
    const { attach, wc, recordDecision } = setup();
    const { request } = attach('persist:personal');
    const reply = vi.fn();
    await request(wc, 'notifications', reply, { requestingUrl: 'https://example.com' });
    expect(reply).toHaveBeenCalledExactlyOnceWith(false);
    expect(recordDecision).not.toHaveBeenCalled();
    expect(wc.listenerCount('destroyed')).toBe(0);
  });

  it('denies unknown capabilities and distinguishes loopback from local-network hosts', () => {
    expect(evaluateStaticPermissionPolicy('unknown', 'https://example.com', false)).toBe('deny');
    expect(evaluateStaticPermissionPolicy('fileSystem', 'https://example.com', false)).toBe('deny');
    expect(isWebOriginEligible('http://attacker.local')).toBe(false);
    expect(isWebOriginEligible('http://localhost:3000')).toBe(true);
    expect(isWebOriginEligible('http://[::1]:3000')).toBe(true);
  });
});
