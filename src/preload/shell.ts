import { contextBridge, ipcRenderer } from 'electron';
import type { NookAPI, NookIntent, NookStateSnapshot } from '../shared/types';

const api: NookAPI = {
  getState: () => ipcRenderer.invoke('nook:get-state'),
  dispatch: (intent: NookIntent) => ipcRenderer.invoke('nook:dispatch', intent),
  onStateUpdated: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: NookStateSnapshot) => {
      listener(snapshot);
    };
    ipcRenderer.on('nook:state-updated', handler);
    return () => ipcRenderer.removeListener('nook:state-updated', handler);
  },
  showTabContextMenu: (tabId) => ipcRenderer.invoke('nook:tab-context-menu', tabId),
  getLittleNookInfo: () => ipcRenderer.invoke('nook:little-info'),
  onLittleNookUpdated: (listener) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      info: { url: string; title: string; isLoading: boolean; canGoBack: boolean; canGoForward: boolean }
    ) => {
      listener(info);
    };
    ipcRenderer.on('nook:little-updated', handler);
    return () => ipcRenderer.removeListener('nook:little-updated', handler);
  },
  littleNookAction: (action, url) => ipcRenderer.invoke('nook:little-action', action, url),
};

contextBridge.exposeInMainWorld('nookAPI', api);
