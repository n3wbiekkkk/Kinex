import { describe, expect, it, vi } from 'vitest';
import {
  collectPerformanceSnapshot,
  ESTIMATED_SLEEPING_TAB_BYTES,
  summarizeShieldsBlockCounts,
} from './performanceTelemetry';

describe('performanceTelemetry', () => {
  it('aggregates injected getters into a single snapshot', () => {
    const getters = {
      getTabCount: () => 25,
      getActiveViewCount: () => 5,
      getSleepingTabCount: () => 20,
      getShieldsBlockCounts: () => ({ ads: 120, trackers: 60, other: 7 }),
    };
    const snapshot = collectPerformanceSnapshot(getters, 1_700_000_000_000);
    expect(snapshot).toEqual({
      tabCount: 25,
      activeViewCount: 5,
      sleepingTabCount: 20,
      estimatedSleepingMemorySavedBytes: 20 * ESTIMATED_SLEEPING_TAB_BYTES,
      shieldsBlocked: { ads: 120, trackers: 60, other: 7, total: 187 },
      shieldsBlockedTotal: 187,
      capturedAt: 1_700_000_000_000,
    });
  });

  it('prefers a measured sleeping-memory value over the estimate', () => {
    const snapshot = collectPerformanceSnapshot({
      getSleepingTabCount: () => 20,
      getSleepingMemorySavedBytes: () => 123_456,
    });
    expect(snapshot.estimatedSleepingMemorySavedBytes).toBe(123_456);
  });

  it('defaults to zero for missing getters and tolerates throwing getters', () => {
    const snapshot = collectPerformanceSnapshot({
      getTabCount: () => 4,
      getActiveViewCount: () => 3,
      getShieldsBlockCounts: () => {
        throw new Error('shields unavailable');
      },
    });
    expect(snapshot.tabCount).toBe(4);
    expect(snapshot.activeViewCount).toBe(3);
    expect(snapshot.sleepingTabCount).toBe(0);
    expect(snapshot.estimatedSleepingMemorySavedBytes).toBe(0);
    expect(snapshot.shieldsBlockedTotal).toBe(0);

    const empty = collectPerformanceSnapshot();
    expect(empty.tabCount).toBe(0);
    expect(empty.shieldsBlocked).toEqual({ ads: 0, trackers: 0, other: 0, total: 0 });
  });

  it('clamps invalid/negative values and caps active views at tab count', () => {
    const snapshot = collectPerformanceSnapshot({
      getTabCount: () => 3,
      getActiveViewCount: () => 99,
      getSleepingTabCount: () => -5,
      getShieldsBlockCounts: () => ({ ads: -1, trackers: Number.NaN, other: 2, total: -3 }),
    });
    expect(snapshot.activeViewCount).toBe(3);
    expect(snapshot.sleepingTabCount).toBe(0);
    expect(snapshot.shieldsBlocked).toEqual({ ads: 0, trackers: 0, other: 2, total: 2 });
  });

  it('invokes each getter exactly once', () => {
    const getTabCount = vi.fn(() => 10);
    const getActiveViewCount = vi.fn(() => 2);
    const getShieldsBlockCounts = vi.fn(() => ({ ads: 1 }));
    collectPerformanceSnapshot({ getTabCount, getActiveViewCount, getShieldsBlockCounts });
    expect(getTabCount).toHaveBeenCalledTimes(1);
    expect(getActiveViewCount).toHaveBeenCalledTimes(1);
    expect(getShieldsBlockCounts).toHaveBeenCalledTimes(1);
  });

  it('summarizes per-tab Shields stats', () => {
    const summary = summarizeShieldsBlockCounts({
      'tab-1': { ads: 3, trackers: 2, other: 1, total: 6 },
      'tab-2': { ads: 4, trackers: 1, other: 0 },
    });
    expect(summary).toEqual({ ads: 7, trackers: 3, other: 1, total: 11 });
  });
});
