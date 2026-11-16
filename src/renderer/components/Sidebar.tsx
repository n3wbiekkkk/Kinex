import React, { memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Archive,
  ArrowLeft,
  ArrowRight,
  ArrowUpCircle,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  EyeOff,
  Folder,
  FolderPlus,
  Globe,
  Lock,
  Moon,
  PanelLeftClose,
  PictureInPicture2,
  Pin,
  PinOff,
  Plus,
  RotateCcw,
  RotateCw,
  Settings,
  Shield,
  ShieldOff,
  Sparkles,
  SplitSquareHorizontal,
  Star,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import { extractHostname, getActiveSplit } from '../../shared/domain';
import { BROWSER_COMMANDS, formatShortcut } from '../../shared/commands';
import type { KinexIntent, KinexStateSnapshot, TabItem } from '../../shared/types';

interface SidebarProps {
  state: KinexStateSnapshot;
  dispatch: (intent: KinexIntent) => void;
}

const Favicon = memo<{ url?: string; fallbackLabel?: string }>(({ url, fallbackLabel }) => {
  const [errored, setErrored] = useState(false);
  if (url && !errored) {
    return (
      <img
        src={url}
        alt=""
        width={15}
        height={15}
        style={{ borderRadius: 4, flexShrink: 0 }}
        onError={() => setErrored(true)}
      />
    );
  }
  if (fallbackLabel) {
    const ch = fallbackLabel.trim().charAt(0).toUpperCase() || 'K';
    return (
      <span className="fav-monogram" aria-hidden="true">
        {ch}
      </span>
    );
  }
  return <Globe size={14} style={{ opacity: 0.72, flexShrink: 0 }} />;
});

interface SidebarTabRowProps {
  tab: TabItem;
  isPinned: boolean;
  isActive: boolean;
  isFocused: boolean;
  onDragStartTab: (tabId: string) => void;
  onDropTab: (targetTabId: string) => void;
  dispatch: (intent: KinexIntent) => void;
  isTabStop: boolean;
  onFocusPrimary: () => void;
}

const SidebarTabRow = memo<SidebarTabRowProps>(
  ({ tab, isPinned, isActive, isFocused, onDragStartTab, onDropTab, dispatch, isTabStop, onFocusPrimary }) => {
    const isModified = isPinned && Boolean(tab.pinnedUrl) && tab.url !== tab.pinnedUrl;
    return (
      <div
        draggable
        title={tab.isDiscarded ? `${tab.title || tab.url} (Sleeping to save memory)` : tab.title || tab.url}
        onDragStart={() => onDragStartTab(tab.id)}
        onDragOver={(e) => e.preventDefault()}
        onDrop={() => onDropTab(tab.id)}
        className={`tab-row ${isActive ? 'active' : ''} ${tab.isDiscarded ? 'discarded' : ''}`}
        data-focused={isFocused || undefined}
        onClick={() => dispatch({ type: 'select-tab', tabId: tab.id })}
        onContextMenu={(e) => {
          e.preventDefault();
          void window.kinexAPI.showTabContextMenu(tab.id);
        }}
      >
        <button
          className="tab-row-main"
          data-sidebar-item={`tab:${tab.id}`}
          data-tab-id={tab.id}
          tabIndex={isTabStop ? 0 : -1}
          aria-label={tab.title || tab.url}
          aria-current={isActive ? 'true' : undefined}
          onFocus={onFocusPrimary}
          onClick={(event) => {
            event.stopPropagation();
            dispatch({ type: 'select-tab', tabId: tab.id });
          }}
        >
        <Favicon url={tab.favicon} />
        {tab.isCrashed && (
          <AlertTriangle
            size={12}
            style={{ color: 'var(--danger)', flexShrink: 0 }}
            aria-label="Tab crashed"
          />
        )}
        <span className="tab-row-title">{tab.title || tab.url}</span>
        {tab.isDiscarded && (
          <span className="sleep-indicator" title="Sleeping (Memory Saver)" aria-label="Sleeping tab">
            <Moon size={10} />
          </span>
        )}
        </button>
        <div className="tab-row-actions" onClick={(e) => e.stopPropagation()}>
          {isModified && (
            <button
              className="tab-mini-btn"
              title="Reset to pinned URL"
              onClick={() => dispatch({ type: 'reset-pinned-tab', tabId: tab.id })}
            >
              <RotateCcw size={12} />
            </button>
          )}
          {tab.isAudible && (
            <button
              className="tab-mini-btn"
              title={tab.isMuted ? 'Unmute' : 'Mute'}
              onClick={() => dispatch({ type: 'toggle-mute', tabId: tab.id })}
            >
              {tab.isMuted ? <VolumeX size={12} /> : <Volume2 size={12} />}
            </button>
          )}
          <button
            className="tab-mini-btn"
            title="Open in Split"
            onClick={() => dispatch({ type: 'toggle-split', tabId: tab.id })}
          >
            <SplitSquareHorizontal size={12} />
          </button>
          {isPinned ? (
            <>
              <button
                className="tab-mini-btn"
                title="Add to Favorites"
                onClick={() => dispatch({ type: 'set-tab-location', tabId: tab.id, location: 'topApp' })}
              >
                <Star size={12} />
              </button>
              <button
                className="tab-mini-btn"
                title="Unpin"
                onClick={() => dispatch({ type: 'set-tab-location', tabId: tab.id, location: 'unpinned' })}
              >
                <PinOff size={12} />
              </button>
            </>
          ) : (
            <>
              <button
                className="tab-mini-btn"
                title="Pin Tab (⌘D)"
                onClick={() => dispatch({ type: 'set-tab-location', tabId: tab.id, location: 'pinned' })}
              >
                <Pin size={12} />
              </button>
              <button
                className="tab-mini-btn"
                title="Close Tab"
                onClick={() => dispatch({ type: 'close-tab', tabId: tab.id })}
              >
                <X size={12} />
              </button>
            </>
          )}
        </div>
      </div>
    );
  }
);

export const Sidebar: React.FC<SidebarProps> = ({ state, dispatch }) => {
  const draggedTabIdRef = useRef<string | null>(null);
  const draggedSpaceIdRef = useRef<string | null>(null);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [focusedItem, setFocusedItem] = useState<string | null>(null);
  const [renamingFolder, setRenamingFolder] = useState<string | null>(null);
  const [folderName, setFolderName] = useState('');
  const folderFocusRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (renamingFolder) {
      folderFocusRef.current = renamingFolder;
    } else if (folderFocusRef.current) {
      document.getElementById(`sidebar-folder-${folderFocusRef.current}`)?.focus();
      folderFocusRef.current = null;
    }
  }, [renamingFolder]);

  const activeSpace = useMemo(
    () => state.spaces.find((s) => s.id === state.activeSpaceId) ?? state.spaces[0],
    [state.spaces, state.activeSpaceId]
  );
  const split = useMemo(() => getActiveSplit(state), [state.splitsBySpace, state.activeSpaceId, state.tabs]);
  const activeTabIds = useMemo(() => new Set(split.tabIds), [split.tabIds]);
  const focusedTab = useMemo(
    () => state.tabs.find((t) => t.id === split.tabIds[split.focusedIndex]) ?? state.tabs[0],
    [state.tabs, split.tabIds, split.focusedIndex]
  );

  const { favoriteTabs, spaceFolders, pinnedTabs, rootPinnedTabs, todayTabs, audibleTab, folderTabsMap } =
    useMemo(() => {
      const favorites: TabItem[] = [];
      const pinned: TabItem[] = [];
      const rootPinned: TabItem[] = [];
      const today: TabItem[] = [];
      const byFolder = new Map<string, TabItem[]>();
      let audible: TabItem | undefined;

      for (const tab of state.tabs) {
        if (tab.isAudible && !audible) audible = tab;
        if (tab.spaceId === activeSpace.id) {
          if (tab.location === 'topApp') {
            favorites.push(tab);
          } else if (tab.location === 'pinned') {
            pinned.push(tab);
            if (tab.folderId) {
              const list = byFolder.get(tab.folderId);
              if (list) list.push(tab);
              else byFolder.set(tab.folderId, [tab]);
            } else {
              rootPinned.push(tab);
            }
          } else {
            today.push(tab);
          }
        }
      }

      return {
        favoriteTabs: favorites,
        spaceFolders: state.folders.filter((f) => f.spaceId === activeSpace.id),
        pinnedTabs: pinned,
        rootPinnedTabs: rootPinned,
        todayTabs: today,
        audibleTab: audible,
        folderTabsMap: byFolder,
      };
    }, [state.tabs, state.folders, activeSpace.id]);

  const sidebarItemIds = [
    ...favoriteTabs.map((tab) => `tab:${tab.id}`),
    ...spaceFolders.flatMap((folder) => [
      `folder:${folder.id}`,
      ...(folder.collapsed ? [] : (folderTabsMap.get(folder.id) ?? []).map((tab) => `tab:${tab.id}`)),
    ]),
    ...rootPinnedTabs.map((tab) => `tab:${tab.id}`),
    ...todayTabs.map((tab) => `tab:${tab.id}`),
  ];
  const selectedItem = focusedItem && sidebarItemIds.includes(focusedItem)
    ? focusedItem
    : sidebarItemIds.includes(`tab:${focusedTab?.id}`) ? `tab:${focusedTab?.id}` : sidebarItemIds[0];
  const sidebarShortcut = formatShortcut(BROWSER_COMMANDS.find((command) => command.id === 'toggle-sidebar')?.accelerator);

  const onSidebarKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    const target = event.target as HTMLElement;
    const item = target.closest<HTMLElement>('[data-sidebar-item]');
    if (!item || target !== item || event.nativeEvent.isComposing) return;
    const tabId = item.dataset.tabId;
    if (tabId && (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))) {
      event.preventDefault();
      void window.kinexAPI.showTabContextMenu(tabId);
      return;
    }
    if (tabId && event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault();
      const tab = state.tabs.find((candidate) => candidate.id === tabId);
      const siblings = state.tabs.filter((candidate) => candidate.spaceId === activeSpace.id && candidate.location === tab?.location && candidate.folderId === tab?.folderId);
      const index = siblings.findIndex((candidate) => candidate.id === tabId);
      const sibling = siblings[index + (event.key === 'ArrowUp' ? -1 : 1)];
      if (sibling) dispatch({ type: 'reorder-tab', sourceTabId: event.key === 'ArrowUp' ? tabId : sibling.id, targetTabId: event.key === 'ArrowUp' ? sibling.id : tabId });
      return;
    }
    const folderId = item.dataset.folderId;
    const folder = state.folders.find((candidate) => candidate.id === folderId);
    if (folder && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      event.preventDefault();
      if ((event.key === 'ArrowLeft' && !folder.collapsed) || (event.key === 'ArrowRight' && folder.collapsed)) dispatch({ type: 'toggle-folder', folderId: folder.id });
      return;
    }
    const direction = event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? -1
      : event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : 0;
    if (direction || event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[data-sidebar-item]'));
      const index = items.indexOf(item);
      const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + direction + items.length) % items.length;
      items[nextIndex]?.focus();
    }
  };

  const focusedHost = focusedTab
    ? extractHostname(focusedTab.url) || focusedTab.url
    : 'Search or enter URL';

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = state.sidebarWidth;
    let rafId: number | null = null;
    let pendingWidth = startW;

    const flushWidth = () => {
      rafId = null;
      dispatch({ type: 'set-sidebar-width', width: pendingWidth });
    };

    const onMove = (ev: MouseEvent) => {
      pendingWidth = startW + (ev.clientX - startX);
      if (rafId === null) {
        rafId = requestAnimationFrame(flushWidth);
      }
    };
    const onUp = () => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        dispatch({ type: 'set-sidebar-width', width: pendingWidth });
      }
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const handleDragStartTab = useCallback((tabId: string) => {
    draggedTabIdRef.current = tabId;
  }, []);

  const handleDropTab = useCallback(
    (targetTabId: string) => {
      const srcId = draggedTabIdRef.current;
      draggedTabIdRef.current = null;
      if (srcId && srcId !== targetTabId) {
        dispatch({ type: 'reorder-tab', sourceTabId: srcId, targetTabId });
      }
    },
    [dispatch]
  );

  const renderSecurityIcon = () => {
    if (!focusedTab) return <Globe size={13} />;
    if (focusedTab.securityState === 'cert-warning' || focusedTab.securityState === 'insecure') {
      return <AlertTriangle size={13} style={{ color: '#f59e0b' }} />;
    }
    if (focusedTab.securityState === 'secure') {
      return <Lock size={12} />;
    }
    return <Globe size={13} />;
  };

  const renderTabRow = (tab: TabItem, isPinned: boolean) => (
    <SidebarTabRow
      key={tab.id}
      tab={tab}
      isPinned={isPinned}
      isActive={activeTabIds.has(tab.id)}
      isFocused={tab.id === focusedTab?.id}
      onDragStartTab={handleDragStartTab}
      onDropTab={handleDropTab}
      dispatch={dispatch}
      isTabStop={selectedItem === `tab:${tab.id}`}
      onFocusPrimary={() => setFocusedItem(`tab:${tab.id}`)}
    />
  );

  return (
    <>
      <aside className="sidebar" aria-label="Sidebar" onKeyDown={onSidebarKeyDown} style={{ width: state.sidebarWidth }}>
        <div className="sidebar-drag-top">
          <button
            className="icon-btn"
            title={`Toggle Sidebar (${sidebarShortcut})`}
            aria-label="Toggle Sidebar"
            onClick={() => dispatch({ type: 'toggle-sidebar' })}
          >
            <PanelLeftClose size={14} />
          </button>
          <button
            className="icon-btn"
            title="Back (⌘[)"
            disabled={!focusedTab?.canGoBack}
            style={{ opacity: focusedTab?.canGoBack ? 1 : 0.3 }}
            onClick={() => dispatch({ type: 'nav-back' })}
          >
            <ArrowLeft size={14} />
          </button>
          <button
            className="icon-btn"
            title="Forward (⌘])"
            disabled={!focusedTab?.canGoForward}
            style={{ opacity: focusedTab?.canGoForward ? 1 : 0.3 }}
            onClick={() => dispatch({ type: 'nav-forward' })}
          >
            <ArrowRight size={14} />
          </button>
          <button
            className="icon-btn"
            title={focusedTab?.isLoading ? 'Stop' : 'Reload (⌘R)'}
            onClick={() => dispatch({ type: focusedTab?.isLoading ? 'nav-stop' : 'nav-reload' })}
          >
            {focusedTab?.isLoading ? <X size={13} /> : <RotateCw size={13} />}
          </button>
        </div>

        <div className={`sidebar-url-bar ${focusedTab?.isLoading ? 'loading' : ''}`}>
          <button
            className="tab-mini-btn"
            title="Site Security & Permissions"
            onClick={() => dispatch({ type: 'set-overlay', overlay: { mode: 'site-info' } })}
          >
            {renderSecurityIcon()}
          </button>
          <button
            className="sidebar-url-main"
            title="Edit URL or Search (⌘L)"
            onClick={() =>
              dispatch({
                type: 'set-overlay',
                overlay: {
                  mode: 'command-bar',
                  initialQuery:
                    focusedTab?.url && !focusedTab.url.startsWith('kinex://') && !focusedTab.url.startsWith('nook://')
                      ? focusedTab.url
                      : '',
                  targetMode: 'edit-url',
                },
              })
            }
          >
            <span className="url-pill-text">{focusedHost}</span>
          </button>
          <button
            className="tab-mini-btn"
            title="Copy Clean URL (⌘⇧C)"
            onClick={() => dispatch({ type: 'copy-current-url' })}
          >
            <Copy size={12} />
          </button>
          <button
            className="tab-mini-btn"
            title="Little Kinex (⌥⌘N)"
            onClick={() =>
              dispatch({
                type: 'open-url',
                url: focusedTab?.url || 'kinex://newtab',
                target: 'little-kinex',
              })
            }
          >
            <PictureInPicture2 size={12} />
          </button>
        </div>

        <div className="space-header">
          <button
            className="space-title-btn"
            title="Edit Space, Profile & Theme"
            onClick={() =>
              dispatch({ type: 'set-overlay', overlay: { mode: 'space-editor', spaceId: activeSpace.id } })
            }
          >
            <span>{activeSpace.icon}</span>
            <span>{activeSpace.name}</span>
          </button>
          <div style={{ display: 'flex', gap: 1 }}>
            <button
              className="icon-btn"
              title="New Private Window (⌘⇧N)"
              onClick={() => dispatch({ type: 'open-incognito' })}
            >
              <EyeOff size={13} />
            </button>
            <button
              className="icon-btn"
              title="New Pinned Folder"
              onClick={() => setCreatingFolder((v) => !v)}
            >
              <FolderPlus size={13} />
            </button>
            <button
              className="icon-btn"
              title="Toggle Split View (⌘⇧\)"
              onClick={() => dispatch({ type: 'toggle-split' })}
            >
              <SplitSquareHorizontal size={13} />
            </button>
          </div>
        </div>

        {favoriteTabs.length > 0 && (
          <div className="favorites-grid">
            {favoriteTabs.map((tab) => (
              <button
                key={tab.id}
                className={`fav-tile ${activeTabIds.has(tab.id) ? 'active' : ''}`}
                data-focused={tab.id === focusedTab?.id || undefined}
                title={`${tab.title} (${tab.url})`}
                aria-label={tab.title || tab.url}
                aria-current={activeTabIds.has(tab.id) ? 'true' : undefined}
                data-sidebar-item={`tab:${tab.id}`}
                data-tab-id={tab.id}
                tabIndex={selectedItem === `tab:${tab.id}` ? 0 : -1}
                onFocus={() => setFocusedItem(`tab:${tab.id}`)}
                onClick={() => dispatch({ type: 'select-tab', tabId: tab.id })}
                onContextMenu={(e) => {
                  e.preventDefault();
                  void window.kinexAPI.showTabContextMenu(tab.id);
                }}
              >
                <Favicon url={tab.favicon} fallbackLabel={tab.title || extractHostname(tab.url)} />
              </button>
            ))}
          </div>
        )}

        <div className="sidebar-scroll">
          {creatingFolder && (
            <form
              style={{ display: 'flex', gap: 4, padding: '2px 4px' }}
              onSubmit={(e) => {
                e.preventDefault();
                if (newFolderName.trim()) {
                  dispatch({ type: 'create-folder', spaceId: activeSpace.id, name: newFolderName });
                }
                setNewFolderName('');
                setCreatingFolder(false);
              }}
            >
              <input
                className="text-input"
                style={{ padding: '4px 8px', fontSize: 12 }}
                placeholder="Folder name..."
                aria-label="New Folder Name"
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                autoFocus
              />
            </form>
          )}

          {(spaceFolders.length > 0 || pinnedTabs.length > 0) && (
            <>
              <div className="section-header">
                <span>PINNED</span>
              </div>

              {spaceFolders.map((folder) => {
                const folderTabs = folderTabsMap.get(folder.id) ?? [];
                return (
                  <div
                    key={folder.id}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={() => {
                      const srcId = draggedTabIdRef.current;
                      draggedTabIdRef.current = null;
                      if (srcId) {
                        dispatch({ type: 'move-tab-to-folder', tabId: srcId, folderId: folder.id });
                      }
                    }}
                  >
                    {renamingFolder === folder.id ? (
                      <form className="tab-row" onSubmit={(event) => {
                        event.preventDefault();
                        if (folderName.trim()) dispatch({ type: 'rename-folder', folderId: folder.id, name: folderName.trim() });
                        setRenamingFolder(null);
                      }}>
                        <input className="text-input" aria-label="Folder Name" value={folderName} onChange={(event) => setFolderName(event.target.value)} autoFocus onKeyDown={(event) => {
                          if (event.key === 'Escape') { event.preventDefault(); setRenamingFolder(null); }
                        }} />
                        <button type="submit" className="btn-secondary">Save</button>
                        <button type="button" className="tab-mini-btn" aria-label="Cancel Folder Rename" onClick={() => setRenamingFolder(null)}><X size={12} /></button>
                      </form>
                    ) : (
                      <div className="tab-row">
                        <button
                          className="tab-row-main"
                          data-sidebar-item={`folder:${folder.id}`}
                          id={`sidebar-folder-${folder.id}`}
                          data-folder-id={folder.id}
                          tabIndex={selectedItem === `folder:${folder.id}` ? 0 : -1}
                          aria-expanded={!folder.collapsed}
                          onFocus={() => setFocusedItem(`folder:${folder.id}`)}
                          onClick={() => dispatch({ type: 'toggle-folder', folderId: folder.id })}
                        >
                          {folder.collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                          <Folder size={13} style={{ opacity: 0.78 }} />
                          <span className="tab-row-title">{folder.name}</span>
                        </button>
                        <div className="tab-row-actions">
                          <button className="tab-mini-btn" title="Rename Folder" aria-label={`Rename ${folder.name} Folder`} onClick={() => { setFolderName(folder.name); setRenamingFolder(folder.id); }}><Settings size={12} /></button>
                          <button className="tab-mini-btn" title="Delete Folder" aria-label={`Delete ${folder.name} Folder`} onClick={() => dispatch({ type: 'delete-folder', folderId: folder.id })}><X size={12} /></button>
                        </div>
                      </div>
                    )}
                    {!folder.collapsed && (
                      <div style={{ paddingLeft: 14, display: 'flex', flexDirection: 'column', gap: 2 }}>
                        {folderTabs.map((t) => renderTabRow(t, true))}
                      </div>
                    )}
                  </div>
                );
              })}

              {rootPinnedTabs.map((t) => renderTabRow(t, true))}
            </>
          )}

          <div className="section-header">
            <span>TODAY</span>
            {todayTabs.length > 0 && (
              <button
                className="clear-btn"
                onClick={() => dispatch({ type: 'clear-today-tabs', spaceId: activeSpace.id })}
              >
                Clear
              </button>
            )}
          </div>

          <button
            className="new-tab-row"
            onClick={() =>
              dispatch({
                type: 'set-overlay',
                overlay: { mode: 'command-bar', initialQuery: '', targetMode: 'new-tab' },
              })
            }
          >
            <Plus size={14} />
            <span>New Tab</span>
          </button>

          {todayTabs.map((t) => renderTabRow(t, false))}
        </div>

        <div className="sidebar-footer">
          {state.updateStatus.state === 'downloaded' && (
            <div className="update-banner">
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <ArrowUpCircle size={14} />
                Kinex v{state.updateStatus.version} ready
              </span>
              <button
                className="btn-primary"
                style={{ padding: '4px 9px', fontSize: 11 }}
                onClick={() => dispatch({ type: 'install-update' })}
              >
                Restart
              </button>
            </div>
          )}

          {state.updateStatus.state === 'downloading' && (
            <div className="update-banner">
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <ArrowUpCircle size={14} />
                Updating v{state.updateStatus.version} ({state.updateStatus.percent}%)
              </span>
            </div>
          )}

          {audibleTab && (
            <div className="now-playing-bar">
              <div className={`eq-bars ${audibleTab.isMuted ? 'paused' : ''}`} aria-hidden="true">
                <span />
                <span />
                <span />
              </div>
              <Favicon url={audibleTab.favicon} />
              <button
                className="tab-row-title"
                style={{ fontSize: 12 }}
                title="Jump to playing tab"
                onClick={() => dispatch({ type: 'select-tab', tabId: audibleTab.id })}
              >
                {audibleTab.title || audibleTab.url}
              </button>
              <button
                className="tab-mini-btn"
                title={audibleTab.isMuted ? 'Unmute' : 'Mute'}
                onClick={() => dispatch({ type: 'toggle-mute', tabId: audibleTab.id })}
              >
                {audibleTab.isMuted ? <VolumeX size={13} /> : <Volume2 size={13} />}
              </button>
            </div>
          )}

          <div className="space-switcher">
            {state.spaces.map((sp) => (
              <button
                key={sp.id}
                draggable
                title={`${sp.name} (⌥← / ⌥→ to reorder)`}
                aria-current={sp.id === activeSpace.id ? 'true' : undefined}
                onKeyDown={(event) => {
                  const direction = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0;
                  if (!direction) return;
                  event.preventDefault();
                  const index = state.spaces.findIndex((candidate) => candidate.id === sp.id);
                  const target = state.spaces[index + direction];
                  if (event.altKey) {
                    if (target) dispatch({ type: 'reorder-space', sourceSpaceId: sp.id, targetSpaceId: target.id });
                  } else {
                    const buttons = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('.space-pill');
                    buttons?.[(index + direction + state.spaces.length) % state.spaces.length]?.focus();
                  }
                }}
                className={`space-pill ${sp.id === activeSpace.id ? 'active' : ''}`}
                onDragStart={() => {
                  draggedSpaceIdRef.current = sp.id;
                }}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => {
                  const src = draggedSpaceIdRef.current;
                  draggedSpaceIdRef.current = null;
                  if (src && src !== sp.id) {
                    dispatch({ type: 'reorder-space', sourceSpaceId: src, targetSpaceId: sp.id });
                  }
                }}
                onClick={() => dispatch({ type: 'select-space', spaceId: sp.id })}
              >
                <span>{sp.icon}</span>
                <span>{sp.name}</span>
              </button>
            ))}
            <button
              className="icon-btn"
              title="New Space"
              onClick={() => dispatch({ type: 'set-overlay', overlay: { mode: 'space-editor' } })}
            >
              <Plus size={13} />
            </button>
          </div>

          <div className="footer-tools">
            <div style={{ display: 'flex', gap: 2 }}>
              <button
                className="icon-btn"
                title="Archived Tabs"
                onClick={() => dispatch({ type: 'set-overlay', overlay: { mode: 'archive' } })}
              >
                <Archive size={14} />
              </button>
              <button
                className="icon-btn"
                title="Downloads"
                onClick={() => dispatch({ type: 'set-overlay', overlay: { mode: 'downloads' } })}
              >
                <Download size={14} />
              </button>
              <button
                className="icon-btn"
                title="Boosts Studio (⌘⇧B)"
                onClick={() =>
                  dispatch({
                    type: 'set-overlay',
                    overlay: { mode: 'boosts', domain: extractHostname(focusedTab?.url ?? '') || '*' },
                  })
                }
              >
                <Sparkles size={14} />
              </button>
              <button
                className="icon-btn"
                title="Settings (⌘,)"
                onClick={() => dispatch({ type: 'set-overlay', overlay: { mode: 'settings' } })}
              >
                <Settings size={14} />
              </button>
            </div>

            <button
              className="shield-pill"
              title="Open Kinex Shields (⌘⇧K)"
              aria-label="Open Kinex Shields"
              onClick={() => dispatch({ type: 'set-overlay', overlay: { mode: 'shields' } })}
            >
              {state.adBlockEnabled ? <Shield size={12} /> : <ShieldOff size={12} />}
              <span>
                {state.adBlockEnabled
                  ? focusedTab
                    ? state.shieldsRuntime.tabStats[focusedTab.id]?.total ?? 0
                    : state.blockedRequestsCount
                  : 'Off'}
              </span>
            </button>
          </div>
        </div>
      </aside>
      <div
        className="sidebar-resizer"
        role="separator"
        tabIndex={0}
        aria-label="Resize Sidebar"
        aria-orientation="vertical"
        aria-valuemin={200}
        aria-valuemax={380}
        aria-valuenow={state.sidebarWidth}
        onMouseDown={startResize}
        onKeyDown={(event) => {
          const width = event.key === 'ArrowLeft' ? state.sidebarWidth - (event.shiftKey ? 32 : 8)
            : event.key === 'ArrowRight' ? state.sidebarWidth + (event.shiftKey ? 32 : 8)
              : event.key === 'Home' ? 200 : event.key === 'End' ? 380 : undefined;
          if (width === undefined) return;
          event.preventDefault();
          dispatch({ type: 'set-sidebar-width', width: Math.max(200, Math.min(380, width)) });
        }}
      />
    </>
  );
};
