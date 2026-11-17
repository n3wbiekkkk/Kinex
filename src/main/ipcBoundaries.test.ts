import { describe, expect, it, vi } from 'vitest';
import { registerKinexIpcHandlers } from './ipcHandlers';
import { TrustedIpcRegistry } from './ipcValidation';

describe('IPC frame boundaries', () => {
  it('fails closed until an internal base URL is configured', () => {
    const registry = new TrustedIpcRegistry();
    registry.register(1, 'shell');
    expect(registry.isTrusted(1, undefined)).toBe(false);
    expect(registry.isTrusted(1, 'https://example.com')).toBe(false);
  });

  it('rejects subframes on every IPC endpoint even with a trusted contents ID and URL', () => {
    const handlers = new Map<string, (...args: any[]) => any>();
    const ipcRegistry = new TrustedIpcRegistry();
    ipcRegistry.addAllowedBaseUrl('file:///app/index.html');
    ipcRegistry.register(1, 'shell');
    const getSnapshot = vi.fn(() => ({ tabs: [] }));
    const manager = { ipcRegistry, getSnapshot };
    registerKinexIpcHandlers({ handle: (name, handler) => handlers.set(name, handler) } as any, () => manager as any);
    const mainFrame = { url: 'file:///app/index.html?view=shell' };
    const sender = { id: 1, mainFrame };
    for (const handler of handlers.values()) {
      expect(() => handler({ sender, senderFrame: { url: mainFrame.url } })).toThrow('Untrusted IPC sender');
      expect(() => handler({ sender, senderFrame: null })).toThrow('Untrusted IPC sender');
    }
    expect(getSnapshot).not.toHaveBeenCalled();
    expect(handlers.get('kinex:get-state')!({ sender, senderFrame: mainFrame })).toEqual({ tabs: [] });
  });
});
