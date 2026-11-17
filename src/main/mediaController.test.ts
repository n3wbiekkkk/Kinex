import { describe, expect, it } from 'vitest';
import { AutoPictureInPicture } from './mediaController';

function fixture(id: string) {
  const calls: string[] = [];
  return { calls, contents: { isDestroyed: () => false, executeJavaScript: async (script: string) => { calls.push(`${id}:${script.includes('requestPictureInPicture') ? 'enter' : 'exit'}`); return script.includes('requestPictureInPicture') ? true : true; } } };
}

describe('automatic Picture-in-Picture lifecycle', () => {
  it('closes only its own window when another tab is selected', async () => {
    const first = fixture('first');
    const second = fixture('second');
    const media = new AutoPictureInPicture();
    const contents = new Map([['first', first.contents], ['second', second.contents]]);
    await media.select('second', (id) => contents.get(id));
    expect(second.calls).toEqual(['second:enter']);
    expect(media.activeTabId).toBe('second');
    await media.select('first', (id) => contents.get(id));
    expect(first.calls).toEqual(['first:enter']);
    await media.clear((id) => contents.get(id));
    expect(media.activeTabId).toBeUndefined();
  });
});
