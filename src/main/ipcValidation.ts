import path from 'node:path';
import { isCommandId } from '../shared/commands';
import { EXTENSION_ID_RE, parseWebStoreUrl } from './extensionSupport';
import type {
  AirTrafficRule,
  BoostRule,
  KinexIntent,
  LittleKinexAction,
  MemorySaverTimeout,
  OverlayState,
  SearchEngineId,
  ShieldsMode,
  SpaceTheme,
  TabLocation,
} from '../shared/types';
import { isSafeNavigationUrl, isSafeUpdateFeedUrl } from './security';
import { sanitizeContextPayload } from './contextMenu';
import { isAutoArchiveTimeout } from './archiveManager';
import { validateSiteControlMutation } from './siteControl';
import { validateFocusRule } from './zenFocus';
import { isLinkPeekAction, isLinkPeekUrl } from './linkPeek';
import {
  clampDefaultZoom,
  isAccentPreference,
  isClearDataScope,
  isDensityPreference,
  isReferrerPolicy,
  isSidebarSide,
  isStartupBehavior,
  isThemePreference,
  isThirdPartyCookiesPolicy,
  isVibrancyPreference,
  isWebRtcPolicy,
  normalizeCustomSearchEngine,
  MAX_CUSTOM_FILTER_URLS,
  MAX_SITE_WHITELIST,
  MAX_STARTUP_URLS,
} from '../shared/settingsPreferences';

export type TrustedIpcRole = 'shell' | 'overlay' | 'little-kinex' | 'private-header';

const MAX_STRING_LEN = 4096;
const MAX_URL_LEN = 8192;

const TAB_LOCATIONS = new Set<TabLocation>(['topApp', 'pinned', 'unpinned']);
const SEARCH_ENGINES = new Set<SearchEngineId>(['google', 'duckduckgo', 'bing', 'startpage', 'kagi']);
const NEW_TAB_PRESETS = new Set(['minimal', 'focus', 'personal']);
const NEW_TAB_BACKGROUNDS = new Set(['clean', 'mist', 'dusk', 'sage']);
const MEMORY_SAVER_TIMEOUTS = new Set<MemorySaverTimeout>(['disabled', '5m', '15m', '30m', '60m']);
const SHIELDS_MODES = new Set<ShieldsMode>(['standard', 'aggressive', 'disabled']);
const CLEAR_SCOPES = new Set(['history', 'cookies', 'cache', 'archived']);
const IMPORT_SOURCES = new Set(['arc', 'chrome', 'file']);
const LITTLE_ACTIONS = new Set<LittleKinexAction>([
  'back',
  'forward',
  'reload',
  'navigate',
  'promote',
  'close',
  'focus-content',
]);
const OPEN_TARGETS = new Set([
  'current',
  'new-tab',
  'new-tab-background',
  'split',
  'little-kinex',
  'little-nook',
]);
const DUPLICATE_POLICIES = new Set(['prompt', 'allow']);
const DUPLICATE_DECISIONS = new Set(['switch-existing', 'open-anyway', 'cancel']);
const READER_THEMES = new Set(['light', 'sepia', 'dark']);

const DISALLOWED_EXPLICIT_SCHEME_RE = /^(javascript|data|vbscript|file|blob):/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown, maxLen = MAX_STRING_LEN): value is string {
  return typeof value === 'string' && value.length <= maxLen && !value.includes('\0');
}

function isNonEmptyString(value: unknown, maxLen = MAX_STRING_LEN): value is string {
  return isString(value, maxLen) && value.trim().length > 0;
}

function isOptionalString(value: unknown, maxLen = MAX_STRING_LEN): value is string | undefined {
  return value === undefined || isString(value, maxLen);
}

function isOptionalNonEmptyString(value: unknown, maxLen = MAX_STRING_LEN): value is string | undefined {
  return value === undefined || isNonEmptyString(value, maxLen);
}

function isSafeProfilePartition(value: unknown): value is string | undefined {
  if (value === undefined) return true;
  return isNonEmptyString(value, 256) && value.startsWith('persist:');
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

interface AnchorRectInput {
  x: number;
  y: number;
  width: number;
  height: number;
}

function isAnchorRect(value: unknown): value is AnchorRectInput | undefined {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  return ['x', 'y', 'width', 'height'].every(
    (key) => isFiniteNumber(value[key]) && Math.abs(value[key] as number) <= 20000
  );
}

function isBoundedRect(value: unknown): value is { x: number; y: number; width: number; height: number } {
  if (!isRecord(value)) return false;
  return (
    ['x', 'y', 'width', 'height'].every((key) => isFiniteNumber(value[key]) && Math.abs(value[key] as number) <= 20000) &&
    (value.width as number) >= 0 &&
    (value.height as number) >= 0
  );
}

function isBoundedStringArray(value: unknown, max: number, maxLen = MAX_URL_LEN): value is string[] {
  return Array.isArray(value) && value.length <= max && value.every((item) => isNonEmptyString(item, maxLen));
}

function isSpaceTheme(value: unknown): value is SpaceTheme {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value.id, 128) &&
    isNonEmptyString(value.name, 128) &&
    isNonEmptyString(value.gradientFrom, 128) &&
    isNonEmptyString(value.gradientTo, 128) &&
    isNonEmptyString(value.tintRgba, 128) &&
    isNonEmptyString(value.accent, 128) &&
    typeof value.isDark === 'boolean'
  );
}

function isBoostRule(value: unknown): value is BoostRule {
  if (!isRecord(value)) return false;
  if (
    !isNonEmptyString(value.id, 128) ||
    !isString(value.name, 256) ||
    !isNonEmptyString(value.domainPattern, 512) ||
    typeof value.enabled !== 'boolean' ||
    !isString(value.css, 65536) ||
    !isString(value.js, 65536) ||
    !Array.isArray(value.zappedSelectors) ||
    !value.zappedSelectors.every((s) => isNonEmptyString(s, 512))
  ) {
    return false;
  }
  if (value.filterInvert !== undefined && typeof value.filterInvert !== 'boolean') return false;
  if (!isOptionalString(value.fontFamily, 256)) return false;
  if (value.zoomFactor !== undefined && !isFiniteNumber(value.zoomFactor)) return false;
  return true;
}

