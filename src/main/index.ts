import path from 'node:path';
import { app, ipcMain, protocol } from 'electron';
import { registerKinexIpcHandlers } from './ipcHandlers';
import { ensureAppName, KinexWindowManager, registerKinexProtocol } from './windowManager';

if (process.env.KINEX_USER_DATA_DIR) {
  app.setPath('userData', path.resolve(process.env.KINEX_USER_DATA_DIR));
}

ensureAppName();

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'kinex',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
  {
    scheme: 'nook',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
]);

let manager: KinexWindowManager | null = null;
let pendingStartupUrl: string | undefined;
let ipcRegistered = false;

function extractStartupUrl(argv: string[]): string | undefined {
  return argv.find((a) => /^(https?|kinex|nook):\/\//i.test(a));
}

function getOrCreateManager(): KinexWindowManager {
  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (!manager) {
    manager = new KinexWindowManager(app.getPath('userData'), devServerUrl);
  }
  return manager;
}

const isTestMode = process.env.KINEX_TEST_MODE === '1';
const gotLock = isTestMode ? true : app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const incomingUrl = extractStartupUrl(argv);
    const mgr = getOrCreateManager();
    if (!mgr.hasWindow()) {
      if (incomingUrl) mgr.setStartupUrl(incomingUrl);
      mgr.createWindow();
    } else {
      mgr.focusMainWindow();
      if (incomingUrl) {
        mgr.openUrl(incomingUrl, 'new-tab');
      }
    }
  });

  app.on('open-url', (event, url) => {
    event.preventDefault();
    if (!/^(https?|kinex|nook):\/\//i.test(url)) return;
    if (!app.isReady()) {
      pendingStartupUrl = url;
      return;
    }
    const mgr = getOrCreateManager();
    if (mgr.hasWindow()) {
      mgr.focusMainWindow();
      mgr.openUrl(url, 'new-tab');
    } else {
      mgr.setStartupUrl(url);
      mgr.createWindow();
    }
  });

  void app.whenReady().then(() => {
    registerKinexProtocol(protocol);
    if (!ipcRegistered) {
      ipcRegistered = true;
      registerKinexIpcHandlers(ipcMain, () => manager);
    }
    const mgr = getOrCreateManager();
    const startupUrl = pendingStartupUrl ?? extractStartupUrl(process.argv);
    pendingStartupUrl = undefined;
    if (startupUrl) mgr.setStartupUrl(startupUrl);
    mgr.createWindow();

    app.on('activate', () => {
      const current = getOrCreateManager();
      if (!current.hasWindow()) {
        current.createWindow();
      } else {
        current.focusMainWindow();
      }
    });
  });

  app.on('before-quit', () => {
    manager?.dispose();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
}
