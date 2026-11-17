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

  it('rejects malformed, oversized and unauthenticated console messages', () => {
    const id = 'a'.repeat(32);
    const prefix = `kinex-action:${id}:`;
    expect(parseActionBadgeConsole(prefix + 'text:12')).toBeNull();
    expect(parseActionBadgeConsole(prefix + 'text:12', undefined)).toBeNull();
    expect(parseActionBadgeConsole(prefix + 'text:12', 'not-a-runtime-id')).toBeNull();
    expect(parseActionBadgeConsole('other-prefix:text:12', id)).toBeNull();
    expect(parseActionBadgeConsole(prefix + 'color:#aabbccdd', id)).toBeNull();
    expect(parseActionBadgeConsole(prefix + 'color:#GGGGGG', id)).toBeNull();
    expect(parseActionBadgeConsole(prefix + 'color:#aabbcc;background:url(javascript:alert(1))', id)).toBeNull();
    expect(parseActionBadgeConsole(prefix + 'color:#AABBCC', id)).toEqual({ color: '#AABBCC' });
    expect(parseActionBadgeConsole(`${prefix}text:${'x'.repeat(300)}`, id)).toBeNull();
    expect(parseActionBadgeConsole(`${prefix}text:${'x'.repeat(256 - prefix.length - 5)}`, id)).not.toBeNull();
  });

  it('requires consent and saves sanitized badge state', () => {
    let extension = record();
    const saveBadge = vi.fn();
    const bridge = new ExtensionActionBridge({ getExtension: () => extension, findByRuntimeUrl: () => undefined, saveBadge });
    bridge.setBadgeText(extension.id, '12345\u0000');
    expect(bridge.getBadge(extension.id)).toEqual({ text: '1234', color: '#6b7280' });
    bridge.setBadgeBackgroundColor(extension.id, '#a0B1c2');
    expect(bridge.getBadge(extension.id)?.color).toBe('#a0B1c2');
    extension = { ...record(), enabled: false };
    bridge.setBadgeText(extension.id, 'bad');
    expect(bridge.getBadge(extension.id)?.text).toBe('1234');
    expect(saveBadge).toHaveBeenCalledTimes(2);
  });

  it('bounds badge text and rejects unsafe colors before they reach saved state', () => {
    const saveBadge = vi.fn();
    const bridge = new ExtensionActionBridge({ getExtension: () => record(), findByRuntimeUrl: () => undefined, saveBadge });

    bridge.setBadgeText(record().id, '123456789');
    expect(bridge.getBadge(record().id)?.text).toBe('1234');
    bridge.setBadgeText(record().id, 'a\u0000b\nc\rd');
    expect(bridge.getBadge(record().id)?.text).toBe('abcd');
    bridge.setBadgeText(record().id, { toString: () => 'evil' });
    expect(bridge.getBadge(record().id)?.text).toBe('');

    bridge.setBadgeBackgroundColor(record().id, 'red; background:url(javascript:alert(1))');
    expect(bridge.getBadge(record().id)?.color).toBe('#6b7280');
    bridge.setBadgeBackgroundColor(record().id, '#12345');
    expect(bridge.getBadge(record().id)?.color).toBe('#6b7280');
    bridge.setBadgeBackgroundColor(record().id, '#AbCdEf');
    expect(bridge.getBadge(record().id)?.color).toBe('#AbCdEf');
    expect(saveBadge).toHaveBeenCalledTimes(6);
  });
});
