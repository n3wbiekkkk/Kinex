import React, { useState } from 'react';
import {
  ArrowUpCircle,
  Download,
  Keyboard,
  Layers,
  Plus,
  Settings,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';
import { SEARCH_ENGINES } from '../../shared/domain';
import kinexLogo from '../assets/kinex-logo.png';
import type {
  NookIntent,
  NookStateSnapshot,
  SearchEngineId,
  SettingsSection,
} from '../../shared/types';

interface SettingsViewProps {
  state: NookStateSnapshot;
  initialSection?: SettingsSection;
  dispatch: (intent: NookIntent) => void;
}

const SHORTCUTS: Array<[string, string]> = [
  ['Open Command Bar (New Tab)', '⌘T'],
  ['Edit Current URL', '⌘L'],
  ['Toggle Sidebar', '⌘S'],
  ['Toggle Split View', '⌘⇧\\'],
  ['Pin / Unpin Current Tab', '⌘D'],
  ['Copy Clean URL', '⌘⇧C'],
  ['Open Little NOOK', '⌥⌘N'],
  ['New Private Window', '⌘⇧N'],
  ['Boosts Studio', '⌘⇧B'],
  ['Find in Page', '⌘F'],
  ['Zoom In / Out / Reset', '⌘+  ⌘-  ⌘0'],
  ['Switch Spaces', '⌃⌘← / ⌃⌘→'],
  ['Jump to Tab 1–9', '⌘1 .. ⌘9'],
  ['Developer Tools', '⌥⌘I'],
  ['Settings', '⌘,'],
];

export const SettingsView: React.FC<SettingsViewProps> = ({
  state,
  initialSection = 'general',
  dispatch,
}) => {
  const [section, setSection] = useState<SettingsSection>(initialSection);
  const [feedUrl, setFeedUrl] = useState(state.updateFeedUrl);
  const [newProfileName, setNewProfileName] = useState('');
  const [rulePattern, setRulePattern] = useState('');
  const [ruleSpaceId, setRuleSpaceId] = useState(state.spaces[0]?.id ?? '');
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
        return `Found NOOK v${up.version}, downloading...`;
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
    { id: 'shortcuts', label: 'Shortcuts', icon: <Keyboard size={15} /> },
    { id: 'import', label: 'Import & Data', icon: <Download size={15} /> },
    { id: 'updates', label: 'Updates & About', icon: <ArrowUpCircle size={15} /> },
  ];

  return (
    <div className="settings-window" onClick={(e) => e.stopPropagation()}>
      <nav className="settings-nav">
        <div className="settings-nav-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <img src={kinexLogo} alt="Kinex" width={16} height={16} style={{ borderRadius: 4, background: '#fff', padding: 2 }} />
          <span>Kinex Settings</span>
        </div>
        {navItems.map((item) => (
          <button
            key={item.id}
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
                      className="btn-secondary"
                      style={{
                        border:
                          state.searchEngine === id
                            ? '1px solid #7c8cff'
                            : '1px solid transparent',
                      }}
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
                    checked={state.cleanCopyUrl}
                    onChange={(e) =>
                      dispatch({ type: 'set-clean-copy-url', enabled: e.target.checked })
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
                    value={rulePattern}
                    onChange={(e) => setRulePattern(e.target.value)}
                  />
                  <select
                    className="text-input"
                    style={{ width: 160 }}
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
                    <div key={`${perm.origin}:${perm.permission}`} className="settings-row">
                      <div style={{ fontSize: 12.5 }}>
                        <strong>{perm.origin}</strong> · {perm.permission} ({perm.decision})
                      </div>
                      <button
                        className="btn-secondary"
                        onClick={() =>
                          dispatch({
                            type: 'revoke-site-permission',
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

          {section === 'shortcuts' && (
            <div className="settings-group">
              {SHORTCUTS.map(([label, keys]) => (
                <div key={label} className="settings-row">
                  <span style={{ fontSize: 13 }}>{label}</span>
                  <span className="kbd-badge">{keys}</span>
                </div>
              ))}
            </div>
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
                    disabled={up.state === 'checking' || up.state === 'downloading'}
                    onClick={() => dispatch({ type: 'check-for-updates' })}
                  >
                    Check for Updates
                  </button>
                )}
              </div>
              <div>
                <label className="field-label">Update Feed (HTTPS URL or local release folder)</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    className="text-input"
                    value={feedUrl}
                    onChange={(e) => setFeedUrl(e.target.value)}
                  />
                  <button
                    className="btn-secondary"
                    onClick={() => dispatch({ type: 'set-update-feed-url', url: feedUrl })}
                  >
                    Save Feed
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
