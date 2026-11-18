import React, { useState } from 'react';
import { ExternalLink, Search, Trash2, X } from 'lucide-react';
import type { ClearDataScope, Wave2Intent } from '../../shared/settingsPreferences';
import type { KinexIntent, KinexStateSnapshot } from '../../shared/types';

interface HistoryViewProps {
  state: KinexStateSnapshot;
  dispatch: (intent: KinexIntent) => void;
  onClose?: () => void;
}

type ViewIntent = KinexIntent | Wave2Intent;

/** Searchable browsing history with timed and per-Space clearing. */
export const HistoryView: React.FC<HistoryViewProps> = ({ state, dispatch, onClose }) => {
  const [query, setQuery] = useState('');
  const [timeRange, setTimeRange] = useState<'1h' | '24h' | '7d' | 'all'>('24h');
  const [spaceId, setSpaceId] = useState('');
  const [scopes, setScopes] = useState<Record<ClearDataScope, boolean>>({
    history: true,
    cookies: false,
    cache: false,
    archived: false,
  });

  const emit = (intent: ViewIntent) => dispatch(intent as KinexIntent);
  const close = () => (onClose ? onClose() : dispatch({ type: 'set-overlay', overlay: { mode: 'none' } }));
  const q = query.trim().toLowerCase();
  const entries = [...state.history]
    .filter((entry) => !q || entry.title.toLowerCase().includes(q) || entry.url.toLowerCase().includes(q))
    .sort((a, b) => b.visitedAt - a.visitedAt);

  const clearTimed = () => {
    const duration = timeRange === '1h' ? 3_600_000
      : timeRange === '24h' ? 86_400_000
      : timeRange === '7d' ? 604_800_000 : 0;
    emit({
      type: 'clear-browsing-data-timed',
      scopes: (Object.keys(scopes) as ClearDataScope[]).filter((scope) => scopes[scope]),
      since: duration ? Date.now() - duration : 0,
      ...(spaceId ? { spaceId } : {}),
    });
  };

  return (
    <div className="modal-card" role="dialog" aria-modal="true" aria-label="Browsing History" onClick={(e) => e.stopPropagation()}>
      <div className="modal-header">
        <span style={{ fontWeight: 600 }}>History</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input
            className="text-input"
            type="search"
            style={{ width: 220 }}
            aria-label="Search history"
            placeholder="Search history..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button className="icon-btn" aria-label="Close History" onClick={close}><X size={16} /></button>
        </div>
      </div>
      <div className="modal-body" style={{ overflowY: 'auto', maxHeight: '65vh' }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
          <select
            className="text-input"
            style={{ width: 140 }}
            aria-label="History time range"
            value={timeRange}
            onChange={(e) => setTimeRange(e.target.value as typeof timeRange)}
          >
            <option value="1h">Last hour</option>
            <option value="24h">Last 24 hours</option>
            <option value="7d">Last 7 days</option>
            <option value="all">All time</option>
          </select>
          <select
            className="text-input"
            style={{ width: 150 }}
            aria-label="History Space"
            value={spaceId}
            onChange={(e) => setSpaceId(e.target.value)}
          >
            <option value="">All Spaces</option>
            {state.spaces.map((space) => (
              <option key={space.id} value={space.id}>{space.name}</option>
            ))}
          </select>
          <button className="btn-secondary" onClick={clearTimed}>Clear Data…</button>
          <button
            className="btn-secondary"
            onClick={() => dispatch({ type: 'set-overlay', overlay: { mode: 'settings', section: 'privacy' } })}
          >
            Privacy Settings
          </button>
        </div>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 12, marginBottom: 10 }}>
          {(Object.keys(scopes) as ClearDataScope[]).map((scope) => (
            <label key={scope} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              <input
                type="checkbox"
                checked={scopes[scope]}
                onChange={(e) => setScopes((prev) => ({ ...prev, [scope]: e.target.checked }))}
              />
              {scope}
            </label>
          ))}
        </div>
        {entries.length === 0 ? (
          <div className="empty-state">
            <Search size={22} style={{ opacity: 0.65 }} />
            <div className="empty-state-title">{q ? 'No matching pages' : 'No browsing history'}</div>
            <div className="empty-state-sub">Pages you visit will appear here.</div>
          </div>
        ) : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }} aria-label="Visited pages">
            {entries.map((entry) => (
              <li key={entry.url} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <button
                  className="command-item"
                  style={{ flex: 1, minWidth: 0 }}
                  onClick={() => dispatch({ type: 'open-url', url: entry.url, target: 'new-tab' })}
                >
                  <ExternalLink size={14} aria-hidden="true" />
                  <span className="command-item-text">
                    <span className="command-item-title" style={{ display: 'block' }}>{entry.title || entry.url}</span>
                    <span className="command-item-sub" style={{ display: 'block' }}>{entry.url}</span>
                  </span>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)', flexShrink: 0 }}>
                    {new Date(entry.visitedAt).toLocaleDateString()}
                  </span>
                </button>
                <button
                  className="icon-btn"
                  aria-label={`Remove ${entry.title || entry.url} from history`}
                  onClick={() => emit({ type: 'remove-history-entry', url: entry.url })}
                >
                  <Trash2 size={13} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
};
