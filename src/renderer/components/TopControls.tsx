import React, { useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Copy,
  Lock,
  PanelLeft,
  PictureInPicture2,
  Printer,
  Puzzle,
  RotateCw,
  Shield,
  ShieldAlert,
  ShieldOff,
  SlidersHorizontal,
  Sparkles,
  SplitSquareHorizontal,
  X,
} from 'lucide-react';
import { extractHostname, getActiveSplit, resolveEffectiveShieldsMode } from '../../shared/domain';
import { BROWSER_COMMANDS, formatShortcut } from '../../shared/commands';
import type { KinexIntent, KinexStateSnapshot, ReaderTheme } from '../../shared/types';
import { SiteControlPopover, type SiteControlViewModel } from './SiteControlPopover';
import { ReaderControls } from './ReaderControls';

interface TopControlsProps {
  state: KinexStateSnapshot;
  dispatch: (intent: KinexIntent) => void;
}

/** Badge colors are rendered as inline CSS, so only accept a literal #RRGGBB value. */
function safeBadgeColor(color: string | undefined): string | undefined {
  return color && /^#[0-9a-f]{6}$/i.test(color) ? color : undefined;
}

export const TopControls: React.FC<TopControlsProps> = ({ state, dispatch }) => {
  const split = getActiveSplit(state);
  const panes = split.tabIds
    .map((id) => state.tabs.find((t) => t.id === id))
    .filter((t): t is NonNullable<typeof t> => Boolean(t));
  const focusedTab = panes[split.focusedIndex] ?? panes[0];
  const focusedEffectiveShields = resolveEffectiveShieldsMode(
    state.shields,
    focusedTab?.url ?? '',
    extractHostname(focusedTab?.url ?? '')
  );
  const focusedBlockedCount = focusedTab ? state.shieldsRuntime.tabStats[focusedTab.id]?.total ?? 0 : 0;
  const activeExtensions = state.extensions.filter(
    (extension) => extension.enabled && extension.spaceId === state.activeSpaceId && (extension.actionPopup || extension.badge?.text)
  );
  const [siteControlOpen, setSiteControlOpen] = useState(false);
  const siteModel: SiteControlViewModel | null = focusedTab
    ? (() => {
        let origin = '';
        try { origin = new URL(focusedTab.url).origin; } catch { origin = ''; }
        const internal = /^(kinex|about|devtools|chrome):/i.test(focusedTab.url);
        const secure = /^https:/i.test(focusedTab.url);
        return {
          url: focusedTab.url,
          origin,
          host: extractHostname(focusedTab.url) || focusedTab.url,
          isInternal: internal,
          tls: {
            state: internal ? 'internal' : secure ? 'secure' : 'insecure',
            secure,
            label: internal ? 'internal' : secure ? 'secure' : 'insecure',
          },
          shields: {
            mode: focusedEffectiveShields.mode,
            source: focusedEffectiveShields.source,
            domainKey: focusedEffectiveShields.domainKey,
          },
          cookiePolicy: {
            effective: state.cookiePolicyByOrigin[origin] ?? 'block-third-party',
            source: state.cookiePolicyByOrigin[origin] ? 'site' : 'global',
            origin,
          },
          permissions: state.sitePermissions
            .filter((permission) => permission.origin === origin)
            .map((permission) => ({
              permission: permission.permission,
              status: permission.decision === 'allow' ? ('allowed' as const) : ('denied' as const),
              origin: permission.origin,
            })),
        };
      })()
    : null;

  return (
    <div className={`top-controls ${state.sidebarOpen ? '' : 'sidebar-closed'}`} role="toolbar" aria-label="Browser Toolbar" onKeyDown={(event) => {
      if (!(event.target instanceof HTMLButtonElement) || event.altKey || event.metaKey || event.ctrlKey) return;
      const direction = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0;
      if (!direction) return;
      event.preventDefault();
      const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
      const index = buttons.indexOf(event.target);
      buttons[(index + direction + buttons.length) % buttons.length]?.focus();
    }}>
      {!state.sidebarOpen && (
        <>
          <button
            className="icon-btn"
            title={`Show Sidebar (${formatShortcut(BROWSER_COMMANDS.find((command) => command.id === 'toggle-sidebar')?.accelerator)})`}
            aria-label="Show Sidebar"
            onClick={() => dispatch({ type: 'toggle-sidebar' })}
          >
            <PanelLeft size={15} />
          </button>

          <button
            className="icon-btn"
            title="Back (⌘[)"
            aria-label="Back"
            disabled={!focusedTab?.canGoBack}
            style={{ opacity: focusedTab?.canGoBack ? 1 : 0.35 }}
            onClick={() => dispatch({ type: 'nav-back' })}
          >
            <ArrowLeft size={15} />
          </button>

          <button
            className="icon-btn"
            title="Forward (⌘])"
            aria-label="Forward"
            disabled={!focusedTab?.canGoForward}
            style={{ opacity: focusedTab?.canGoForward ? 1 : 0.35 }}
            onClick={() => dispatch({ type: 'nav-forward' })}
          >
            <ArrowRight size={15} />
          </button>

          <button
            className="icon-btn"
            title={focusedTab?.isLoading ? 'Stop' : 'Reload (⌘R)'}
            aria-label={focusedTab?.isLoading ? 'Stop Loading' : 'Reload'}
            onClick={() => dispatch({ type: focusedTab?.isLoading ? 'nav-stop' : 'nav-reload' })}
          >
            {focusedTab?.isLoading ? <X size={14} /> : <RotateCw size={14} />}
          </button>
        </>
      )}

      <div className="pane-pills">
        {panes.map((tab, idx) => (
          <div
            key={tab.id}
            className={`pane-pill ${idx === split.focusedIndex ? 'focused' : ''} ${tab.isLoading ? 'loading' : ''}`}
          >
            <button
              className="tab-mini-btn"
              title="Site Control Center"
              aria-label="Site Control Center"
              onClick={(e) => {
                e.stopPropagation();
                dispatch({ type: 'focus-pane', paneIndex: idx });
                dispatch({ type: 'set-overlay', overlay: { mode: 'site-info' } });
              }}
            >
              {tab.securityState === 'cert-warning' || tab.securityState === 'insecure' ? (
                <AlertTriangle size={11} style={{ color: '#f59e0b' }} />
              ) : tab.securityState === 'secure' ? (
                <Lock size={11} />
              ) : (
                <SlidersHorizontal size={11} />
              )}
            </button>
            <button
              className="pane-pill-main"
              aria-label={idx === split.focusedIndex ? `Edit address for ${tab.title || tab.url}` : `Focus pane ${idx + 1}: ${tab.title || tab.url}`}
            onClick={() => {
              if (idx !== split.focusedIndex) {
                dispatch({ type: 'focus-pane', paneIndex: idx });
              } else {
                dispatch({
                  type: 'set-overlay',
                  overlay: {
                    mode: 'command-bar',
                    initialQuery:
                      tab.url.startsWith('kinex://') || tab.url.startsWith('nook://') ? '' : tab.url,
                    targetMode: 'edit-url',
                  },
                });
              }
            }}

            >
              <span className="pane-pill-url">{tab.url}</span>
            </button>
            {panes.length > 1 && (
              <button
                className="tab-mini-btn"
                title="Close split pane"
                aria-label="Close split pane"
                onClick={(e) => {
                  e.stopPropagation();
                  dispatch({ type: 'close-split-pane', paneIndex: idx });
                }}
              >
                <X size={12} />
              </button>
            )}
          </div>
        ))}
      </div>

      {panes.length === 2 && (
        <div className="split-ratio-pill" title="Adjust Split Ratio">
          <input
            type="range"
            min={22}
            max={78}
            aria-label="Adjust Split Ratio"
            value={Math.round((split.splitRatio || 0.5) * 100)}
            style={{ width: 52 }}
            onChange={(e) =>
              dispatch({ type: 'set-split-ratio', ratio: Number(e.target.value) / 100 })
            }
          />
          <span style={{ fontSize: 10.5, color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>
            {Math.round((split.splitRatio || 0.5) * 100)}/{100 - Math.round((split.splitRatio || 0.5) * 100)}
          </span>
          <button
            className="split-reset-btn"
            title="Reset split to 50/50"
            aria-label="Reset split to 50/50"
            disabled={Math.abs((split.splitRatio ?? 0.5) - 0.5) < 0.01}
            onClick={() => dispatch({ type: 'set-split-ratio', ratio: 0.5 })}
          >
            50/50
          </button>
        </div>
      )}

      {focusedTab && state.readerTabIds.includes(focusedTab.id) && (
        <div className="split-ratio-pill" aria-label="Reader Mode Controls">
          <button
            className="tab-mini-btn"
            title="Decrease font size"
            aria-label="Decrease reader font size"
            onClick={() =>
              dispatch({
                type: 'set-reader-options',
                options: { fontSize: Math.max(12, state.readerOptions.fontSize - 1) },
              })
            }
          >
            A-
          </button>
          <span style={{ fontSize: 10.5, color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums' }}>
            {state.readerOptions.fontSize}px
          </span>
          <button
            className="tab-mini-btn"
            title="Increase font size"
            aria-label="Increase reader font size"
            onClick={() =>
              dispatch({
                type: 'set-reader-options',
                options: { fontSize: Math.min(28, state.readerOptions.fontSize + 1) },
              })
            }
          >
            A+
          </button>
          {(['light', 'sepia', 'dark'] as ReaderTheme[]).map((rt) => (
            <button
              key={rt}
              className="tab-mini-btn"
              title={`Reader ${rt} theme`}
              aria-label={`Reader ${rt} theme`}
              style={{
                background:
                  state.readerOptions.theme === rt ? 'var(--accent-soft)' : 'transparent',
                color:
                  state.readerOptions.theme === rt ? 'var(--accent)' : 'var(--text-muted)',
                fontSize: 10,
                padding: '0 4px',
                width: 'auto',
              }}
              onClick={() => dispatch({ type: 'set-reader-options', options: { theme: rt } })}
            >
              {rt.charAt(0).toUpperCase()}
            </button>
          ))}
        </div>
      )}

      {focusedTab && (focusedTab.zoomFactor ?? 1) !== 1 && (
        <button
          className="shield-pill"
          title="Reset Page Zoom (⌘0)"
          onClick={() => dispatch({ type: 'set-zoom', delta: 'reset', tabId: focusedTab.id })}
        >
          {Math.round((focusedTab.zoomFactor ?? 1) * 100)}%
        </button>
      )}

      <button
        className={`icon-btn ${focusedTab && state.readerTabIds.includes(focusedTab.id) ? 'active' : ''}`}
        title="Toggle Reader Mode (⌥⌘R)"
        aria-label="Toggle Reader Mode"
        onClick={() => dispatch({ type: 'toggle-reader-mode', tabId: focusedTab?.id })}
      >
        <BookOpen size={14} />
      </button>

      <button
        className="icon-btn"
        title="Print Page (⌘P)"
        aria-label="Print Page"
        onClick={() => dispatch({ type: 'print-page' })}
      >
        <Printer size={14} />
      </button>

      <button
        className="icon-btn"
        title="Copy Clean URL (⌘⇧C)"
        aria-label="Copy Clean URL"
        onClick={() => dispatch({ type: 'copy-current-url' })}
      >
        <Copy size={14} />
      </button>

      <button
        className={`icon-btn ${panes.length > 1 ? 'active' : ''}`}
        title="Toggle Split View (⌘⇧\)"
        aria-label="Toggle Split View"
        onClick={() => dispatch({ type: 'toggle-split' })}
      >
        <SplitSquareHorizontal size={14} />
      </button>

      <button
        className="icon-btn"
        title="Little Kinex (⌥⌘N)"
        aria-label="Little Kinex"
        onClick={() =>
          dispatch({
            type: 'open-url',
            url: focusedTab?.url || 'kinex://newtab',
            target: 'little-kinex',
          })
        }
      >
        <PictureInPicture2 size={14} />
      </button>

      <button
        className="icon-btn"
        title="Kinex Shields (⌘⇧K)"
        aria-label="Open Kinex Shields"
        onClick={() => dispatch({ type: 'set-overlay', overlay: { mode: 'shields' } })}
      >
        {focusedEffectiveShields.mode === 'disabled' ? (
          <ShieldOff size={14} style={{ opacity: 0.55 }} />
        ) : focusedEffectiveShields.mode === 'aggressive' ? (
          <ShieldAlert size={14} style={{ color: 'var(--warning)' }} />
        ) : (
          <Shield size={14} />
        )}
        {focusedBlockedCount > 0 && (
          <span className="toolbar-shield-badge">{focusedBlockedCount}</span>
        )}
      </button>

      <button
        className="icon-btn"
        title="Boosts Studio (⌘⇧B)"
        aria-label="Boosts Studio"
        onClick={() =>
          dispatch({
            type: 'set-overlay',
            overlay: { mode: 'boosts', domain: extractHostname(focusedTab?.url ?? '') || '*' },
          })
        }
      >
        <Sparkles size={14} />
      </button>

      {activeExtensions.map((extension) => (
        <button
          key={extension.id}
          className="icon-btn extension-action-btn"
          data-extension-id={extension.id}
          title={`${extension.name}${extension.error ? ` — ${extension.error}` : ''}`}
          aria-label={`Open ${extension.name} popup`}
          disabled={!extension.loaded || !extension.actionPopup}
          onClick={(event) => {
            if (!extension.actionPopup) return;
            const rect = event.currentTarget.getBoundingClientRect();
            dispatch({
              type: 'open-extension-popup',
              extensionId: extension.id,
              anchor: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            });
          }}
        >
          {extension.iconDataUrl ? (
            <img className="extension-action-icon" src={extension.iconDataUrl} alt="" />
          ) : (
            <Puzzle size={14} />
          )}
          {extension.badge?.text && (
            <span className="extension-action-badge" style={{ backgroundColor: safeBadgeColor(extension.badge.color) }} aria-label={`${extension.name} badge ${extension.badge.text}`}>
              {extension.badge.text}
            </span>
          )}
        </button>
      ))}

      {focusedTab && (
        <button
          className="icon-btn"
          aria-label="Site controls"
          title="Site controls"
          aria-pressed={siteControlOpen}
          onClick={() => setSiteControlOpen((open) => !open)}
        >
          <Shield size={15} />
        </button>
      )}
      {siteControlOpen && siteModel && (
        <SiteControlPopover
          model={siteModel}
          reducedMotion={state.reducedEffects}
          onClose={() => setSiteControlOpen(false)}
          onShieldsModeChange={(mode) => {
            dispatch({ type: 'set-shields-site-mode', domain: siteModel.shields.domainKey || siteModel.host, mode });
          }}
          onCookiePolicyChange={(policy) => {
            if (siteModel.origin) dispatch({ type: 'set-site-cookie-policy', origin: siteModel.origin, policy });
          }}
          onPermissionChange={(permission, decision) => {
            if (siteModel.origin) dispatch({ type: 'set-site-permission', origin: siteModel.origin, permission, decision });
          }}
        />
      )}
      {focusedTab && state.readerTabIds.includes(focusedTab.id) && (
        <ReaderControls
          active
          options={state.readerOptions}
          inReadingList={state.readingList.some((entry) => entry.url === focusedTab.url)}
          reducedMotion={state.reducedEffects}
          onToggleReader={() => dispatch({ type: 'toggle-reader-mode', tabId: focusedTab.id })}
          onFontSizeChange={(fontSize) => dispatch({ type: 'set-reader-options', options: { fontSize } })}
          onThemeChange={(theme) => dispatch({ type: 'set-reader-options', options: { theme } })}
          onToggleReadingList={() => dispatch({ type: 'toggle-reading-list', url: focusedTab.url, title: focusedTab.title || focusedTab.url })}
          onClose={() => dispatch({ type: 'toggle-reader-mode', tabId: focusedTab.id })}
        />
      )}
    </div>
  );
};
