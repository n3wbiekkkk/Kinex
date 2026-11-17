import { describe, expect, it, vi } from 'vitest';
const { windows } = vi.hoisted(() => ({ windows: [] as any[] }));
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  let contentsId = 0;
  class BrowserWindow extends EventEmitter {
    contentView = { addChildView() {} };
    constructor() { super(); windows.push(this); }
    isDestroyed() { return false; }
    getContentBounds() { return { width: 800, height: 600 }; }
  }
  class WebContentsView {
    webContents = Object.assign(new EventEmitter(), {
      id: ++contentsId, isDestroyed: () => false, send() {},
      setWindowOpenHandler() {}, loadURL: async () => {}, close() {},
    });
    setBackgroundColor() {}
    setBounds() {}
    setVisible() {}
  }
  return { BrowserWindow, WebContentsView, clipboard: {}, Menu: {} };
});
import { AuxiliaryWindowManager } from './auxiliaryWindows';

function setup() {
  const personal = {};
  const work = {};
  let activeSession = personal;
  const navigated = vi.fn();
  const manager = new AuxiliaryWindowManager({
    getSearchEngine: () => 'google',
    getRegularSessionForActiveSpace: () => activeSession,
  } as any, {} as any, {} as any, { navigateWebContents: navigated } as any);
  const created: any[] = [];
  vi.spyOn(manager as any, 'createAuxWindow').mockImplementation((options: any) => {
    let destroyed = false;
    const state = {
      win: {
        isDestroyed: () => destroyed,
        show: vi.fn(), focus: vi.fn(),
        close: vi.fn(() => { destroyed = true; }),
      },
      webView: { webContents: { session: options.sess } },
    };
    created.push(state);
    return state;
  });
  return { manager, created, navigated, switchProfile: () => { activeSession = work; } };
}

describe('Little Kinex profile ownership', () => {
  it('reuses its window within a profile and recreates it before navigating in another profile', () => {
    const { manager, created, navigated, switchProfile } = setup();
    manager.openLittleKinex('https://example.com/personal');
    manager.openLittleKinex('https://example.com/another');
    expect(created).toHaveLength(1);
    expect(navigated).toHaveBeenCalledTimes(1);
    switchProfile();
    manager.openLittleKinex('https://example.com/work');
    expect(created[0].win.close).toHaveBeenCalledOnce();
    expect(created).toHaveLength(2);
    expect(created[0].webView.webContents.session).not.toBe(created[1].webView.webContents.session);
    expect(navigated).toHaveBeenCalledTimes(1);
  });
});

it('destroys private popups before clearing their owner session even if normal close would be cancelled', () => {
  let navigationOptions: any;
  const destroyPrivateSession = vi.fn();
  const manager = new AuxiliaryWindowManager({
    getSearchEngine: () => 'google', getRendererUrl: () => 'file:///app/index.html',
    onWebContentsCreated() {},
  } as any, { register() {}, unregister() {} } as any, {
    createPrivateSession: () => ({ sess: {} }), destroyPrivateSession,
  } as any, {
    navigateWebContents() {},
    attachWebContentsGuards: (_wc: any, options: any) => { navigationOptions = options; },
  } as any);
  manager.openPrivateWindow();
  const popup = { isDestroyed: () => false, webContents: { id: 100, on() {} }, once() {}, close: vi.fn(), destroy: vi.fn() };
  navigationOptions.onDidCreatePopupWindow(popup);
  windows.at(-1).emit('closed');
  expect(popup.close).not.toHaveBeenCalled();
  expect(popup.destroy).toHaveBeenCalledOnce();
  expect(destroyPrivateSession).toHaveBeenCalledOnce();
  expect(popup.destroy.mock.invocationCallOrder[0]).toBeLessThan(destroyPrivateSession.mock.invocationCallOrder[0]);
});