function isAirTrafficRule(value: unknown): value is AirTrafficRule {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value.id, 128) &&
    isNonEmptyString(value.pattern, 512) &&
    isNonEmptyString(value.spaceId, 128) &&
    typeof value.enabled === 'boolean'
  );
}

function isOverlayState(value: unknown): value is OverlayState {
  if (!isRecord(value) || typeof value.mode !== 'string') return false;
  switch (value.mode) {
    case 'none':
    case 'archive':
    case 'history':
    case 'downloads':
    case 'find':
    case 'shields':
    case 'site-info':
      return true;
    case 'command-bar':
      return (
        isString(value.initialQuery, MAX_URL_LEN) &&
        (value.targetMode === 'new-tab' || value.targetMode === 'edit-url' || value.targetMode === 'split')
      );
    case 'boosts':
      return isString(value.domain, 512);
    case 'space-editor':
      return isOptionalNonEmptyString(value.spaceId, 128);
    case 'settings':
      return (
        value.section === undefined ||
        ['general', 'spaces', 'privacy', 'shields', 'shortcuts', 'extensions', 'import', 'updates'].includes(String(value.section))
      );
    default:
      return false;
  }
}

export function isExplicitDangerousUrlInput(rawUrl: string): boolean {
  const sanitized = rawUrl.replace(/[\u0000-\u0020]+/g, '');
  return DISALLOWED_EXPLICIT_SCHEME_RE.test(sanitized);
}

export class TrustedIpcRegistry {
  private readonly rolesBySenderId = new Map<number, TrustedIpcRole>();
  private readonly allowedBaseUrls = new Set<string>();

  addAllowedBaseUrl(baseUrl: string): void {
    const clean = baseUrl.split('?')[0].split('#')[0];
    if (clean) {
      this.allowedBaseUrls.add(clean);
    }
  }

  register(senderId: number, role: TrustedIpcRole): void {
    this.rolesBySenderId.set(senderId, role);
  }

  unregister(senderId: number): void {
    this.rolesBySenderId.delete(senderId);
  }

