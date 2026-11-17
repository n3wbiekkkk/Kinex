import { BROWSER_COMMANDS, formatShortcut } from '../../shared/commands';
import React, { useState } from 'react';
import {
  ArrowUpCircle,
  Download,
  Keyboard,
  Layers,
  Plus,
  Puzzle,
  Settings,
  Shield,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';
import { SEARCH_ENGINES } from '../../shared/domain';
import kinexLogo from '../assets/kinex-logo.png';
import type {
  KinexIntent,
  KinexStateSnapshot,
  MemorySaverTimeout,
  NewTabBackground,
  NewTabPreset,
  SearchEngineId,
  SettingsSection,
  ShieldsMode,
} from '../../shared/types';

interface SettingsViewProps {
  state: KinexStateSnapshot;
  initialSection?: SettingsSection;
  dispatch: (intent: KinexIntent) => void;
}

export const SettingsView: React.FC<SettingsViewProps> = ({
  state,
  initialSection = 'general',
  dispatch,
}) => {
  const [section, setSection] = useState<SettingsSection>(initialSection);
  const [newProfileName, setNewProfileName] = useState('');
  const [rulePattern, setRulePattern] = useState('');
  const [ruleSpaceId, setRuleSpaceId] = useState(state.spaces[0]?.id ?? '');
  const [customRuleDomain, setCustomRuleDomain] = useState('');
  const [customRuleSelector, setCustomRuleSelector] = useState('');
  const [extensionConsent, setExtensionConsent] = useState<Record<string, boolean>>({});
  const [clearScopes, setClearScopes] = useState<Record<'history' | 'cookies' | 'cache' | 'archived', boolean>>({
    history: true,
    cache: true,
    cookies: false,
    archived: false,
  });

  const up = state.updateStatus;
  const describeUpdate = () => {
    switch (up.state) {
      case 'idle':
        return up.message || `Version ${state.appVersion}`;
      case 'checking':
        return 'Checking for updates...';
      case 'available':
        return `Found Kinex v${up.version}, downloading...`;
      case 'downloading':
        return `Downloading v${up.version} (${up.percent}%)`;
      case 'downloaded':
        return `Kinex v${up.version} is ready to install`;
      case 'up-to-date':
        return `You are running the latest version (v${up.version})`;
      case 'error':
        return up.message;
    }
  };

  const navItems: Array<{ id: SettingsSection; label: string; icon: React.ReactNode }> = [
    { id: 'general', label: 'General', icon: <Settings size={15} /> },
    { id: 'spaces', label: 'Spaces & Profiles', icon: <Layers size={15} /> },
    { id: 'privacy', label: 'Privacy & Security', icon: <ShieldCheck size={15} /> },
    { id: 'shields', label: 'Shields & Filters', icon: <Shield size={15} /> },
    { id: 'shortcuts', label: 'Shortcuts', icon: <Keyboard size={15} /> },
    { id: 'extensions', label: 'Extensions', icon: <Puzzle size={15} /> },
    { id: 'import', label: 'Import & Data', icon: <Download size={15} /> },
    { id: 'updates', label: 'Updates & About', icon: <ArrowUpCircle size={15} /> },
  ];

  return (
      <div className="settings-window" role="dialog" aria-modal="true" aria-label="Kinex Settings" onClick={(e) => e.stopPropagation()}>
      <nav className="settings-nav" aria-label="Settings Sections">
        <div className="settings-nav-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <img src={kinexLogo} alt="Kinex" width={16} height={16} style={{ borderRadius: 4, background: '#fff', padding: 2 }} />
          <span>Kinex Settings</span>
        </div>
        {navItems.map((item) => (
          <button
            key={item.id}
            aria-current={section === item.id ? 'page' : undefined}
            data-initial-focus={section === item.id || undefined}
            className={`settings-nav-item ${section === item.id ? 'active' : ''}`}
            onClick={() => setSection(item.id)}
          >
            {item.icon}
            <span>{item.label}</span>
          </button>
        ))}
      </nav>

      <div className="settings-content">
        <header className="settings-content-header">
          <span>{navItems.find((i) => i.id === section)?.label}</span>
          <button
            className="icon-btn"
            aria-label="Close Settings"
            onClick={() => dispatch({ type: 'set-overlay', overlay: { mode: 'none' } })}
          >
            <X size={16} />
          </button>
        </header>

        <div className="settings-content-body">
          {section === 'general' && (
            <>
              <div className="settings-group">
                <div className="settings-row">
                  <div>
                    <div className="settings-row-title">Default Browser</div>
                    <div className="settings-row-desc">
                      Open external links from other macOS apps directly in Kinex.
                    </div>
                  </div>
                  <button
                    className="btn-primary"
                    onClick={() => dispatch({ type: 'set-default-browser' })}
                  >
                    {state.isDefaultBrowser ? 'Default Browser' : 'Set as Default'}
                  </button>
                </div>
              </div>

              <div className="settings-group">
                <div className="settings-row-title">Search Engine</div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {(Object.keys(SEARCH_ENGINES) as SearchEngineId[]).map((id) => (
                    <button
                      key={id}
                      aria-pressed={state.searchEngine === id}
                      className={`btn-secondary ${state.searchEngine === id ? 'selected' : ''}`}
                      onClick={() => dispatch({ type: 'set-search-engine', engine: id })}
                    >
                      {SEARCH_ENGINES[id].name}
                    </button>
                  ))}
                </div>
              </div>

              <div className="settings-group">
                <div className="settings-row">
                  <div>
                    <div className="settings-row-title">Clean Copy URL</div>
                    <div className="settings-row-desc">
                      Strip tracking parameters (utm_*, fbclid, gclid) when copying with ⌘⇧C.
                    </div>
                  </div>
                  <input
                    type="checkbox"
                    aria-label="Clean Copy URL"
                    checked={state.cleanCopyUrl}
                    onChange={(e) =>
                      dispatch({ type: 'set-clean-copy-url', enabled: e.target.checked })
                    }
                  />
                </div>
              </div>

              <div className="settings-group">
                <div className="settings-row">
                  <div>
                    <div className="settings-row-title">Memory Saver</div>
                    <div className="settings-row-desc">
                      Free memory from inactive background tabs automatically ({state.tabs.filter((t) => t.isDiscarded).length} sleeping). Never discards audio, downloads, calls, or unsaved forms.
                    </div>
                  </div>
                  <select
                    className="text-input"
                    style={{ width: 170 }}
                    aria-label="Memory Saver"
                    value={state.memorySaverTimeout}
                    onChange={(e) =>
                      dispatch({
                        type: 'set-memory-saver-timeout',
                        timeout: e.target.value as MemorySaverTimeout,
                      })
                    }
                  >
                    <option value="disabled">Disabled</option>
                    <option value="5m">After 5 minutes</option>
                    <option value="15m">After 15 minutes</option>
                    <option value="30m">After 30 minutes</option>
                    <option value="60m">After 60 minutes</option>
                  </select>
                </div>
                <div className="settings-row">
                  <div>
                    <div className="settings-row-title">Keep Pinned &amp; Favorite Tabs Active</div>
                    <div className="settings-row-desc">
                      Exempt pinned and favorite tabs from automatic Memory Saver sleep.
                    </div>
                  </div>
                  <input
                    type="checkbox"
                    aria-label="Keep pinned and favorite tabs active"
                    checked={state.memorySaverExemptPinned}
                    onChange={(e) =>
                      dispatch({
                        type: 'set-memory-saver-exempt-pinned',
                        exempt: e.target.checked,
                      })
                    }
                  />
                </div>
              </div>

              <div className="settings-group">
                <div>
                  <div className="settings-row-title">New Tab Experience</div>
                  <div className="settings-row-desc">
                    Customize the start page layout and visible modules while keeping Space light/dark harmony.
                  </div>
                </div>
                <div className="settings-row">
                  <span style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>Layout Preset</span>
                  <div style={{ display: 'flex', gap: 6 }}>
                    {(['minimal', 'focus', 'personal'] as NewTabPreset[]).map((preset) => (
                      <button
                        key={preset}
                        aria-pressed={state.newTabConfig.preset === preset}
                        className={`btn-secondary ${state.newTabConfig.preset === preset ? 'selected' : ''}`}
                        onClick={() => dispatch({ type: 'set-new-tab-config', config: { preset } })}
                      >
                        {preset.charAt(0).toUpperCase() + preset.slice(1)}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="settings-row">
                  <span style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>Backdrop Atmosphere</span>
                  <div style={{ display: 'flex', gap: 6 }}>
                    {(['clean', 'mist', 'dusk', 'sage'] as NewTabBackground[]).map((background) => (
                      <button
                        key={background}
                        aria-pressed={state.newTabConfig.background === background}
                        className={`btn-secondary ${state.newTabConfig.background === background ? 'selected' : ''}`}
                        onClick={() => dispatch({ type: 'set-new-tab-config', config: { background } })}
                      >
                        {background.charAt(0).toUpperCase() + background.slice(1)}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="settings-row">
                  <span style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>Show Clock</span>
                  <input
                    type="checkbox"
                    aria-label="Show clock on New Tab"
                    checked={state.newTabConfig.showClock}
                    onChange={(e) =>
                      dispatch({ type: 'set-new-tab-config', config: { showClock: e.target.checked } })
                    }
                  />
                </div>
                <div className="settings-row">
                  <span style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>Show Pinned Favorites</span>
                  <input
                    type="checkbox"
                    aria-label="Show pinned favorites on New Tab"
                    checked={state.newTabConfig.showFavorites}
                    onChange={(e) =>
                      dispatch({ type: 'set-new-tab-config', config: { showFavorites: e.target.checked } })
                    }
                  />
                </div>
                <div className="settings-row">
                  <span style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>Show Frequently Visited</span>
                  <input
                    type="checkbox"
                    aria-label="Show frequently visited sites on New Tab"
                    checked={state.newTabConfig.showFrequent}
                    onChange={(e) =>
                      dispatch({ type: 'set-new-tab-config', config: { showFrequent: e.target.checked } })
                    }
                  />
                </div>
              </div>
            </>
          )}

          {section === 'spaces' && (
            <>
              <div className="settings-group">
                <div className="settings-row-title">Cookie &amp; Login Profiles</div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {state.profiles.map((p) => (
                    <span key={p.id} className="kbd-badge" style={{ fontFamily: 'inherit' }}>
                      {p.name}
                    </span>
                  ))}
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    className="text-input"
                    placeholder="New isolated profile name (e.g. Client, Dev)..."
                    aria-label="New Profile Name"
                    value={newProfileName}
                    onChange={(e) => setNewProfileName(e.target.value)}
                  />
                  <button
                    className="btn-secondary"
                    onClick={() => {
                      if (newProfileName.trim()) {
                        dispatch({ type: 'create-profile', name: newProfileName });
                        setNewProfileName('');
                      }
                    }}
                  >
                    Create
                  </button>
                </div>
              </div>

              <div className="settings-group">
                <div className="settings-row">
                  <div>
                    <div className="settings-row-title">Air Traffic Control</div>
                    <div className="settings-row-desc">
                      Automatically route matching domains into a designated Space.
                    </div>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    className="text-input"
                    placeholder="Domain pattern (e.g. slack.com or *.linear.app)"
                    aria-label="Air Traffic Domain Pattern"
                    value={rulePattern}
                    onChange={(e) => setRulePattern(e.target.value)}
                  />
                  <select
                    className="text-input"
                    style={{ width: 160 }}
                    aria-label="Air Traffic Destination Space"
                    value={ruleSpaceId}
                    onChange={(e) => setRuleSpaceId(e.target.value)}
                  >
                    {state.spaces.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.icon} {s.name}
                      </option>
                    ))}
                  </select>
                  <button
                    className="btn-primary"
                    aria-label="Add Air Traffic Rule"
                    onClick={() => {
                      if (!rulePattern.trim() || !ruleSpaceId) return;
                      dispatch({
                        type: 'save-air-traffic-rule',
                        rule: {
                          id: `atc-${Date.now()}`,
                          pattern: rulePattern.trim(),
                          spaceId: ruleSpaceId,
                          enabled: true,
                        },
                      });
                      setRulePattern('');
                    }}
                  >
                    <Plus size={14} />
                  </button>
                </div>

                {state.airTrafficRules.map((rule) => {
                  const sp = state.spaces.find((s) => s.id === rule.spaceId);
                  return (
                    <div key={rule.id} className="settings-row">
                      <span style={{ fontSize: 12.5 }}>
                        <span className="kbd-badge">{rule.pattern}</span> → {sp?.icon} {sp?.name}
                      </span>
                      <button
                        className="icon-btn"
                        aria-label={`Delete rule for ${rule.pattern}`}
                        onClick={() => dispatch({ type: 'delete-air-traffic-rule', ruleId: rule.id })}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  );
                })}
              </div>
            </>
          )}

          {section === 'privacy' && (
            <>
              <div className="settings-group">
                <div className="settings-row">
                  <div>
                    <div className="settings-row-title">HTTPS-Only Mode</div>
                    <div className="settings-row-desc">
                      Automatically upgrade HTTP connections to HTTPS (excludes localhost and .local).
                    </div>
                  </div>
                  <input
                    type="checkbox"
                    aria-label="HTTPS-Only Mode"
                    checked={state.httpsOnly}
                    onChange={(e) =>
                      dispatch({ type: 'set-https-only', enabled: e.target.checked })
                    }
                  />
                </div>
                <div className="settings-row">
                  <div>
                    <div className="settings-row-title">Ad &amp; Tracker Shields</div>
                    <div className="settings-row-desc">
                      Blocked {state.blockedRequestsCount} third-party tracker/ad requests this session.
                    </div>
                  </div>
                  <input
                    type="checkbox"
                    aria-label="Ad and Tracker Shields"
                    checked={state.adBlockEnabled}
                    onChange={() => dispatch({ type: 'toggle-adblock' })}
                  />
                </div>
              </div>

              <div className="settings-group">
                <div className="settings-row-title">Clear Browsing Data</div>
                <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 12.5 }}>
                  {(
                    [
                      ['history', `History (${state.history.length})`],
                      ['cache', 'HTTP Cache'],
                      ['cookies', 'Cookies & Site Storage'],
                      ['archived', `Archived Tabs (${state.archivedTabs.length})`],
                    ] as const
                  ).map(([key, label]) => (
                    <label key={key} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <input
                        type="checkbox"
                        checked={clearScopes[key]}
                        onChange={(e) =>
                          setClearScopes((prev) => ({ ...prev, [key]: e.target.checked }))
                        }
                      />
                      {label}
                    </label>
                  ))}
                </div>
                <div>
                  <button
                    className="btn-danger"
                    onClick={() => {
                      const scopes = (
                        Object.keys(clearScopes) as Array<keyof typeof clearScopes>
                      ).filter((k) => clearScopes[k]);
                      if (scopes.length > 0) {
                        dispatch({ type: 'clear-browsing-data', scopes });
                      }
                    }}
                  >
                    Clear Selected Data
                  </button>
                </div>
              </div>

              <div className="settings-group">
                <div className="settings-row-title">Saved Site Permissions</div>
                {state.sitePermissions.length === 0 ? (
                  <div className="settings-row-desc">No site permissions granted or blocked yet.</div>
                ) : (
                  state.sitePermissions.map((perm) => (
                    <div key={`${perm.partition}:${perm.origin}:${perm.permission}`} className="settings-row">
                      <div style={{ fontSize: 12.5 }}>
                        <strong>{perm.origin}</strong> · {state.profiles.find((profile) => profile.partition === perm.partition)?.name || perm.partition} · {perm.permission} ({perm.decision})
                      </div>
                      <button
                        className="btn-secondary"
                        onClick={() =>
                          dispatch({
                            type: 'revoke-site-permission',
                            partition: perm.partition,
                            origin: perm.origin,
                            permission: perm.permission,
                          })
                        }
                      >
                        Reset
                      </button>
                    </div>
                  ))
                )}
              </div>
            </>
          )}

          {section === 'shields' && (
            <>
              <div className="settings-group">
                <div className="settings-row">
                  <div>
                    <div className="settings-row-title">Global Protection Mode</div>
                    <div className="settings-row-desc">
                      Default blocking level across websites unless overridden per site.{' '}
                      {state.shieldsRuntime.totalRuleCount.toLocaleString()} active rules.
                    </div>
                  </div>
                  <div className="seg-group" role="group" aria-label="Global Shields Mode">
                    {(
                      [
                        ['standard', 'Standard'],
                        ['aggressive', 'Aggressive'],
                        ['disabled', 'Disabled'],
                      ] as Array<[ShieldsMode, string]>
                    ).map(([mode, label]) => (
                      <button
                        key={mode}
                        className={`seg-btn ${state.shields.globalMode === mode ? 'active' : ''}`}
                        aria-pressed={state.shields.globalMode === mode}
                        onClick={() => dispatch({ type: 'set-shields-global-mode', mode })}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
                {state.shields.globalMode === 'aggressive' && (
                  <div className="settings-row-desc" style={{ color: 'var(--warning)' }}>
                    Warning: Aggressive mode enables additional cookie/annoyance filters and may break websites.
                  </div>
                )}

                <div className="settings-row">
                  <div>
                    <div className="settings-row-title">Cosmetic Filtering</div>
                    <div className="settings-row-desc">
                      Hide empty ad containers, sponsored boxes, and element placeholders.
                    </div>
                  </div>
                  <input
                    type="checkbox"
                    aria-label="Cosmetic Filtering"
                    checked={state.shields.cosmeticFilteringEnabled}
                    onChange={(e) =>
                      dispatch({ type: 'set-shields-cosmetic-enabled', enabled: e.target.checked })
                    }
                  />
                </div>

                <div className="settings-row">
                  <div>
                    <div className="settings-row-title">Strip Tracking Parameters</div>
                    <div className="settings-row-desc">
                      Remove utm_*, fbclid, gclid, and similar click-tracking query parameters on navigation.
                    </div>
                  </div>
                  <input
                    type="checkbox"
                    aria-label="Strip Tracking Parameters"
                    checked={state.shields.stripTrackingParams}
                    onChange={(e) =>
                      dispatch({ type: 'set-shields-strip-params', enabled: e.target.checked })
                    }
                  />
                </div>
              </div>

              <div className="settings-group">
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                  <div>
                    <div className="settings-row-title">Filter Lists</div>
                    <div className="settings-row-desc">
                      {state.shields.lastGlobalUpdateAt
                        ? `Last updated ${new Date(state.shields.lastGlobalUpdateAt).toLocaleString()}`
                        : 'Using verified bundled filter lists'}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button
                      className="btn-secondary"
                      disabled={state.shieldsRuntime.updatingLists}
                      onClick={() => dispatch({ type: 'restore-default-filter-lists' })}
                    >
                      Restore Defaults
                    </button>
                    <button
                      className="btn-primary"
                      disabled={state.shieldsRuntime.updatingLists}
                      onClick={() => dispatch({ type: 'update-filter-lists' })}
                    >
                      {state.shieldsRuntime.updatingLists ? 'Updating...' : 'Update Lists'}
                    </button>
                  </div>
                </div>

                {state.shields.filterLists.map((list) => (
                  <div key={list.id} className="settings-row">
                    <div style={{ minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        <span className="settings-row-title">{list.name}</span>
                        <span className="command-kind-tag">{list.tier}</span>
                        <span className="command-kind-tag" style={{ textTransform: 'none' }}>
                          {list.ruleCount.toLocaleString()} rules
                        </span>
                      </div>
                      <div className="settings-row-desc">
                        {list.description} · {list.license}
                        {list.lastUpdatedAt ? ` · Updated ${new Date(list.lastUpdatedAt).toLocaleDateString()}` : ''}
                      </div>
                      {list.lastError && (
                        <div style={{ fontSize: 11.5, color: 'var(--warning)', marginTop: 2 }}>
                          Update error (kept previous rules): {list.lastError}
                        </div>
                      )}
                    </div>
                    <input
                      type="checkbox"
                      aria-label={`Enable ${list.name}`}
                      checked={list.enabled}
                      onChange={(e) =>
                        dispatch({
                          type: 'toggle-filter-list',
                          listId: list.id,
                          enabled: e.target.checked,
                        })
                      }
                    />
                  </div>
                ))}
              </div>

              <div className="settings-group">
                <div className="settings-row-title">Per-Site Shields Overrides</div>
                {Object.keys(state.shields.siteOverrides).length === 0 ? (
                  <div className="settings-row-desc">No per-site Shields exceptions configured yet.</div>
                ) : (
                  Object.entries(state.shields.siteOverrides).map(([domain, mode]) => (
                    <div key={domain} className="settings-row">
                      <span style={{ fontSize: 12.5, fontWeight: 550 }}>{domain}</span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <select
                          className="select-input"
                          aria-label={`Shields mode for ${domain}`}
                          value={mode}
                          onChange={(e) =>
                            dispatch({
                              type: 'set-shields-site-mode',
                              domain,
                              mode: e.target.value as ShieldsMode,
                            })
                          }
                        >
                          <option value="standard">Standard</option>
                          <option value="aggressive">Aggressive</option>
                          <option value="disabled">Disabled</option>
                        </select>
                        <button
                          className="btn-secondary"
                          onClick={() =>
                            dispatch({ type: 'set-shields-site-mode', domain, mode: 'inherit' })
                          }
                        >
                          Remove
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>

              <div className="settings-group">
                <div className="settings-row-title">Custom Element Hiding Rules</div>
                <div className="settings-row-desc">
                  Manage selectors saved via Element Picker or add custom site-scoped CSS rules manually.
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <input
                    className="text-input"
                    style={{ flex: '1 1 150px' }}
                    aria-label="Custom rule domain"
                    placeholder="example.com"
                    value={customRuleDomain}
                    onChange={(e) => setCustomRuleDomain(e.target.value)}
                  />
                  <input
                    className="text-input"
                    style={{ flex: '2 1 200px' }}
                    aria-label="Custom CSS selector"
                    placeholder=".promo-banner"
                    value={customRuleSelector}
                    onChange={(e) => setCustomRuleSelector(e.target.value)}
                  />
                  <button
                    className="btn-secondary"
                    onClick={() => {
                      if (!customRuleDomain.trim() || !customRuleSelector.trim()) return;
                      dispatch({
                        type: 'add-shields-cosmetic-rule',
                        domain: customRuleDomain.trim(),
                        selector: customRuleSelector.trim(),
                      });
                      setCustomRuleSelector('');
                    }}
                  >
                    Add Rule
                  </button>
                </div>
                {Object.entries(state.shields.customCosmeticRules).map(([domain, selectors]) =>
                  selectors.map((sel) => (
                    <div key={`${domain}:${sel}`} className="settings-row">
                      <code style={{ fontSize: 12 }}>
                        {domain}##{sel}
                      </code>
                      <button
                        className="btn-secondary"
                        aria-label={`Remove ${domain} rule ${sel}`}
                        onClick={() =>
                          dispatch({
                            type: 'remove-shields-cosmetic-rule',
                            domain,
                            selector: sel,
                          })
                        }
                      >
                        Remove
                      </button>
                    </div>
                  ))
                )}
              </div>
            </>
          )}

          {section === 'shortcuts' && (
            <div className="settings-group">
              <p className="settings-row-desc">F6 cycles between website content and browser controls. Use arrows to navigate Sidebar tabs, ⌥↑ / ⌥↓ to reorder tabs, Shift+F10 for tab actions, and ⌥← / ⌥→ to reorder Spaces. Tab and Shift+Tab reach every control. Escape closes the current dialog and restores focus.</p>
              {BROWSER_COMMANDS.filter((command) => command.accelerator).map((command) => (
                <div key={command.id} className="settings-row">
                  <span style={{ fontSize: 13 }}>{command.title}</span>
                  <kbd className="kbd-badge">{formatShortcut(command.accelerator)}</kbd>
                </div>
              ))}
            </div>
          )}

          {section === 'extensions' && (
            <>
              <div className="settings-group">
                <div className="settings-row">
                  <div>
                    <div className="settings-row-title">Manifest V3 Extensions</div>
                    <div className="settings-row-desc">
                      Unpacked extensions run in the active Space's Browser Profile. Private windows never load extensions, and extensions cannot access Kinex's privileged controls.
                    </div>
                  </div>
                  <button
                    className="btn-primary"
                    onClick={() => {
                      void (async () => {
                        const sourcePath = await window.kinexAPI.pickExtensionFolder();
                        if (sourcePath) dispatch({ type: 'install-extension', sourcePath });
                      })();
                    }}
                  >
                    Install from Folder…
                  </button>
                </div>
              </div>

              {state.extensions.length === 0 ? (
                <div className="settings-group">
                  <div className="settings-row-desc">No extensions installed in this profile yet.</div>
                </div>
              ) : (
                <div className="settings-group">
                  {state.extensions.map((extension) => {
                    const space = state.spaces.find((item) => item.id === extension.spaceId);
                    const permissions = [
                      ...extension.permissions,
                      ...extension.hostPermissions.map((pattern) => `site: ${pattern}`),
                    ];
                    return (
                      <div key={extension.id} className="settings-row" data-extension-id={extension.id}>
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                            {extension.iconDataUrl && (
                              <img className="extension-action-icon" src={extension.iconDataUrl} alt="" />
                            )}
                            <span className="settings-row-title">{extension.name}</span>
                            <span className="command-kind-tag">v{extension.version}</span>
                            <span className="command-kind-tag">{space?.name ?? extension.spaceId}</span>
                            <span className="command-kind-tag">
                              {extension.loaded ? 'Active' : extension.error ? 'Load failed' : 'Not loaded'}
                            </span>
                          </div>
                          {extension.description && (
                            <div className="settings-row-desc">{extension.description}</div>
                          )}
                          {extension.error && (
                            <div className="settings-row-desc" style={{ color: 'var(--warning)' }}>{extension.error}</div>
                          )}
                          <div className="extension-permission-list">
                            {permissions.length === 0 ? (
                              <span className="command-kind-tag">No declared permissions</span>
                            ) : permissions.map((permission) => (
                              <span key={permission} className="kbd-badge">{permission}</span>
                            ))}
                          </div>
                          {!extension.consented && (
                            <label className="extension-consent">
                              <input
                                type="checkbox"
                                aria-label={`I reviewed permissions for ${extension.name}`}
                                checked={Boolean(extensionConsent[extension.id])}
                                onChange={(event) => setExtensionConsent((prev) => ({ ...prev, [extension.id]: event.target.checked }))}
                              />
                              I have reviewed these permissions
                            </label>
                          )}
                        </div>
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                          {!extension.consented ? (
                            <button
                              className="btn-primary"
                              disabled={!extensionConsent[extension.id]}
                              aria-label={`Review and enable ${extension.name}`}
                              onClick={() => dispatch({ type: 'set-extension-enabled', extensionId: extension.id, enabled: true, consent: true })}
                            >
                              Review &amp; Enable
                            </button>
                          ) : (
                            <button
                              className="btn-secondary"
                              aria-label={`${extension.enabled ? 'Disable' : 'Enable'} ${extension.name}`}
                              onClick={() => dispatch({ type: 'set-extension-enabled', extensionId: extension.id, enabled: !extension.enabled })}
                            >
                              {extension.enabled ? 'Disable' : 'Enable'}
                            </button>
                          )}
                          <button
                            className="btn-danger"
                            aria-label={`Remove ${extension.name}`}
                            onClick={() => dispatch({ type: 'uninstall-extension', extensionId: extension.id })}
                          >
                            Remove
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}

          {section === 'import' && (
            <div className="settings-group">
              <div className="settings-row-title">Import Bookmarks &amp; Sidebar</div>
              <div className="settings-row-desc">
                Import pinned tabs and folders into the active Space without altering source browsers.
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button
                  className="btn-secondary"
                  onClick={() => dispatch({ type: 'import-browser-data', source: 'arc' })}
                >
                  Import from Arc
                </button>
                <button
                  className="btn-secondary"
                  onClick={() => dispatch({ type: 'import-browser-data', source: 'chrome' })}
                >
                  Import from Chrome
                </button>
                <button
                  className="btn-primary"
                  onClick={() => dispatch({ type: 'import-browser-data', source: 'file' })}
                >
                  Choose JSON / HTML File...
                </button>
              </div>
            </div>
          )}

          {section === 'updates' && (
            <div className="settings-group">
              <div className="settings-row">
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <img
                    src={kinexLogo}
                    alt="Kinex"
                    width={36}
                    height={36}
                    style={{ borderRadius: 10, background: '#fff', padding: 5 }}
                  />
                  <div>
                    <div className="settings-row-title">Kinex Browser v{state.appVersion}</div>
                    <div className="settings-row-desc">{describeUpdate()}</div>
                  </div>
                </div>
                {up.state === 'downloaded' ? (
                  <button
                    className="btn-primary"
                    onClick={() => dispatch({ type: 'install-update' })}
                  >
                    Restart &amp; Update
                  </button>
                ) : (
                  <button
                    className="btn-primary"
                    disabled={up.state === 'checking' || up.state === 'downloading' || up.state === 'available'}
                    onClick={() => dispatch({ type: 'check-for-updates' })}
                  >
                    Check for Updates
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
