import { describe, expect, it, vi } from 'vitest';
import {
  ScreenshotController,
  buildScreenshotFilename,
  buildVisibleRect,
  normalizeCaptureRect,
  resolveScreenshotTarget,
  sanitizeViewport,
  type ScreenshotCapabilities,
} from './screenshot';

const VIEWPORT = { width: 1200, height: 800 };

describe('sanitizeViewport / buildVisibleRect', () => {
  it('accepts a normal viewport and produces the full visible rect', () => {
    expect(sanitizeViewport(VIEWPORT)).toEqual(VIEWPORT);
    expect(buildVisibleRect(VIEWPORT)).toEqual({ x: 0, y: 0, width: 1200, height: 800 });
  });

  it('rejects malformed, zero and absurd viewports', () => {
    expect(sanitizeViewport(null)).toBeNull();
    expect(sanitizeViewport({ width: 0, height: 800 })).toBeNull();
    expect(sanitizeViewport({ width: 10, height: NaN })).toBeNull();
    expect(sanitizeViewport({ width: 40_000, height: 800 })).toBeNull();
    expect(buildVisibleRect({ width: '1200', height: 800 })).toBeNull();
  });

  it('caps an oversized viewport to the hard dimension limit', () => {
    expect(buildVisibleRect({ width: 30_000, height: 30_000 })?.width).toBe(16_384);
    expect(buildVisibleRect(VIEWPORT, { maxDimension: 640 })?.width).toBe(640);
  });
});

describe('normalizeCaptureRect', () => {
  it('accepts an in-bounds selection', () => {
    expect(normalizeCaptureRect({ x: 10, y: 20, width: 100, height: 50 }, VIEWPORT)).toEqual({
      x: 10,
      y: 20,
      width: 100,
      height: 50,
    });
  });

  it('clamps a rect that overflows the viewport', () => {
    expect(normalizeCaptureRect({ x: -20, y: -10, width: 2000, height: 2000 }, VIEWPORT)).toEqual({
      x: 0,
      y: 0,
      width: 1200,
      height: 800,
    });
  });

  it('rejects malformed, empty and off-screen rects', () => {
    expect(normalizeCaptureRect(null, VIEWPORT)).toBeNull();
    expect(normalizeCaptureRect({ x: 0, y: 0, width: -5, height: 10 }, VIEWPORT)).toBeNull();
    expect(normalizeCaptureRect({ x: 0, y: 0, width: 0, height: 10 }, VIEWPORT)).toBeNull();
    expect(normalizeCaptureRect({ x: 0, y: 0, width: 0.5, height: 10 }, VIEWPORT)).toBeNull();
    expect(normalizeCaptureRect({ x: '0', y: 0, width: 10, height: 10 }, VIEWPORT)).toBeNull();
    expect(normalizeCaptureRect({ x: Infinity, y: 0, width: 10, height: 10 }, VIEWPORT)).toBeNull();
    expect(normalizeCaptureRect({ x: 5000, y: 0, width: 10, height: 10 }, VIEWPORT)).toBeNull();
    expect(normalizeCaptureRect({ x: 0, y: 900, width: 10, height: 10 }, VIEWPORT)).toBeNull();
  });

  it('rejects oversized dimensions and area at the boundary', () => {
    expect(normalizeCaptureRect({ x: 0, y: 0, width: 16_385, height: 10 }, VIEWPORT)).toBeNull();
    expect(normalizeCaptureRect({ x: 0, y: 0, width: 4096, height: 4097 }, VIEWPORT)).toBeNull();
    expect(normalizeCaptureRect({ x: 0, y: 0, width: 4096, height: 4096 }, VIEWPORT)).not.toBeNull();
  });
});

describe('buildScreenshotFilename', () => {
  it('sanitizes a hostile title and uses a deterministic UTC stamp', () => {
    const name = buildScreenshotFilename({
      title: '  My/Page:\\*?"<>|\u0000Title  ',
      area: 'selection',
      timestamp: Date.UTC(2026, 0, 2, 3, 4, 5),
    });
    expect(name).toBe('kinex-selection-My Page Title-20260102-030405.png');
    expect(name.endsWith('.png')).toBe(true);
  });

  it('falls back safely and bounds the title', () => {
    expect(buildScreenshotFilename({ title: '   ', timestamp: 0 })).toMatch(
      /^kinex-visible-screenshot-19700101-000000\.png$/
    );
    const long = buildScreenshotFilename({ title: 'a'.repeat(200), timestamp: 0 });
    expect(long.length).toBeLessThan(120);
  });
});