  isTrusted(
    senderId: number,
    senderFrameUrl: string | undefined,
    allowedRoles?: TrustedIpcRole[]
  ): boolean {
    const role = this.rolesBySenderId.get(senderId);
    if (!role) return false;
    if (allowedRoles && !allowedRoles.includes(role)) return false;

    if (!senderFrameUrl || this.allowedBaseUrls.size === 0) return false;
    const cleanFrame = senderFrameUrl.split('?')[0].split('#')[0];
    if (!this.allowedBaseUrls.has(cleanFrame)) return false;
    return true;
  }
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

export function validateIntent(raw: unknown): ValidationResult<KinexIntent> {
  if (!isRecord(raw) || typeof raw.type !== 'string') {
    return { ok: false, error: 'Intent must be an object with a string type' };
  }

  switch (raw.type) {
    case 'run-command':
      return isCommandId(raw.commandId)
        ? { ok: true, value: { type: 'run-command', commandId: raw.commandId } }
        : { ok: false, error: 'Unknown browser command' };
    case 'focus-region':
      return raw.region === 'content' || raw.region === 'sidebar' || raw.region === 'toolbar'
        ? { ok: true, value: { type: 'focus-region', region: raw.region } }
        : { ok: false, error: 'Invalid focus region' };
    case 'select-space':
    case 'delete-space':
      return isNonEmptyString(raw.spaceId, 128)
        ? { ok: true, value: { type: raw.type, spaceId: raw.spaceId } }
        : { ok: false, error: 'Invalid spaceId' };

    case 'clear-today-tabs':
      return isNonEmptyString(raw.spaceId, 128)
        ? { ok: true, value: { type: 'clear-today-tabs', spaceId: raw.spaceId } }
        : { ok: false, error: 'Invalid spaceId' };

    case 'create-space':
      return isNonEmptyString(raw.name, 128) &&
        isNonEmptyString(raw.icon, 32) &&
        isSpaceTheme(raw.theme) &&
        isSafeProfilePartition(raw.profilePartition)
        ? {
            ok: true,
            value: {
              type: 'create-space',
              name: raw.name.trim(),
              icon: raw.icon.trim(),
              theme: raw.theme,
              profilePartition: raw.profilePartition,
            },
          }
        : { ok: false, error: 'Invalid create-space payload' };

    case 'update-space':
      return isNonEmptyString(raw.spaceId, 128) &&
        isNonEmptyString(raw.name, 128) &&
        isNonEmptyString(raw.icon, 32) &&
        isSpaceTheme(raw.theme) &&
        isSafeProfilePartition(raw.profilePartition)
        ? {
            ok: true,
            value: {
              type: 'update-space',
              spaceId: raw.spaceId,
              name: raw.name.trim(),
              icon: raw.icon.trim(),
              theme: raw.theme,
              profilePartition: raw.profilePartition,
            },
          }
        : { ok: false, error: 'Invalid update-space payload' };

    case 'rename-space':
      return isNonEmptyString(raw.spaceId, 128) && isNonEmptyString(raw.name, 128)
        ? { ok: true, value: { type: 'rename-space', spaceId: raw.spaceId, name: raw.name.trim() } }
        : { ok: false, error: 'Invalid rename-space payload' };

    case 'reorder-space':
      return isNonEmptyString(raw.sourceSpaceId, 128) && isNonEmptyString(raw.targetSpaceId, 128)
        ? {
            ok: true,
            value: {
              type: 'reorder-space',
              sourceSpaceId: raw.sourceSpaceId,
              targetSpaceId: raw.targetSpaceId,
            },
          }
        : { ok: false, error: 'Invalid reorder-space payload' };

    case 'create-profile':
      return isNonEmptyString(raw.name, 128)
        ? { ok: true, value: { type: 'create-profile', name: raw.name.trim() } }
        : { ok: false, error: 'Invalid profile name' };

    case 'create-folder':
      return isNonEmptyString(raw.spaceId, 128) && isNonEmptyString(raw.name, 128)
        ? { ok: true, value: { type: 'create-folder', spaceId: raw.spaceId, name: raw.name.trim() } }
        : { ok: false, error: 'Invalid create-folder payload' };

    case 'toggle-folder':
    case 'delete-folder':
      return isNonEmptyString(raw.folderId, 128)
        ? { ok: true, value: { type: raw.type, folderId: raw.folderId } }
        : { ok: false, error: 'Invalid folderId' };

    case 'rename-folder':
      return isNonEmptyString(raw.folderId, 128) && isNonEmptyString(raw.name, 128)
        ? { ok: true, value: { type: 'rename-folder', folderId: raw.folderId, name: raw.name.trim() } }
        : { ok: false, error: 'Invalid rename-folder payload' };

    case 'move-tab-to-folder':
      return isNonEmptyString(raw.tabId, 128) && isOptionalNonEmptyString(raw.folderId, 128)
        ? { ok: true, value: { type: 'move-tab-to-folder', tabId: raw.tabId, folderId: raw.folderId } }
        : { ok: false, error: 'Invalid move-tab-to-folder payload' };

    case 'move-tab-to-space':
      return isNonEmptyString(raw.tabId, 128) && isNonEmptyString(raw.spaceId, 128)
        ? { ok: true, value: { type: 'move-tab-to-space', tabId: raw.tabId, spaceId: raw.spaceId } }
        : { ok: false, error: 'Invalid move-tab-to-space payload' };

    case 'reorder-tab':
      return isNonEmptyString(raw.sourceTabId, 128) && isNonEmptyString(raw.targetTabId, 128)
        ? { ok: true, value: { type: 'reorder-tab', sourceTabId: raw.sourceTabId, targetTabId: raw.targetTabId } }
        : { ok: false, error: 'Invalid reorder-tab payload' };

    case 'copy-text':
      return typeof raw.text === 'string' && raw.text.length <= 256
        ? { ok: true, value: { type: 'copy-text', text: raw.text } }
        : { ok: false, error: 'Invalid text to copy' };

    case 'select-tab':
      return isNonEmptyString(raw.tabId, 128) &&
        (raw.paneIndex === undefined || (isFiniteNumber(raw.paneIndex) && (raw.paneIndex === 0 || raw.paneIndex === 1)))
        ? { ok: true, value: { type: 'select-tab', tabId: raw.tabId, paneIndex: raw.paneIndex } }
        : { ok: false, error: 'Invalid select-tab payload' };

    case 'duplicate-tab':
    case 'close-tab':
    case 'close-other-tabs':
    case 'close-tabs-to-right':
    case 'reset-pinned-tab':
    case 'toggle-mute':
      return isNonEmptyString(raw.tabId, 128)
        ? { ok: true, value: { type: raw.type, tabId: raw.tabId } }
        : { ok: false, error: 'Invalid tabId' };

    case 'reopen-closed-tab':
      return isOptionalNonEmptyString(raw.closedId, 128)
        ? { ok: true, value: { type: 'reopen-closed-tab', closedId: raw.closedId } }
        : { ok: false, error: 'Invalid closedId' };

    case 'restore-closed-group':
      return isNonEmptyString(raw.groupId, 128)
        ? { ok: true, value: { type: 'restore-closed-group', groupId: raw.groupId } }
        : { ok: false, error: 'Invalid groupId' };

    case 'clear-closed-tabs':
      return { ok: true, value: { type: 'clear-closed-tabs' } };

    case 'open-url':
      if (
        !isString(raw.url, MAX_URL_LEN) ||
        typeof raw.target !== 'string' ||
        !OPEN_TARGETS.has(raw.target) ||
        !isOptionalNonEmptyString(raw.spaceId, 128) ||
        (raw.duplicatePolicy !== undefined &&
          (typeof raw.duplicatePolicy !== 'string' || !DUPLICATE_POLICIES.has(raw.duplicatePolicy)))
      ) {
        return { ok: false, error: 'Invalid open-url payload' };
      }
      if (isExplicitDangerousUrlInput(raw.url)) {
        return { ok: false, error: 'Blocked unsafe URL scheme' };
      }
      return {
        ok: true,
        value: {
          type: 'open-url',
          url: raw.url,
          target: raw.target as Extract<KinexIntent, { type: 'open-url' }>['target'],
          spaceId: raw.spaceId,
          ...(raw.duplicatePolicy
            ? { duplicatePolicy: raw.duplicatePolicy as 'prompt' | 'allow' }
            : {}),
        },
      };

    case 'resolve-duplicate-open':
      return typeof raw.decision === 'string' && DUPLICATE_DECISIONS.has(raw.decision)
        ? {
            ok: true,
            value: {
              type: 'resolve-duplicate-open',
              decision: raw.decision as 'switch-existing' | 'open-anyway' | 'cancel',
            },
          }
        : { ok: false, error: 'Invalid duplicate open decision' };

    case 'set-tab-location':
      return isNonEmptyString(raw.tabId, 128) &&
        typeof raw.location === 'string' &&
        TAB_LOCATIONS.has(raw.location as TabLocation)
        ? {
            ok: true,
            value: { type: 'set-tab-location', tabId: raw.tabId, location: raw.location as TabLocation },
          }
        : { ok: false, error: 'Invalid set-tab-location payload' };

    case 'restore-archived-tab':
      return isNonEmptyString(raw.archivedId, 128)
        ? { ok: true, value: { type: 'restore-archived-tab', archivedId: raw.archivedId } }
        : { ok: false, error: 'Invalid archivedId' };

    case 'toggle-split':
      return isOptionalNonEmptyString(raw.tabId, 128)
        ? { ok: true, value: { type: 'toggle-split', tabId: raw.tabId } }
        : { ok: false, error: 'Invalid toggle-split payload' };

    case 'close-split-pane':
    case 'focus-pane':
      return isFiniteNumber(raw.paneIndex) && (raw.paneIndex === 0 || raw.paneIndex === 1)
        ? { ok: true, value: { type: raw.type, paneIndex: raw.paneIndex } }
        : { ok: false, error: 'Invalid paneIndex' };

    case 'set-split-ratio':
      return isFiniteNumber(raw.ratio)
        ? { ok: true, value: { type: 'set-split-ratio', ratio: Math.min(0.8, Math.max(0.2, raw.ratio)) } }
        : { ok: false, error: 'Invalid split ratio' };

    case 'nav-back':
    case 'nav-forward':
    case 'nav-reload':
    case 'nav-stop':
    case 'copy-current-url':
      return isOptionalNonEmptyString(raw.tabId, 128)
        ? { ok: true, value: { type: raw.type, tabId: raw.tabId } }
        : { ok: false, error: 'Invalid optional tabId' };

    case 'set-zoom':
      return (raw.delta === 'in' || raw.delta === 'out' || raw.delta === 'reset') &&
        isOptionalNonEmptyString(raw.tabId, 128)
        ? { ok: true, value: { type: 'set-zoom', delta: raw.delta, tabId: raw.tabId } }
        : { ok: false, error: 'Invalid zoom delta' };

    case 'toggle-sidebar':
      return raw.open === undefined || typeof raw.open === 'boolean'
        ? { ok: true, value: { type: 'toggle-sidebar', open: raw.open } }
        : { ok: false, error: 'Invalid sidebar open flag' };

    case 'toggle-sidebar-collapse':
      return raw.collapsed === undefined || typeof raw.collapsed === 'boolean'
        ? { ok: true, value: { type: 'toggle-sidebar-collapse', collapsed: raw.collapsed } }
        : { ok: false, error: 'Invalid sidebar collapse flag' };

    case 'set-hover-peek':
      return typeof raw.enabled === 'boolean'
        ? { ok: true, value: { type: 'set-hover-peek', enabled: raw.enabled } }
        : { ok: false, error: 'Invalid hover peek flag' };

    case 'set-sidebar-peeking':
      return typeof raw.peeking === 'boolean'
        ? { ok: true, value: { type: 'set-sidebar-peeking', peeking: raw.peeking } }
        : { ok: false, error: 'Invalid sidebar peeking flag' };

    case 'set-sidebar-width':
      return isFiniteNumber(raw.width)
        ? { ok: true, value: { type: 'set-sidebar-width', width: Math.min(380, Math.max(200, Math.round(raw.width))) } }
        : { ok: false, error: 'Invalid sidebar width' };

    case 'set-overlay':
      return isOverlayState(raw.overlay)
        ? { ok: true, value: { type: 'set-overlay', overlay: raw.overlay } }
        : { ok: false, error: 'Invalid overlay payload' };

    case 'set-search-engine':
      return typeof raw.engine === 'string' && SEARCH_ENGINES.has(raw.engine as SearchEngineId)
        ? { ok: true, value: { type: 'set-search-engine', engine: raw.engine as SearchEngineId } }
        : { ok: false, error: 'Invalid search engine' };

    case 'set-https-only':
    case 'set-clean-copy-url':
      return typeof raw.enabled === 'boolean'
        ? { ok: true, value: { type: raw.type, enabled: raw.enabled } }
        : { ok: false, error: 'Invalid boolean enabled flag' };

    case 'revoke-site-permission':
      return isSafeProfilePartition(raw.partition) && isNonEmptyString(raw.partition, 256) &&
        isNonEmptyString(raw.origin, 512) && isNonEmptyString(raw.permission, 128)
        ? { ok: true, value: { type: 'revoke-site-permission', partition: raw.partition, origin: raw.origin, permission: raw.permission } }
        : { ok: false, error: 'Invalid revoke-site-permission payload' };

    case 'save-air-traffic-rule':
      return isAirTrafficRule(raw.rule)
        ? { ok: true, value: { type: 'save-air-traffic-rule', rule: raw.rule } }
        : { ok: false, error: 'Invalid air traffic rule' };

    case 'delete-air-traffic-rule':
      return isNonEmptyString(raw.ruleId, 128)
        ? { ok: true, value: { type: 'delete-air-traffic-rule', ruleId: raw.ruleId } }
        : { ok: false, error: 'Invalid ruleId' };

    case 'clear-browsing-data':
      return Array.isArray(raw.scopes) &&
        raw.scopes.every((s) => typeof s === 'string' && CLEAR_SCOPES.has(s))
        ? {
            ok: true,
            value: {
              type: 'clear-browsing-data',
              scopes: raw.scopes as Array<'history' | 'cookies' | 'cache' | 'archived'>,
            },
          }
        : { ok: false, error: 'Invalid clear-browsing-data scopes' };

    case 'save-boost':
      return isBoostRule(raw.boost)
        ? { ok: true, value: { type: 'save-boost', boost: raw.boost } }
        : { ok: false, error: 'Invalid boost rule' };

    case 'delete-boost':
    case 'toggle-boost-enabled':
      return isNonEmptyString(raw.boostId, 128)
        ? { ok: true, value: { type: raw.type, boostId: raw.boostId } }
        : { ok: false, error: 'Invalid boostId' };

    case 'start-zapper':
    case 'stop-zapper':
    case 'toggle-adblock':
    case 'update-filter-lists':
    case 'restore-default-filter-lists':
    case 'start-element-picker':
    case 'stop-element-picker':
    case 'open-devtools':
    case 'print-page':
    case 'stop-find-in-page':
    case 'set-default-browser':
    case 'check-for-updates':
    case 'download-update':
    case 'install-update':
    case 'open-update-release':
      return { ok: true, value: { type: raw.type } };

    case 'set-shields-global-mode':
      return typeof raw.mode === 'string' && SHIELDS_MODES.has(raw.mode as ShieldsMode)
        ? { ok: true, value: { type: 'set-shields-global-mode', mode: raw.mode as ShieldsMode } }
        : { ok: false, error: 'Invalid Shields global mode' };

    case 'set-shields-site-mode':
      return isNonEmptyString(raw.domain, 255) &&
        typeof raw.mode === 'string' &&
        (raw.mode === 'inherit' || SHIELDS_MODES.has(raw.mode as ShieldsMode))
        ? {
            ok: true,
            value: {
              type: 'set-shields-site-mode',
              domain: raw.domain.trim().toLowerCase(),
              mode: raw.mode as ShieldsMode | 'inherit',
            },
          }
        : { ok: false, error: 'Invalid Shields per-site override' };

    case 'set-shields-strip-params':
      return typeof raw.enabled === 'boolean'
        ? { ok: true, value: { type: 'set-shields-strip-params', enabled: raw.enabled } }
        : { ok: false, error: 'Invalid stripTrackingParams flag' };

    case 'set-shields-cosmetic-enabled':
      return typeof raw.enabled === 'boolean'
        ? { ok: true, value: { type: 'set-shields-cosmetic-enabled', enabled: raw.enabled } }
        : { ok: false, error: 'Invalid cosmeticFilteringEnabled flag' };

    case 'toggle-filter-list':
      return isNonEmptyString(raw.listId, 128) && typeof raw.enabled === 'boolean'
        ? { ok: true, value: { type: 'toggle-filter-list', listId: raw.listId, enabled: raw.enabled } }
        : { ok: false, error: 'Invalid filter list toggle payload' };

    case 'add-shields-cosmetic-rule':
    case 'remove-shields-cosmetic-rule':
      return isNonEmptyString(raw.domain, 255) &&
        isNonEmptyString(raw.selector, 512) &&
        !/[{}\n\r;]/.test(raw.selector)
        ? {
            ok: true,
            value: {
              type: raw.type,
              domain: raw.domain.trim().toLowerCase(),
              selector: raw.selector.trim(),
            },
          }
        : { ok: false, error: 'Invalid cosmetic rule domain or selector' };

    case 'open-incognito':
      if (!isOptionalString(raw.url, MAX_URL_LEN)) {
        return { ok: false, error: 'Invalid incognito URL' };
      }
      if (raw.url && isExplicitDangerousUrlInput(raw.url)) {
        return { ok: false, error: 'Blocked unsafe URL scheme for private window' };
      }
      return { ok: true, value: { type: 'open-incognito', url: raw.url } };

    case 'find-in-page':
      return isString(raw.text, 512) &&
        (raw.forward === undefined || typeof raw.forward === 'boolean') &&
        (raw.findNext === undefined || typeof raw.findNext === 'boolean')
        ? {
            ok: true,
            value: {
              type: 'find-in-page',
              text: raw.text,
              forward: raw.forward,
              findNext: raw.findNext,
            },
          }
        : { ok: false, error: 'Invalid find-in-page payload' };

    case 'promote-little-nook':
      return isNonEmptyString(raw.url, MAX_URL_LEN) &&
        isSafeNavigationUrl(raw.url) &&
        isString(raw.title, 512)
        ? { ok: true, value: { type: 'promote-little-nook', url: raw.url, title: raw.title } }
        : { ok: false, error: 'Invalid promote URL or title' };

    case 'import-browser-data':
      return typeof raw.source === 'string' && IMPORT_SOURCES.has(raw.source)
        ? { ok: true, value: { type: 'import-browser-data', source: raw.source as 'arc' | 'chrome' | 'file' } }
        : { ok: false, error: 'Invalid import source' };

    case 'show-download-in-finder':
      return isNonEmptyString(raw.savePath, MAX_URL_LEN)
        ? { ok: true, value: { type: 'show-download-in-finder', savePath: raw.savePath } }
        : { ok: false, error: 'Invalid download path' };

    case 'pause-download':
    case 'resume-download':
    case 'cancel-download':
    case 'open-download':
      return isNonEmptyString(raw.downloadId, 128)
        ? { ok: true, value: { type: raw.type, downloadId: raw.downloadId } }
        : { ok: false, error: 'Invalid downloadId' };

    case 'clear-completed-downloads':
      return { ok: true, value: { type: 'clear-completed-downloads' } };

    case 'save-page-pdf':
      return { ok: true, value: { type: 'save-page-pdf' } };

    case 'toggle-reader-mode':
      return isOptionalNonEmptyString(raw.tabId, 128)
        ? { ok: true, value: { type: 'toggle-reader-mode', tabId: raw.tabId } }
        : { ok: false, error: 'Invalid tabId' };

    case 'set-reader-options': {
      if (!isRecord(raw.options)) return { ok: false, error: 'Invalid reader options' };
      const opts = raw.options;
      if (opts.fontSize !== undefined && (!isFiniteNumber(opts.fontSize) || opts.fontSize < 12 || opts.fontSize > 28)) {
        return { ok: false, error: 'Invalid reader fontSize' };
      }
      if (opts.theme !== undefined && (typeof opts.theme !== 'string' || !READER_THEMES.has(opts.theme))) {
        return { ok: false, error: 'Invalid reader theme' };
      }
      return {
        ok: true,
        value: {
          type: 'set-reader-options',
          options: {
            ...(typeof opts.fontSize === 'number' ? { fontSize: Math.round(opts.fontSize) } : {}),
            ...(opts.theme ? { theme: opts.theme as 'light' | 'sepia' | 'dark' } : {}),
          },
        },
      };
    }

    case 'set-update-feed-url':
      return isString(raw.url, MAX_URL_LEN) && isSafeUpdateFeedUrl(raw.url)
        ? { ok: true, value: { type: 'set-update-feed-url', url: raw.url.trim() } }
        : { ok: false, error: 'Update feed must be an HTTPS URL, localhost, or a local directory path' };

    case 'set-auto-picture-in-picture':
      return typeof raw.enabled === 'boolean'
        ? { ok: true, value: { type: 'set-auto-picture-in-picture', enabled: raw.enabled } }
        : { ok: false, error: 'Invalid auto Picture-in-Picture flag' };

    case 'set-memory-saver-timeout':
      return typeof raw.timeout === 'string' && MEMORY_SAVER_TIMEOUTS.has(raw.timeout as MemorySaverTimeout)
        ? { ok: true, value: { type: 'set-memory-saver-timeout', timeout: raw.timeout as MemorySaverTimeout } }
        : { ok: false, error: 'Invalid memory saver timeout' };

    case 'set-memory-saver-exempt-pinned':
      return typeof raw.exempt === 'boolean'
        ? { ok: true, value: { type: 'set-memory-saver-exempt-pinned', exempt: raw.exempt } }
        : { ok: false, error: 'Invalid memory saver exempt flag' };

    case 'discard-tab':
      return isNonEmptyString(raw.tabId, 128)
        ? { ok: true, value: { type: 'discard-tab', tabId: raw.tabId } }
        : { ok: false, error: 'Invalid tabId' };

    case 'install-extension':
      return isNonEmptyString(raw.sourcePath, MAX_URL_LEN) && path.isAbsolute(raw.sourcePath)
        ? { ok: true, value: { type: 'install-extension', sourcePath: raw.sourcePath } }
        : { ok: false, error: 'Invalid extension folder path' };

    case 'install-extension-crx':
      return isNonEmptyString(raw.sourcePath, MAX_URL_LEN) && path.isAbsolute(raw.sourcePath) &&
        path.extname(raw.sourcePath).toLowerCase() === '.crx'
        ? { ok: true, value: { type: 'install-extension-crx', sourcePath: raw.sourcePath } }
        : { ok: false, error: 'Invalid CRX file path' };

    case 'install-extension-webstore': {
      const item = parseWebStoreUrl(raw.url);
      if (!item) return { ok: false, error: 'Invalid Chrome Web Store URL or extension id' };
      if (raw.consent !== true) {
        return { ok: false, error: 'Web Store installation requires explicit consent' };
      }
      return { ok: true, value: { type: 'install-extension-webstore', url: item.itemUrl, consent: true } };
    }

    case 'uninstall-extension':
      return typeof raw.extensionId === 'string' && EXTENSION_ID_RE.test(raw.extensionId)
        ? { ok: true, value: { type: 'uninstall-extension', extensionId: raw.extensionId } }
        : { ok: false, error: 'Invalid extension id' };

    case 'open-extension-popup':
      return typeof raw.extensionId === 'string' && EXTENSION_ID_RE.test(raw.extensionId) && isAnchorRect(raw.anchor)
        ? {
            ok: true,
            value: {
              type: 'open-extension-popup',
              extensionId: raw.extensionId,
              ...(raw.anchor ? {
                anchor: {
                  x: Math.trunc(raw.anchor.x),
                  y: Math.trunc(raw.anchor.y),
                  width: Math.trunc(raw.anchor.width),
                  height: Math.trunc(raw.anchor.height),
                },
              } : {}),
            },
          }
        : { ok: false, error: 'Invalid extension popup request' };

    case 'set-extension-enabled':
      return typeof raw.extensionId === 'string' && EXTENSION_ID_RE.test(raw.extensionId) &&
        typeof raw.enabled === 'boolean' &&
        (raw.consent === undefined || typeof raw.consent === 'boolean')
        ? {
            ok: true,
            value: {
              type: 'set-extension-enabled',
              extensionId: raw.extensionId,
              enabled: raw.enabled,
              ...(typeof raw.consent === 'boolean' ? { consent: raw.consent } : {}),
            },
          }
        : { ok: false, error: 'Invalid extension enabled payload' };

    case 'close-extension-popup':
      return { ok: true, value: { type: 'close-extension-popup' } };

    case 'set-new-tab-config': {
      if (!isRecord(raw.config)) return { ok: false, error: 'Invalid newTabConfig' };
      const cfg = raw.config;
      if (cfg.preset !== undefined && (typeof cfg.preset !== 'string' || !NEW_TAB_PRESETS.has(cfg.preset))) {
        return { ok: false, error: 'Invalid new tab preset' };
      }
      if (
        cfg.background !== undefined &&
        (typeof cfg.background !== 'string' || !NEW_TAB_BACKGROUNDS.has(cfg.background))
      ) {
        return { ok: false, error: 'Invalid new tab background' };
      }
      if (cfg.showClock !== undefined && typeof cfg.showClock !== 'boolean') {
        return { ok: false, error: 'Invalid showClock flag' };
      }
      if (cfg.showFavorites !== undefined && typeof cfg.showFavorites !== 'boolean') {
        return { ok: false, error: 'Invalid showFavorites flag' };
      }
      if (cfg.showFrequent !== undefined && typeof cfg.showFrequent !== 'boolean') {
        return { ok: false, error: 'Invalid showFrequent flag' };
      }
      return {
        ok: true,
        value: {
          type: 'set-new-tab-config',
          config: {
            ...(cfg.preset ? { preset: cfg.preset as 'minimal' | 'focus' | 'personal' } : {}),
            ...(cfg.background ? { background: cfg.background as 'clean' | 'mist' | 'dusk' | 'sage' } : {}),
            ...(typeof cfg.showClock === 'boolean' ? { showClock: cfg.showClock } : {}),
            ...(typeof cfg.showFavorites === 'boolean' ? { showFavorites: cfg.showFavorites } : {}),
            ...(typeof cfg.showFrequent === 'boolean' ? { showFrequent: cfg.showFrequent } : {}),
          },
        },
      };
    }

    case 'show-web-context-menu': {
      const safe = sanitizeContextPayload(raw);
      return {
        ok: true,
        value: {
          type: 'show-web-context-menu',
          linkUrl: safe.navigationLinkUrl ?? undefined,
          imageUrl: safe.imageUrl ?? undefined,
          selectionText: safe.selectionText ?? undefined,
          pageUrl: safe.pageLinkUrl ?? undefined,
          isEditable: safe.isEditable,
          mediaFlags: safe.media,
        },
      };
    }

    case 'capture-screenshot': {
      if (raw.area !== 'visible' && raw.area !== 'selection') {
        return { ok: false, error: 'Invalid screenshot area' };
      }
      if (raw.rect !== undefined && !isBoundedRect(raw.rect)) {
        return { ok: false, error: 'Invalid capture rect' };
      }
      if (raw.target !== undefined && raw.target !== 'clipboard' && raw.target !== 'file') {
        return { ok: false, error: 'Invalid screenshot target' };
      }
      if (!isOptionalString(raw.title, 256)) {
        return { ok: false, error: 'Invalid screenshot title' };
      }
      return {
        ok: true,
        value: {
          type: 'capture-screenshot',
          area: raw.area,
          ...(raw.rect ? { rect: raw.rect } : {}),
          ...(raw.target ? { target: raw.target } : {}),
          ...(raw.title ? { title: raw.title } : {}),
        },
      };
    }

    case 'save-page-mhtml':
      return { ok: true, value: { type: 'save-page-mhtml' } };

    case 'open-console':
      return { ok: true, value: { type: 'open-console' } };

    case 'view-source':
      return { ok: true, value: { type: 'view-source' } };

    case 'download-url':
      return isNonEmptyString(raw.url, MAX_URL_LEN) && isSafeNavigationUrl(raw.url)
        ? { ok: true, value: { type: 'download-url', url: raw.url } }
        : { ok: false, error: 'Invalid download URL' };

    case 'swipe-navigation':
      return isFiniteNumber(raw.deltaX) && isFiniteNumber(raw.deltaY) &&
        Math.abs(raw.deltaX) <= 20000 && Math.abs(raw.deltaY) <= 20000 &&
        (raw.x === undefined || isFiniteNumber(raw.x)) &&
        (raw.viewportWidth === undefined || isFiniteNumber(raw.viewportWidth)) &&
        (raw.reducedMotion === undefined || typeof raw.reducedMotion === 'boolean')
        ? {
            ok: true,
            value: {
              type: 'swipe-navigation',
              deltaX: raw.deltaX,
              deltaY: raw.deltaY,
              ...(raw.x !== undefined ? { x: raw.x } : {}),
              ...(raw.viewportWidth !== undefined ? { viewportWidth: raw.viewportWidth } : {}),
              ...(raw.reducedMotion !== undefined ? { reducedMotion: raw.reducedMotion } : {}),
            },
          }
        : { ok: false, error: 'Invalid swipe input' };

    case 'set-auto-archive-timeout':
      return isAutoArchiveTimeout(raw.timeout)
        ? { ok: true, value: { type: 'set-auto-archive-timeout', timeout: raw.timeout } }
        : { ok: false, error: 'Invalid auto-archive timeout' };

    case 'query-archive-vault':
      return isNonEmptyString(raw.query, 256) && isOptionalString(raw.spaceId, 128)
        ? { ok: true, value: { type: 'query-archive-vault', query: raw.query, spaceId: raw.spaceId } }
        : { ok: false, error: 'Invalid archive query' };

    case 'move-folder':
      return isNonEmptyString(raw.folderId, 128) &&
        (raw.parentId === undefined || (isNonEmptyString(raw.parentId, 128) && raw.parentId !== raw.folderId))
        ? { ok: true, value: { type: 'move-folder', folderId: raw.folderId, parentId: raw.parentId } }
        : { ok: false, error: 'Invalid folder move' };

    case 'set-site-cookie-policy': {
      const checked = validateSiteControlMutation({ ...(isRecord(raw) ? raw : {}), type: 'set-site-cookie-policy' });
      return checked.ok && checked.mutation.type === 'set-site-cookie-policy'
        ? { ok: true, value: { type: 'set-site-cookie-policy', origin: checked.mutation.origin, policy: checked.mutation.policy } }
        : { ok: false, error: 'Invalid site cookie policy' };
    }

    case 'set-site-permission': {
      const checked = validateSiteControlMutation({ ...(isRecord(raw) ? raw : {}), type: 'set-site-permission' });
      return checked.ok && checked.mutation.type === 'set-site-permission'
        ? { ok: true, value: { type: 'set-site-permission', origin: checked.mutation.origin, permission: checked.mutation.permission, decision: checked.mutation.decision } }
        : { ok: false, error: 'Invalid site permission mutation' };
    }

    case 'toggle-reading-list':
      return isNonEmptyString(raw.url, MAX_URL_LEN) && isSafeNavigationUrl(raw.url) && isNonEmptyString(raw.title, 256)
        ? { ok: true, value: { type: 'toggle-reading-list', url: raw.url, title: raw.title } }
        : { ok: false, error: 'Invalid reading-list entry' };

    case 'start-focus-session':
    case 'end-focus-session':
    case 'toggle-focus-session':
      return isNonEmptyString(raw.spaceId, 128)
        ? { ok: true, value: { type: raw.type, spaceId: raw.spaceId } as KinexIntent }
        : { ok: false, error: 'Invalid focus session space' };

    case 'save-focus-rule': {
      const checked = validateFocusRule(raw.rule);
      return checked.ok ? { ok: true, value: { type: 'save-focus-rule', rule: checked.rule } } : { ok: false, error: checked.reason };
    }

    case 'delete-focus-rule':
      return isNonEmptyString(raw.ruleId, 128) && isNonEmptyString(raw.spaceId, 128)
        ? { ok: true, value: { type: 'delete-focus-rule', ruleId: raw.ruleId, spaceId: raw.spaceId } }
        : { ok: false, error: 'Invalid focus rule deletion' };

    case 'open-link-peek':
      return isLinkPeekUrl(raw.url) && isBoundedRect(raw.rect) && isSafeProfilePartition(raw.partition)
        ? {
            ok: true,
            value: {
              type: 'open-link-peek',
              url: raw.url as string,
              rect: raw.rect,
              ...(raw.partition ? { partition: raw.partition } : {}),
            },
          }
        : { ok: false, error: 'Invalid Link Peek request' };

    case 'link-peek-action':
      return isLinkPeekAction(raw.action)
        ? { ok: true, value: { type: 'link-peek-action', action: raw.action } }
        : { ok: false, error: 'Invalid Link Peek action' };

    case 'show-share-qr':
      return raw.url === undefined || (isNonEmptyString(raw.url, MAX_URL_LEN) && isSafeNavigationUrl(raw.url))
        ? { ok: true, value: { type: 'show-share-qr', url: raw.url } }
        : { ok: false, error: 'Invalid share URL' };

    case 'set-theme':
      return isThemePreference(raw.theme) ? { ok: true, value: { type: 'set-theme', theme: raw.theme } } : { ok: false, error: 'Invalid theme' };
    case 'set-sidebar-side':
      return isSidebarSide(raw.side) ? { ok: true, value: { type: 'set-sidebar-side', side: raw.side } } : { ok: false, error: 'Invalid sidebar side' };
    case 'set-density':
      return isDensityPreference(raw.density) ? { ok: true, value: { type: 'set-density', density: raw.density } } : { ok: false, error: 'Invalid density' };
    case 'set-accent':
      return isAccentPreference(raw.accent) ? { ok: true, value: { type: 'set-accent', accent: raw.accent } } : { ok: false, error: 'Invalid accent' };
    case 'set-vibrancy':
      return isVibrancyPreference(raw.vibrancy) ? { ok: true, value: { type: 'set-vibrancy', vibrancy: raw.vibrancy } } : { ok: false, error: 'Invalid vibrancy' };
    case 'set-show-full-url':
    case 'set-ask-before-download':
      return typeof raw.enabled === 'boolean'
        ? { ok: true, value: { type: raw.type, enabled: raw.enabled } as KinexIntent }
        : { ok: false, error: 'Invalid boolean preference' };
    case 'set-default-zoom':
      return isFiniteNumber(raw.zoom)
        ? { ok: true, value: { type: 'set-default-zoom', zoom: clampDefaultZoom(raw.zoom) } }
        : { ok: false, error: 'Invalid default zoom' };
    case 'set-startup-behavior':
      return isStartupBehavior(raw.behavior)
        ? { ok: true, value: { type: 'set-startup-behavior', behavior: raw.behavior } }
        : { ok: false, error: 'Invalid startup behavior' };
    case 'set-startup-urls':
      return isBoundedStringArray(raw.urls, MAX_STARTUP_URLS) && raw.urls.every((url) => isSafeNavigationUrl(url))
        ? { ok: true, value: { type: 'set-startup-urls', urls: raw.urls } }
        : { ok: false, error: 'Invalid startup URLs' };
    case 'set-custom-search-engine':
      return raw.engine === null || normalizeCustomSearchEngine(raw.engine) !== null
        ? { ok: true, value: { type: 'set-custom-search-engine', engine: raw.engine === null ? null : normalizeCustomSearchEngine(raw.engine) } }
        : { ok: false, error: 'Invalid custom search engine' };
    case 'set-download-folder':
      return isNonEmptyString(raw.folder, MAX_STRING_LEN)
        ? { ok: true, value: { type: 'set-download-folder', folder: raw.folder } }
        : { ok: false, error: 'Invalid download folder' };
    case 'set-third-party-cookies':
      return isThirdPartyCookiesPolicy(raw.policy)
        ? { ok: true, value: { type: 'set-third-party-cookies', policy: raw.policy } }
        : { ok: false, error: 'Invalid third-party cookie policy' };
    case 'set-referrer-policy':
      return isReferrerPolicy(raw.policy)
        ? { ok: true, value: { type: 'set-referrer-policy', policy: raw.policy } }
        : { ok: false, error: 'Invalid referrer policy' };
    case 'set-webrtc-policy':
      return isWebRtcPolicy(raw.policy)
        ? { ok: true, value: { type: 'set-webrtc-policy', policy: raw.policy } }
        : { ok: false, error: 'Invalid WebRTC policy' };
    case 'set-custom-filter-urls':
      return isBoundedStringArray(raw.urls, MAX_CUSTOM_FILTER_URLS) && raw.urls.every((url) => /^https:\/\//i.test(url))
        ? { ok: true, value: { type: 'set-custom-filter-urls', urls: raw.urls } }
        : { ok: false, error: 'Invalid custom filter URLs' };
    case 'set-site-whitelist':
      return isBoundedStringArray(raw.sites, MAX_SITE_WHITELIST)
        ? { ok: true, value: { type: 'set-site-whitelist', sites: raw.sites } }
        : { ok: false, error: 'Invalid site whitelist' };
    case 'reset-settings':
      return { ok: true, value: { type: 'reset-settings' } };
    case 'set-custom-shortcut':
      return isNonEmptyString(raw.id, 128) && isNonEmptyString(raw.accelerator, 64)
        ? { ok: true, value: { type: 'set-custom-shortcut', id: raw.id, accelerator: raw.accelerator } }
        : { ok: false, error: 'Invalid custom shortcut' };
    case 'remove-custom-shortcut':
      return isNonEmptyString(raw.id, 128)
        ? { ok: true, value: { type: 'remove-custom-shortcut', id: raw.id } }
        : { ok: false, error: 'Invalid shortcut id' };
    case 'reset-custom-shortcuts':
      return { ok: true, value: { type: 'reset-custom-shortcuts' } };
    case 'reset-welcome-card':
      return { ok: true, value: { type: 'reset-welcome-card' } };
    case 'clear-browsing-data-timed':
      return Array.isArray(raw.scopes) && raw.scopes.length > 0 && raw.scopes.every((scope) => isClearDataScope(scope)) &&
        isFiniteNumber(raw.since) && raw.since >= 0 && isOptionalString(raw.spaceId, 128)
        ? { ok: true, value: { type: 'clear-browsing-data-timed', scopes: raw.scopes, since: raw.since, ...(raw.spaceId ? { spaceId: raw.spaceId as string } : {}) } }
        : { ok: false, error: 'Invalid timed data deletion' };
    case 'remove-history-entry':
      return isNonEmptyString(raw.url, MAX_URL_LEN)
        ? { ok: true, value: { type: 'remove-history-entry', url: raw.url } }
        : { ok: false, error: 'Invalid history entry' };
    case 'remove-bookmark':
      return isNonEmptyString(raw.tabId, 128)
        ? { ok: true, value: { type: 'remove-bookmark', tabId: raw.tabId } }
        : { ok: false, error: 'Invalid bookmark id' };

    default:
      return { ok: false, error: `Unknown intent type: ${String(raw.type)}` };
  }
}

/** Passphrase supplied to encrypted sync operations from the trusted shell. */
export function validatePassphraseInput(raw: unknown): ValidationResult<string> {
  return isNonEmptyString(raw, 256)
    ? { ok: true, value: raw }
    : { ok: false, error: 'Invalid sync passphrase' };
}

export function validateTabContextMenuInput(tabId: unknown): ValidationResult<string> {
  return isNonEmptyString(tabId, 128)
    ? { ok: true, value: tabId }
    : { ok: false, error: 'Invalid tabId' };
}

export function validateLittleKinexActionInput(
  action: unknown,
  url?: unknown
): ValidationResult<{ action: LittleKinexAction; url?: string }> {
  if (typeof action !== 'string' || !LITTLE_ACTIONS.has(action as LittleKinexAction)) {
    return { ok: false, error: 'Invalid little-kinex action' };
  }
  if (!isOptionalString(url, MAX_URL_LEN)) {
    return { ok: false, error: 'Invalid little-kinex URL' };
  }
  if (url && isExplicitDangerousUrlInput(url)) {
    return { ok: false, error: 'Blocked unsafe URL scheme' };
  }
  return {
    ok: true,
    value: { action: action as LittleKinexAction, url },
  };
}
