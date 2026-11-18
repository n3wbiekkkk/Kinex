/**
 * Pure preference contracts for the Wave 2 settings work.
 *
 * This module deliberately has no Electron or React dependencies so it can be
 * shared by the main and renderer TypeScript projects. It reuses the keyboard
 * normalization semantics from `./commands` rather than duplicating them.
 */
import { BROWSER_COMMANDS, normalizeShortcut } from './commands';

export type ThemePreference = 'system' | 'light' | 'dark';
export type SidebarSide = 'left' | 'right';
export type DensityPreference = 'compact' | 'cozy' | 'spacious';
export type AccentPreference = 'indigo' | 'violet' | 'emerald' | 'amber' | 'rose' | 'cyan';
export type VibrancyPreference = 'off' | 'subtle' | 'full';
export type StartupBehavior = 'new-tab' | 'restore-session' | 'specific-pages';
export type ThirdPartyCookiesPolicy = 'block' | 'allow' | 'incognito-only';
export type ReferrerPolicyPreference =
  | 'strict-origin-when-cross-origin'
  | 'no-referrer'
  | 'origin'
  | 'same-origin'
  | 'unsafe-url';
export type WebRtcPolicy = 'default' | 'public-only' | 'disabled';
export type ClearDataScope = 'history' | 'cookies' | 'cache' | 'archived';

export const THEME_PREFERENCES: readonly ThemePreference[] = ['system', 'light', 'dark'];
export const SIDEBAR_SIDES: readonly SidebarSide[] = ['left', 'right'];
export const DENSITY_PREFERENCES: readonly DensityPreference[] = ['compact', 'cozy', 'spacious'];
export const ACCENT_PREFERENCES: readonly AccentPreference[] = [
  'indigo', 'violet', 'emerald', 'amber', 'rose', 'cyan',
];
export const VIBRANCY_PREFERENCES: readonly VibrancyPreference[] = ['off', 'subtle', 'full'];
export const STARTUP_BEHAVIORS: readonly StartupBehavior[] = [
  'new-tab', 'restore-session', 'specific-pages',
];
export const THIRD_PARTY_COOKIE_POLICIES: readonly ThirdPartyCookiesPolicy[] = [
  'block', 'allow', 'incognito-only',
];
export const REFERRER_POLICIES: readonly ReferrerPolicyPreference[] = [
  'strict-origin-when-cross-origin', 'no-referrer', 'origin', 'same-origin', 'unsafe-url',
];
export const WEBRTC_POLICIES: readonly WebRtcPolicy[] = ['default', 'public-only', 'disabled'];
export const CLEAR_DATA_SCOPES: readonly ClearDataScope[] = [
  'history', 'cookies', 'cache', 'archived',
];

export const DEFAULT_ZOOM_MIN = 0.5;
export const DEFAULT_ZOOM_MAX = 2;
export const MAX_CUSTOM_FILTER_URLS = 50;
export const MAX_SITE_WHITELIST = 200;
export const MAX_STARTUP_URLS = 10;

function oneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}

export function isThemePreference(value: unknown): value is ThemePreference {
  return oneOf(THEME_PREFERENCES, value);
}
export function isSidebarSide(value: unknown): value is SidebarSide {
  return oneOf(SIDEBAR_SIDES, value);
}
export function isDensityPreference(value: unknown): value is DensityPreference {
  return oneOf(DENSITY_PREFERENCES, value);
}
export function isAccentPreference(value: unknown): value is AccentPreference {
  return oneOf(ACCENT_PREFERENCES, value);
}
export function isVibrancyPreference(value: unknown): value is VibrancyPreference {
  return oneOf(VIBRANCY_PREFERENCES, value);
}
export function isStartupBehavior(value: unknown): value is StartupBehavior {
  return oneOf(STARTUP_BEHAVIORS, value);
}
export function isThirdPartyCookiesPolicy(value: unknown): value is ThirdPartyCookiesPolicy {
  return oneOf(THIRD_PARTY_COOKIE_POLICIES, value);
}
export function isReferrerPolicy(value: unknown): value is ReferrerPolicyPreference {
  return oneOf(REFERRER_POLICIES, value);
}
export function isWebRtcPolicy(value: unknown): value is WebRtcPolicy {
  return oneOf(WEBRTC_POLICIES, value);
}
export function isClearDataScope(value: unknown): value is ClearDataScope {
  return oneOf(CLEAR_DATA_SCOPES, value);
}

