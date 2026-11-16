import type { Session } from 'electron';

const BLOCKED_HOST_SUFFIXES = new Set([
  'doubleclick.net',
  'googlesyndication.com',
  'googleadservices.com',
  'googletagmanager.com',
  'google-analytics.com',
  'adservice.google.com',
  'pagead2.googlesyndication.com',
  'connect.facebook.net',
  'analytics.tiktok.com',
  'ads-twitter.com',
  'bat.bing.com',
  'scorecardresearch.com',
  'quantserve.com',
  'criteo.com',
  'outbrain.com',
  'taboola.com',
  'adnxs.com',
  'pubmatic.com',
  'rubiconproject.com',
  'openx.net',
  'amazon-adsystem.com',
  'hotjar.com',
  'mixpanel.com',
  'segment.io',
  'sentry.io',
  'clarity.ms',
]);

const attachedSessions = new WeakSet<Session>();

export function isBlockedAdOrTrackerUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }
    let host = parsed.hostname.toLowerCase();
    while (host) {
      if (BLOCKED_HOST_SUFFIXES.has(host)) return true;
      const dot = host.indexOf('.');
      if (dot === -1) break;
      host = host.slice(dot + 1);
    }
    return false;
  } catch {
    return false;
  }
}

export function attachAdBlocker(
  sess: Session,
  isEnabled: () => boolean,
  onBlocked: () => void
): void {
  if (attachedSessions.has(sess)) return;
  attachedSessions.add(sess);

  sess.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
    if (!isEnabled()) {
      callback({ cancel: false });
      return;
    }
    if (details.resourceType !== 'mainFrame' && isBlockedAdOrTrackerUrl(details.url)) {
      onBlocked();
      callback({ cancel: true });
      return;
    }
    callback({ cancel: false });
  });
}