describe('resolveScreenshotTarget', () => {
  it('honors an available request and falls back sensibly', () => {
    expect(resolveScreenshotTarget('clipboard', { clipboard: true, file: true })).toBe('clipboard');
    expect(resolveScreenshotTarget('file', { clipboard: true, file: true })).toBe('file');
    expect(resolveScreenshotTarget('clipboard', { clipboard: false, file: true })).toBe('file');
    expect(resolveScreenshotTarget('file', { clipboard: true, file: false })).toBe('clipboard');
  });

  it('never returns an arbitrary requested destination', () => {
    expect(resolveScreenshotTarget('shell:rm -rf', { clipboard: true, file: true })).toBe('file');
    expect(resolveScreenshotTarget(undefined, { clipboard: true, file: false })).toBe('clipboard');
  });
});

function fixture(): {
  caps: ScreenshotCapabilities;
  writes: Array<[string, Uint8Array]>;
  copies: Uint8Array[];
} {
  const writes: Array<[string, Uint8Array]> = [];
  const copies: Uint8Array[] = [];
  const data = new Uint8Array([1, 2, 3]);
  const caps: ScreenshotCapabilities = {
    getViewport: () => VIEWPORT,
    captureVisible: vi.fn(async () => data),
    captureRect: vi.fn(async () => data),
    writeFile: vi.fn(async (filePath, payload) => {
      writes.push([filePath, payload]);
    }),
    copyImage: vi.fn(async (payload) => {
      copies.push(payload);
    }),
    now: () => Date.UTC(2026, 0, 2, 3, 4, 5),
    buildFilePath: (filename) => `/tmp/${filename}`,
  };
  return { caps, writes, copies };
}

describe('ScreenshotController', () => {
  it('captures the visible area to a file with a safe filename', async () => {
    const { caps, writes } = fixture();
    const result = await new ScreenshotController(caps).capture({
      area: 'visible',
      title: 'Example',
      target: 'file',
    });
    expect(result.ok).toBe(true);
    expect(result.target).toBe('file');
    expect(result.filePath).toMatch(/^\/tmp\/kinex-visible-Example-20260102-030405\.png$/);
    expect(writes).toHaveLength(1);
    expect(caps.captureRect).not.toHaveBeenCalled();
  });

  it('captures a selected area to the clipboard using an injected rect', async () => {
    const { caps, copies } = fixture();
    const result = await new ScreenshotController(caps).capture({
      area: 'selection',
      rect: { x: 5, y: 5, width: 50, height: 50 },
      target: 'clipboard',
    });
    expect(result.ok).toBe(true);
    expect(result.target).toBe('clipboard');
    expect(caps.captureRect).toHaveBeenCalledWith({ x: 5, y: 5, width: 50, height: 50 });
    expect(copies).toHaveLength(1);
  });

  it('rejects invalid area and rect without capturing', async () => {
    const { caps } = fixture();
    const controller = new ScreenshotController(caps);
    expect(await controller.capture({ area: 'evil' })).toEqual({
      ok: false,
      reason: 'invalid-area',
    });
    expect(await controller.capture({ area: 'selection', rect: { x: 0, y: 0, width: -1, height: 2 } })).toEqual({
      ok: false,
      reason: 'invalid-rect',
    });
    expect(caps.captureVisible).not.toHaveBeenCalled();
    expect(caps.captureRect).not.toHaveBeenCalled();
  });

  it('reports capture failures instead of throwing', async () => {
    const { caps } = fixture();
    caps.captureVisible = vi.fn(async () => {
      throw new Error('renderer gone');
    });
    expect(await new ScreenshotController(caps).capture({ area: 'visible' })).toEqual({
      ok: false,
      reason: 'capture-failed',
    });
  });
});