/** Clamp a default page zoom factor into the supported range. */
export function clampDefaultZoom(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return 1;
  const bounded = Math.min(DEFAULT_ZOOM_MAX, Math.max(DEFAULT_ZOOM_MIN, numeric));
  return Math.round(bounded * 100) / 100;
}

export interface CustomSearchEngine {
  name: string;
  /** HTTPS search URL containing exactly the `%s` query placeholder. */
  template: string;
  /** Address-bar keyword in `@word` form. */
  keyword: string;
}

export function isValidSearchTemplate(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return false;
  if (!value.includes('%s')) return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

export function isValidSearchKeyword(value: unknown): value is string {
  return typeof value === 'string' && /^@[a-z0-9_-]{1,32}$/i.test(value);
}

export function normalizeCustomSearchEngine(value: unknown): CustomSearchEngine | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.name !== 'string' || raw.name.trim().length === 0 || raw.name.length > 64 ||
    !isValidSearchTemplate(raw.template) || !isValidSearchKeyword(raw.keyword)
  ) {
    return null;
  }
  return {
    name: raw.name.trim(),
    template: raw.template.trim(),
    keyword: raw.keyword.trim().toLowerCase(),
  };
}

/** Render a custom search URL without ever interpolating unencoded input. */
export function formatCustomSearchUrl(engine: CustomSearchEngine, query: string): string | null {
  if (!isValidSearchTemplate(engine.template)) return null;
  return engine.template.replace('%s', encodeURIComponent(query));
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** Custom filter lists may only be fetched over HTTPS (or a local loopback for testing). */
export function isValidCustomFilterUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return false;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function normalizeCustomFilterUrls(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const item of value) {
    if (isValidCustomFilterUrl(item) && !result.includes(item)) result.push(item);
    if (result.length >= MAX_CUSTOM_FILTER_URLS) break;
  }
  return result;
}

/** Normalize a host or `*.host` whitelist pattern, stripping any scheme/path. */
export function normalizeSitePattern(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return '';
  if (trimmed === '*') return '*';
  const wildcard = trimmed.startsWith('*.');
  const hostInput = wildcard ? trimmed.slice(2) : trimmed;
  let host = hostInput;
  try {
    host = new URL(hostInput.includes('://') ? hostInput : `https://${hostInput}`).hostname.toLowerCase();
  } catch {
    return '';
  }
  host = host.replace(/^www\./, '');
  return /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(
    wildcard ? `*.${host}` : host
  )
    ? wildcard ? `*.${host}` : host
    : '';
}

export function normalizeSiteWhitelist(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const item of value) {
    const host = normalizeSitePattern(item);
    if (host && !result.includes(host)) result.push(host);
    if (result.length >= MAX_SITE_WHITELIST) break;
  }
  return result;
}

export interface SettingsPreferences {
  theme: ThemePreference;
  sidebarSide: SidebarSide;
  density: DensityPreference;
  accent: AccentPreference;
  vibrancy: VibrancyPreference;
  showFullUrl: boolean;
  defaultZoom: number;
  startupBehavior: StartupBehavior;
  startupUrls: string[];
  customSearchEngine: CustomSearchEngine | null;
  downloadFolder: string;
  askBeforeDownload: boolean;
  thirdPartyCookies: ThirdPartyCookiesPolicy;
  referrerPolicy: ReferrerPolicyPreference;
  webRtcPolicy: WebRtcPolicy;
  httpsOnly: boolean;
  cleanCopyUrl: boolean;
  customFilterUrls: string[];
  siteWhitelist: string[];
}

export const DEFAULT_SETTINGS_PREFERENCES: SettingsPreferences = {
  theme: 'system',
  sidebarSide: 'left',
  density: 'cozy',
  accent: 'indigo',
  vibrancy: 'subtle',
  showFullUrl: false,
  defaultZoom: 1,
  startupBehavior: 'new-tab',
  startupUrls: [],
  customSearchEngine: null,
  downloadFolder: '',
  askBeforeDownload: false,
  thirdPartyCookies: 'block',
  referrerPolicy: 'strict-origin-when-cross-origin',
  webRtcPolicy: 'public-only',
  httpsOnly: true,
  cleanCopyUrl: true,
  customFilterUrls: [],
  siteWhitelist: [],
};

