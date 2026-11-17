import React from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Copy,
  Lock,
  PanelLeft,
  PictureInPicture2,
  Printer,
  Puzzle,
  RotateCw,
  Shield,
  ShieldAlert,
  ShieldOff,
  SlidersHorizontal,
  Sparkles,
  SplitSquareHorizontal,
  X,
} from 'lucide-react';
import { extractHostname, getActiveSplit, resolveEffectiveShieldsMode } from '../../shared/domain';
import { BROWSER_COMMANDS, formatShortcut } from '../../shared/commands';
import type { KinexIntent, KinexStateSnapshot, ReaderTheme } from '../../shared/types';

interface TopControlsProps {
  state: KinexStateSnapshot;
  dispatch: (intent: KinexIntent) => void;
}

export const TopControls: React.FC<TopControlsProps> = ({ state, dispatch }) => {
  const split = getActiveSplit(state);
  const panes = split.tabIds
    .map((id) => state.tabs.find((t) => t.id === id))
    .filter((t): t is NonNullable<typeof t> => Boolean(t));
  const focusedTab = panes[split.focusedIndex] ?? panes[0];
  const focusedEffectiveShields = resolveEffectiveShieldsMode(
    state.shields,
    focusedTab?.url ?? '',
    extractHostname(focusedTab?.url ?? '')
  );
  const focusedBlockedCount = focusedTab ? state.shieldsRuntime.tabStats[focusedTab.id]?.total ?? 0 : 0;
  const activeExtensions = state.extensions.filter(
    (extension) => extension.enabled && extension.spaceId === state.activeSpaceId && Boolean(extension.actionPopup)
  );

  return (
    <div className={`top-controls ${state.sidebarOpen ? '' : 'sidebar-closed'}`} role="toolbar" aria-label="Browser Toolbar" onKeyDown={(event) => {
      if (!(event.target instanceof HTMLButtonElement) || event.altKey || event.metaKey || event.ctrlKey) return;
      const direction = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0;
      if (!direction) return;
      event.preventDefault();
      const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
      const index = buttons.indexOf(event.target);
      buttons[(index + direction + buttons.length) % buttons.length]?.focus();
    }}>
      {!state.sidebarOpen && (
        <>
          <button
            className="icon-btn"
            title={`Show Sidebar (${formatShortcut(BROWSER_COMMANDS.find((command) => command.id === 'toggle-sidebar')?.accelerator)})`}
            aria-label="Show Sidebar"
            onClick={() => dispatch({ type: 'toggle-sidebar' })}
          >
            <PanelLeft size={15} />
          </button>

          <button
            className="icon-btn"
            title="Back (⌘[)"
            aria-label="Back"
            disabled={!focusedTab?.canGoBack}
            style={{ opacity: focusedTab?.canGoBack ? 1 : 0.35 }}
            onClick={() => dispatch({ type: 'nav-back' })}
          >
            <ArrowLeft size={15} />
          </button>

          <button
            className="icon-btn"
            title="Forward (⌘])"
            aria-label="Forward"
            disabled={!focusedTab?.canGoForward}
            style={{ opacity: focusedTab?.canGoForward ? 1 : 0.35 }}
            onClick={() => dispatch({ type: 'nav-forward' })}
          >
            <ArrowRight size={15} />
          </button>

          <button
            className="icon-btn"
            title={focusedTab?.isLoading ? 'Stop' : 'Reload (⌘R)'}
            aria-label={focusedTab?.isLoading ? 'Stop Loading' : 'Reload'}
            onClick={() => dispatch({ type: focusedTab?.isLoading ? 'nav-stop' : 'nav-reload' })}
          >
            {focusedTab?.isLoading ? <X size={14} /> : <RotateCw size={14} />}
          </button>
        </>
      )}

      <div className="pane-pills">
        {panes.map((tab, idx) => (
          <div
            key={tab.id}
            className={`pane-pill ${idx === split.focusedIndex ? 'focused' : ''} ${tab.isLoading ? 'loading' : ''}`}
          >
            <button
              className="tab-mini-btn"
              title="Site Control Center"
              aria-label="Site Control Center"
              onClick={(e) => {
                e.stopPropagation();
                dispatch({ type: 'focus-pane', paneIndex: idx });
                dispatch({ type: 'set-overlay', overlay: { mode: 'site-info' } });
              }}
            >
              {tab.securityState === 'cert-warning' || tab.securityState === 'insecure' ? (
                <AlertTriangle size={11} style={{ color: '#f59e0b' }} />
              ) : tab.securityState === 'secure' ? (
                <Lock size={11} />
              ) : (
                <SlidersHorizontal size={11} />
              )}
            </button>
            <button
              className="pane-pill-main"
              aria-label={idx === split.focusedIndex ? `Edit address for ${tab.title || tab.url}` : `Focus pane ${idx + 1}: ${tab.title || tab.url}`}
            onClick={() => {
              if (idx !== split.focusedIndex) {
                dispatch({ type: 'focus-pane', paneIndex: idx });
              } else {
                dispatch({
                  type: 'set-overlay',
                  overlay: {
                    mode: 'command-bar',
                    initialQuery:
                      tab.url.startsWith('kinex://') || tab.url.startsWith('nook://') ? '' : tab.url,
                    targetMode: 'edit-url',
                  },
                });
              }
            }}

            >
              <span className="pane-pill-url">{tab.url}</span>
            </button>
            {panes.length > 1 && (
              <button
                className="tab-mini-btn"
                title="Close split pane"
                aria-label="Close split pane"
                onClick={(e) => {
                  e.stopPropagation();
                  dispatch({ type: 'close-split-pane', paneIndex: idx });
                }}
              >
                <X size={12} />
              </button>
            )}
          </div>
        ))}
      </div>

      {panes.length === 2 && (
        <div className="split-ratio-pill" title="Adjust Split Ratio">
          <input
            type="range"
            min={22}
            max={78}
            aria-label="Adjust Split Ratio"
            value={Math.round((split.splitRatio || 0.5) * 100)}
            style={{ width: 52 }}
            onChange={(e) =>
              dispatch({ type: 'set-split-ratio', ratio: Number(e.target.value) / 100 })
            }
          />
          <span style={{ fontSize: 10.5, color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>
            {Math.round((split.splitRatio || 0.5) * 100)}/{100 - Math.round((split.splitRatio || 0.5) * 100)}
          </span>
        </div>
      )}

      {focusedTab && state.readerTabIds.includes(focusedTab.id) && (
        <div className="split-ratio-pill" aria-label="Reader Mode Controls">
          <button
            className="tab-mini-btn"
            title="Decrease font size"
            aria-label="Decrease reader font size"
            onClick={() =>
              dispatch({
                type: 'set-reader-options',
                options: { fontSize: Math.max(12, state.readerOptions.fontSize - 1) },
              })
            }
          >
            A-
          </button>
          <span style={{ fontSize: 10.5, color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums' }}>
            {state.readerOptions.fontSize}px
          </span>
          <button
            className="tab-mini-btn"
            title="Increase font size"
            aria-label="Increase reader font size"
            onClick={() =>
              dispatch({
                type: 'set-reader-options',
                options: { fontSize: Math.min(28, state.readerOptions.fontSize + 1) },
              })
            }
          >
            A+
          </button>
          {(['light', 'sepia', 'dark'] as ReaderTheme[]).map((rt) => (
            <button
              key={rt}
              className="tab-mini-btn"
              title={`Reader ${rt} theme`}
              aria-label={`Reader ${rt} theme`}
              style={{
                background:
                  state.readerOptions.theme === rt ? 'var(--accent-soft)' : 'transparent',
                color:
                  state.readerOptions.theme === rt ? 'var(--accent)' : 'var(--text-muted)',
                fontSize: 10,
                padding: '0 4px',
                width: 'auto',
              }}
              onClick={() => dispatch({ type: 'set-reader-options', options: { theme: rt } })}
            >
              {rt.charAt(0).toUpperCase()}
            </button>
          ))}
        </div>
      )}

      {focusedTab && (focusedTab.zoomFactor ?? 1) !== 1 && (
        <button
          className="shield-pill"
          title="Reset Page Zoom (⌘0)"
          onClick={() => dispatch({ type: 'set-zoom', delta: 'reset', tabId: focusedTab.id })}
        >
          {Math.round((focusedTab.zoomFactor ?? 1) * 100)}%
        </button>
      )}

      <button
        className={`icon-btn ${focusedTab && state.readerTabIds.includes(focusedTab.id) ? 'active' : ''}`}
        title="Toggle Reader Mode (⌥⌘R)"
        aria-label="Toggle Reader Mode"
        onClick={() => dispatch({ type: 'toggle-reader-mode', tabId: focusedTab?.id })}
      >
        <BookOpen size={14} />
      </button>

      <button
        className="icon-btn"
        title="Print Page (⌘P)"
        aria-label="Print Page"
        onClick={() => dispatch({ type: 'print-page' })}
      >
        <Printer size={14} />
      </button>

      <button
        className="icon-btn"
        title="Copy Clean URL (⌘⇧C)"
        aria-label="Copy Clean URL"
        onClick={() => dispatch({ type: 'copy-current-url' })}
      >
        <Copy size={14} />
      </button>

      <button
        className={`icon-btn ${panes.length > 1 ? 'active' : ''}`}
        title="Toggle Split View (⌘⇧\)"
        aria-label="Toggle Split View"
        onClick={() => dispatch({ type: 'toggle-split' })}
      >
        <SplitSquareHorizontal size={14} />
      </button>

      <button
        className="icon-btn"
        title="Little Kinex (⌥⌘N)"
        aria-label="Little Kinex"
        onClick={() =>
          dispatch({
            type: 'open-url',
            url: focusedTab?.url || 'kinex://newtab',
            target: 'little-kinex',
          })
        }
      >
        <PictureInPicture2 size={14} />
      </button>

      <button
        className="icon-btn"
        title="Kinex Shields (⌘⇧K)"
        aria-label="Open Kinex Shields"
        onClick={() => dispatch({ type: 'set-overlay', overlay: { mode: 'shields' } })}
      >
        {focusedEffectiveShields.mode === 'disabled' ? (
          <ShieldOff size={14} style={{ opacity: 0.55 }} />
        ) : focusedEffectiveShields.mode === 'aggressive' ? (
          <ShieldAlert size={14} style={{ color: 'var(--warning)' }} />
        ) : (
          <Shield size={14} />
        )}
        {focusedBlockedCount > 0 && (
          <span className="toolbar-shield-badge">{focusedBlockedCount}</span>
        )}
      </button>

      <button
        className="icon-btn"
        title="Boosts Studio (⌘⇧B)"
        aria-label="Boosts Studio"
        onClick={() =>
          dispatch({
            type: 'set-overlay',
            overlay: { mode: 'boosts', domain: extractHostname(focusedTab?.url ?? '') || '*' },
          })
        }
      >
        <Sparkles size={14} />
      </button>

      {activeExtensions.map((extension) => (
        <button
          key={extension.id}
          className="icon-btn extension-action-btn"
          data-extension-id={extension.id}
          title={`${extension.name}${extension.error ? ` — ${extension.error}` : ''}`}
          aria-label={`Open ${extension.name} popup`}
          disabled={!extension.loaded}
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            dispatch({
              type: 'open-extension-popup',
              extensionId: extension.id,
              anchor: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            });
          }}
        >
          {extension.iconDataUrl ? (
            <img className="extension-action-icon" src={extension.iconDataUrl} alt="" />
          ) : (
            <Puzzle size={14} />
          )}
        </button>
      ))}
    </div>
  );
};
