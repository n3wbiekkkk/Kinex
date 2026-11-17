import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { getActiveSplit } from '../shared/domain';
import type { KinexIntent, KinexStateSnapshot } from '../shared/types';
import { LittleKinexApp } from './components/LittleKinexApp';
import { OverlayApp } from './components/OverlayApp';
import { Sidebar } from './components/Sidebar';
import { TopControls } from './components/TopControls';

export const App: React.FC = () => {
  const viewMode = new URLSearchParams(window.location.search).get('view') || 'shell';
  const [state, setState] = useState<KinexStateSnapshot | null>(null);
  const lastFocused = useRef<HTMLElement | null>(null);
  const splitResizeFrame = useRef<number | null>(null);
  const pendingSplitRatio = useRef<number | null>(null);
  useEffect(() => () => {
    if (splitResizeFrame.current !== null) cancelAnimationFrame(splitResizeFrame.current);
  }, []);
  const [focusRequest, setFocusRequest] = useState<{ region: string; sequence: number } | null>(null);

  useEffect(() => {
    if (viewMode !== 'shell') return;
    return window.kinexAPI.onFocusRequested((region) => {
      setFocusRequest((previous) => ({ region, sequence: (previous?.sequence ?? 0) + 1 }));
    });
  }, [viewMode]);

  useLayoutEffect(() => {
    if (!focusRequest || !state || viewMode !== 'shell') return;
    const { region } = focusRequest;
    if (region === 'content') return;
    const previous = lastFocused.current;
    const target = region === 'restore' && previous?.isConnected
      ? previous
      : region === 'toolbar'
        ? document.querySelector<HTMLElement>('.top-controls button:not(:disabled)') ?? document.querySelector<HTMLElement>('.sidebar-drag-top button:not(:disabled)')
        : document.querySelector<HTMLElement>('[data-sidebar-item][aria-current="true"]') ?? document.querySelector<HTMLElement>('[data-sidebar-item][tabindex="0"]') ?? document.querySelector<HTMLElement>('.sidebar button');
    if (target) {
      target.focus({ preventScroll: true });
      setFocusRequest(null);
    }
  }, [focusRequest, state?.sidebarOpen, viewMode]);

  useEffect(() => {
    if (viewMode === 'little' || viewMode === 'private') return;
    void window.kinexAPI.getState().then(setState);
    return window.kinexAPI.onStateUpdated(setState);
  }, [viewMode]);

  const dispatch = useCallback((intent: KinexIntent) => {
    void window.kinexAPI.dispatch(intent);
  }, []);

  if (viewMode === 'little' || viewMode === 'private') {
    return <LittleKinexApp isPrivateMode={viewMode === 'private'} />;
  }

  if (!state) {
    return null;
  }

  if (viewMode === 'overlay') {
    return <OverlayApp state={state} dispatch={dispatch} />;
  }

  const activeSpace = state.spaces.find((s) => s.id === state.activeSpaceId) ?? state.spaces[0];
  const themeClass = activeSpace.theme.isDark ? 'theme-dark' : 'theme-light';
  const split = getActiveSplit(state);
  const focusedId = split.tabIds[split.focusedIndex] ?? split.tabIds[0];
  const focusedTab = state.tabs.find((t) => t.id === focusedId);
  const isReaderActive = Boolean(focusedId && state.readerTabIds.includes(focusedId));
  const hasCustomZoom = Boolean(focusedTab && (focusedTab.zoomFactor ?? 1) !== 1);
  const showTopBar = !state.sidebarOpen || split.tabIds.length > 1 || isReaderActive || hasCustomZoom;

  return (
    <div
      className={`kinex-shell ${themeClass}`}
      data-low-power={state.reducedEffects || undefined}
      onFocusCapture={(event) => {
        if (event.target instanceof HTMLElement) lastFocused.current = event.target;
      }}
      style={{
        backgroundColor: activeSpace.theme.tintRgba,
      }}
    >
      {state.sidebarOpen && <Sidebar state={state} dispatch={dispatch} />}
      {state.sidebarOpen && state.sidebarCollapsed && state.hoverPeek && (
        <div
          className="sidebar-peek-rail"
          role="button"
          tabIndex={0}
          aria-label="Peek at sidebar"
          onMouseEnter={() => dispatch({ type: 'set-sidebar-peeking', peeking: true })}
          onMouseLeave={() => dispatch({ type: 'set-sidebar-peeking', peeking: false })}
          onFocus={() => dispatch({ type: 'set-sidebar-peeking', peeking: true })}
          onBlur={() => dispatch({ type: 'set-sidebar-peeking', peeking: false })}
          onClick={() => dispatch({ type: 'toggle-sidebar-collapse', collapsed: false })}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              dispatch({ type: 'toggle-sidebar-collapse', collapsed: false });
            }
          }}
        />
      )}
      <div className="main-area">
        {showTopBar && <TopControls state={state} dispatch={dispatch} />}
        {split.tabIds.length > 1 && (
          <div
            className="split-divider-track"
            role="separator"
            tabIndex={0}
            aria-label="Resize Split View"
            aria-orientation="vertical"
            aria-valuemin={22}
            aria-valuemax={78}
            aria-valuenow={Math.round((split.splitRatio || 0.5) * 100)}
            aria-valuetext={`${Math.round((split.splitRatio || 0.5) * 100)} percent left pane`}
            style={{ left: `calc(${(split.splitRatio || 0.5) * 100}% + ${(state.sidebarOpen ? 4 : 14) - (state.sidebarOpen ? 18 : 28) * (split.splitRatio || 0.5)}px)` }}
            onKeyDown={(event) => {
              const ratio = split.splitRatio || 0.5;
              const step = event.shiftKey ? 0.1 : 0.02;
              const next = event.key === 'ArrowLeft' ? ratio - step
                : event.key === 'ArrowRight' ? ratio + step
                  : event.key === 'Home' ? 0.22
                    : event.key === 'End' ? 0.78 : undefined;
              if (next === undefined) return;
              event.preventDefault();
              dispatch({ type: 'set-split-ratio', ratio: Math.max(0.22, Math.min(0.78, next)) });
            }}
            onPointerDown={(event) => {
              event.preventDefault();
              event.currentTarget.focus();
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
              if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
              const bounds = event.currentTarget.parentElement?.getBoundingClientRect();
              if (bounds) {
                const offset = state.sidebarOpen ? 4 : 14;
                const availableWidth = bounds.width - (state.sidebarOpen ? 18 : 28);
                pendingSplitRatio.current = Math.max(0.22, Math.min(0.78, (event.clientX - bounds.left - offset) / availableWidth));
                if (splitResizeFrame.current === null) {
                  splitResizeFrame.current = requestAnimationFrame(() => {
                    splitResizeFrame.current = null;
                    if (pendingSplitRatio.current !== null) dispatch({ type: 'set-split-ratio', ratio: pendingSplitRatio.current });
                  });
                }
              }
            }}
            onPointerUp={(event) => {
              if (splitResizeFrame.current !== null) {
                cancelAnimationFrame(splitResizeFrame.current);
                splitResizeFrame.current = null;
              }
              if (pendingSplitRatio.current !== null) {
                dispatch({ type: 'set-split-ratio', ratio: pendingSplitRatio.current });
                pendingSplitRatio.current = null;
              }
              if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
            }}
          >
            <div className="split-divider-line" />
          </div>
        )}
      </div>
      {state.toastMessage && <div className="toast" role="status">{state.toastMessage}</div>}
    </div>
  );
};