/**
 * Read preferences from an unknown state snapshot, falling back to safe
 * defaults for every field. Unknown/malformed values never become preferences.
 */
export function readSettingsPreferences(
  source: Record<string, unknown> | null | undefined
): SettingsPreferences {
  const s = source ?? {};
  const bool = (key: string, fallback: boolean): boolean =>
    typeof s[key] === 'boolean' ? (s[key] as boolean) : fallback;
  const str = (key: string): string | undefined =>
    typeof s[key] === 'string' ? (s[key] as string) : undefined;
  const startupUrls = Array.isArray(s.startupUrls)
    ? s.startupUrls.filter((u): u is string => typeof u === 'string' && u.length > 0 && u.length <= 2048).slice(0, MAX_STARTUP_URLS)
    : [];

  return {
    theme: isThemePreference(s.theme) ? s.theme : DEFAULT_SETTINGS_PREFERENCES.theme,
    sidebarSide: isSidebarSide(s.sidebarSide) ? s.sidebarSide : DEFAULT_SETTINGS_PREFERENCES.sidebarSide,
    density: isDensityPreference(s.density) ? s.density : DEFAULT_SETTINGS_PREFERENCES.density,
    accent: isAccentPreference(s.accent) ? s.accent : DEFAULT_SETTINGS_PREFERENCES.accent,
    vibrancy: isVibrancyPreference(s.vibrancy) ? s.vibrancy : DEFAULT_SETTINGS_PREFERENCES.vibrancy,
    showFullUrl: bool('showFullUrl', DEFAULT_SETTINGS_PREFERENCES.showFullUrl),
    defaultZoom: clampDefaultZoom(s.defaultZoom ?? DEFAULT_SETTINGS_PREFERENCES.defaultZoom),
    startupBehavior: isStartupBehavior(s.startupBehavior)
      ? s.startupBehavior
      : DEFAULT_SETTINGS_PREFERENCES.startupBehavior,
    startupUrls,
    customSearchEngine: normalizeCustomSearchEngine(s.customSearchEngine),
    downloadFolder: str('downloadFolder') ?? DEFAULT_SETTINGS_PREFERENCES.downloadFolder,
    askBeforeDownload: bool('askBeforeDownload', DEFAULT_SETTINGS_PREFERENCES.askBeforeDownload),
    thirdPartyCookies: isThirdPartyCookiesPolicy(s.thirdPartyCookies)
      ? s.thirdPartyCookies
      : DEFAULT_SETTINGS_PREFERENCES.thirdPartyCookies,
    referrerPolicy: isReferrerPolicy(s.referrerPolicy)
      ? s.referrerPolicy
      : DEFAULT_SETTINGS_PREFERENCES.referrerPolicy,
    webRtcPolicy: isWebRtcPolicy(s.webRtcPolicy) ? s.webRtcPolicy : DEFAULT_SETTINGS_PREFERENCES.webRtcPolicy,
    httpsOnly: bool('httpsOnly', DEFAULT_SETTINGS_PREFERENCES.httpsOnly),
    cleanCopyUrl: bool('cleanCopyUrl', DEFAULT_SETTINGS_PREFERENCES.cleanCopyUrl),
    customFilterUrls: normalizeCustomFilterUrls(s.customFilterUrls),
    siteWhitelist: normalizeSiteWhitelist(s.siteWhitelist),
  };
}

export interface SettingIndexEntry {
  id: string;
  /** SettingsSection id this control lives in. */
  section: string;
  label: string;
  keywords?: string[];
}

