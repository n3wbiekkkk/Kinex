import { describe, expect, it } from 'vitest';
import { BROWSER_COMMANDS, isCommandId, matchShortcut, normalizeShortcut, shortcutConflicts } from './commands';
import { buildCommandBarResults, createDefaultPersistedData } from './domain';
import { validateIntent } from '../main/ipcValidation';

describe('browser commands and keyboard contract', () => {
  it('has unique command IDs and macOS shortcut chords, including modifier aliases', () => {
    expect(new Set(BROWSER_COMMANDS.map((c) => c.id)).size).toBe(BROWSER_COMMANDS.length);
    expect(shortcutConflicts('darwin')).toEqual([]);
    expect(normalizeShortcut('Command+Shift+T')).toBe(normalizeShortcut('Shift+CmdOrCtrl+T'));
    expect(isCommandId('select-tab-9')).toBe(true);
    expect(isCommandId('select-tab-10')).toBe(false);
  });

  it('matches only declared browser chords, leaves typing alone and ignores IME/key-up', () => {
    const input = { type: 'keyDown', key: 't', control: false, meta: false, alt: false, shift: false };
    expect(matchShortcut(input)).toBeUndefined();
    expect(matchShortcut({ ...input, meta: true })).toBe('new-tab');
    expect(matchShortcut({ ...input, meta: true, shift: true })).toBe('reopen-closed-tab');
    expect(matchShortcut({ ...input, key: 'Tab', control: true })).toBe('next-tab');
    expect(matchShortcut({ ...input, key: 'F6' })).toBe('focus-next');
    expect(matchShortcut({ ...input, key: 's', meta: true })).toBeUndefined();
    expect(matchShortcut({ ...input, meta: true, isComposing: true })).toBeUndefined();
    expect(matchShortcut({ ...input, meta: true, type: 'keyUp' })).toBeUndefined();
  });

  it('validates command and focus input at the IPC boundary', () => {
    for (const command of BROWSER_COMMANDS) {
      expect(validateIntent({ type: 'run-command', commandId: command.id }).ok).toBe(true);
    }
    expect(validateIntent({ type: 'run-command', commandId: '__proto__' }).ok).toBe(false);
    expect(validateIntent({ type: 'focus-region', region: 'sidebar' }).ok).toBe(true);
    expect(validateIntent({ type: 'focus-region', region: 'file:///etc/passwd' }).ok).toBe(false);
  });

  it('prioritizes real fuzzy commands over web search and binds moves to the focused split pane', () => {
    const state = createDefaultPersistedData();
    expect(buildCommandBarResults('opndwnlds', state)[0]?.actionId).toBe('open-downloads');
    expect(buildCommandBarResults('Close Tab', state)[0]?.actionId).toBe('close-tab');
    const tab = state.tabs.find((t) => t.spaceId === state.activeSpaceId)!;
    state.tabs.push({ ...tab, id: 'second-pane' });
    state.splitsBySpace[state.activeSpaceId] = { tabIds: [tab.id, 'second-pane'], focusedIndex: 1, splitRatio: 0.5 };
    const work = state.spaces.find((s) => s.id !== state.activeSpaceId)!;
    const move = buildCommandBarResults(`Move Tab to ${work.name}`, state)[0];
    expect(move?.intent).toEqual({ type: 'move-tab-to-space', tabId: 'second-pane', spaceId: work.id });
    expect(buildCommandBarResults('https://example.com', state)[0]?.id).toBe('direct-nav');
  });
});
