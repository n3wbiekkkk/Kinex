import { app, BrowserWindow, ipcMain, protocol } from 'electron';
import type { NookIntent } from '../shared/types';
import { ensureAppName, NookWindowManager, registerNookProtocol } from './windowManager';

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'kinex',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
    },
  },
  {
    scheme: 'nook',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
    },
  },
]);

ensureAppName();

let manager: NookWindowManager | null = null;
let pendingOpenUrl: string | null = null;

function extractCliUrl(argv: string[]): string | null {
  const candidate = argv.find((a) => /^(https?|kinex|nook):\/\//i.test(a));
  return candidate ?? null;
}

const gotSingleLock = app.requestSingleInstanceLock();
if (!gotSingleLock) {
  app.quit();
}

app.on('second-instance', (_event, argv) => {
  const url = extractCliUrl(argv);
  if (manager) {
    manager.focusMainWindow();
    if (url) {
      void manager.handleIntent({ type: 'open-url', url, target: 'new-tab' });
    }
  }
});

app.on('open-url', (event, url) => {
  event.preventDefault();
  if (manager) {
    manager.focusMainWindow();
    void manager.handleIntent({ type: 'open-url', url, target: 'new-tab' });
  } else {
    pendingOpenUrl = url;
  }
});

function registerIpc(mgr: NookWindowManager): void {
  ipcMain.handle('nook:get-state', () => mgr.getSnapshot());
  ipcMain.handle('nook:dispatch', (_event, intent: NookIntent) => mgr.handleIntent(intent));
  ipcMain.handle('nook:tab-context-menu', (_event, tabId: string) => mgr.showTabContextMenu(tabId));
  ipcMain.handle('nook:little-info', (event) => mgr.getLittleNookInfo(event.sender.id));
  ipcMain.handle(
    'nook:little-action',
    (
      event,
      action: 'back' | 'forward' | 'reload' | 'navigate' | 'promote' | 'close',
      url?: string
    ) => mgr.handleLittleNookAction(event.sender.id, action, url)
  );
}

app.whenReady().then(async () => {
  if (!gotSingleLock) return;
  registerNookProtocol(protocol);

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  manager = new NookWindowManager(app.getPath('userData'), devServerUrl);
  registerIpc(manager);

  await manager.createMainWindow();

  const initialUrl = pendingOpenUrl ?? extractCliUrl(process.argv);
  if (initialUrl) {
    pendingOpenUrl = null;
    await manager.handleIntent({ type: 'open-url', url: initialUrl, target: 'new-tab' });
  }

  if (process.argv.includes('--smoke-test')) {
    setTimeout(() => {
      app.quit();
    }, 1500);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && manager) {
      void manager.createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
