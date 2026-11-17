import type { IpcMain } from 'electron';
import {
  validateIntent,
  validateLittleKinexActionInput,
  validateTabContextMenuInput,
} from './ipcValidation';
import type { KinexWindowManager } from './windowManager';

export function registerKinexIpcHandlers(
  ipc: IpcMain,
  getManager: () => KinexWindowManager | null
): void {
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
}
