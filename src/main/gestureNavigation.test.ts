import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SWIPE_CONFIG,
  GestureNavigationController,
  classifyHorizontalSwipe,
  clampSwipeConfig,
  computeEdgeIndicator,
  isSwipeDebounced,
  type GestureNavigationDeps,
  type SwipeDirection,
} from './gestureNavigation';

describe('clampSwipeConfig', () => {
  it('uses safe defaults for hostile input', () => {
    expect(clampSwipeConfig(undefined)).toEqual(DEFAULT_SWIPE_CONFIG);
    expect(clampSwipeConfig('evil')).toEqual(DEFAULT_SWIPE_CONFIG);
    expect(clampSwipeConfig({ threshold: 'x' }).threshold).toBe(40);
  });

  it('bounds numeric values', () => {
    expect(clampSwipeConfig({ threshold: 1, axisRatio: 100, debounceMs: -5 })).toMatchObject({
      threshold: 8,
      axisRatio: 6,
      debounceMs: 0,
    });
    expect(clampSwipeConfig({ threshold: 9000 }).threshold).toBe(500);
  });

  it('only trusts an explicit boolean for naturalScrollInvert', () => {
    expect(clampSwipeConfig({ naturalScrollInvert: false }).naturalScrollInvert).toBe(false);
    expect(clampSwipeConfig({ naturalScrollInvert: 'yes' }).naturalScrollInvert).toBe(true);
  });
});

describe('classifyHorizontalSwipe', () => {
  it('classifies horizontal direction with natural scrolling', () => {
    expect(classifyHorizontalSwipe(120, 5)).toBe('back');
    expect(classifyHorizontalSwipe(-120, 5)).toBe('forward');
  });

  it('honors inverted mapping', () => {
    const config = { ...DEFAULT_SWIPE_CONFIG, naturalScrollInvert: false };
    expect(classifyHorizontalSwipe(120, 5, config)).toBe('forward');
    expect(classifyHorizontalSwipe(-120, 5, config)).toBe('back');
  });

  it('ignores vertical, diagonal and sub-threshold gestures', () => {
    expect(classifyHorizontalSwipe(5, 100)).toBeNull();
    expect(classifyHorizontalSwipe(30, 0)).toBeNull();
    expect(classifyHorizontalSwipe(100, 90)).toBeNull();
    expect(classifyHorizontalSwipe(0, 0)).toBeNull();
  });

  it('rejects missing or non-finite input without throwing', () => {
    expect(classifyHorizontalSwipe(undefined, 0)).toBeNull();
    expect(classifyHorizontalSwipe(Infinity, 0)).toBeNull();
    expect(classifyHorizontalSwipe('100', 0)).toBeNull();
    expect(classifyHorizontalSwipe(NaN, NaN)).toBeNull();
  });

  it('respects threshold boundary values', () => {
    expect(classifyHorizontalSwipe(40, 0)).toBe('back');
    expect(classifyHorizontalSwipe(39.9, 0)).toBeNull();
  });
});

describe('isSwipeDebounced', () => {
  it('suppresses repeats inside the window only', () => {
    expect(isSwipeDebounced(100, 0, 700)).toBe(true);
    expect(isSwipeDebounced(700, 0, 700)).toBe(false);
    expect(isSwipeDebounced(100, -Infinity, 700)).toBe(false);
  });
});

describe('computeEdgeIndicator', () => {
  it('shows only at left/right edges', () => {
    expect(computeEdgeIndicator({ x: 10, viewportWidth: 1000, reducedMotion: false })).toEqual({
      visible: true,
      side: 'left',
      animate: true,
    });
    expect(computeEdgeIndicator({ x: 995, viewportWidth: 1000, reducedMotion: false }).side).toBe(
      'right'
    );
    expect(computeEdgeIndicator({ x: 500, viewportWidth: 1000, reducedMotion: false })).toEqual({
      visible: false,
      side: null,
      animate: false,
    });
  });

  it('respects reduced motion while keeping the indicator visible', () => {
    expect(computeEdgeIndicator({ x: 5, viewportWidth: 1000, reducedMotion: true })).toEqual({
      visible: true,
      side: 'left',
      animate: false,
    });
  });

  it('falls back to swipe direction if x is unusable and rejects bad viewports', () => {
    expect(computeEdgeIndicator({ x: null, viewportWidth: 1000, reducedMotion: false, direction: 'back' }).side).toBe('left');
    expect(computeEdgeIndicator({ x: null, viewportWidth: 1000, reducedMotion: false, direction: 'forward' }).side).toBe('right');
    expect(computeEdgeIndicator({ x: 0, viewportWidth: 0, reducedMotion: false }).visible).toBe(false);
    expect(computeEdgeIndicator({ x: 0, viewportWidth: '1000', reducedMotion: false }).visible).toBe(false);
  });

  it('scales the edge zone for narrow viewports', () => {
    expect(computeEdgeIndicator({ x: 40, viewportWidth: 100, reducedMotion: false }).visible).toBe(
      false
    );
    expect(computeEdgeIndicator({ x: 5, viewportWidth: 100, reducedMotion: false }).side).toBe(
      'left'
    );
  });
});

function fixture(): {
  deps: GestureNavigationDeps;
  emitted: SwipeDirection[];
  clock: { now: number };
  canGo: { back: boolean; forward: boolean };
} {
  const emitted: SwipeDirection[] = [];
  const clock = { now: 0 };
  const canGo = { back: true, forward: true };
  const deps: GestureNavigationDeps = {
    now: () => clock.now,
    navigate: (direction) => emitted.push(direction),
    canGoBack: () => canGo.back,
    canGoForward: () => canGo.forward,
  };
  return { deps, emitted, clock, canGo };
}

describe('GestureNavigationController', () => {
  it('emits at most one navigation per debounce window', () => {
    const { deps, emitted, clock } = fixture();
    const controller = new GestureNavigationController(deps, { debounceMs: 700 });
    expect(controller.handleScroll(120, 0)).toBe('back');
    clock.now = 100;
    expect(controller.handleScroll(-120, 0)).toBeNull();
    clock.now = 800;
    expect(controller.handleScroll(-120, 0)).toBe('forward');
    expect(emitted).toEqual(['back', 'forward']);
  });

  it('does not emit when history cannot move, and does not start debounce', () => {
    const { deps, emitted, canGo, clock } = fixture();
    const controller = new GestureNavigationController(deps);
    canGo.back = false;
    expect(controller.handleScroll(120, 0)).toBeNull();
    canGo.back = true;
    clock.now = 10;
    expect(controller.handleScroll(120, 0)).toBe('back');
    expect(emitted).toEqual(['back']);
  });

  it('reset clears the debounce window', () => {
    const { deps, emitted, clock } = fixture();
    const controller = new GestureNavigationController(deps, { debounceMs: 700 });
    controller.handleScroll(120, 0);
    clock.now = 10;
    controller.reset();
    expect(controller.handleScroll(120, 0)).toBe('back');
    expect(emitted).toEqual(['back', 'back']);
  });

  it('ignores vertical gestures entirely', () => {
    const { deps, emitted } = fixture();
    const controller = new GestureNavigationController(deps);
    expect(controller.handleScroll(0, 300)).toBeNull();
    expect(emitted).toEqual([]);
  });
});
