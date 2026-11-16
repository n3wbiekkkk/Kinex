import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  BookOpen,
  Clock,
  Globe,
  Search,
  Settings,
  Sparkles,
  Star,
  Terminal,
} from 'lucide-react';
import { buildCommandBarResults } from '../../shared/domain';
import type { CommandBarResult, KinexIntent, KinexStateSnapshot } from '../../shared/types';

interface CommandBarProps {
  active: boolean;
  state: KinexStateSnapshot;
  initialQuery: string;
  targetMode: 'new-tab' | 'edit-url' | 'split';
  dispatch: (intent: KinexIntent) => void;
}

const HighlightMatch: React.FC<{ text: string; query: string }> = ({ text, query }) => {
  const q = query.trim();
  if (!q) return <>{text}</>;
  const idx = text.toLowerCase().indexOf(q.toLowerCase());
  if (idx === -1) return <>{text}</>;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="cmd-match">{text.slice(idx, idx + q.length)}</mark>
      {text.slice(idx + q.length)}
    </>
  );
};

const ResultIcon: React.FC<{ item: CommandBarResult }> = ({ item }) => {
  const [imgErr, setImgErr] = useState(false);
  if (item.favicon && !imgErr) {
    return (
      <img
        src={item.favicon}
        alt=""
        width={15}
        height={15}
        style={{ borderRadius: 4, flexShrink: 0 }}
        onError={() => setImgErr(true)}
      />
    );
  }
  if (item.kind === 'search') return <Search size={15} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />;
  if (item.kind === 'action') return <Sparkles size={15} style={{ color: 'var(--accent)', flexShrink: 0 }} />;
  if (item.kind === 'settings') return <Settings size={15} style={{ color: 'var(--accent)', flexShrink: 0 }} />;
  if (item.kind === 'favorite') return <Star size={15} style={{ color: 'var(--warning)', flexShrink: 0 }} />;
  if (item.kind === 'history') return <Clock size={15} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />;
  if (item.kind === 'open-tab' || item.kind === 'pinned-tab') {
    return <Terminal size={15} style={{ color: 'var(--accent)', flexShrink: 0 }} />;
  }
  return <Globe size={15} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />;
};

