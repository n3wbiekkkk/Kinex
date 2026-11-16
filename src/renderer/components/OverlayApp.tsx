import React, { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Archive,
  ChevronDown,
  ChevronUp,
  Download,
  FolderOpen,
  Lock,
  RotateCcw,
  Shield,
  ShieldCheck,
  Sparkles,
  Volume2,
  VolumeX,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { extractHostname, getFocusedTab } from '../../shared/domain';
import type { NookIntent, NookStateSnapshot } from '../../shared/types';
import { BoostPanel } from './BoostPanel';
import { CommandBar } from './CommandBar';
import { SettingsView } from './SettingsView';
import { SpaceEditor } from './SpaceEditor';

interface OverlayAppProps {
  state: NookStateSnapshot;
  dispatch: (intent: NookIntent) => void;
}

const FindBar: React.FC<{ dispatch: (intent: NookIntent) => void }> = ({ dispatch }) => {
  const [text, setText] = useState('');
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setTimeout(() => ref.current?.focus(), 10);
  }, []);

  const search = (forward: boolean, findNext: boolean) => {
    dispatch({ type: 'find-in-page', text, forward, findNext });
  };

  return (
    <div className="find-bar" onClick={(e) => e.stopPropagation()}>
      <input
        ref={ref}
        className="text-input"
        style={{ width: 220 }}
        placeholder="Find in page..."
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          dispatch({ type: 'find-in-page', text: e.target.value, forward: true, findNext: false });
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            dispatch({ type: 'stop-find-in-page' });
          } else if (e.key === 'Enter') {
            search(!e.shiftKey, true);
          }
        }}
      />
      <button className="icon-btn" title="Previous" onClick={() => search(false, true)}>
        <ChevronUp size={15} />
      </button>
      <button className="icon-btn" title="Next" onClick={() => search(true, true)}>
        <ChevronDown size={15} />
      </button>
      <button className="icon-btn" title="Close" onClick={() => dispatch({ type: 'stop-find-in-page' })}>
        <X size={15} />
      </button>
    </div>
  );
};

