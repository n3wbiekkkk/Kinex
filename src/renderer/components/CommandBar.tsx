import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Globe, Search, Sparkles, Terminal } from 'lucide-react';
import { buildCommandBarResults } from '../../shared/domain';
import type { CommandBarResult, NookIntent, NookStateSnapshot } from '../../shared/types';

interface CommandBarProps {
  state: NookStateSnapshot;
  initialQuery: string;
  targetMode: 'new-tab' | 'edit-url' | 'split';
  dispatch: (intent: NookIntent) => void;
}

export const CommandBar: React.FC<CommandBarProps> = ({
  state,
  initialQuery,
  targetMode,
  dispatch,
}) => {
  const [query, setQuery] = useState(initialQuery);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setQuery(initialQuery);
    setSelectedIndex(0);
    setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 10);
  }, [initialQuery, targetMode]);

  const results = useMemo(() => buildCommandBarResults(query, state), [query, state]);

  const executeResult = (item: CommandBarResult, modifier: 'default' | 'split' | 'little') => {
    if (item.kind === 'action') {
      if (item.actionId === 'new-split') dispatch({ type: 'toggle-split' });
      if (item.actionId === 'toggle-boosts') {
        dispatch({ type: 'set-overlay', overlay: { mode: 'boosts', domain: '*' } });
        return;
      }
      if (item.actionId === 'little-nook') {
        dispatch({ type: 'open-url', url: 'kinex://newtab', target: 'little-nook' });
        return;
      }
      if (item.actionId === 'new-space') {
        dispatch({ type: 'set-overlay', overlay: { mode: 'space-editor' } });
        return;
      }
      if (item.actionId === 'open-settings') {
        dispatch({ type: 'set-overlay', overlay: { mode: 'settings' } });
        return;
      }
      if (item.actionId === 'check-updates') {
        dispatch({ type: 'check-for-updates' });
        dispatch({ type: 'set-overlay', overlay: { mode: 'settings' } });
        return;
      }
      dispatch({ type: 'set-overlay', overlay: { mode: 'none' } });
      return;
    }

    if (modifier === 'little' && item.url) {
      dispatch({ type: 'open-url', url: item.url, target: 'little-nook' });
      return;
    }
    if (modifier === 'split' || targetMode === 'split') {
      if (item.tabId) {
        dispatch({ type: 'toggle-split', tabId: item.tabId });
        dispatch({ type: 'set-overlay', overlay: { mode: 'none' } });
      } else if (item.url) {
        dispatch({ type: 'open-url', url: item.url, target: 'split' });
      }
      return;
    }

    if (item.tabId && (item.kind === 'open-tab' || item.kind === 'pinned-tab')) {
      dispatch({ type: 'select-tab', tabId: item.tabId });
      return;
    }

    if (item.url) {
      dispatch({
        type: 'open-url',
        url: item.url,
        target: targetMode === 'edit-url' ? 'current' : 'new-tab',
      });
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      dispatch({ type: 'set-overlay', overlay: { mode: 'none' } });
      return;
    }
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
    if (e.key === 'Enter' && results[selectedIndex]) {
      e.preventDefault();
      const mod = e.metaKey || e.ctrlKey ? 'split' : e.altKey ? 'little' : 'default';
      executeResult(results[selectedIndex], mod);
    }
  };

  const renderIcon = (kind: CommandBarResult['kind']) => {
    if (kind === 'search') return <Search size={15} style={{ opacity: 0.75 }} />;
    if (kind === 'action') return <Sparkles size={15} style={{ color: '#a78bfa' }} />;
    if (kind === 'open-tab' || kind === 'pinned-tab') return <Terminal size={15} style={{ color: '#93c5fd' }} />;
    return <Globe size={15} style={{ opacity: 0.75 }} />;
  };

  return (
    <div className="command-bar" onClick={(e) => e.stopPropagation()} onKeyDown={onKeyDown}>
      <div className="command-input-wrap">
        <Search size={17} style={{ opacity: 0.6 }} />
        <input
          ref={inputRef}
          className="command-input"
          placeholder={
            targetMode === 'edit-url'
              ? 'Edit URL or search...'
              : 'Search tabs, history, or enter a URL...'
          }
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSelectedIndex(0);
          }}
        />
      </div>

      <div className="command-results">
        {results.map((item, idx) => (
          <button
            key={item.id}
            ref={idx === selectedIndex ? (el) => el?.scrollIntoView({ block: 'nearest' }) : undefined}
            className={`command-item ${idx === selectedIndex ? 'selected' : ''}`}
            onMouseEnter={() => setSelectedIndex(idx)}
            onClick={(e) => {
              const mod = e.metaKey || e.ctrlKey ? 'split' : e.altKey ? 'little' : 'default';
              executeResult(item, mod);
            }}
          >
            {renderIcon(item.kind)}
            <div className="command-item-text">
              <div className="command-item-title">{item.title}</div>
              <div className="command-item-sub">{item.subtitle}</div>
            </div>
            {item.spaceLabel && (
              <span className="command-kind-tag" style={{ textTransform: 'none' }}>
                {item.spaceLabel}
              </span>
            )}
            <span className="command-kind-tag">{item.kind}</span>
          </button>
        ))}
      </div>

      <div className="command-footer">
        <span>Enter: Open</span>
        <span>⌘Enter: Open in Split</span>
        <span>⌥Enter: Little Kinex</span>
        <span>Esc: Close</span>
      </div>
    </div>
  );
};
