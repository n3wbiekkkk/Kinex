/**
 * Web context-menu policy.
 *
 * The render side (or Electron's `context-menu` event) hands us a *hostile*
 * payload: link/image URLs, selected text, page URL, editing and media flags.
 * This module turns that payload into a small, fixed set of safe menu entries.
 * It never imports Electron at runtime, never touches process/filesystem APIs,
 * and only ever emits actions from a closed allowlist.
 */

export type ContextMenuAction =
  | 'open-link-new-tab'
  | 'open-link-split'
  | 'save-link'
  | 'copy-link'
  | 'save-image'
  | 'copy-image'
  | 'open-image-new-tab'
  | 'copy-selection'
  | 'search-selection'
  | 'copy-page-url'
  | 'reload'
  | 'print'
  | 'inspect';

export interface ContextMenuItem {
  separator?: false;
  label: string;
  action: ContextMenuAction;
  args?: string;
  enabled: boolean;
}

export interface ContextMenuSeparator {
  separator: true;
}

export type ContextMenuEntry = ContextMenuItem | ContextMenuSeparator;

export interface MediaFlags {
  isImage: boolean;
  isVideo: boolean;
  isAudio: boolean;
  hasVideo: boolean;
  hasAudio: boolean;
}

export interface SanitizedContext {
  linkUrl: string | null;
  navigationLinkUrl: string | null;
  imageUrl: string | null;
  navigationImageUrl: string | null;
  selectionText: string | null;
  searchText: string | null;
  pageLinkUrl: string | null;
  isEditable: boolean;
  media: MediaFlags;
}

const MAX_URL_LEN = 8192;
const MAX_LABEL_LEN = 200;
const MAX_SEARCH_LEN = 2048;
const MAX_IMAGE_DATA_LEN = 1_048_576;

/** Schemes we are willing to navigate to from a context menu. */
const NAVIGATION_PROTOCOLS = new Set(['http:', 'https:', 'kinex:', 'nook:']);
/** Schemes safe to put on the clipboard / hand to an external handler. */
const COPYABLE_PROTOCOLS = new Set([...NAVIGATION_PROTOCOLS, 'mailto:', 'tel:']);
/** Strictly constrained inline images (never navigated to, only saved/copied). */
const IMAGE_DATA_URL_RE = /^data:image\/(?:png|jpeg|jpg|gif|webp|avif);base64,[A-Za-z0-9+/=]+$/i;
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;
const CONTROL_CHARS_GLOBAL_RE = /[\u0000-\u001f\u007f]/g;

export const CONTEXT_MENU_ACTIONS = new Set<ContextMenuAction>([
  'open-link-new-tab',
  'open-link-split',
  'save-link',
  'copy-link',
  'save-image',
  'copy-image',
  'open-image-new-tab',
  'copy-selection',
  'search-selection',
  'copy-page-url',
  'reload',
  'print',
  'inspect',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate a URL coming from page-controlled data.
 *
 * `kind = 'copyable'` also accepts mailto:/tel:, which are safe to copy or hand
 * to an external handler but must never be loaded as a document. Everything
 * else (javascript:, data:, vbscript:, file:, blob:, chrome*, devtools:, ...) is
 * rejected outright.
 */
export function sanitizeContextUrl(
  raw: unknown,
  kind: 'navigation' | 'copyable' = 'navigation'
): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value || value.length > MAX_URL_LEN) return null;
  if (CONTROL_CHARS_RE.test(value)) return null;
  if (value === 'about:blank') return value;
  try {
    const parsed = new URL(value);
    const protocol = parsed.protocol.toLowerCase();
    if (parsed.username || parsed.password) return null;
    const allowed = kind === 'copyable' ? COPYABLE_PROTOCOLS : NAVIGATION_PROTOCOLS;
    if (!allowed.has(protocol)) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

/** Accept only tightly scoped inline images, never document data: URLs. */
export function sanitizeImageDataUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > MAX_IMAGE_DATA_LEN) return null;
  if (CONTROL_CHARS_RE.test(raw)) return null;
  return IMAGE_DATA_URL_RE.test(raw) ? raw : null;
}

/** Strip control characters, collapse whitespace and bound a display string. */
export function sanitizeMenuText(raw: unknown, maxLen = MAX_LABEL_LEN): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw
    .replace(CONTROL_CHARS_GLOBAL_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return null;
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen) : cleaned;
}

/** Escape characters treated as menu mnemonics by native menus. */
export function escapeMenuLabel(text: string): string {
  return text.replace(/&/g, '&&').trim();
}

export function parseMediaFlags(raw: unknown): MediaFlags {
  const source = isRecord(raw) ? raw : {};
  const flag = (key: keyof MediaFlags): boolean => source[key] === true;
  return {
    isImage: flag('isImage'),
    isVideo: flag('isVideo'),
    isAudio: flag('isAudio'),
    hasVideo: flag('hasVideo'),
    hasAudio: flag('hasAudio'),
  };
}

