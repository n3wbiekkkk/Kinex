import type { FolderItem, TabItem } from './types';

export interface ImportedBookmarksResult {
  folders: FolderItem[];
  tabs: TabItem[];
}

interface ChromeBookmarkNode {
  type?: string;
  name?: string;
  url?: string;
  children?: ChromeBookmarkNode[];
}

export function parseChromeBookmarksJson(
  rawJson: string,
  spaceId: string
): ImportedBookmarksResult {
  const parsed = JSON.parse(rawJson) as { roots?: Record<string, ChromeBookmarkNode> };
  const roots = parsed.roots ?? {};
  const folders: FolderItem[] = [];
  const tabs: TabItem[] = [];
  const now = Date.now();
  let counter = 0;

  const walk = (node: ChromeBookmarkNode, folderId?: string) => {
    if (node.type === 'url' && node.url && /^https?:\/\//i.test(node.url)) {
      counter += 1;
      tabs.push({
        id: `tab-imp-${now}-${counter}`,
        spaceId,
        location: 'pinned',
        folderId,
        url: node.url,
        pinnedUrl: node.url,
        title: node.name || node.url,
        isLoading: false,
        canGoBack: false,
        canGoForward: false,
        isMuted: false,
        isAudible: false,
        lastActiveAt: now,
      });
      return;
    }
    if (Array.isArray(node.children)) {
      let nextFolderId = folderId;
      if (node.name && !['Bookmarks bar', 'Other bookmarks', 'Mobile bookmarks'].includes(node.name)) {
        counter += 1;
        nextFolderId = `fld-imp-${now}-${counter}`;
        folders.push({
          id: nextFolderId,
          spaceId,
          name: node.name,
          collapsed: true,
        });
      }
      for (const child of node.children) {
        walk(child, nextFolderId);
      }
    }
  };

  for (const root of Object.values(roots)) {
    if (root) walk(root);
  }

  return { folders: folders.slice(0, 40), tabs: tabs.slice(0, 200) };
}

export function parseArcStorableSidebarJson(
  rawJson: string,
  spaceId: string
): ImportedBookmarksResult {
  const parsed = JSON.parse(rawJson) as {
    sidebar?: { containers?: Array<{ items?: unknown[] }> };
  };
  const folders: FolderItem[] = [];
  const tabs: TabItem[] = [];
  const now = Date.now();
  let counter = 0;

  const containers = parsed.sidebar?.containers ?? [];
  for (const container of containers) {
    const items = Array.isArray(container.items) ? container.items : [];
    for (let i = 0; i < items.length; i++) {
      const entry = items[i];
      if (!entry || typeof entry !== 'object') continue;
      const obj = entry as {
        id?: string;
        title?: string | null;
        data?: { tab?: { savedURL?: string; savedTitle?: string } };
      };
      const url = obj.data?.tab?.savedURL;
      if (url && /^https?:\/\//i.test(url)) {
        counter += 1;
        tabs.push({
          id: `tab-arc-${now}-${counter}`,
          spaceId,
          location: 'pinned',
          url,
          pinnedUrl: url,
          title: obj.title || obj.data?.tab?.savedTitle || url,
          isLoading: false,
          canGoBack: false,
          canGoForward: false,
          isMuted: false,
          isAudible: false,
          lastActiveAt: now,
        });
      }
    }
  }
  return { folders, tabs: tabs.slice(0, 200) };
}

export function parseHtmlBookmarks(html: string, spaceId: string): ImportedBookmarksResult {
  const tabs: TabItem[] = [];
  const now = Date.now();
  const linkRe = /<A\s+[^>]*HREF=["']([^"']+)["'][^>]*>([^<]*)<\/A>/gi;
  let match: RegExpExecArray | null;
  let counter = 0;
  while ((match = linkRe.exec(html)) !== null && counter < 200) {
    const url = match[1];
    const title = match[2].trim() || url;
    if (/^https?:\/\//i.test(url)) {
      counter += 1;
      tabs.push({
        id: `tab-html-${now}-${counter}`,
        spaceId,
        location: 'pinned',
        url,
        pinnedUrl: url,
        title,
        isLoading: false,
        canGoBack: false,
        canGoForward: false,
        isMuted: false,
        isAudible: false,
        lastActiveAt: now,
      });
    }
  }
  return { folders: [], tabs };
}
