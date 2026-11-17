import { contextBridge, ipcRenderer } from 'electron';
import type {
  KinexAPI,
  FocusRequest,
  KinexIntent,
  KinexStateSnapshot,
  LittleKinexAction,
  LittleKinexInfo,
} from '../shared/types';

const api: KinexAPI = {
  getState: () => ipcRenderer.invoke('kinex:get-state'),
  dispatch: (intent: KinexIntent) => ipcRenderer.invoke('kinex:dispatch', intent),
  onFocusRequested: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, region: FocusRequest) => listener(region);
    ipcRenderer.on('kinex:focus-requested', handler);
    return () => ipcRenderer.removeListener('kinex:focus-requested', handler);
  },
  onStateUpdated: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: KinexStateSnapshot) => {
      listener(snapshot);
    };
    ipcRenderer.on('kinex:state-updated', handler);
    return () => ipcRenderer.removeListener('kinex:state-updated', handler);
  },
  showTabContextMenu: (tabId) => ipcRenderer.invoke('kinex:tab-context-menu', tabId),
  pickExtensionFolder: () => ipcRenderer.invoke('kinex:pick-extension-folder'),
  getLittleKinexInfo: () => ipcRenderer.invoke('kinex:little-info'),
  onLittleKinexUpdated: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, info: LittleKinexInfo) => {
      listener(info);
    };
    ipcRenderer.on('kinex:little-updated', handler);
    return () => ipcRenderer.removeListener('kinex:little-updated', handler);
  },
  littleKinexAction: (action: LittleKinexAction, url?: string) =>
    ipcRenderer.invoke('kinex:little-action', action, url),
};

contextBridge.exposeInMainWorld('kinexAPI', api);