/** Normalize every hostile field into a predictable, bounded shape. */
export function sanitizeContextPayload(raw: unknown): SanitizedContext {
  const source = isRecord(raw) ? raw : {};
  return {
    linkUrl: sanitizeContextUrl(source.linkUrl, 'copyable'),
    navigationLinkUrl: sanitizeContextUrl(source.linkUrl, 'navigation'),
    imageUrl:
      sanitizeContextUrl(source.imageUrl, 'copyable') ?? sanitizeImageDataUrl(source.imageUrl),
    navigationImageUrl: sanitizeContextUrl(source.imageUrl, 'navigation'),
    selectionText: sanitizeMenuText(source.selectionText),
    searchText: sanitizeMenuText(source.selectionText, MAX_SEARCH_LEN),
    pageLinkUrl: sanitizeContextUrl(source.pageUrl, 'copyable'),
    isEditable: source.isEditable === true,
    media: parseMediaFlags(source.mediaFlags),
  };
}

function item(label: string, action: ContextMenuAction, args?: string): ContextMenuItem {
  return { label: escapeMenuLabel(label), action, args, enabled: true };
}

const separator = (): ContextMenuSeparator => ({ separator: true });

function isHttpUrl(url: string | null): boolean {
  return !!url && (url.startsWith('http:') || url.startsWith('https:'));
}

/**
 * Build an ordered, action-only menu template. Unknown or unsafe fields simply
 * do not produce entries — no disabled "dangerous" affordances are exposed.
 */
export function buildContextMenuTemplate(raw: unknown): ContextMenuEntry[] {
  const ctx = sanitizeContextPayload(raw);
  const entries: ContextMenuEntry[] = [];
  const { linkUrl, navigationLinkUrl, imageUrl, navigationImageUrl } = ctx;

  if (navigationLinkUrl) {
    entries.push(item('Open Link in New Tab', 'open-link-new-tab', navigationLinkUrl));
    entries.push(item('Open Link in Split View', 'open-link-split', navigationLinkUrl));
    if (isHttpUrl(navigationLinkUrl)) {
      entries.push(item('Save Link As…', 'save-link', navigationLinkUrl));
    }
  }
  if (linkUrl) {
    entries.push(item('Copy Link Address', 'copy-link', linkUrl));
  }
  if (navigationLinkUrl || linkUrl || imageUrl) entries.push(separator());

  const canSaveImage = !!imageUrl && (ctx.media.isImage || imageUrl.startsWith('data:image/'));
  if (canSaveImage && imageUrl) {
    entries.push(item('Save Image As…', 'save-image', imageUrl));
    entries.push(item('Copy Image', 'copy-image', imageUrl));
  }
  if (navigationImageUrl) {
    entries.push(item('Open Image in New Tab', 'open-image-new-tab', navigationImageUrl));
  }
  if (canSaveImage || navigationImageUrl) entries.push(separator());

  if (ctx.selectionText) {
    entries.push(item('Copy', 'copy-selection', ctx.selectionText));
    if (ctx.searchText) {
      entries.push(item(`Search “${ctx.selectionText}”`, 'search-selection', ctx.searchText));
    }
    entries.push(separator());
  }

  if (ctx.pageLinkUrl) {
    entries.push(item('Copy Page Address', 'copy-page-url', ctx.pageLinkUrl));
  }
  entries.push(item('Reload', 'reload'));
  if (navigationLinkUrl) entries.push(item('Print…', 'print'));
  entries.push(item('Inspect', 'inspect'));

  return entries;
}

export type ContextMenuHandler = (args: string | undefined) => void | Promise<void>;
export type ContextMenuHandlers = Partial<Record<ContextMenuAction, ContextMenuHandler>>;

export function isContextMenuEntry(value: unknown): value is ContextMenuItem {
  return (
    isRecord(value) &&
    value.separator !== true &&
    typeof value.label === 'string' &&
    typeof value.action === 'string' &&
    CONTEXT_MENU_ACTIONS.has(value.action as ContextMenuAction)
  );
}

/**
 * Thin, injected controller. The handlers are supplied by the privileged main
 * process; the untrusted payload can never choose which handler runs beyond the
 * fixed action set, and cannot invoke process/filesystem operations directly.
 */
export class WebContextMenuController {
  constructor(private readonly handlers: ContextMenuHandlers = {}) {}

  template(raw: unknown): ContextMenuEntry[] {
    return buildContextMenuTemplate(raw);
  }

  async invoke(entry: ContextMenuItem): Promise<boolean> {
    if (!isContextMenuEntry(entry)) return false;
    const handler = this.handlers[entry.action];
    if (!handler) return false;
    await handler(entry.args);
    return true;
  }
}
