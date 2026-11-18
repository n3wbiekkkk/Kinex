/**
 * Pure auto-archive + Archived Vault policy.
 *
 * No Electron imports: all capabilities (private-space knowledge, current time,
 * persistence) are supplied by the caller so this module is unit-testable in
 * plain Node. The orchestrator wires the exported helpers into IPC handlers.
 */
import type { ArchivedTab, FolderItem, TabItem } from '../shared/types';

export type AutoArchiveTimeout = '12h' | '24h' | '7d' | 'off';

export const AUTO_ARCHIVE_TIMEOUTS: readonly AutoArchiveTimeout[] = ['12h', '24h', '7d', 'off'];

export const AUTO_ARCHIVE_TIMEOUT_MS: Readonly<Record<AutoArchiveTimeout, number>> = {
  '12h': 12 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  off: Number.POSITIVE_INFINITY,
};

export function isAutoArchiveTimeout(value: unknown): value is AutoArchiveTimeout {
  return typeof value === 'string' && (AUTO_ARCHIVE_TIMEOUTS as readonly string[]).includes(value);
}

export interface IdleArchiveInput {
  tabs: readonly TabItem[];
  now: number;
  timeout: AutoArchiveTimeout;
  /** Space ids whose tabs must never be auto-archived (private spaces). */
  privateSpaceIds?: ReadonlySet<string>;
}

/**
 * Select tabs eligible for auto-archiving. Pinned/topApp, audible, private and
 * non-idle tabs are excluded. `off` (or an invalid clock) selects nothing.
 */
export function selectIdleTabs(input: IdleArchiveInput): TabItem[] {
  if (input.timeout === 'off' || !Number.isFinite(input.now)) return [];
  const threshold = AUTO_ARCHIVE_TIMEOUT_MS[input.timeout];
  if (!Number.isFinite(threshold)) return [];
  return input.tabs.filter((tab) => {
    if (tab.location !== 'unpinned') return false;
    if (tab.isAudible) return false;
    if (input.privateSpaceIds?.has(tab.spaceId)) return false;
    if (!Number.isFinite(tab.lastActiveAt)) return false;
    return input.now - tab.lastActiveAt >= threshold;
  });
}

export function createArchivedEntry(tab: TabItem, now: number): ArchivedTab {
  return {
    id: `arch-${tab.id}-${now}`,
    spaceId: tab.spaceId,
    url: tab.url,
    title: tab.title || tab.url,
    favicon: tab.favicon,
    archivedAt: now,
  };
}

export interface AutoArchivePlan {
  /** Ids of tabs the caller should close/destroy. */
  tabIds: string[];
  /** Archived vault entries corresponding 1:1 with `tabIds`. */
  entries: ArchivedTab[];
}

export function planAutoArchive(input: IdleArchiveInput): AutoArchivePlan {
  const eligible = selectIdleTabs(input);
  return {
    tabIds: eligible.map((tab) => tab.id),
    entries: eligible.map((tab) => createArchivedEntry(tab, input.now)),
  };
}

export function mergeArchivedEntries(
  existing: readonly ArchivedTab[],
  incoming: readonly ArchivedTab[],
  limit = 200
): ArchivedTab[] {
  if (incoming.length === 0) return existing.slice();
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 200;
  return [...incoming, ...existing].slice(0, safeLimit);
}

export interface VaultQueryOptions {
  query?: string;
  spaceId?: string;
  limit?: number;
}

/** Case-insensitive search over title/url/space, newest first, bounded. */
export function queryArchiveVault(
  entries: readonly ArchivedTab[],
  options: VaultQueryOptions = {}
): ArchivedTab[] {
  const query = (options.query ?? '').trim().toLowerCase();
  const safeLimit =
    typeof options.limit === 'number' && Number.isFinite(options.limit) && options.limit > 0
      ? Math.floor(options.limit)
      : 200;
  return entries
    .filter((entry) => (options.spaceId ? entry.spaceId === options.spaceId : true))
    .filter((entry) => {
      if (!query) return true;
      return (
        entry.title.toLowerCase().includes(query) ||
        entry.url.toLowerCase().includes(query) ||
        entry.spaceId.toLowerCase().includes(query)
      );
    })
    .slice()
    .sort((a, b) => b.archivedAt - a.archivedAt)
    .slice(0, safeLimit);
}

/** Folder extended with an optional parent for nested folder trees. */
export interface NestedFolder extends FolderItem {
  parentId?: string;
}

function folderIndex(folders: readonly NestedFolder[]): Map<string, NestedFolder> {
  return new Map(folders.map((folder) => [folder.id, folder]));
}

/** Root-first chain of folders ending at `folderId`; cycle-safe. */
export function getFolderPath(
  folders: readonly NestedFolder[],
  folderId: string
): NestedFolder[] {
  const byId = folderIndex(folders);
  const path: NestedFolder[] = [];
  const seen = new Set<string>();
  let current = byId.get(folderId);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    path.unshift(current);
    if (!current.parentId) break;
    current = byId.get(current.parentId);
  }
  return path;
}

export function getFolderPathNames(
  folders: readonly NestedFolder[],
  folderId: string
): string[] {
  return getFolderPath(folders, folderId).map((folder) => folder.name);
}

export function getFolderDepth(folders: readonly NestedFolder[], folderId: string): number {
  return Math.max(0, getFolderPath(folders, folderId).length - 1);
}

/** True when `candidateId` is `ancestorId` itself or one of its descendants. */
export function isFolderDescendant(
  folders: readonly NestedFolder[],
  ancestorId: string,
  candidateId: string
): boolean {
  if (ancestorId === candidateId) return true;
  const byId = folderIndex(folders);
  const seen = new Set<string>();
  let current = byId.get(candidateId);
  while (current?.parentId && !seen.has(current.id)) {
    if (current.parentId === ancestorId) return true;
    seen.add(current.id);
    current = byId.get(current.parentId);
  }
  return false;
}

/** Moving a folder beneath itself or beneath one of its descendants is a cycle. */
export function wouldCreateFolderCycle(
  folders: readonly NestedFolder[],
  folderId: string,
  newParentId: string | undefined
): boolean {
  if (!folderId || !newParentId) return false;
  if (folderId === newParentId) return true;
  if (!folderIndex(folders).has(newParentId)) return false;
  return isFolderDescendant(folders, folderId, newParentId);
}
