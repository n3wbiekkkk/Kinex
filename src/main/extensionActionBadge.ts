import fs from 'node:fs';
import type { ExtensionActionBadge } from '../shared/types';
import { resolveInsideRoot } from './extensionSupport';

export function createBadge(text: unknown, color: unknown): ExtensionActionBadge {
  const safeColor = typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color) ? color : '#6b7280';
  const safeText = typeof text === 'string' ? Array.from(text.replace(/[\u0000-\u001f\u007f]/g, '')).slice(0, 4).join('') : '';
  return { text: safeText, color: safeColor };
}

export function createBadgeWorker(target: string, workerPath: string, crxId: string): void {
  const manifestPath = resolveInsideRoot(target, 'manifest.json');
  const original = resolveInsideRoot(target, workerPath);
  const backup = resolveInsideRoot(target, `${workerPath}.kinex-original.js`);
  const wrapper = resolveInsideRoot(target, 'kinex-badge-worker.js');
  if (!manifestPath || !original || !backup || !wrapper) throw new Error('Invalid CRX action worker');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { background: { service_worker: string } };
  if (manifest.background.service_worker === 'kinex-badge-worker.js') return;
  fs.copyFileSync(original, backup, fs.constants.COPYFILE_EXCL);
  const script = `
    for (const [name, property] of [['setBadgeText', 'text'], ['setBadgeBackgroundColor', 'color']]) {
      const original = chrome.action[name].bind(chrome.action);
      chrome.action[name] = (details) => {
        const value = typeof details?.[property] === 'string' ? details[property] : '';
        console.log('kinex-action:${crxId}:' + property + ':' + value.slice(0, 16));
        return original(details);
      };
    }
    importScripts(${JSON.stringify(`${workerPath}.kinex-original.js`)});
  `;
  fs.writeFileSync(wrapper, script, { mode: 0o600, flag: 'wx' });
  manifest.background.service_worker = 'kinex-badge-worker.js';
  fs.writeFileSync(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
}
