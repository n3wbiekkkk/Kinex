import React, { useState } from 'react';
import {
  AlertTriangle,
  Crosshair,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  ShieldOff,
  Sliders,
  Trash2,
  X,
} from 'lucide-react';
import {
  extractHostname,
  normalizeShieldsSiteKey,
  resolveEffectiveShieldsMode,
} from '../../shared/domain';
import type {
  KinexIntent,
  KinexStateSnapshot,
  ShieldsMode,
  TabItem,
} from '../../shared/types';

interface ShieldsPanelProps {
  state: KinexStateSnapshot;
  focusedTab: TabItem | undefined;
  dispatch: (intent: KinexIntent) => void;
  onClose: () => void;
}

export const ShieldsPanel: React.FC<ShieldsPanelProps> = ({
  state,
  focusedTab,
  dispatch,
  onClose,
}) => {
  const [showBlockedList, setShowBlockedList] = useState(false);

  const pageUrl = focusedTab?.url ?? '';
  const host = extractHostname(pageUrl);
  const siteKey = normalizeShieldsSiteKey(pageUrl);
  const effective = resolveEffectiveShieldsMode(state.shields, pageUrl, siteKey);
  const isInternal = effective.source === 'internal' || !siteKey;

  const tabStats = focusedTab ? state.shieldsRuntime.tabStats[focusedTab.id] : undefined;
  const blockedTotal = tabStats?.total ?? 0;
  const blockedAds = tabStats?.ads ?? 0;
  const blockedTrackers = tabStats?.trackers ?? 0;
  const blockedOther = tabStats?.other ?? 0;
  const recentBlocked = tabStats?.recentBlocked ?? [];
  const needsReload = Boolean(focusedTab && state.shieldsRuntime.needsReloadByTabId[focusedTab.id]);
  const hasExplicitOverride = Boolean(siteKey && siteKey in state.shields.siteOverrides);
  const customRules = siteKey ? state.shields.customCosmeticRules[siteKey] ?? [] : [];

  const renderShieldHeaderIcon = () => {
    if (effective.mode === 'disabled') {
      return <ShieldOff size={16} style={{ color: 'var(--text-muted)' }} />;
    }
    if (effective.mode === 'aggressive') {
      return <ShieldAlert size={16} style={{ color: 'var(--warning)' }} />;
    }
    return <ShieldCheck size={16} style={{ color: 'var(--accent)' }} />;
  };

  const setSiteMode = (mode: ShieldsMode | 'inherit') => {
    if (!siteKey) {
      if (mode !== 'inherit') dispatch({ type: 'set-shields-global-mode', mode });
      return;
    }
    dispatch({ type: 'set-shields-site-mode', domain: siteKey, mode });
  };

  return (
    <div
      className="modal-card shields-panel"
      role="dialog"
      aria-modal="true"
      aria-label="Kinex Shields"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="modal-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, fontWeight: 600 }}>
          {renderShieldHeaderIcon()}
          <span>Kinex Shields</span>
          {!isInternal && (
            <span className="command-kind-tag" style={{ textTransform: 'none' }}>
              {host || siteKey}
            </span>
          )}
        </div>
        <button
          data-initial-focus
          className="icon-btn"
          aria-label="Close Kinex Shields"
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </div>

      <div className="modal-body" style={{ overflowY: 'auto', maxHeight: '72vh' }}>
        {isInternal ? (
          <div className="settings-group">
            <div className="settings-row-title">Protected Internal Surface</div>
            <div className="settings-row-desc">
              Kinex Shields does not alter internal browser pages. Global default mode is{' '}
              <strong>{state.shields.globalMode}</strong> with{' '}
              {state.shieldsRuntime.totalRuleCount.toLocaleString()} active rules.
            </div>
          </div>
        ) : (
          <>
            <div className="settings-row">
              <div>
                <div className="settings-row-title">
                  {effective.mode === 'disabled'
                    ? `Shields Disabled for ${siteKey}`
                    : `Shields Active for ${siteKey}`}
                </div>
                <div className="settings-row-desc">
                  {hasExplicitOverride
                    ? `Per-site override (${effective.mode})`
                    : `Using global setting (${state.shields.globalMode})`}
                </div>
              </div>
              <button
                className={effective.mode === 'disabled' ? 'btn-primary' : 'btn-secondary'}
                aria-pressed={effective.mode !== 'disabled'}
                onClick={() =>
                  setSiteMode(effective.mode === 'disabled' ? 'inherit' : 'disabled')
                }
              >
                {effective.mode === 'disabled' ? 'Enable for Site' : 'Pause on Site'}
              </button>
            </div>

            <div>
              <div className="field-label">Protection Level ({siteKey})</div>
              <div className="shields-mode-group" role="group" aria-label="Site protection mode">
                {(
                  [
                    ['standard', 'Standard'],
                    ['aggressive', 'Aggressive'],
                    ['disabled', 'Disabled'],
                  ] as Array<[ShieldsMode, string]>
                ).map(([mode, label]) => {
                  const selected = effective.mode === mode;
                  return (
                    <button
                      key={mode}
                      className={`shields-mode-btn ${selected ? 'active' : ''}`}
                      aria-pressed={selected}
                      onClick={() => setSiteMode(mode)}
                    >
                      {label}
                    </button>
                  );
                })}
                {hasExplicitOverride && (
                  <button
                    className="shields-mode-btn"
                    title="Reset site override to follow Global default"
                    onClick={() => setSiteMode('inherit')}
                  >
                    Reset
                  </button>
                )}
              </div>
              {effective.mode === 'aggressive' && (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    marginTop: 7,
                    fontSize: 11.5,
                    color: 'var(--warning)',
                  }}
                >
                  <AlertTriangle size={13} />
                  <span>
                    Aggressive mode blocks cookie/annoyance overlays and may break strict sites.
                  </span>
                </div>
              )}
            </div>

            {needsReload && focusedTab && (
              <div className="shields-reload-banner" role="status">
                <span>Reload page to apply updated network rules cleanly.</span>
                <button
                  className="btn-primary"
                  style={{ padding: '4px 10px', fontSize: 11.5 }}
                  onClick={() => dispatch({ type: 'nav-reload', tabId: focusedTab.id })}
                >
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                    <RefreshCw size={12} /> Reload
                  </span>
                </button>
              </div>
            )}

            <div className="shields-stat-grid" aria-label="Blocked counts for current tab">
              <div className="shields-stat-card">
                <div className="shields-stat-num">{blockedTotal}</div>
                <div className="shields-stat-label">Total Blocked</div>
              </div>
              <div className="shields-stat-card">
                <div className="shields-stat-num">{blockedAds}</div>
                <div className="shields-stat-label">Ads</div>
              </div>
              <div className="shields-stat-card">
                <div className="shields-stat-num">{blockedTrackers}</div>
                <div className="shields-stat-label">Trackers</div>
              </div>
              <div className="shields-stat-card">
                <div className="shields-stat-num">{blockedOther}</div>
                <div className="shields-stat-label">Other</div>
              </div>
            </div>

            {recentBlocked.length > 0 && (
              <div>
                <button
                  className="btn-secondary"
                  style={{ width: '100%', justifyContent: 'space-between', display: 'flex', alignItems: 'center' }}
                  aria-expanded={showBlockedList}
                  onClick={() => setShowBlockedList((prev) => !prev)}
                >
                  <span>Blocked Requests on This Tab ({recentBlocked.length})</span>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    {showBlockedList ? 'Hide' : 'Inspect'}
                  </span>
                </button>
                {showBlockedList && (
                  <div className="shields-blocked-list">
                    {recentBlocked.map((item) => (
                      <div key={item.id} className="shields-blocked-item">
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontSize: 12, fontWeight: 550, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {item.host}
                          </div>
                          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                            {item.resourceType} · {item.listName}
                          </div>
                        </div>
                        <span className="command-kind-tag">{item.category}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div className="settings-group" style={{ gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                <div>
                  <div className="settings-row-title">Element Picker</div>
                  <div className="settings-row-desc">
                    Hide specific ads or page clutter cleanly using cosmetic filters.
                  </div>
                </div>
                <button
                  className="btn-secondary"
                  onClick={() => dispatch({ type: 'start-element-picker' })}
                >
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <Crosshair size={13} /> Pick Element
                  </span>
                </button>
              </div>
              {customRules.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                  {customRules.map((selector) => (
                    <div key={selector} className="shields-blocked-item">
                      <code style={{ fontSize: 11.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {siteKey}##{selector}
                      </code>
                      <button
                        className="icon-btn"
                        title={`Remove rule ${selector}`}
                        aria-label={`Remove rule ${selector}`}
                        onClick={() =>
                          dispatch({
                            type: 'remove-shields-cosmetic-rule',
                            domain: siteKey,
                            selector,
                          })
                        }
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, paddingTop: 2 }}>
          <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
            {state.shieldsRuntime.engineError || (state.shieldsRuntime.engineReady
              ? `${state.shieldsRuntime.totalRuleCount.toLocaleString()} rules ready`
              : 'Initializing engine...')}
          </span>
          <button
            className="btn-secondary"
            onClick={() =>
              dispatch({ type: 'set-overlay', overlay: { mode: 'settings', section: 'shields' } })
            }
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <Sliders size={13} /> Filter Lists &amp; Settings
            </span>
          </button>
        </div>
      </div>
    </div>
  );
};
