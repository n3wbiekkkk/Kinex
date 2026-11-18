import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { Session, WebContents } from 'electron';
import type { SitePermissionDecision } from '../shared/types';

const { prompt } = vi.hoisted(() => ({ prompt: vi.fn() }));
vi.mock('electron', () => ({ dialog: { showMessageBox: prompt } }));
import {
  PermissionManager,
  capabilityKey,
  evaluateStaticPermissionPolicy,
  grantCoversCapability,
  isPasskeyCapability,
  isWebOriginEligible,
  passkeyScope,
} from './permissionManager';

type ScopedDecision = SitePermissionDecision & { spaceId?: string };

function setup(decisions: ScopedDecision[] = []) {
  const recordDecision = vi.fn((partition, origin, permission, decision) => {
    decisions.push({ partition, origin, permission, decision, updatedAt: 0 });
  });
  const recordDecisionForSpace = vi.fn(
    (partition: string, spaceId: string, origin: string, permission: string, decision: 'allow' | 'deny') => {
      decisions.push({ partition, spaceId, origin, permission, decision, updatedAt: 0 });
    }
  );
  const manager = new PermissionManager({
    getMainWindow: () => ({ isDestroyed: () => false }) as any,
    getDecisions: () => decisions,
    recordDecision,
    revokeDecision: vi.fn(),
    recordDecisionForSpace,
    revokeDecisionForSpace: vi.fn(),
  });
  function attach(partition: string, isPrivate = false, spaceId?: string) {
    let check: any;
    let request: any;
    manager.attachToSession({
      setPermissionCheckHandler: (handler: any) => { check = handler; },
      setPermissionRequestHandler: (handler: any) => { request = handler; },
    } as Session, { partition, isPrivate, spaceId });
    return { check, request };
  }
  const wc = Object.assign(new EventEmitter(), { id: 1, isDestroyed: () => false }) as unknown as WebContents;
  return { manager, attach, wc, recordDecision, recordDecisionForSpace };
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

  it.each(['mediaKeySystem', 'protectedMediaIdentifier'])('requires explicit HTTPS per-profile consent for %s', async (permission) => {
    prompt.mockResolvedValueOnce({ response: 1 });
    const { attach, wc, recordDecision } = setup();
    const personal = attach('persist:personal');
    const work = attach('persist:work');
    const reply = vi.fn();
    await personal.request(wc, permission, reply, { requestingUrl: 'https://example.com/watch' });
    expect(reply).toHaveBeenCalledWith(true);
    expect(recordDecision).toHaveBeenCalledWith('persist:personal', 'https://example.com', permission, 'allow');
    expect(personal.check(wc, permission, 'https://example.com', {})).toBe(true);
    expect(work.check(wc, permission, 'https://example.com', {})).toBe(false);
    expect(evaluateStaticPermissionPolicy(permission, 'http://example.com/watch', false)).toBe('deny');
    expect(evaluateStaticPermissionPolicy(permission, 'http://localhost:3000', false)).toBe('deny');
    expect(evaluateStaticPermissionPolicy(permission, 'https://example.com/watch', true)).toBe('deny');
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

  it('scopes grants to a Space while legacy profile-wide grants remain valid', () => {
    const { attach } = setup([
      { partition: 'persist:personal', spaceId: 'space-a', origin: 'https://example.com', permission: 'geolocation', decision: 'allow', updatedAt: 0 },
      { partition: 'persist:personal', spaceId: 'space-b', origin: 'https://example.com', permission: 'notifications', decision: 'allow', updatedAt: 0 },
      { partition: 'persist:personal', origin: 'https://example.com', permission: 'clipboard-read', decision: 'allow', updatedAt: 0 },
    ]);
    const spaceA = attach('persist:personal', false, 'space-a');
    const spaceB = attach('persist:personal', false, 'space-b');
    const unscoped = attach('persist:personal');
    expect(spaceA.check(null, 'geolocation', 'https://example.com', {})).toBe(true);
    expect(spaceB.check(null, 'geolocation', 'https://example.com', {})).toBe(false);
    expect(unscoped.check(null, 'geolocation', 'https://example.com', {})).toBe(false);
    expect(spaceB.check(null, 'notifications', 'https://example.com', {})).toBe(true);
    expect(spaceA.check(null, 'notifications', 'https://example.com', {})).toBe(false);
    expect(spaceA.check(null, 'clipboard-read', 'https://example.com', {})).toBe(true);
    expect(spaceB.check(null, 'clipboard-read', 'https://example.com', {})).toBe(true);
  });

  it('records new grants with their Space id', async () => {
    prompt.mockResolvedValueOnce({ response: 1 });
    const { attach, wc, recordDecisionForSpace, recordDecision } = setup();
    const spaceA = attach('persist:personal', false, 'space-a');
    const reply = vi.fn();
    await spaceA.request(wc, 'geolocation', reply, { requestingUrl: 'https://example.com' });
    expect(reply).toHaveBeenCalledWith(true);
    expect(recordDecisionForSpace).toHaveBeenCalledWith(
      'persist:personal', 'space-a', 'https://example.com', 'geolocation', 'allow'
    );
    expect(recordDecision).not.toHaveBeenCalled();
  });

  it('limits WebAuthn/passkey verifications per Space and origin', async () => {
    prompt.mockResolvedValue({ response: 1 });
    const grant: ScopedDecision = {
      partition: 'persist:personal', spaceId: 'space-a', origin: 'https://example.com',
      permission: 'webauthn', decision: 'allow', updatedAt: 0,
    };
    const { attach, wc, manager } = setup([grant]);
    const spaceA = attach('persist:personal', false, 'space-a');
    const spaceB = attach('persist:personal', false, 'space-b');
    const scopeA = passkeyScope('persist:personal', 'space-a', 'https://example.com');
    expect(manager.isPasskeyVerificationAllowed(scopeA)).toBe(true);

    for (let i = 0; i < 5; i += 1) {
      const reply = vi.fn();
      await spaceA.request(wc, 'publickey-credentials-get', reply, { requestingUrl: 'https://example.com' });
      expect(reply).toHaveBeenCalledWith(true);
    }
    expect(manager.isPasskeyVerificationAllowed(scopeA)).toBe(false);
    expect(spaceA.check(wc, 'webauthn', 'https://example.com', {})).toBe(false);

    const limited = vi.fn();
    await spaceA.request(wc, 'webauthn', limited, { requestingUrl: 'https://example.com' });
    expect(limited).toHaveBeenCalledWith(false);

    const otherSpace = vi.fn();
    await spaceB.request(wc, 'webauthn', otherSpace, { requestingUrl: 'https://example.com' });
    expect(otherSpace).toHaveBeenCalledWith(true);

    manager.resetPasskeyVerification(scopeA);
    expect(spaceA.check(wc, 'webauthn', 'https://example.com', {})).toBe(true);
  });

  it('keeps capability grants specific and normalizes aliases', () => {
    expect(capabilityKey('media', { mediaType: 'audio' })).toBe('media:audio');
    expect(capabilityKey('microphone')).toBe('media:audio');
    expect(capabilityKey('camera')).toBe('media:video');
    expect(capabilityKey('publickey-credentials-get')).toBe('webauthn');
    expect(grantCoversCapability('media:audio', 'media:audio')).toBe(true);
    expect(grantCoversCapability('media:audio', 'media:video')).toBe(false);
    expect(isPasskeyCapability('publickey-credentials-create')).toBe(true);
    expect(isPasskeyCapability('geolocation')).toBe(false);
    expect(evaluateStaticPermissionPolicy('webauthn', 'https://example.com', false)).toBe('prompt');
  });
});
