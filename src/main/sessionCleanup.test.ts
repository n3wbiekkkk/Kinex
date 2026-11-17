import { expect, it, vi } from 'vitest';
import type { Session } from 'electron';
import { SessionManager } from './sessionManager';
import type { PermissionManager } from './permissionManager';
import type { DownloadManager } from './downloadManager';

it('attempts every private cleanup operation after a storage purge fails', async () => {
  const sess = {
    clearStorageData: vi.fn().mockRejectedValue(new Error('storage unavailable')),
    clearCache: vi.fn().mockResolvedValue(undefined),
    clearAuthCache: vi.fn().mockResolvedValue(undefined),
    closeAllConnections: vi.fn().mockResolvedValue(undefined),
  };
  const manager = new SessionManager({} as PermissionManager, {} as DownloadManager);
  await manager.destroyPrivateSession(sess as unknown as Session);
  for (const operation of Object.values(sess)) expect(operation).toHaveBeenCalledOnce();
});
