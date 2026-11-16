import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dialog, type BrowserWindow } from 'electron';
import {
  parseArcStorableSidebarJson,
  parseChromeBookmarksJson,
  parseHtmlBookmarks,
  type ImportedBookmarksResult,
} from '../shared/importer';

export async function runBrowserImport(
  source: 'arc' | 'chrome' | 'file',
  activeSpaceId: string,
  parentWindow: BrowserWindow | null
): Promise<{ imported: ImportedBookmarksResult; label: string } | { cancelled: true } | { error: string }> {
  try {
    if (source === 'arc') {
      const arcPath = path.join(os.homedir(), 'Library', 'Application Support', 'Arc', 'StorableSidebar.json');
      if (!fs.existsSync(arcPath)) {
        return { error: 'Arc StorableSidebar.json not found on this Mac' };
      }
      const raw = fs.readFileSync(arcPath, 'utf8');
      return {
        imported: parseArcStorableSidebarJson(raw, activeSpaceId),
        label: 'Arc',
      };
    }

    if (source === 'chrome') {
      const chromePath = path.join(
        os.homedir(),
        'Library',
        'Application Support',
        'Google',
        'Chrome',
        'Default',
        'Bookmarks'
      );
      if (!fs.existsSync(chromePath)) {
        return { error: 'Chrome Bookmarks file not found on this Mac' };
      }
      const raw = fs.readFileSync(chromePath, 'utf8');
      return {
        imported: parseChromeBookmarksJson(raw, activeSpaceId),
        label: 'Chrome',
      };
    }

    if (!parentWindow || parentWindow.isDestroyed()) {
      return { cancelled: true };
    }
    const picked = await dialog.showOpenDialog(parentWindow, {
      title: 'Import Bookmarks (HTML, Chrome Bookmarks, or Arc StorableSidebar.json)',
      properties: ['openFile'],
      filters: [{ name: 'Bookmarks / Sidebar', extensions: ['html', 'htm', 'json'] }],
    });
    if (picked.canceled || picked.filePaths.length === 0) {
      return { cancelled: true };
    }
    const raw = fs.readFileSync(picked.filePaths[0], 'utf8');
    const trimmed = raw.trim();
    if (trimmed.startsWith('{')) {
      try {
        return { imported: parseChromeBookmarksJson(raw, activeSpaceId), label: 'JSON' };
      } catch {
        return { imported: parseArcStorableSidebarJson(raw, activeSpaceId), label: 'Arc JSON' };
      }
    }
    return { imported: parseHtmlBookmarks(raw, activeSpaceId), label: 'HTML' };
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Failed to import bookmarks' };
  }
}
