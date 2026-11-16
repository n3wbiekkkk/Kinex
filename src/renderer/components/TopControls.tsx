import React from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Copy,
  Lock,
  PanelLeft,
  PictureInPicture2,
  RotateCw,
  SlidersHorizontal,
  Sparkles,
  SplitSquareHorizontal,
  X,
} from 'lucide-react';
import { extractHostname, getActiveSplit } from '../../shared/domain';
import type { NookIntent, NookStateSnapshot } from '../../shared/types';

interface TopControlsProps {
  state: NookStateSnapshot;
  dispatch: (intent: NookIntent) => void;
}

export const TopControls: React.FC<TopControlsProps> = ({ state, dispatch }) => {
  const split = getActiveSplit(state);
  const panes = split.tabIds
    .map((id) => state.tabs.find((t) => t.id === id))
    .filter((t): t is NonNullable<typeof t> => Boolean(t));
  const focusedTab = panes[split.focusedIndex] ?? panes[0];

  return (
    <div className={`top-controls ${state.sidebarOpen ? '' : 'sidebar-closed'}`}>
      {!state.sidebarOpen && (
        <>
          <button
            className="icon-btn"
            title="Show Sidebar (⌘S)"
            onClick={() => dispatch({ type: 'toggle-sidebar' })}
          >
            <PanelLeft size={15} />
          </button>

          <button
            className="icon-btn"
            title="Back (⌘[)"
            disabled={!focusedTab?.canGoBack}
            style={{ opacity: focusedTab?.canGoBack ? 1 : 0.35 }}
            onClick={() => dispatch({ type: 'nav-back' })}
          >
            <ArrowLeft size={15} />
          </button>

          <button
            className="icon-btn"
            title="Forward (⌘])"
            disabled={!focusedTab?.canGoForward}
            style={{ opacity: focusedTab?.canGoForward ? 1 : 0.35 }}
            onClick={() => dispatch({ type: 'nav-forward' })}
          >
            <ArrowRight size={15} />
          </button>

          <button
            className="icon-btn"
            title={focusedTab?.isLoading ? 'Stop' : 'Reload (⌘R)'}
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
            <button
              className="tab-mini-btn"
              title="Site Control Center"
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
            <span className="pane-pill-url">{tab.url}</span>
            {panes.length > 1 && (
              <button
                className="tab-mini-btn"
                title="Close split pane"
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
        <input
          type="range"
          min={25}
          max={75}
          value={Math.round((split.splitRatio || 0.5) * 100)}
          title="Adjust Split Ratio"
          style={{ width: 58, accentColor: '#7c8cff' }}
          onChange={(e) =>
            dispatch({ type: 'set-split-ratio', ratio: Number(e.target.value) / 100 })
          }
        />
      )}

      <button
        className="icon-btn"
        title="Copy Clean URL (⌘⇧C)"
        onClick={() => dispatch({ type: 'copy-current-url' })}
      >
        <Copy size={14} />
      </button>

      <button
        className={`icon-btn ${panes.length > 1 ? 'active' : ''}`}
        title="Toggle Split View (⌘⇧\)"
        onClick={() => dispatch({ type: 'toggle-split' })}
      >
        <SplitSquareHorizontal size={14} />
      </button>

      <button
        className="icon-btn"
        title="Little Kinex (⌥⌘N)"
        onClick={() =>
          dispatch({
            type: 'open-url',
            url: focusedTab?.url || 'kinex://newtab',
            target: 'little-nook',
          })
        }
      >
        <PictureInPicture2 size={14} />
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
    </div>
  );
};
