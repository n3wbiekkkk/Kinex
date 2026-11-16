import React, { useCallback, useEffect, useState } from 'react';
import { getActiveSplit } from '../shared/domain';
import type { NookIntent, NookStateSnapshot } from '../shared/types';
import { LittleNookApp } from './components/LittleNookApp';
import { OverlayApp } from './components/OverlayApp';
import { Sidebar } from './components/Sidebar';
import { TopControls } from './components/TopControls';

export const App: React.FC = () => {
  const viewMode = new URLSearchParams(window.location.search).get('view') || 'shell';
  const [state, setState] = useState<NookStateSnapshot | null>(null);

  useEffect(() => {
    if (viewMode === 'little') return;
    void window.nookAPI.getState().then(setState);
    return window.nookAPI.onStateUpdated(setState);
  }, [viewMode]);

  const dispatch = useCallback((intent: NookIntent) => {
    void window.nookAPI.dispatch(intent);
  }, []);

  if (viewMode === 'little') {
    return <LittleNookApp />;
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
  const showTopBar = !state.sidebarOpen || split.tabIds.length > 1;

  return (
    <div
      className={`nook-shell ${themeClass}`}
      style={{
        backgroundColor: activeSpace.theme.tintRgba,
      }}
    >
      {state.sidebarOpen && <Sidebar state={state} dispatch={dispatch} />}
      <div className="main-area">
        {showTopBar && <TopControls state={state} dispatch={dispatch} />}
      </div>
      {state.toastMessage && <div className="toast">{state.toastMessage}</div>}
    </div>
  );
};