export const CommandBar: React.FC<CommandBarProps> = ({
  active,
  state,
  initialQuery,
  targetMode,
  dispatch,
}) => {
  const [query, setQuery] = useState(initialQuery);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useLayoutEffect(() => {
    if (!active) return;
    setQuery(initialQuery);
    setSelectedIndex(0);
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [initialQuery, targetMode, active]);

  const results = useMemo(
    () => buildCommandBarResults(query, state),
    [query, state.tabs, state.history, state.spaces, state.folders, state.activeSpaceId, state.splitsBySpace, state.closedTabs, state.searchEngine]
  );

  const activeIndex = Math.min(selectedIndex, Math.max(0, results.length - 1));

  const executeResult = (
    item: CommandBarResult,
    modifier: 'default' | 'split' | 'little' | 'force-duplicate'
  ) => {
    if (item.kind === 'settings' && item.settingsSection) {
      dispatch({ type: 'set-overlay', overlay: { mode: 'settings', section: item.settingsSection } });
      return;
    }

    if (item.kind === 'action' && item.intent) {
      dispatch(item.intent);
      return;
    }

    if (modifier === 'little' && item.url) {
      dispatch({ type: 'open-url', url: item.url, target: 'little-kinex' });
      return;
    }
    if (modifier === 'split' || targetMode === 'split') {
      if (item.tabId && (item.kind === 'open-tab' || item.kind === 'pinned-tab' || item.kind === 'favorite')) {
        dispatch({ type: 'toggle-split', tabId: item.tabId });
        dispatch({ type: 'set-overlay', overlay: { mode: 'none' } });
      } else if (item.url) {
        dispatch({ type: 'open-url', url: item.url, target: 'split', duplicatePolicy: 'allow' });
      }
      return;
    }

    if (item.tabId && (item.kind === 'open-tab' || item.kind === 'pinned-tab' || item.kind === 'favorite')) {
      dispatch({ type: 'select-tab', tabId: item.tabId });
      return;
    }

    if (item.url) {
      dispatch({
        type: 'open-url',
        url: item.url,
        target: targetMode === 'edit-url' ? 'current' : 'new-tab',
        duplicatePolicy:
          targetMode === 'edit-url' || modifier === 'force-duplicate' ? 'allow' : 'prompt',
      });
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((prev) => (results.length ? (prev + 1) % results.length : 0));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((prev) => (results.length ? (prev - 1 + results.length) % results.length : 0));
      return;
    }
    if (e.key === 'Enter' && results[activeIndex]) {
      e.preventDefault();
      const mod = e.metaKey || e.ctrlKey
        ? 'split'
        : e.altKey
          ? 'little'
          : e.shiftKey
            ? 'force-duplicate'
            : 'default';
      executeResult(results[activeIndex], mod);
    }
  };

  const renderKindLabel = (kind: CommandBarResult['kind']) => {
    switch (kind) {
      case 'open-tab':
        return 'Tab';
      case 'pinned-tab':
        return 'Pinned';
      case 'favorite':
        return 'Favorite';
      case 'settings':
        return 'Settings';
      default:
        return kind;
    }
  };

  return (
    <div
      className="command-bar"
      role="dialog"
      aria-modal="true"
      aria-label="Command Bar"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={onKeyDown}
    >
      <div className="command-input-wrap">
        <Search size={16} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
        <input
          ref={inputRef}
          data-initial-focus
          role="combobox"
          aria-autocomplete="list"
          aria-expanded="true"
          aria-controls="command-results"
          aria-activedescendant={results[activeIndex] ? `command-result-${activeIndex}` : undefined}
          className="command-input"
          aria-label="Search tabs, history, commands, or enter a URL"
          placeholder={
            targetMode === 'edit-url'
              ? 'Edit URL or search...'
              : 'Search tabs, history, settings, commands, or enter a URL...'
          }
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSelectedIndex(0);
          }}
        />
      </div>

      <div id="command-results" className="command-results" role="listbox" aria-label="Results">
        {results.length === 0 ? (
          <div className="empty-state" style={{ padding: '22px 12px' }}>
            <BookOpen size={18} style={{ opacity: 0.6 }} />
            <div className="empty-state-title">No matching results</div>
            <div className="empty-state-sub">
              Type a domain or search term to navigate cleanly.
            </div>
          </div>
        ) : (
          results.map((item, idx) => (
            <button
              key={item.id}
              id={`command-result-${idx}`}
              role="option"
              tabIndex={-1}
              aria-selected={idx === activeIndex}
              ref={idx === activeIndex ? (el) => el?.scrollIntoView({ block: 'nearest' }) : undefined}
              className={`command-item ${idx === activeIndex ? 'selected' : ''}`}
              onMouseEnter={() => setSelectedIndex(idx)}
              onClick={(e) => {
                const mod = e.metaKey || e.ctrlKey
                  ? 'split'
                  : e.altKey
                    ? 'little'
                    : e.shiftKey
                      ? 'force-duplicate'
                      : 'default';
                executeResult(item, mod);
              }}
            >
              <ResultIcon item={item} />
              <div className="command-item-text">
                <div className="command-item-title">
                  <HighlightMatch text={item.title} query={query} />
                </div>
                <div className="command-item-sub">
                  <HighlightMatch text={item.subtitle} query={query} />
                </div>
              </div>
              {item.isAlreadyOpen && (
                <span className="command-kind-tag" style={{ color: 'var(--accent)', borderColor: 'var(--accent-border)' }}>
                  Already Open
                </span>
              )}
              {item.spaceLabel && (
                <span className="command-kind-tag" style={{ textTransform: 'none' }}>
                  {item.spaceLabel}
                </span>
              )}
              {item.shortcut && <kbd className="kbd-badge">{item.shortcut}</kbd>}
              <span className="command-kind-tag">{renderKindLabel(item.kind)}</span>
            </button>
          ))
        )}
      </div>

      <div className="command-footer">
        <span className="command-footer-hint"><kbd className="kbd-badge">↵</kbd> Open</span>
        <span className="command-footer-hint"><kbd className="kbd-badge">⌘↵</kbd> Split</span>
        <span className="command-footer-hint"><kbd className="kbd-badge">⌥↵</kbd> Little Kinex</span>
        <span className="command-footer-hint"><kbd className="kbd-badge">Esc</kbd> Close</span>
      </div>
    </div>
  );
};
