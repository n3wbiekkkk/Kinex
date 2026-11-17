import { randomBytes } from 'node:crypto';
import { session, type Protocol, type Session } from 'electron';
import type { DownloadManager } from './downloadManager';
import { renderKinexInternalHtml, type NewTabRenderContext } from './internalPages';
import type { PermissionManager } from './permissionManager';
import type { KinexShieldsCoordinator } from './shields/coordinator';

export function createInternalPageResponse(url: string, context?: NewTabRenderContext): Response {
  const nonce = randomBytes(18).toString('base64');
  const reader = new URL(url).hostname === 'reader';
  const html = renderKinexInternalHtml(url, context).replaceAll('<script>', `<script nonce="${nonce}">`);
  return new Response(html, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': `default-src 'none'; script-src ${reader ? "'none'" : `'nonce-${nonce}'`}; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    },
  });
}

const protocolRegisteredSessions = new WeakSet<Session>();

export function registerKinexProtocolOnSession(
  sess: Session,
  getNewTabContext?: () => NewTabRenderContext
): void {
  if (protocolRegisteredSessions.has(sess)) return;
  protocolRegisteredSessions.add(sess);

  const handler = (request: Request) => createInternalPageResponse(request.url, getNewTabContext?.());

  sess.protocol.handle('kinex', handler);
  sess.protocol.handle('nook', handler);
}

export function registerDefaultAppProtocols(protocolObj: Protocol): void {
  const handler = (request: Request) => createInternalPageResponse(request.url);
  protocolObj.handle('kinex', handler);
  protocolObj.handle('nook', handler);
}

export class SessionManager {
  private privateCounter = 0;

  private readonly regularSessions = new Set<Session>();

  constructor(
    private readonly permissionManager: PermissionManager,
    private readonly downloadManager: DownloadManager,
    private readonly shieldsCoordinator?: Pick<KinexShieldsCoordinator, 'attachSession'>,
    private readonly getNewTabContext?: () => NewTabRenderContext,
    private readonly onRegularSessionReady?: (partition: string, sess: Session) => void
  ) {}

  getRegularSession(partition: string): Session {
    const safePartition = partition || 'persist:nook-default';
    const sess = session.fromPartition(safePartition);
    registerKinexProtocolOnSession(sess, this.getNewTabContext);
    this.shieldsCoordinator?.attachSession(sess);
    this.permissionManager.attachToSession(sess, { isPrivate: false, partition: safePartition });
    sess.setDisplayMediaRequestHandler((_request, callback) => callback({}), { useSystemPicker: true });
    this.downloadManager.attachRegularSession(sess);
    this.onRegularSessionReady?.(safePartition, sess);
    this.regularSessions.add(sess);
    return sess;
  }

  getAllRegularSessions(): Session[] {
    return [...this.regularSessions];
  }

  createPrivateSession(): { partition: string; sess: Session } {
    this.privateCounter += 1;
    // No 'persist:' prefix guarantees an in-memory ephemeral Electron partition
    const partition = `kinex-private-${Date.now()}-${this.privateCounter}`;
    const sess = session.fromPartition(partition, { cache: false });
    registerKinexProtocolOnSession(sess);
    this.shieldsCoordinator?.attachSession(sess);
    this.permissionManager.attachToSession(sess, { isPrivate: true, partition });
    sess.setDisplayMediaRequestHandler((_request, callback) => callback({}));
    this.downloadManager.attachPrivateSession(sess);
    return { partition, sess };
  }

  async destroyPrivateSession(sess: Session): Promise<void> {
    await Promise.allSettled([
      sess.clearStorageData(),
      sess.clearCache(),
      sess.clearAuthCache(),
      sess.closeAllConnections(),
    ]);
  }

  async clearRegularSessionData(
    partitions: string[],
    opts: { cookies: boolean; cache: boolean }
  ): Promise<void> {
    for (const part of partitions) {
      const sess = session.fromPartition(part);
      if (opts.cookies) {
        await sess.clearStorageData({
          storages: [
            'cookies',
            'localstorage',
            'indexdb',
            'serviceworkers',
            'cachestorage',
            'filesystem',
            'shadercache',
          ],
        });
      }
      if (opts.cache) {
        await sess.clearCache();
      }
    }
  }
}
