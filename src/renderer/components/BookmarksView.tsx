import React, { useState } from 'react';
import { Archive, ExternalLink, RotateCcw, Star, Trash2, X } from 'lucide-react';
import type { Wave2Intent } from '../../shared/settingsPreferences';
import type { KinexIntent, KinexStateSnapshot } from '../../shared/types';

interface BookmarksViewProps {
  state: KinexStateSnapshot;
  dispatch: (intent: KinexIntent) => void;
  onClose?: () => void;
}

type ViewIntent = KinexIntent | Wave2Intent;

/** Favorites/bookmarks from tabs plus the recoverable archived-tab vault. */
export const BookmarksView: React.FC<BookmarksViewProps> = ({ state, dispatch, onClose }) => {
  const [query, setQuery] = useState('');
  const emit = (intent: ViewIntent) => dispatch(intent as KinexIntent);
  const close = () => (onClose ? onClose() : dispatch({ type: 'set-overlay', overlay: { mode: 'none' } }));
  const q = query.trim().toLowerCase();
  const matches = (title: string, url: string) =>
    !q || title.toLowerCase().includes(q) || url.toLowerCase().includes(q);

  const bookmarks = state.tabs.filter(
    (tab) => (tab.location === 'topApp' || tab.location === 'pinned') && matches(tab.title, tab.url)
  );
  const archived = state.archivedTabs.filter((tab) => matches(tab.title, tab.url));
  const spaceName = (spaceId: string) => state.spaces.find((space) => space.id === spaceId)?.name ?? spaceId;

  return (
    <div className="modal-card" role="dialog" aria-modal="true" aria-label="Bookmarks" onClick={(e) => e.stopPropagation()}>
      <div className="modal-header">
        <span style={{ fontWeight: 600 }}>Bookmarks</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input
            className="text-input"
            type="search"
            style={{ width: 220 }}
            aria-label="Search bookmarks"
            placeholder="Search bookmarks..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button className="icon-btn" aria-label="Close Bookmarks" onClick={close}><X size={16} /></button>
        </div>
      </div>
      <div className="modal-body" style={{ overflowY: 'auto', maxHeight: '65vh' }}>
        <div className="field-label">Favorites &amp; Pinned</div>
        {bookmarks.length === 0 ? (
          <div className="empty-state">
            <Star size={22} style={{ opacity: 0.65 }} />
            <div className="empty-state-title">No bookmarks found</div>
            <div className="empty-state-sub">Favorite or pin a tab to keep it here.</div>
          </div>
        ) : (
          bookmarks.map((tab) => (
            <div key={tab.id} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <button
                className="command-item"
                style={{ flex: 1, minWidth: 0 }}
                onClick={() => dispatch({ type: 'open-url', url: tab.url, target: 'new-tab', spaceId: tab.spaceId })}
              >
                <ExternalLink size={14} aria-hidden="true" />
                <span className="command-item-text">
                  <span className="command-item-title" style={{ display: 'block' }}>{tab.title || tab.url}</span>
                  <span className="command-item-sub" style={{ display: 'block' }}>{tab.url} · {spaceName(tab.spaceId)}</span>
                </span>
              </button>
              <button
                className="icon-btn"
                aria-label={`Remove bookmark ${tab.title || tab.url}`}
                onClick={() => emit({ type: 'remove-bookmark', tabId: tab.id })}
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))
        )}

        <div className="field-label" style={{ marginTop: 12 }}>Archived Tabs</div>
        {archived.length === 0 ? (
          <div className="settings-row-desc">No archived tabs.</div>
        ) : (
          <>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 6 }}>
              <button
                className="btn-secondary"
                onClick={() => dispatch({ type: 'clear-browsing-data', scopes: ['archived'] })}
              >
                <Trash2 size={12} /> Clear Archived
              </button>
            </div>
            {archived.map((item) => (
              <div key={item.id} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {item.title || item.url}
                  </div>
                  <div style={{ fontSize: 11.5, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {item.url} · {spaceName(item.spaceId)}
                  </div>
                </div>
                <button className="btn-secondary" onClick={() => dispatch({ type: 'restore-archived-tab', archivedId: item.id })}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                    <RotateCcw size={12} /> Restore
                  </span>
                </button>
              </div>
            ))}
          </>
        )}
        {bookmarks.length === 0 && archived.length === 0 && (
          <div className="empty-state">
            <Archive size={22} style={{ opacity: 0.65 }} />
            <div className="empty-state-sub">Try a different search term.</div>
          </div>
        )}
      </div>
    </div>
  );
};
