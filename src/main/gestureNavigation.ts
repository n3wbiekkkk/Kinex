/**
 * macOS horizontal trackpad swipe classification and swipe-edge indicator
 * policy. Pure functions + injected clock/navigation capabilities; no Electron
 * or DOM imports, so the whole policy is unit-testable in plain Node.
 */

export type SwipeDirection = 'back' | 'forward';

export interface SwipeConfig {
  /** Minimum absolute horizontal delta required to count as a swipe. */
  threshold: number;
  /** How much more horizontal than vertical motion is required. */
  axisRatio: number;
  /** Minimum ms between emitted navigations. */
  debounceMs: number;
  /** Natural scrolling: a positive deltaX (finger right) navigates back. */
  naturalScrollInvert: boolean;
}

export const DEFAULT_SWIPE_CONFIG: SwipeConfig = {
  threshold: 40,
  axisRatio: 1.4,
  debounceMs: 700,
  naturalScrollInvert: true,
};

export interface EdgeIndicatorInput {
  /** Pointer/edge x coordinate. */
  x: unknown;
  viewportWidth: unknown;
  reducedMotion: unknown;
  edgeZone?: unknown;
  direction?: SwipeDirection | null;
}

export interface EdgeIndicatorState {
  visible: boolean;
  side: 'left' | 'right' | null;
  /** False when the user prefers reduced motion (static indicator only). */
  animate: boolean;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (!isFiniteNumber(value)) return fallback;
  return Math.min(Math.max(value, min), max);
}

/** Coerce a hostile/partial config into bounded, predictable values. */
export function clampSwipeConfig(raw: unknown): SwipeConfig {
  const source = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  return {
    threshold: clampNumber(source.threshold, 8, 500, DEFAULT_SWIPE_CONFIG.threshold),
    axisRatio: clampNumber(source.axisRatio, 1, 6, DEFAULT_SWIPE_CONFIG.axisRatio),
    debounceMs: clampNumber(source.debounceMs, 0, 5000, DEFAULT_SWIPE_CONFIG.debounceMs),
    naturalScrollInvert:
      typeof source.naturalScrollInvert === 'boolean'
        ? source.naturalScrollInvert
        : DEFAULT_SWIPE_CONFIG.naturalScrollInvert,
  };
}

/**
 * Classify a single scroll event into a navigation direction.
 * Returns null for vertical gestures, sub-threshold motion, or hostile input.
 */
export function classifyHorizontalSwipe(
  deltaX: unknown,
  deltaY: unknown,
  config: SwipeConfig = DEFAULT_SWIPE_CONFIG
): SwipeDirection | null {
  if (!isFiniteNumber(deltaX) || !isFiniteNumber(deltaY)) return null;
  const safe = clampSwipeConfig(config);
  const absX = Math.abs(deltaX);
  const absY = Math.abs(deltaY);
  if (absX < safe.threshold) return null;
  if (absX <= absY * safe.axisRatio) return null;
  const positiveIsBack = safe.naturalScrollInvert;
  if (deltaX > 0) return positiveIsBack ? 'back' : 'forward';
  return positiveIsBack ? 'forward' : 'back';
}

/** Pure debounce check; a fresh gesture (lastAt = -Infinity) is never suppressed. */
export function isSwipeDebounced(now: number, lastAt: number, debounceMs: number): boolean {
  if (![now, lastAt, debounceMs].every(isFiniteNumber)) return false;
  if (lastAt === -Infinity) return false;
  return now - lastAt < debounceMs;
}

/**
 * Edge indicator policy: only near the left/right edge, never in the middle.
 * Reduced motion keeps the indicator visible but disables its animation.
 */
export function computeEdgeIndicator(input: EdgeIndicatorInput): EdgeIndicatorState {
  const hidden: EdgeIndicatorState = { visible: false, side: null, animate: false };
  const width = input.viewportWidth;
  if (!isFiniteNumber(width) || width <= 0) return hidden;

  const zone = clampNumber(input.edgeZone, 8, 120, 28);
  const effectiveZone = Math.min(zone, width / 3);
  let side: 'left' | 'right' | null = null;
  if (isFiniteNumber(input.x)) {
    if (input.x <= effectiveZone) side = 'left';
    else if (input.x >= width - effectiveZone) side = 'right';
  } else if (input.direction === 'back') {
    side = 'left';
  } else if (input.direction === 'forward') {
    side = 'right';
  }
  if (!side) return hidden;
  return {
    visible: true,
    side,
    animate: input.reducedMotion === true ? false : true,
  };
}

export interface GestureNavigationDeps {
  now(): number;
  navigate(direction: SwipeDirection): void;
  canGoBack(): boolean;
  canGoForward(): boolean;
}

/**
 * Wire this to the renderer's horizontal swipe/scroll events. It emits at most
 * one navigation per debounce window, and never emits when history cannot move.
 */
export class GestureNavigationController {
  readonly config: SwipeConfig;
  private lastNavigationAt = -Infinity;

  constructor(
    private readonly deps: GestureNavigationDeps,
    config: unknown = {}
  ) {
    this.config = clampSwipeConfig(config);
  }

  handleScroll(deltaX: unknown, deltaY: unknown): SwipeDirection | null {
    const direction = classifyHorizontalSwipe(deltaX, deltaY, this.config);
    if (!direction) return null;
    const now = this.deps.now();
    if (isSwipeDebounced(now, this.lastNavigationAt, this.config.debounceMs)) return null;
    if (direction === 'back' && !this.deps.canGoBack()) return null;
    if (direction === 'forward' && !this.deps.canGoForward()) return null;
    this.lastNavigationAt = now;
    this.deps.navigate(direction);
    return direction;
  }

  /** Call when a new gesture begins (e.g. wheel/touch end) if desired. */
  reset(): void {
    this.lastNavigationAt = -Infinity;
  }
}