export const OverlayApp: React.FC<OverlayAppProps> = ({ state, dispatch }) => {
  const { overlay } = state;
  if (overlay.mode === 'none') return null;

  const focusedTab = getFocusedTab(state);
  let focusedOrigin = '';
  try {
    focusedOrigin = focusedTab ? new URL(focusedTab.url).origin : '';
  } catch {
    focusedOrigin = '';
  }
  const sitePerms = state.sitePermissions.filter((p) => p.origin === focusedOrigin);

  const securityLabel = () => {
    switch (focusedTab?.securityState) {
      case 'secure':
        return 'Connection is secure (HTTPS)';
      case 'cert-warning':
        return 'Certificate warning on this site';
      case 'insecure':
        return 'Not secure (unencrypted HTTP)';
      default:
        return 'Kinex internal page';
    }
  };

  return (
    <div
      className={`overlay-backdrop ${overlay.mode === 'find' ? 'find-mode' : ''} ${overlay.mode === 'settings' ? 'settings-mode' : ''}`}
      onClick={() => {
        if (overlay.mode === 'find') dispatch({ type: 'stop-find-in-page' });
        else dispatch({ type: 'set-overlay', overlay: { mode: 'none' } });
      }}
    >
      {overlay.mode === 'command-bar' && (
        <CommandBar
          state={state}
          initialQuery={overlay.initialQuery}
          targetMode={overlay.targetMode}
          dispatch={dispatch}
        />
      )}

      {overlay.mode === 'boosts' && (
        <BoostPanel state={state} initialDomain={overlay.domain} dispatch={dispatch} />
      )}

      {overlay.mode === 'space-editor' && (
        <SpaceEditor state={state} spaceId={overlay.spaceId} dispatch={dispatch} />
      )}

      {overlay.mode === 'find' && <FindBar dispatch={dispatch} />}

      {overlay.mode === 'settings' && (
        <SettingsView state={state} initialSection={overlay.section} dispatch={dispatch} />
      )}

      {overlay.mode === 'site-info' && focusedTab && (
        <div className="modal-card" style={{ maxWidth: 440 }} onClick={(e) => e.stopPropagation()}>
          <div className="modal-header">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600 }}>
              {focusedTab.securityState === 'cert-warning' || focusedTab.securityState === 'insecure' ? (
                <AlertTriangle size={15} style={{ color: '#f59e0b' }} />
              ) : focusedTab.securityState === 'secure' ? (
                <ShieldCheck size={15} style={{ color: '#34d399' }} />
              ) : (
                <Lock size={15} />
              )}
              <span>{extractHostname(focusedTab.url) || focusedTab.url}</span>
            </div>
            <button
              className="icon-btn"
              onClick={() => dispatch({ type: 'set-overlay', overlay: { mode: 'none' } })}
            >
              <X size={16} />
            </button>
          </div>
          <div className="modal-body">
            <div style={{ fontSize: 12.5, fontWeight: 500 }}>{securityLabel()}</div>
            <div style={{ fontSize: 11.5, opacity: 0.62, wordBreak: 'break-all' }}>{focusedTab.url}</div>

            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button className="btn-secondary" onClick={() => dispatch({ type: 'toggle-adblock' })}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <Shield size={13} /> Shields: {state.adBlockEnabled ? 'On' : 'Off'}
                </span>
              </button>
              <button
                className="btn-secondary"
                onClick={() => dispatch({ type: 'toggle-mute', tabId: focusedTab.id })}
              >
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  {focusedTab.isMuted ? <VolumeX size={13} /> : <Volume2 size={13} />}
                  {focusedTab.isMuted ? 'Unmute Tab' : 'Mute Tab'}
                </span>
              </button>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 12.5, opacity: 0.7 }}>Zoom</span>
              <button className="btn-secondary" onClick={() => dispatch({ type: 'set-zoom', delta: 'out' })}>
                <ZoomOut size={14} />
              </button>
              <button className="btn-secondary" onClick={() => dispatch({ type: 'set-zoom', delta: 'reset' })}>
                {Math.round((focusedTab.zoomFactor ?? 1) * 100)}%
              </button>
              <button className="btn-secondary" onClick={() => dispatch({ type: 'set-zoom', delta: 'in' })}>
                <ZoomIn size={14} />
              </button>
            </div>

            {sitePerms.length > 0 && (
              <div>
                <label className="field-label">Site Permissions</label>
                {sitePerms.map((p) => (
                  <div key={p.permission} className="settings-row" style={{ marginBottom: 4 }}>
                    <span style={{ fontSize: 12 }}>
                      {p.permission} ({p.decision})
                    </span>
                    <button
                      className="btn-secondary"
                      onClick={() =>
                        dispatch({
                          type: 'revoke-site-permission',
                          origin: p.origin,
                          permission: p.permission,
                        })
                      }
                    >
                      Reset
                    </button>
                  </div>
                ))}
              </div>
            )}

            <button
              className="btn-primary"
              onClick={() =>
                dispatch({
                  type: 'set-overlay',
                  overlay: { mode: 'boosts', domain: extractHostname(focusedTab.url) || '*' },
                })
              }
            >
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <Sparkles size={13} /> Customize Site with Boosts
              </span>
            </button>
          </div>
        </div>
      )}

      {overlay.mode === 'archive' && (
        <div className="modal-card" onClick={(e) => e.stopPropagation()}>
          <div className="modal-header">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600 }}>
              <Archive size={16} />
              <span>Archived Today Tabs</span>
            </div>
            <button
              className="icon-btn"
              onClick={() => dispatch({ type: 'set-overlay', overlay: { mode: 'none' } })}
            >
              <X size={16} />
            </button>
          </div>
          <div className="modal-body">
            {state.archivedTabs.length === 0 ? (
              <div style={{ fontSize: 13, opacity: 0.6 }}>No archived tabs yet.</div>
            ) : (
              state.archivedTabs.map((item) => (
                <div
                  key={item.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 10,
                    padding: '8px 10px',
                    borderRadius: 10,
                    background: 'rgba(255,255,255,0.05)',
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 13,
                        fontWeight: 500,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {item.title}
                    </div>
                    <div
                      style={{
                        fontSize: 11.5,
                        opacity: 0.55,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {item.url}
                    </div>
                  </div>
                  <button
                    className="btn-secondary"
                    onClick={() => dispatch({ type: 'restore-archived-tab', archivedId: item.id })}
                  >
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                      <RotateCcw size={12} /> Restore
                    </span>
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {overlay.mode === 'downloads' && (
        <div className="modal-card" onClick={(e) => e.stopPropagation()}>
          <div className="modal-header">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600 }}>
              <Download size={16} />
              <span>Downloads</span>
            </div>
            <button
              className="icon-btn"
              onClick={() => dispatch({ type: 'set-overlay', overlay: { mode: 'none' } })}
            >
              <X size={16} />
            </button>
          </div>
          <div className="modal-body">
            {state.downloads.length === 0 ? (
              <div style={{ fontSize: 13, opacity: 0.6 }}>No downloads in this session.</div>
            ) : (
              state.downloads.map((dl) => (
                <div
                  key={dl.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '8px 10px',
                    borderRadius: 10,
                    background: 'rgba(255,255,255,0.05)',
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 500 }}>{dl.filename}</div>
                    <div style={{ fontSize: 11.5, opacity: 0.55 }}>
                      {dl.state} · {Math.round(dl.receivedBytes / 1024)} KB
                    </div>
                  </div>
                  {dl.savePath && (
                    <button
                      className="btn-secondary"
                      onClick={() => dispatch({ type: 'show-download-in-finder', savePath: dl.savePath })}
                    >
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                        <FolderOpen size={12} /> Finder
                      </span>
                    </button>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
};