/** Searchable catalogue of preference labels and alternate keywords. */
export const SETTINGS_SEARCH_INDEX: readonly SettingIndexEntry[] = [
  { id: 'default-browser', section: 'general', label: 'Default Browser', keywords: ['set default', 'external links'] },
  { id: 'search-engine', section: 'general', label: 'Search Engine', keywords: ['google', 'duckduckgo', 'bing', 'kagi', 'startpage'] },
  { id: 'custom-search-engine', section: 'general', label: 'Custom Search Engine', keywords: ['%s', '@keyword', 'template', 'address bar'] },
  { id: 'theme', section: 'general', label: 'Appearance Theme', keywords: ['dark mode', 'light mode', 'system', 'appearance'] },
  { id: 'sidebar-side', section: 'general', label: 'Sidebar Side', keywords: ['layout', 'left', 'right', 'position'] },
  { id: 'density', section: 'general', label: 'UI Density', keywords: ['compact', 'cozy', 'spacious', 'spacing'] },
  { id: 'accent', section: 'general', label: 'Accent Color', keywords: ['theme color', 'brand', 'appearance'] },
  { id: 'vibrancy', section: 'general', label: 'Window Vibrancy', keywords: ['translucency', 'blur', 'appearance'] },
  { id: 'show-full-url', section: 'general', label: 'Show Full URL', keywords: ['address bar', 'url'] },
  { id: 'default-zoom', section: 'general', label: 'Default Zoom', keywords: ['page zoom', 'magnification', 'scale'] },
  { id: 'startup-behavior', section: 'general', label: 'Startup Behavior', keywords: ['on launch', 'restore session', 'new tab', 'specific pages'] },
  { id: 'startup-urls', section: 'general', label: 'Startup Pages', keywords: ['on launch', 'homepage', 'urls'] },
  { id: 'download-folder', section: 'general', label: 'Download Folder', keywords: ['save location', 'downloads path'] },
  { id: 'ask-before-download', section: 'general', label: 'Ask Before Downloading', keywords: ['save as', 'prompt', 'downloads'] },
  { id: 'memory-saver', section: 'general', label: 'Memory Saver', keywords: ['sleeping tabs', 'performance'] },
  { id: 'new-tab', section: 'general', label: 'New Tab Experience', keywords: ['welcome', 'start page', 'backdrop'] },
  { id: 'https-only', section: 'privacy', label: 'HTTPS-Only Mode', keywords: ['upgrade', 'secure connection'] },
  { id: 'third-party-cookies', section: 'privacy', label: 'Third-Party Cookies', keywords: ['cross-site', 'tracking', 'incognito'] },
  { id: 'referrer-policy', section: 'privacy', label: 'Referrer Policy', keywords: ['strip referrer', 'referer', 'headers'] },
  { id: 'webrtc-policy', section: 'privacy', label: 'WebRTC IP Policy', keywords: ['ip leak', 'public ip', 'relay'] },
  { id: 'clean-copy', section: 'privacy', label: 'Clean Copy URL', keywords: ['tracking parameters', 'utm', 'clipboard'] },
  { id: 'site-whitelist', section: 'privacy', label: 'Site Whitelist', keywords: ['allowlist', 'exceptions', 'domains'] },
  { id: 'site-permissions', section: 'privacy', label: 'Saved Site Permissions', keywords: ['camera', 'microphone', 'notifications', 'clipboard', 'passkey', 'revoke'] },
  { id: 'clear-browsing-data', section: 'privacy', label: 'Clear Browsing Data', keywords: ['history', 'cookies', 'cache', 'timed', 'space'] },
  { id: 'reset-settings', section: 'privacy', label: 'Reset Settings', keywords: ['restore defaults', 'factory reset'] },
  { id: 'custom-filter-urls', section: 'shields', label: 'Custom Filter URLs', keywords: ['filter list', 'subscription', 'blocklist'] },
  { id: 'shields-mode', section: 'shields', label: 'Global Protection Mode', keywords: ['standard', 'aggressive', 'disabled'] },
  { id: 'custom-shortcuts', section: 'shortcuts', label: 'Custom Shortcuts', keywords: ['keyboard', 'accelerator', 'conflict', 'reset'] },
  { id: 'spaces', section: 'spaces', label: 'Spaces & Profiles', keywords: ['workspace', 'profile', 'air traffic'] },
  { id: 'extensions', section: 'extensions', label: 'Extensions', keywords: ['manifest v3', 'crx', 'web store'] },
  { id: 'import', section: 'import', label: 'Import & Data', keywords: ['bookmarks', 'arc', 'chrome'] },
  { id: 'updates', section: 'updates', label: 'Updates & About', keywords: ['version', 'feed', 'release'] },
];

/** Case-insensitive substring search over labels, ids, sections and keywords. */
export function searchSettings(
  query: string,
  entries: readonly SettingIndexEntry[] = SETTINGS_SEARCH_INDEX
): SettingIndexEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...entries];
  return entries.filter((entry) =>
    [entry.label, entry.id, entry.section, ...(entry.keywords ?? [])]
      .some((text) => text.toLowerCase().includes(q))
  );
}

export interface CustomShortcutBinding {
  id: string;
  accelerator: string;
}

