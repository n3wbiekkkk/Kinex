import { BrowserWindow, dialog, type IpcMain, type IpcMainInvokeEvent } from 'electron';
import {
  validateIntent,
  validateLittleKinexActionInput,
  validatePassphraseInput,
  validateTabContextMenuInput,
} from './ipcValidation';
import type { KinexWindowManager } from './windowManager';

export function registerKinexIpcHandlers(
  ipc: IpcMain,
  getManager: () => KinexWindowManager | null
): void {
  const trustedShell = (event: IpcMainInvokeEvent): KinexWindowManager | null => {
    const mgr = getManager();
    if (!mgr) return null;
    if (
      !event.senderFrame ||
      event.senderFrame !== event.sender.mainFrame ||
      !mgr.ipcRegistry.isTrusted(event.sender.id, event.senderFrame.url, ['shell', 'overlay'])
    ) {
      return null;
    }
    return mgr;
  };
  ipc.handle('kinex:get-state', (event) => {
    const mgr = getManager();
    if (!mgr) throw new Error('Browser controller unavailable');
    if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame || !mgr.ipcRegistry.isTrusted(event.sender.id, event.senderFrame?.url, ['shell', 'overlay'])) {
      throw new Error('Untrusted IPC sender for kinex:get-state');
    }
    return mgr.getSnapshot(event.sender.id);
  });

  ipc.handle('kinex:dispatch', (event, rawIntent: unknown) => {
    const mgr = getManager();
    if (!mgr) throw new Error('Browser controller unavailable');
    if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame || !mgr.ipcRegistry.isTrusted(event.sender.id, event.senderFrame?.url, ['shell', 'overlay'])) {
      throw new Error('Untrusted IPC sender for kinex:dispatch');
    }
    const parsed = validateIntent(rawIntent);
    if (!parsed.ok) {
      throw new Error(`Invalid IPC intent: ${parsed.error}`);
    }
    return mgr.handleIntent(parsed.value, event.sender.id);
  });

  ipc.handle('kinex:tab-context-menu', (event, rawTabId: unknown) => {
    const mgr = getManager();
    if (!mgr) throw new Error('Browser controller unavailable');
    if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame || !mgr.ipcRegistry.isTrusted(event.sender.id, event.senderFrame?.url, ['shell'])) {
      throw new Error('Untrusted IPC sender for kinex:tab-context-menu');
    }
    const parsed = validateTabContextMenuInput(rawTabId);
    if (!parsed.ok) {
      throw new Error(`Invalid tab context menu input: ${parsed.error}`);
    }
    mgr.showTabContextMenu(parsed.value);
  });

  ipc.handle('kinex:pick-extension-folder', (event) => {
    const mgr = getManager();
    if (!mgr) throw new Error('Browser controller unavailable');
    if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame || !mgr.ipcRegistry.isTrusted(event.sender.id, event.senderFrame?.url, ['shell', 'overlay'])) {
      throw new Error('Untrusted IPC sender for kinex:pick-extension-folder');
    }
    return mgr.pickExtensionFolder();
  });

  ipc.handle('kinex:pick-extension-crx', (event) => {
    const mgr = getManager();
    if (!mgr) throw new Error('Browser controller unavailable');
    if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame || !mgr.ipcRegistry.isTrusted(event.sender.id, event.senderFrame?.url, ['shell', 'overlay'])) {
      throw new Error('Untrusted IPC sender for kinex:pick-extension-crx');
    }
    return mgr.pickExtensionCrx();
  });

  ipc.handle('kinex:little-info', (event) => {
    const mgr = getManager();
    if (!mgr) throw new Error('Browser controller unavailable');
    if (
      !event.senderFrame || event.senderFrame !== event.sender.mainFrame ||
      !mgr.ipcRegistry.isTrusted(event.sender.id, event.senderFrame?.url, [
        'little-kinex',
        'private-header',
      ])
    ) {
      throw new Error('Untrusted IPC sender for kinex:little-info');
    }
    return mgr.getLittleKinexInfo(event.sender.id);
  });

  ipc.handle('kinex:little-action', (event, rawAction: unknown, rawUrl?: unknown) => {
    const mgr = getManager();
    if (!mgr) throw new Error('Browser controller unavailable');
    if (
      !event.senderFrame || event.senderFrame !== event.sender.mainFrame ||
      !mgr.ipcRegistry.isTrusted(event.sender.id, event.senderFrame?.url, [
        'little-kinex',
        'private-header',
      ])
    ) {
      throw new Error('Untrusted IPC sender for kinex:little-action');
    }
    const parsed = validateLittleKinexActionInput(rawAction, rawUrl);
    if (!parsed.ok) {
      throw new Error(`Invalid little-kinex action: ${parsed.error}`);
    }
    mgr.handleLittleKinexAction(event.sender.id, parsed.value.action, parsed.value.url);
  });

  ipc.handle('kinex:performance-snapshot', (event) => {
    const mgr = trustedShell(event);
    if (!mgr) throw new Error('Untrusted IPC sender for kinex:performance-snapshot');
    return mgr.getPerformanceSnapshot();
  });

  // Boundary checks throw synchronously; only the privileged work is deferred.
  ipc.handle('kinex:sync-export', (event, rawPassphrase: unknown) => {
    const mgr = trustedShell(event);
    if (!mgr) throw new Error('Untrusted IPC sender for kinex:sync-export');
    const parsed = validatePassphraseInput(rawPassphrase);
    if (!parsed.ok) throw new Error(`Invalid sync passphrase: ${parsed.error}`);
    return (async () => {
      const parent = BrowserWindow.getFocusedWindow();
      const options: Electron.SaveDialogOptions = {
        title: 'Export encrypted Kinex sync file',
        defaultPath: 'kinex-sync.kinex-sync',
        filters: [{ name: 'Kinex Sync', extensions: ['kinex-sync'] }],
      };
      const result = parent && !parent.isDestroyed()
        ? await dialog.showSaveDialog(parent, options)
        : await dialog.showSaveDialog(options);
      if (result.canceled || !result.filePath) return null;
      return mgr.syncExport(result.filePath, parsed.value);
    })();
  });

  ipc.handle('kinex:sync-import', (event, rawPassphrase: unknown) => {
    const mgr = trustedShell(event);
    if (!mgr) throw new Error('Untrusted IPC sender for kinex:sync-import');
    const parsed = validatePassphraseInput(rawPassphrase);
    if (!parsed.ok) throw new Error(`Invalid sync passphrase: ${parsed.error}`);
    return (async () => {
      const parent = BrowserWindow.getFocusedWindow();
      const options: Electron.OpenDialogOptions = {
        title: 'Import encrypted Kinex sync file',
        properties: ['openFile'],
        filters: [{ name: 'Kinex Sync', extensions: ['kinex-sync'] }],
      };
      const result = parent && !parent.isDestroyed()
        ? await dialog.showOpenDialog(parent, options)
        : await dialog.showOpenDialog(options);
      if (result.canceled || result.filePaths.length === 0) return null;
      return mgr.syncImport(result.filePaths[0], parsed.value);
    })();
  });

  ipc.handle('kinex:sync-backup', (event, rawPassphrase: unknown) => {
    const mgr = trustedShell(event);
    if (!mgr) throw new Error('Untrusted IPC sender for kinex:sync-backup');
    const parsed = validatePassphraseInput(rawPassphrase);
    if (!parsed.ok) throw new Error(`Invalid sync passphrase: ${parsed.error}`);
    return mgr.syncBackup(parsed.value);
  });
}
