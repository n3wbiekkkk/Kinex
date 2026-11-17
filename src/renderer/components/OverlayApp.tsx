import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Archive,
  ChevronDown,
  ChevronUp,
  Download,
  ExternalLink,
  FolderOpen,
  Lock,
  Pause,
  Play,
  RotateCcw,
  Shield,
  ShieldCheck,
  Sparkles,
  Trash2,
  Volume2,
  VolumeX,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { extractHostname, getFocusedTab } from '../../shared/domain';
import type { FindInPageStatus, KinexIntent, KinexStateSnapshot } from '../../shared/types';
import { BoostPanel } from './BoostPanel';
import { CommandBar } from './CommandBar';
import { SettingsView } from './SettingsView';
import { ShieldsPanel } from './ShieldsPanel';
import { SpaceEditor } from './SpaceEditor';
import { useModalFocus } from '../focus';

interface OverlayAppProps {
  state: KinexStateSnapshot;
  dispatch: (intent: KinexIntent) => void;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatEta(seconds?: number): string {
  if (!seconds || !Number.isFinite(seconds) || seconds <= 0) return '';
  if (seconds < 60) return `${seconds}s left`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s left`;
}

const FindBar: React.FC<{
  dispatch: (intent: KinexIntent) => void;
  findStatus: FindInPageStatus | null;
  focusedTabId?: string;
}> = ({ dispatch, findStatus, focusedTabId }) => {
  const [text, setText] = useState('');
  const ref = useRef<HTMLInputElement>(null);


  const search = (forward: boolean, findNext: boolean) => {
    dispatch({ type: 'find-in-page', text, forward, findNext });
  };

  const activeCount =
    text && findStatus && findStatus.tabId === focusedTabId
      ? `${findStatus.activeMatchOrdinal}/${findStatus.matches}`
      : null;

  return (
    <div className="find-bar" role="dialog" aria-modal="true" aria-label="Find in Page" onClick={(e) => e.stopPropagation()}>
      <input
        ref={ref}
        data-initial-focus
        className="text-input"
        style={{ width: 200 }}
        placeholder="Find in page..."
        aria-label="Find in page"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          dispatch({ type: 'find-in-page', text: e.target.value, forward: true, findNext: true });
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            search(!e.shiftKey, true);
          }
        }}
      />
      {activeCount && (
        <span className="find-count" aria-live="polite">
          {activeCount}
        </span>
      )}
      <button className="icon-btn" title="Previous Match" aria-label="Previous Match" onClick={() => search(false, true)}>
        <ChevronUp size={15} />
      </button>
      <button className="icon-btn" title="Next Match" aria-label="Next Match" onClick={() => search(true, true)}>
        <ChevronDown size={15} />
      </button>
      <button className="icon-btn" title="Close Find" aria-label="Close Find" onClick={() => dispatch({ type: 'stop-find-in-page' })}>
        <X size={15} />
      </button>
    </div>
  );
};

export const OverlayApp: React.FC<OverlayAppProps> = ({ state, dispatch }) => {
  const open = state.overlay.mode !== 'none' || Boolean(state.duplicatePrompt);
  const retained = useRef(state);
  const [present, setPresent] = useState(open);
  if (open) retained.current = state;
  useLayoutEffect(() => {
    if (open) {
      setPresent(true);
      return;
    }
    const delay = window.matchMedia('(prefers-reduced-motion: reduce)').matches || state.reducedEffects ? 0 : 140;
    const timer = window.setTimeout(() => setPresent(false), delay);
    return () => window.clearTimeout(timer);
  }, [open]);
  if (!open && !present) return null;
  return <OverlayContent state={open ? state : retained.current} dispatch={dispatch} active={open} />;
};

const OverlayContent: React.FC<OverlayAppProps & { active: boolean }> = ({ state, dispatch, active }) => {
  const { overlay, duplicatePrompt } = state;
  const modalRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => {
    if (duplicatePrompt && overlay.mode === 'none') {
      dispatch({ type: 'resolve-duplicate-open', decision: 'cancel' });
    } else if (overlay.mode === 'find') {
      dispatch({ type: 'stop-find-in-page' });
    } else {
      dispatch({ type: 'set-overlay', overlay: { mode: 'none' } });
    }
  }, [dispatch, Boolean(duplicatePrompt), overlay.mode]);
  useModalFocus(modalRef, duplicatePrompt && overlay.mode === 'none' ? 'duplicate' : overlay.mode, active, close);

  const activeSpace = state.spaces.find((s) => s.id === state.activeSpaceId) ?? state.spaces[0];
  const themeClass = activeSpace?.theme.isDark === false ? 'theme-light' : 'theme-dark';
  const focusedTab = getFocusedTab(state);
  let focusedOrigin = '';
  try {
    focusedOrigin = focusedTab ? new URL(focusedTab.url).origin : '';
  } catch {
    focusedOrigin = '';
  }
  const sitePerms = state.sitePermissions.filter((p) => p.origin === focusedOrigin && p.partition === state.spaces.find((space) => space.id === state.activeSpaceId)?.profilePartition);

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

  if (overlay.mode === 'none' && duplicatePrompt) {
    const dupSpace = state.spaces.find((s) => s.id === duplicatePrompt.existingSpaceId);
    return (
      <div
        ref={modalRef}
        tabIndex={-1}
        data-low-power={state.reducedEffects || undefined}
        data-closing={!active || undefined}
        inert={!active}
        aria-hidden={!active || undefined}
        className={`overlay-backdrop ${themeClass}`}
        onClick={() => dispatch({ type: 'resolve-duplicate-open', decision: 'cancel' })}
      >
        <div
          className="modal-card"
          role="dialog"
          aria-modal="true"
          aria-label="Tab Already Open"
          style={{ maxWidth: 460 }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="modal-header">
            <span style={{ fontWeight: 600 }}>Tab Already Open</span>
            <button
              className="icon-btn"
              aria-label="Cancel"
              onClick={() => dispatch({ type: 'resolve-duplicate-open', decision: 'cancel' })}
            >
              <X size={16} />
            </button>
          </div>
          <div className="modal-body">
            <div style={{ fontSize: 13.5, fontWeight: 550 }}>{duplicatePrompt.existingTabTitle}</div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', wordBreak: 'break-all' }}>
              {duplicatePrompt.url}
              {dupSpace ? ` · ${dupSpace.icon} ${dupSpace.name}` : ''}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
              <button
                className="btn-secondary"
                onClick={() => dispatch({ type: 'resolve-duplicate-open', decision: 'open-anyway' })}
              >
                Open New Tab Anyway
              </button>
              <button
                className="btn-primary"
                onClick={() => dispatch({ type: 'resolve-duplicate-open', decision: 'switch-existing' })}
              >
                Switch to Existing Tab
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const closedGroupIdsSeen = new Set<string>();
  const finishedDownloadsCount = state.downloads.filter((d) => d.state !== 'progressing').length;

  return (
    <div
      ref={modalRef}
      tabIndex={-1}
      data-low-power={state.reducedEffects || undefined}
      data-closing={!active || undefined}
      inert={!active}
      aria-hidden={!active || undefined}
      className={`overlay-backdrop ${themeClass} ${overlay.mode === 'find' ? 'find-mode' : ''} ${overlay.mode === 'settings' ? 'settings-mode' : ''}`}
      onClick={() => {
        if (overlay.mode === 'find') dispatch({ type: 'stop-find-in-page' });
        else dispatch({ type: 'set-overlay', overlay: { mode: 'none' } });
      }}
    >
      {overlay.mode === 'command-bar' && (
        <CommandBar
          active={active}
          state={state}
          initialQuery={overlay.initialQuery}
          targetMode={overlay.targetMode}
          dispatch={dispatch}
        />
      )}

      {overlay.mode === 'boosts' && (
        <BoostPanel key={overlay.domain} state={state} initialDomain={overlay.domain} dispatch={dispatch} />
      )}

      {overlay.mode === 'space-editor' && (
        <SpaceEditor key={overlay.spaceId ?? 'new'} state={state} spaceId={overlay.spaceId} dispatch={dispatch} />
      )}

      {overlay.mode === 'find' && (
        <FindBar
          dispatch={dispatch}
          findStatus={state.findStatus}
          focusedTabId={focusedTab?.id}
        />
      )}

      {overlay.mode === 'settings' && (
        <SettingsView state={state} initialSection={overlay.section} dispatch={dispatch} />
      )}

      {overlay.mode === 'shields' && (
        <ShieldsPanel state={state} focusedTab={focusedTab} dispatch={dispatch} onClose={close} />
      )}

      {overlay.mode === 'history' && (
        <div className="modal-card" role="dialog" aria-modal="true" aria-label="Browsing History" onClick={(event) => event.stopPropagation()}>
          <div className="modal-header">
            <span style={{ fontWeight: 600 }}>History</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button className="btn-secondary" onClick={() => dispatch({ type: 'set-overlay', overlay: { mode: 'settings', section: 'privacy' } })}>Clear History…</button>
              <button className="icon-btn" aria-label="Close History" onClick={close}><X size={16} /></button>
            </div>
          </div>
          <div className="modal-body" style={{ overflowY: 'auto', maxHeight: '65vh' }}>
            {state.history.length === 0 ? (
              <div className="empty-state"><div className="empty-state-title">No browsing history</div><div className="empty-state-sub">Pages you visit will appear here.</div></div>
            ) : (
              <ul style={{ listStyle: 'none', margin: 0, padding: 0 }} aria-label="Visited pages">
                {[...state.history].sort((a, b) => b.visitedAt - a.visitedAt).map((entry) => (
                  <li key={entry.url}>
                    <button className="command-item" onClick={() => dispatch({ type: 'open-url', url: entry.url, target: 'new-tab' })}>
                      <ExternalLink size={14} aria-hidden="true" />
                      <span className="command-item-text"><span className="command-item-title" style={{ display: 'block' }}>{entry.title || entry.url}</span><span className="command-item-sub" style={{ display: 'block' }}>{entry.url}</span></span>
                      <span style={{ fontSize: 11, color: 'var(--text-muted)', flexShrink: 0 }}>{new Date(entry.visitedAt).toLocaleDateString()}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {overlay.mode === 'site-info' && focusedTab && (
        <div className="modal-card" role="dialog" aria-modal="true" aria-label="Site controls" style={{ maxWidth: 440 }} onClick={(e) => e.stopPropagation()}>
          <div className="modal-header">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600 }}>
              {focusedTab.securityState === 'cert-warning' || focusedTab.securityState === 'insecure' ? (
                <AlertTriangle size={15} style={{ color: 'var(--warning)' }} />
              ) : focusedTab.securityState === 'secure' ? (
                <ShieldCheck size={15} style={{ color: 'var(--success)' }} />
              ) : (
                <Lock size={15} />
              )}
              <span>{extractHostname(focusedTab.url) || focusedTab.url}</span>
            </div>
            <button
              className="icon-btn"
              aria-label="Close Site Control Center"
              onClick={() => dispatch({ type: 'set-overlay', overlay: { mode: 'none' } })}
            >
              <X size={16} />
            </button>
          </div>
          <div className="modal-body">
            <div style={{ fontSize: 12.5, fontWeight: 500 }}>{securityLabel()}</div>
            <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', wordBreak: 'break-all' }}>{focusedTab.url}</div>

            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button className="btn-secondary" onClick={() => dispatch({ type: 'set-overlay', overlay: { mode: 'shields' } })}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <Shield size={13} /> Kinex Shields ({state.shieldsRuntime.tabStats[focusedTab.id]?.total ?? 0})
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
              <span style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>Page Zoom</span>
              <button className="btn-secondary" aria-label="Zoom out" onClick={() => dispatch({ type: 'set-zoom', delta: 'out' })}>
                <ZoomOut size={14} />
              </button>
              <button className="btn-secondary" aria-label="Reset zoom" onClick={() => dispatch({ type: 'set-zoom', delta: 'reset' })}>
                {Math.round((focusedTab.zoomFactor ?? 1) * 100)}%
              </button>
              <button className="btn-secondary" aria-label="Zoom in" onClick={() => dispatch({ type: 'set-zoom', delta: 'in' })}>
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
                          partition: p.partition,
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
        <div className="modal-card" role="dialog" aria-modal="true" aria-label="Tab history and archive" onClick={(e) => e.stopPropagation()}>
          <div className="modal-header">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600 }}>
              <Archive size={16} />
              <span>Closed &amp; Archived Tabs</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              {state.closedTabs.length > 0 && (
                <button
                  className="btn-secondary"
                  style={{ fontSize: 11.5, padding: '4px 9px' }}
                  onClick={() => dispatch({ type: 'clear-closed-tabs' })}
                >
                  Clear Closed
                </button>
              )}
              <button
                className="icon-btn"
                aria-label="Close"
                onClick={() => dispatch({ type: 'set-overlay', overlay: { mode: 'none' } })}
              >
                <X size={16} />
              </button>
            </div>
          </div>
          <div className="modal-body">
            {state.closedTabs.length > 0 && (
              <>
                <div className="field-label" style={{ marginBottom: 0 }}>Recently Closed (⌘⇧T)</div>
                {state.closedTabs.map((item) => {
                  const showGroupBanner =
                    item.groupId && !closedGroupIdsSeen.has(item.groupId);
                  if (item.groupId) closedGroupIdsSeen.add(item.groupId);
                  const groupCount = item.groupId
                    ? state.closedTabs.filter((x) => x.groupId === item.groupId).length
                    : 0;
                  return (
                    <React.Fragment key={item.id}>
                      {showGroupBanner && item.groupId && groupCount > 1 && (
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            padding: '6px 10px',
                            borderRadius: 8,
                            background: 'var(--accent-soft)',
                            border: '1px solid var(--accent-border)',
                            fontSize: 12,
                          }}
                        >
                          <span>Closed Tab Group ({groupCount} tabs)</span>
                          <button
                            className="btn-primary"
                            style={{ padding: '4px 10px', fontSize: 11.5 }}
                            onClick={() =>
                              dispatch({ type: 'restore-closed-group', groupId: item.groupId! })
                            }
                          >
                            Restore Group
                          </button>
                        </div>
                      )}
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: 10,
                          padding: '9px 11px',
                          borderRadius: 10,
                          background: 'var(--surface-card)',
                          border: '1px solid var(--border-hairline)',
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
                              color: 'var(--text-muted)',
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
                          onClick={() => dispatch({ type: 'reopen-closed-tab', closedId: item.id })}
                        >
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                            <RotateCcw size={12} /> Restore
                          </span>
                        </button>
                      </div>
                    </React.Fragment>
                  );
                })}
              </>
            )}

            {state.archivedTabs.length > 0 && (
              <div className="field-label" style={{ marginBottom: 0, marginTop: state.closedTabs.length > 0 ? 4 : 0 }}>
                Archived Today Tabs
              </div>
            )}

            {state.archivedTabs.length === 0 && state.closedTabs.length === 0 ? (
              <div className="empty-state">
                <Archive size={22} style={{ opacity: 0.65 }} />
                <div className="empty-state-title">No Closed or Archived Tabs</div>
                <div className="empty-state-sub">
                  Recently closed and cleared Today tabs stay recoverable here.
                </div>
              </div>
            ) : (
              state.archivedTabs.map((item) => (
                <div
                  key={item.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 10,
                    padding: '9px 11px',
                    borderRadius: 10,
                    background: 'var(--surface-card)',
                    border: '1px solid var(--border-hairline)',
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
                        color: 'var(--text-muted)',
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
        <div className="modal-card" role="dialog" aria-modal="true" aria-label="Downloads" onClick={(e) => e.stopPropagation()}>
          <div className="modal-header">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600 }}>
              <Download size={16} />
              <span>Downloads</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              {finishedDownloadsCount > 0 && (
                <button
                  className="btn-secondary"
                  style={{ fontSize: 11.5, padding: '4px 9px', display: 'inline-flex', alignItems: 'center', gap: 4 }}
                  onClick={() => dispatch({ type: 'clear-completed-downloads' })}
                >
                  <Trash2 size={11} /> Clear Finished
                </button>
              )}
              <button
                className="icon-btn"
                aria-label="Close Downloads"
                onClick={() => dispatch({ type: 'set-overlay', overlay: { mode: 'none' } })}
              >
                <X size={16} />
              </button>
            </div>
          </div>
          <div className="modal-body">
            {state.downloads.length === 0 ? (
              <div className="empty-state">
                <Download size={22} style={{ opacity: 0.65 }} />
                <div className="empty-state-title">No Recent Downloads</div>
                <div className="empty-state-sub">
                  Files downloaded during this browsing session will appear here with speed, progress, and Finder controls.
                </div>
              </div>
            ) : (
              state.downloads.map((dl) => {
                const pct =
                  dl.totalBytes > 0
                    ? Math.min(100, Math.round((dl.receivedBytes / dl.totalBytes) * 100))
                    : 0;
                const statusParts = [
                  dl.isPaused ? 'Paused' : dl.state,
                  dl.totalBytes > 0
                    ? `${formatBytes(dl.receivedBytes)} / ${formatBytes(dl.totalBytes)}`
                    : formatBytes(dl.receivedBytes),
                ];
                if (dl.state === 'progressing' && !dl.isPaused && dl.speedBytesPerSec) {
                  statusParts.push(`${formatBytes(dl.speedBytesPerSec)}/s`);
                }
                const etaStr = formatEta(dl.etaSeconds);
                if (dl.state === 'progressing' && !dl.isPaused && etaStr) {
                  statusParts.push(etaStr);
                }
                return (
                  <div
                    key={dl.id}
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 8,
                      padding: '10px 12px',
                      borderRadius: 10,
                      background: 'var(--surface-card)',
                      border: '1px solid var(--border-hairline)',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 550, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {dl.filename}
                        </div>
                        <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums' }}>
                          {statusParts.join(' · ')}
                        </div>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                        {dl.state === 'progressing' && !dl.isPaused && (
                          <button
                            className="icon-btn"
                            title="Pause Download"
                            aria-label="Pause Download"
                            onClick={() => dispatch({ type: 'pause-download', downloadId: dl.id })}
                          >
                            <Pause size={13} />
                          </button>
                        )}
                        {(dl.isPaused || dl.state === 'interrupted') && dl.canResume && (
                          <button
                            className="icon-btn"
                            title="Resume Download"
                            aria-label="Resume Download"
                            onClick={() => dispatch({ type: 'resume-download', downloadId: dl.id })}
                          >
                            <Play size={13} />
                          </button>
                        )}
                        {dl.state === 'progressing' && (
                          <button
                            className="icon-btn"
                            title="Cancel Download"
                            aria-label="Cancel Download"
                            onClick={() => dispatch({ type: 'cancel-download', downloadId: dl.id })}
                          >
                            <X size={13} />
                          </button>
                        )}
                        {dl.state === 'completed' && (
                          <button
                            className="btn-secondary"
                            onClick={() => dispatch({ type: 'open-download', downloadId: dl.id })}
                          >
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                              <ExternalLink size={12} /> Open
                            </span>
                          </button>
                        )}
                        {dl.savePath && dl.state !== 'cancelled' && (
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
                    </div>
                    {dl.state === 'progressing' && dl.totalBytes > 0 && (
                      <div className="dl-progress-track">
                        <div className="dl-progress-fill" style={{ width: `${pct}%` }} />
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
};
