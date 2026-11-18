/**
 * Pure Shift-click Link Peek policy. The generated view options are the
 * security contract the orchestrator passes to a sandboxed WebContentsView.
 */
export type LinkPeekAction = 'expand' | 'split' | 'close' | 'backdrop';

export const LINK_PEEK_ACTIONS: readonly LinkPeekAction[] = [
  'expand',
  'split',
  'close',
  'backdrop',
];

export function isLinkPeekAction(value: unknown): value is LinkPeekAction {
  return typeof value === 'string' && (LINK_PEEK_ACTIONS as readonly string[]).includes(value);
}

export interface PreviewRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LinkPeekViewOptions {
  url: string;
  rect: PreviewRect;
  sandbox: true;
  contextIsolation: true;
  webSecurity: true;
  nodeIntegration: false;
  allowFileAccess: false;
  partition: string;
}

export const LINK_PEEK_MIN_WIDTH = 320;
export const LINK_PEEK_MAX_WIDTH = 960;
export const LINK_PEEK_MIN_HEIGHT = 240;
export const LINK_PEEK_MAX_HEIGHT = 720;
export const DEFAULT_PEEK_BOUNDS: Readonly<PreviewRect> = {
  x: 0,
  y: 0,
  width: 1920,
  height: 1080,
};

const MAX_URL_LEN = 8192;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Only public http(s) targets may be previewed; file:// and privileged URLs never. */
export function isLinkPeekUrl(raw: unknown): boolean {
  if (typeof raw !== 'string') return false;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_URL_LEN) return false;
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return false;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }
  const protocol = parsed.protocol.toLowerCase();
  if (protocol !== 'http:' && protocol !== 'https:') return false;
  if (parsed.username || parsed.password) return false;
  return parsed.hostname.length > 0;
}

/** Bounds the preview rect to sane dimensions and inside the display. */
export function clampPreviewRect(
  rect: PreviewRect,
  bounds: PreviewRect = DEFAULT_PEEK_BOUNDS as PreviewRect
): PreviewRect | null {
  const values = [rect?.x, rect?.y, rect?.width, rect?.height];
  if (!values.every((v) => typeof v === 'number' && Number.isFinite(v))) return null;
  if (![bounds.width, bounds.height].every((v) => Number.isFinite(v) && v > 0)) return null;

  const width = Math.round(
    clamp(rect.width, LINK_PEEK_MIN_WIDTH, Math.min(LINK_PEEK_MAX_WIDTH, Math.max(LINK_PEEK_MIN_WIDTH, bounds.width)))
  );
  const height = Math.round(
    clamp(rect.height, LINK_PEEK_MIN_HEIGHT, Math.min(LINK_PEEK_MAX_HEIGHT, Math.max(LINK_PEEK_MIN_HEIGHT, bounds.height)))
  );
  return {
    x: Math.round(clamp(rect.x, 0, Math.max(0, bounds.width - width))),
    y: Math.round(clamp(rect.y, 0, Math.max(0, bounds.height - height))),
    width,
    height,
  };
}

function isEphemeralPartition(partition: unknown): partition is string {
  if (typeof partition !== 'string') return false;
  if (partition === '') return true;
  if (partition.startsWith('persist:')) return false;
  return /^[a-zA-Z0-9-]{1,64}$/.test(partition);
}

export type ViewOptionsResult =
  | { ok: true; options: LinkPeekViewOptions }
  | { ok: false; reason: string };

/** Build locked-down view options, clamping geometry and forcing security flags. */
export function buildLinkPeekViewOptions(
  url: unknown,
  options: { rect: PreviewRect; bounds?: PreviewRect; partition?: string }
): ViewOptionsResult {
  if (!isLinkPeekUrl(url)) return { ok: false, reason: 'Link Peek only supports public http(s) URLs' };
  const rect = clampPreviewRect(options.rect, options.bounds ?? DEFAULT_PEEK_BOUNDS);
  if (!rect) return { ok: false, reason: 'Invalid preview rect' };
  const partition = options.partition ?? '';
  if (!isEphemeralPartition(partition)) {
    return { ok: false, reason: 'Link Peek requires an ephemeral (non-persistent) partition' };
  }
  return {
    ok: true,
    options: {
      url: (url as string).trim(),
      rect,
      sandbox: true,
      contextIsolation: true,
      webSecurity: true,
      nodeIntegration: false,
      allowFileAccess: false,
      partition,
    },
  };
}
