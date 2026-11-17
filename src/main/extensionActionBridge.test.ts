import { describe, expect, it, vi } from 'vitest';
import type { InstalledExtension } from '../shared/types';
import { ExtensionActionBridge, parseActionBadgeConsole } from './extensionActionBridge';

const record = (): InstalledExtension => ({
  id: 'ext-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', name: 'Test', version: '1',
  directory: 'ext-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', partition: 'persist:test', spaceId: 'space-test',
  enabled: true, consented: true, permissions: [], hostPermissions: [], installedAt: 1,
  runtimeId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
});

describe('extension action badge compatibility', () => {
  it('authenticates runtime id, text, and color format', () => {
    expect(parseActionBadgeConsole('kinex-action:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:text:12', 'a'.repeat(32))).toEqual({ text: '12' });
    expect(parseActionBadgeConsole('kinex-action:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:color:#aabbcc', 'a'.repeat(32))).toEqual({ color: '#aabbcc' });
    expect(parseActionBadgeConsole('kinex-action:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:text:12', 'b'.repeat(32))).toBeNull();
    expect(parseActionBadgeConsole('kinex-action:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:color:javascript:alert', 'a'.repeat(32))).toBeNull();
  });

  it('requires consent and saves sanitized badge state', () => {
    let extension = record();
    const saveBadge = vi.fn();
    const bridge = new ExtensionActionBridge({ getExtension: () => extension, saveBadge });
    bridge.setBadgeText(extension.id, '12345\u0000');
    expect(bridge.getBadge(extension.id)).toEqual({ text: '1234', color: '#6b7280' });
    bridge.setBadgeBackgroundColor(extension.id, '#a0B1c2');
    expect(bridge.getBadge(extension.id)?.color).toBe('#a0B1c2');
    extension = { ...record(), enabled: false };
    bridge.setBadgeText(extension.id, 'bad');
    expect(bridge.getBadge(extension.id)?.text).toBe('1234');
    expect(saveBadge).toHaveBeenCalledTimes(2);
  });
});
