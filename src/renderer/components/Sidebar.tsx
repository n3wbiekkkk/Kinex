import React, { useState } from 'react';
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
import type { NookIntent, NookStateSnapshot, TabItem } from '../../shared/types';

interface SidebarProps {
  state: NookStateSnapshot;
  dispatch: (intent: NookIntent) => void;
}

function Favicon({ tab }: { tab: TabItem }) {
  const [errored, setErrored] = useState(false);
  if (tab.favicon && !errored) {
    return (
      <img
        src={tab.favicon}
        alt=""
        width={15}
        height={15}
        style={{ borderRadius: 4, flexShrink: 0 }}
        onError={() => setErrored(true)}
      />
    );
  }
  return <Globe size={14} style={{ opacity: 0.72, flexShrink: 0 }} />;
}

export const Sidebar: React.FC<SidebarProps> = ({ state, dispatch }) => {
  const [draggedTabId, setDraggedTabId] = useState<string | null>(null);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');

  const activeSpace = state.spaces.find((s) => s.id === state.activeSpaceId) ?? state.spaces[0];
  const split = getActiveSplit(state);
  const activeTabIds = new Set(split.tabIds);
  const focusedTab = state.tabs.find((t) => t.id === split.tabIds[split.focusedIndex]) ?? state.tabs[0];

  const favoriteTabs = state.tabs.filter((t) => t.location === 'topApp');
  const spaceFolders = state.folders.filter((f) => f.spaceId === activeSpace.id);
  const pinnedTabs = state.tabs.filter(
    (t) => t.spaceId === activeSpace.id && t.location === 'pinned'
  );
  const rootPinnedTabs = pinnedTabs.filter((t) => !t.folderId);
  const todayTabs = state.tabs.filter(
    (t) => t.spaceId === activeSpace.id && t.location === 'unpinned'
  );

  const focusedHost = focusedTab
    ? extractHostname(focusedTab.url) || focusedTab.url
    : 'Search or enter URL';
  const audibleTab = state.tabs.find((t) => t.isAudible);

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = state.sidebarWidth;
    const onMove = (ev: MouseEvent) => {
      dispatch({ type: 'set-sidebar-width', width: startW + (ev.clientX - startX) });
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

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

  const renderTabRow = (tab: TabItem, isPinned: boolean) => {
    const isModified = isPinned && tab.pinnedUrl && tab.url !== tab.pinnedUrl;
    return (
      <div
        key={tab.id}
        draggable
        onDragStart={() => setDraggedTabId(tab.id)}
        onDragOver={(e) => e.preventDefault()}
        onDrop={() => {
          if (draggedTabId && draggedTabId !== tab.id) {
            dispatch({ type: 'reorder-tab', sourceTabId: draggedTabId, targetTabId: tab.id });
          }
          setDraggedTabId(null);
        }}
        className={`tab-row ${activeTabIds.has(tab.id) ? 'active' : ''}`}
        onClick={() => dispatch({ type: 'select-tab', tabId: tab.id })}
        onContextMenu={(e) => {
          e.preventDefault();
          void window.nookAPI.showTabContextMenu(tab.id);
        }}
      >
        <Favicon tab={tab} />
        <span className="tab-row-title">{tab.title || tab.url}</span>
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
  };

  return (
    <>
      <aside className="sidebar" style={{ width: state.sidebarWidth }}>
        <div className="sidebar-drag-top">
          <button
            className="icon-btn"
            title="Toggle Sidebar (⌘S)"
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
                target: 'little-nook',
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
                title={`${tab.title} (${tab.url})`}
                onClick={() => dispatch({ type: 'select-tab', tabId: tab.id })}
                onContextMenu={(e) => {
                  e.preventDefault();
                  void window.nookAPI.showTabContextMenu(tab.id);
                }}
              >
                <Favicon tab={tab} />
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
                const folderTabs = pinnedTabs.filter((t) => t.folderId === folder.id);
                return (
                  <div
                    key={folder.id}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={() => {
                      if (draggedTabId) {
                        dispatch({ type: 'move-tab-to-folder', tabId: draggedTabId, folderId: folder.id });
                        setDraggedTabId(null);
                      }
                    }}
                  >
                    <div
                      className="tab-row"
                      onClick={() => dispatch({ type: 'toggle-folder', folderId: folder.id })}
                    >
                      {folder.collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                      <Folder size={13} style={{ opacity: 0.78 }} />
                      <span className="tab-row-title">{folder.name}</span>
                      <div className="tab-row-actions" onClick={(e) => e.stopPropagation()}>
                        <button
                          className="tab-mini-btn"
                          title="Delete Folder"
                          onClick={() => dispatch({ type: 'delete-folder', folderId: folder.id })}
                        >
                          <X size={12} />
                        </button>
                      </div>
                    </div>
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
              <Favicon tab={audibleTab} />
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
                className={`space-pill ${sp.id === activeSpace.id ? 'active' : ''}`}
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
              title="Ad & Tracker Shields"
              onClick={() => dispatch({ type: 'toggle-adblock' })}
            >
              {state.adBlockEnabled ? <Shield size={12} /> : <ShieldOff size={12} />}
              <span>{state.adBlockEnabled ? state.blockedRequestsCount : 'Off'}</span>
            </button>
          </div>
        </div>
      </aside>
      <div className="sidebar-resizer" onMouseDown={startResize} />
    </>
  );
};
