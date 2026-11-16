import { describe, expect, it } from 'vitest';
import { isTrackedDownloadPath } from './downloadManager';
import { evaluateStaticPermissionPolicy, isWebOriginEligible } from './permissionManager';
import {
  classifyLoadError,
  isAllowedExternalProtocol,
  isSafeNavigationUrl,
  isSafeUpdateFeedUrl,
  shouldOfferInsecureHttpFallback,
} from './security';
import { computeViewRects } from './viewLayoutManager';

describe('Navigation, HTTPS-only, permission, and layout security policies', () => {
  it('classifies Chromium network errors accurately without conflating failures with missing HTTPS', () => {
    expect(classifyLoadError(-3)).toBe('aborted');
    expect(classifyLoadError(-200)).toBe('cert-error');
    expect(classifyLoadError(-202)).toBe('cert-error');
    expect(classifyLoadError(-501)).toBe('cert-error');
    expect(classifyLoadError(-105)).toBe('dns-error');
    expect(classifyLoadError(-106)).toBe('offline');
    expect(classifyLoadError(-118)).toBe('timeout');
    expect(classifyLoadError(-102)).toBe('https-unavailable');
    expect(classifyLoadError(-107)).toBe('https-unavailable');
    expect(classifyLoadError(-113)).toBe('https-unavailable');
  });

  it('offers explicit HTTP fallback ONLY when HTTPS-only upgrade hit https-unavailable', () => {
    expect(
      shouldOfferInsecureHttpFallback(-102, 'https://legacy.example.com/', true, true)
    ).toBe(true);
    expect(
      shouldOfferInsecureHttpFallback(-107, 'https://legacy.example.com/', true, true)
    ).toBe(true);

    // Must NOT offer downgrade for DNS, offline, timeout, cert error, non-upgraded, or disabled HTTPS-only
    expect(shouldOfferInsecureHttpFallback(-105, 'https://missing.example/', true, true)).toBe(false);
    expect(shouldOfferInsecureHttpFallback(-106, 'https://offline.example/', true, true)).toBe(false);
    expect(shouldOfferInsecureHttpFallback(-118, 'https://slow.example/', true, true)).toBe(false);
    expect(shouldOfferInsecureHttpFallback(-202, 'https://selfsigned.example/', true, true)).toBe(false);
    expect(shouldOfferInsecureHttpFallback(-102, 'https://direct-https.example/', true, false)).toBe(false);
    expect(shouldOfferInsecureHttpFallback(-102, 'http://localhost:3000/', true, true)).toBe(false);
    expect(shouldOfferInsecureHttpFallback(-102, 'https://legacy.example.com/', false, true)).toBe(false);
  });

  it('enforces safe navigation, external protocol, and update feed URL allowlists', () => {
    expect(isSafeNavigationUrl('https://kinex.dev')).toBe(true);
    expect(isSafeNavigationUrl('kinex://private')).toBe(true);
    expect(isSafeNavigationUrl('nook://welcome')).toBe(true);
    expect(isSafeNavigationUrl('about:blank')).toBe(true);
    expect(isSafeNavigationUrl('javascript:void(0)')).toBe(false);
    expect(isSafeNavigationUrl('data:text/html,hi')).toBe(false);
    expect(isSafeNavigationUrl('file:///Applications')).toBe(false);
    expect(isSafeNavigationUrl('smb://nas.local/share')).toBe(false);

    expect(isAllowedExternalProtocol('mailto:hello@example.com')).toBe(true);
    expect(isAllowedExternalProtocol('tel:+15550199')).toBe(true);
    expect(isAllowedExternalProtocol('smb://host/share')).toBe(false);
    expect(isAllowedExternalProtocol('file:///etc/passwd')).toBe(false);

    expect(isSafeUpdateFeedUrl('https://github.com/n3wbiekkkk/Kinex/releases/latest/download')).toBe(true);
    expect(isSafeUpdateFeedUrl('http://127.0.0.1:4123')).toBe(true);
    expect(isSafeUpdateFeedUrl('/Users/dev/Kinex/release')).toBe(true);
    expect(isSafeUpdateFeedUrl('http://insecure-remote.example/feed')).toBe(false);
    expect(isSafeUpdateFeedUrl('file:///Users/dev/release')).toBe(false);
  });

  it('enforces strict permission defaults for dangerous capabilities and private sessions', () => {
    expect(isWebOriginEligible('https://app.example.com')).toBe(true);
    expect(isWebOriginEligible('http://127.0.0.1:3000')).toBe(true);
    expect(isWebOriginEligible('http://unencrypted.example.com')).toBe(false);
    expect(isWebOriginEligible('kinex://welcome')).toBe(false);

    expect(evaluateStaticPermissionPolicy('midiSysex', 'https://app.example.com', false)).toBe('deny');
    expect(evaluateStaticPermissionPolicy('usb', 'https://app.example.com', false)).toBe('deny');
    expect(evaluateStaticPermissionPolicy('openExternal', 'https://app.example.com', false)).toBe('deny');

    // Regular secure web origin prompts for standard permissions
    expect(evaluateStaticPermissionPolicy('notifications', 'https://app.example.com', false)).toBe('prompt');
    expect(evaluateStaticPermissionPolicy('geolocation', 'https://app.example.com', false)).toBe('prompt');

    // Private session strictly denies tracking/fingerprinting/persistent sensitive capabilities
    expect(evaluateStaticPermissionPolicy('notifications', 'https://app.example.com', true)).toBe('deny');
    expect(evaluateStaticPermissionPolicy('geolocation', 'https://app.example.com', true)).toBe('deny');
    expect(evaluateStaticPermissionPolicy('media', 'https://app.example.com', true)).toBe('deny');
    expect(evaluateStaticPermissionPolicy('clipboard-read', 'https://app.example.com', true)).toBe('deny');

    // Harmless UI capabilities allowed
    expect(evaluateStaticPermissionPolicy('fullscreen', 'https://app.example.com', true)).toBe('allow');
  });

  it('verifies download paths strictly against session-tracked downloads', () => {
    const tracked = [
      {
        id: 'dl-1',
        filename: 'report.pdf',
        url: 'https://example.com/report.pdf',
        savePath: '/Users/alice/Downloads/report.pdf',
        receivedBytes: 1024,
        totalBytes: 1024,
        state: 'completed' as const,
        startedAt: Date.now(),
      },
    ];
    expect(isTrackedDownloadPath('/Users/alice/Downloads/report.pdf', tracked)).toBe(true);
    expect(isTrackedDownloadPath('/etc/passwd', tracked)).toBe(false);
    expect(isTrackedDownloadPath('/Users/alice/Downloads/../.ssh/id_rsa', tracked)).toBe(false);
  });

  it('computes non-overlapping ViewBoundsRects for sidebar and split view panes', () => {
    const single = computeViewRects({
      windowWidth: 1280,
      windowHeight: 800,
      sidebarOpen: true,
      sidebarWidth: 256,
      paneCount: 1,
      splitRatio: 0.5,
    });
    expect(single.panes).toHaveLength(1);
    expect(single.panes[0]).toEqual({ x: 256, y: 10, width: 1014, height: 780 });

    const split = computeViewRects({
      windowWidth: 1280,
      windowHeight: 800,
      sidebarOpen: false,
      sidebarWidth: 256,
      paneCount: 2,
      splitRatio: 0.5,
    });
    expect(split.panes).toHaveLength(2);
    expect(split.panes[0].x).toBe(10);
    expect(split.panes[0].y).toBe(40);
    expect(split.panes[1].x).toBeGreaterThan(split.panes[0].x + split.panes[0].width);
    expect(split.panes[0].width + split.panes[1].width + 8).toBe(1260);
  });
});