export interface ShortcutConflict {
  bindingId: string;
  accelerator: string;
  conflictsWithId: string;
  source: 'built-in' | 'custom';
}

type Platform = 'darwin' | 'win32';

function builtinConflict(key: string, platform: Platform) {
  return BROWSER_COMMANDS.find(
    (command) => command.accelerator && normalizeShortcut(command.accelerator, platform) === key
  );
}

/** Find the first conflict for a single candidate chord, if any. */
export function findShortcutConflict(
  accelerator: string,
  bindings: readonly CustomShortcutBinding[] = [],
  platform: Platform = 'darwin'
): ShortcutConflict | null {
  if (typeof accelerator !== 'string' || accelerator.trim().length === 0) return null;
  const key = normalizeShortcut(accelerator, platform);
  if (!key) return null;
  const builtin = builtinConflict(key, platform);
  if (builtin) {
    return { bindingId: '', accelerator, conflictsWithId: builtin.id, source: 'built-in' };
  }
  const custom = bindings.find(
    (binding) => binding.accelerator && normalizeShortcut(binding.accelerator, platform) === key
  );
  if (custom) {
    return { bindingId: '', accelerator, conflictsWithId: custom.id, source: 'custom' };
  }
  return null;
}

/**
 * Detect every custom binding that collides with a built-in browser chord or
 * with an earlier custom binding. Modifier aliases are normalized via the
 * shared `normalizeShortcut` helper.
 */
export function detectShortcutConflicts(
  bindings: readonly CustomShortcutBinding[],
  platform: Platform = 'darwin'
): ShortcutConflict[] {
  const conflicts: ShortcutConflict[] = [];
  const seen = new Map<string, CustomShortcutBinding>();
  for (const binding of bindings) {
    if (typeof binding.accelerator !== 'string' || binding.accelerator.trim().length === 0) continue;
    const key = normalizeShortcut(binding.accelerator, platform);
    if (!key) continue;
    const builtin = builtinConflict(key, platform);
    if (builtin) {
      conflicts.push({
        bindingId: binding.id,
        accelerator: binding.accelerator,
        conflictsWithId: builtin.id,
        source: 'built-in',
      });
      continue;
    }
    const previous = seen.get(key);
    if (previous) {
      conflicts.push({
        bindingId: binding.id,
        accelerator: binding.accelerator,
        conflictsWithId: previous.id,
        source: 'custom',
      });
    } else {
      seen.set(key, binding);
    }
  }
  return conflicts;
}

/**
 * Every new intent dispatched by the Wave 2 renderer. The orchestrator adds
 * these to `KinexIntent` in `src/shared/types.ts` (and validates them in
 * `ipcValidation.ts`); renderer code casts through `emit` until then.
 */
export type Wave2Intent =
  | { type: 'set-theme'; theme: ThemePreference }
  | { type: 'set-sidebar-side'; side: SidebarSide }
  | { type: 'set-density'; density: DensityPreference }
  | { type: 'set-accent'; accent: AccentPreference }
  | { type: 'set-vibrancy'; vibrancy: VibrancyPreference }
  | { type: 'set-show-full-url'; enabled: boolean }
  | { type: 'set-default-zoom'; zoom: number }
  | { type: 'set-startup-behavior'; behavior: StartupBehavior }
  | { type: 'set-startup-urls'; urls: string[] }
  | { type: 'set-custom-search-engine'; engine: CustomSearchEngine | null }
  | { type: 'set-download-folder'; folder: string }
  | { type: 'set-ask-before-download'; enabled: boolean }
  | { type: 'set-third-party-cookies'; policy: ThirdPartyCookiesPolicy }
  | { type: 'set-referrer-policy'; policy: ReferrerPolicyPreference }
  | { type: 'set-webrtc-policy'; policy: WebRtcPolicy }
  | { type: 'set-custom-filter-urls'; urls: string[] }
  | { type: 'set-site-whitelist'; sites: string[] }
  | { type: 'reset-settings' }
  | { type: 'set-custom-shortcut'; id: string; accelerator: string }
  | { type: 'remove-custom-shortcut'; id: string }
  | { type: 'reset-custom-shortcuts' }
  | { type: 'reset-welcome-card' }
  | { type: 'clear-browsing-data-timed'; scopes: ClearDataScope[]; since: number; spaceId?: string }
  | { type: 'remove-history-entry'; url: string }
  | { type: 'remove-bookmark'; tabId: string };
