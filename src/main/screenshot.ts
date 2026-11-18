/**
 * Screenshot policy and orchestration helpers.
 *
 * Pure validation/naming/destination functions live here; the real Electron
 * `webContents.capturePage` call is injected by the caller. No Electron module
 * is imported at runtime, so all policy is unit-testable in plain Node.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Viewport {
  width: number;
  height: number;
}

export interface CaptureLimits {
  maxDimension: number;
  maxArea: number;
}

export const DEFAULT_CAPTURE_LIMITS: CaptureLimits = {
  maxDimension: 16_384,
  maxArea: 4096 * 4096,
};

export type ScreenshotArea = 'visible' | 'selection';
export type ScreenshotTarget = 'clipboard' | 'file';

export interface ScreenshotRequest {
  area: ScreenshotArea | unknown;
  rect?: unknown;
  target?: unknown;
  title?: unknown;
}

export interface ScreenshotOutcome {
  ok: boolean;
  reason?: 'invalid-area' | 'invalid-rect' | 'capture-failed';
  target?: ScreenshotTarget;
  filename?: string;
  filePath?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function sanitizeLimits(limits: Partial<CaptureLimits> | undefined): CaptureLimits {
  const maxDimension = isFiniteNumber(limits?.maxDimension)
    ? Math.min(Math.max(Math.floor(limits.maxDimension), 256), 16_384)
    : DEFAULT_CAPTURE_LIMITS.maxDimension;
  const maxArea = isFiniteNumber(limits?.maxArea)
    ? Math.min(Math.max(Math.floor(limits.maxArea), 1), DEFAULT_CAPTURE_LIMITS.maxArea)
    : DEFAULT_CAPTURE_LIMITS.maxArea;
  return { maxDimension, maxArea };
}

/** Validate a viewport so it cannot poison downstream rect math. */
export function sanitizeViewport(raw: unknown): Viewport | null {
  if (!isRecord(raw)) return null;
  const width = raw.width;
  const height = raw.height;
  if (!isFiniteNumber(width) || !isFiniteNumber(height)) return null;
  if (width <= 0 || height <= 0) return null;
  if (width > 32_768 || height > 32_768) return null;
  return { width: Math.floor(width), height: Math.floor(height) };
}

/** Full visible area, capped to the configured capture limits. */
export function buildVisibleRect(
  rawViewport: unknown,
  limits?: Partial<CaptureLimits>
): Rect | null {
  const viewport = sanitizeViewport(rawViewport);
  if (!viewport) return null;
  const safe = sanitizeLimits(limits);
  const width = Math.min(viewport.width, safe.maxDimension);
  const height = Math.min(viewport.height, safe.maxDimension);
  if (width <= 0 || height <= 0) return null;
  return { x: 0, y: 0, width, height };
}

/**
 * Clamp a hostile selection rect to the viewport. Returns null for malformed
 * input, zero/negative sizes or requested dimensions beyond the hard limits.
 */
export function normalizeCaptureRect(
  raw: unknown,
  rawViewport: unknown,
  limits?: Partial<CaptureLimits>
): Rect | null {
  if (!isRecord(raw)) return null;
  const { x, y, width, height } = raw;
  if (
    !isFiniteNumber(x) ||
    !isFiniteNumber(y) ||
    !isFiniteNumber(width) ||
    !isFiniteNumber(height)
  ) {
    return null;
  }
  if (width <= 0 || height <= 0) return null;
  const viewport = sanitizeViewport(rawViewport);
  if (!viewport) return null;
  const safe = sanitizeLimits(limits);
  if (width > safe.maxDimension || height > safe.maxDimension) return null;
  if (width * height > safe.maxArea) return null;
  if (x >= viewport.width || y >= viewport.height) return null;
  if (x + width <= 0 || y + height <= 0) return null;

  const left = Math.min(Math.max(Math.floor(x), 0), viewport.width - 1);
  const top = Math.min(Math.max(Math.floor(y), 0), viewport.height - 1);
  const right = Math.min(left + Math.floor(width), viewport.width);
  const bottom = Math.min(top + Math.floor(height), viewport.height);
  const clampedWidth = right - left;
  const clampedHeight = bottom - top;
  if (clampedWidth <= 0 || clampedHeight <= 0) return null;
  return { x: left, y: top, width: clampedWidth, height: clampedHeight };
}

/** Build a bounded, filesystem-safe PNG filename from a hostile page title. */
export function buildScreenshotFilename(input: {
  title?: unknown;
  area?: unknown;
  timestamp?: unknown;
}): string {
  const area = input.area === 'selection' ? 'selection' : 'visible';
  const rawTitle = typeof input.title === 'string' ? input.title : '';
  const safeTitle = rawTitle
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60) || 'screenshot';
  const ms = isFiniteNumber(input.timestamp) ? input.timestamp : Date.now();
  let stamp: string;
  try {
    stamp = new Date(ms).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  } catch {
    stamp = '00000000-000000';
  }
  return `kinex-${area}-${safeTitle}-${stamp}.png`;
}

/** Decide clipboard vs file from an untrusted request and real availability. */
export function resolveScreenshotTarget(
  requested: unknown,
  availability: { clipboard: boolean; file: boolean }
): ScreenshotTarget {
  if (requested === 'clipboard' && availability.clipboard) return 'clipboard';
  if (requested === 'file' && availability.file) return 'file';
  if (requested === 'clipboard') return availability.file ? 'file' : 'clipboard';
  if (requested === 'file') return availability.clipboard ? 'clipboard' : 'file';
  return availability.file ? 'file' : 'clipboard';
}

export interface ScreenshotCapabilities {
  getViewport(): unknown;
  captureVisible(): Promise<Uint8Array>;
  captureRect(rect: Rect): Promise<Uint8Array>;
  writeFile(filePath: string, data: Uint8Array): Promise<void>;
  copyImage(data: Uint8Array): Promise<void>;
  now(): number;
  /** Optional injected path builder (default: filename used verbatim). */
  buildFilePath?: (filename: string) => string;
  /** Which destinations are actually available in this environment. */
  availability?: { clipboard: boolean; file: boolean };
}

export class ScreenshotController {
  constructor(
    private readonly caps: ScreenshotCapabilities,
    private readonly limits: Partial<CaptureLimits> = {}
  ) {}

  async capture(request: ScreenshotRequest): Promise<ScreenshotOutcome> {
    if (request.area !== 'visible' && request.area !== 'selection') {
      return { ok: false, reason: 'invalid-area' };
    }
    const viewport = this.caps.getViewport();
    const rect =
      request.area === 'visible'
        ? buildVisibleRect(viewport, this.limits)
        : normalizeCaptureRect(request.rect, viewport, this.limits);
    if (!rect) return { ok: false, reason: 'invalid-rect' };

    let data: Uint8Array;
    try {
      data =
        request.area === 'visible'
          ? await this.caps.captureVisible()
          : await this.caps.captureRect(rect);
    } catch {
      return { ok: false, reason: 'capture-failed' };
    }

    const filename = buildScreenshotFilename({
      title: request.title,
      area: request.area,
      timestamp: this.caps.now(),
    });
    const target = resolveScreenshotTarget(request.target, this.caps.availability ?? {
      clipboard: true,
      file: true,
    });

    if (target === 'clipboard') {
      await this.caps.copyImage(data);
      return { ok: true, target, filename };
    }
    const filePath = this.caps.buildFilePath ? this.caps.buildFilePath(filename) : filename;
    await this.caps.writeFile(filePath, data);
    return { ok: true, target, filename, filePath };
  }
}
