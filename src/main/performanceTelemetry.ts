/**
 * Pure performance telemetry aggregation.
 *
 * This module deliberately has NO Electron (or any other runtime) import at the
 * top level so it can be exercised in plain Node unit tests. Callers inject
 * getters for each live source and receive a single immutable snapshot.
 */

import type { PerformanceSnapshot, ShieldsBlockCounts } from '../shared/types';

export type { PerformanceSnapshot, ShieldsBlockCounts } from '../shared/types';

/** Shape accepted by `summarizeShieldsBlockCounts` (matches TabShieldsStats). */
export interface ShieldsStatsLike {
  ads?: number;
  trackers?: number;
  other?: number;
  total?: number;
}

/**
 * Conservative per-sleeping-tab estimate (120 MiB) used only when a caller
 * does not inject a measured byte value.
 */
export const ESTIMATED_SLEEPING_TAB_BYTES = 120 * 1024 * 1024;

export interface PerformanceGetters {
  getTabCount?: () => number;
  getActiveViewCount?: () => number;
  getSleepingTabCount?: () => number;
  /** Measured bytes saved; overrides the per-sleeping-tab estimate when given. */
  getSleepingMemorySavedBytes?: () => number;
  getShieldsBlockCounts?: () => Partial<ShieldsBlockCounts>;
}

function nonNegative(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function count(getter: (() => number) | undefined): number {
  if (!getter) return 0;
  try {
    return nonNegative(getter());
  } catch {
    return 0;
  }
}

/** Aggregates Shields tab stats into a single block-count summary. */
export function summarizeShieldsBlockCounts(
  tabStats: Record<string, ShieldsStatsLike> | undefined
): ShieldsBlockCounts {
  let ads = 0;
  let trackers = 0;
  let other = 0;
  let total = 0;
  for (const stats of Object.values(tabStats ?? {})) {
    if (!stats || typeof stats !== 'object') continue;
    const categoryTotal = nonNegative(stats.ads) + nonNegative(stats.trackers) + nonNegative(stats.other);
    ads += nonNegative(stats.ads);
    trackers += nonNegative(stats.trackers);
    other += nonNegative(stats.other);
    total += nonNegative(stats.total) || categoryTotal;
  }
  if (total === 0) total = ads + trackers + other;
  return { ads, trackers, other, total };
}

/**
 * Collects a performance snapshot from injected getters. All getters are
 * optional and individually fault-tolerant so one failing source cannot break
 * the whole snapshot.
 */
export function collectPerformanceSnapshot(
  getters: PerformanceGetters = {},
  now: number = Date.now()
): PerformanceSnapshot {
  const tabCount = count(getters.getTabCount);
  const sleepingTabCount = count(getters.getSleepingTabCount);
  const activeViewCount = Math.min(count(getters.getActiveViewCount), tabCount || Number.MAX_SAFE_INTEGER);

  const measured = getters.getSleepingMemorySavedBytes
    ? count(getters.getSleepingMemorySavedBytes)
    : 0;
  const estimatedSleepingMemorySavedBytes =
    measured || sleepingTabCount * ESTIMATED_SLEEPING_TAB_BYTES;

  let rawShields: Partial<ShieldsBlockCounts> = {};
  if (getters.getShieldsBlockCounts) {
    try {
      const value = getters.getShieldsBlockCounts();
      rawShields = value && typeof value === 'object' ? value : {};
    } catch {
      rawShields = {};
    }
  }
  const shieldsBlocked: ShieldsBlockCounts = {
    ads: nonNegative(rawShields.ads),
    trackers: nonNegative(rawShields.trackers),
    other: nonNegative(rawShields.other),
    total: 0,
  };
  shieldsBlocked.total =
    nonNegative(rawShields.total) ||
    shieldsBlocked.ads + shieldsBlocked.trackers + shieldsBlocked.other;

  return {
    tabCount,
    activeViewCount,
    sleepingTabCount,
    estimatedSleepingMemorySavedBytes,
    shieldsBlocked,
    shieldsBlockedTotal: shieldsBlocked.total,
    capturedAt: Number.isFinite(now) && now >= 0 ? Math.floor(now) : Date.now(),
  };
}
