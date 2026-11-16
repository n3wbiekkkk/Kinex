import { session, type Protocol, type Session } from 'electron';
import type { DownloadManager } from './downloadManager';
import { renderKinexInternalHtml, type NewTabRenderContext } from './internalPages';
import type { PermissionManager } from './permissionManager';
import type { KinexShieldsCoordinator } from './shields/coordinator';

const protocolRegisteredSessions = new WeakSet<Session>();

export function registerKinexProtocolOnSession(
  sess: Session,
  getNewTabContext?: () => NewTabRenderContext
): void {
  if (protocolRegisteredSessions.has(sess)) return;
  protocolRegisteredSessions.add(sess);

  const handler = (request: Request) => {
    const isReader = request.url.startsWith('kinex://reader');
    const html = renderKinexInternalHtml(request.url, getNewTabContext?.());
    return new Response(html, {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': isReader
          ? "default-src 'none'; style-src 'unsafe-inline';"
          : "default-src 'self' 'unsafe-inline' data:;",
      },
    });
  };

  sess.protocol.handle('kinex', handler);
  sess.protocol.handle('nook', handler);
}

export function registerDefaultAppProtocols(protocolObj: Protocol): void {
  const handler = (request: Request) => {
    const html = renderKinexInternalHtml(request.url);
    return new Response(html, {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': "default-src 'self' 'unsafe-inline' data:;",
      },
    });
  };
  protocolObj.handle('kinex', handler);
  protocolObj.handle('nook', handler);
}

export class SessionManager {
  private privateCounter = 0;

  constructor(
    private readonly permissionManager: PermissionManager,
    private readonly downloadManager: DownloadManager,
    private readonly shieldsCoordinator?: Pick<KinexShieldsCoordinator, 'attachSession'>,
    private readonly getNewTabContext?: () => NewTabRenderContext
  ) {}

  getRegularSession(partition: string): Session {
    const safePartition = partition || 'persist:nook-default';
    const sess = session.fromPartition(safePartition);
    registerKinexProtocolOnSession(sess, this.getNewTabContext);
    this.shieldsCoordinator?.attachSession(sess);
    this.permissionManager.attachToSession(sess, { isPrivate: false });
    this.downloadManager.attachRegularSession(sess);
    return sess;
  }

  createPrivateSession(): { partition: string; sess: Session } {
    this.privateCounter += 1;
    // No 'persist:' prefix guarantees an in-memory ephemeral Electron partition
    const partition = `kinex-private-${Date.now()}-${this.privateCounter}`;
    const sess = session.fromPartition(partition, { cache: false });
    registerKinexProtocolOnSession(sess);
    this.shieldsCoordinator?.attachSession(sess);
    this.permissionManager.attachToSession(sess, { isPrivate: true });
    this.downloadManager.attachPrivateSession(sess);
    return { partition, sess };
  }

  async destroyPrivateSession(sess: Session): Promise<void> {
    try {
      await sess.clearStorageData();
      await sess.clearCache();
      await sess.clearAuthCache();
    } catch {
      // Ignore cleanup failures if session already torn down during app exit
    }
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
            'websql',
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
