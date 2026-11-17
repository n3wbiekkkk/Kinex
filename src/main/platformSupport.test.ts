import { afterEach, describe, expect, it, vi } from 'vitest';
import { currentPlatform, isLinux, isMac, isWindows, macOnly } from './platformSupport';

// `process.platform` is a configurable data property (not an accessor), so it
// is stubbed with defineProperty rather than vi.spyOn. The descriptor is
// restored after every test, keeping these checks deterministic on any host OS.
let restorePlatform: (() => void) | undefined;

function stubPlatform(platform: NodeJS.Platform): void {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  if (!original) throw new Error('process.platform descriptor is missing');
  Object.defineProperty(process, 'platform', { ...original, value: platform, configurable: true });
  restorePlatform = () => Object.defineProperty(process, 'platform', original);
}

afterEach(() => {
  restorePlatform?.();
  restorePlatform = undefined;
});

describe('platform detection', () => {
  it.each([
    ['darwin', true, false, false],
    ['win32', false, true, false],
    ['linux', false, false, true],
  ] as const)('classifies %s correctly', (platform, mac, windows, linux) => {
    stubPlatform(platform);
    expect(currentPlatform()).toBe(platform);
    expect(isMac()).toBe(mac);
    expect(isWindows()).toBe(windows);
    expect(isLinux()).toBe(linux);
  });

  it('reads the platform at call time rather than caching it', () => {
    stubPlatform('darwin');
    expect(isMac()).toBe(true);
    stubPlatform('linux');
    expect(isMac()).toBe(false);
    expect(isLinux()).toBe(true);
  });

  it('returns the real platform when it is not stubbed', () => {
    expect(currentPlatform()).toBe(process.platform);
  });
});

describe('macOnly fallback helper', () => {
  it('runs the operation on macOS and never calls the fallback', () => {
    stubPlatform('darwin');
    const operation = vi.fn(() => 'mac');
    const fallback = vi.fn(() => 'fallback');
    expect(macOnly(operation, fallback)).toBe('mac');
    expect(operation).toHaveBeenCalledOnce();
    expect(fallback).not.toHaveBeenCalled();
  });

  it.each(['win32', 'linux'] as const)('uses only the fallback on %s', (platform) => {
    stubPlatform(platform);
    const operation = vi.fn(() => 'mac');
    const fallback = vi.fn(() => 'fallback');
    expect(macOnly(operation, fallback)).toBe('fallback');
    expect(fallback).toHaveBeenCalledOnce();
    expect(operation).not.toHaveBeenCalled();
  });
});
