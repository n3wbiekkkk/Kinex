import type { MemorySaverTimeout, TabItem } from '../shared/types';

export const MEMORY_SAVER_TIMEOUT_MS: Record<MemorySaverTimeout, number | null> = {
  disabled: null,
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '30m': 30 * 60_000,
  '60m': 60 * 60_000,
};

export type DiscardBlockReason =
  | 'already-discarded'
  | 'no-live-view'
  | 'visible'
  | 'internal-page'
  | 'pinned-exempt'
  | 'audible'
  | 'active-download'
  | 'media-capture'
  | 'unsaved-form-data'
  | 'below-idle-threshold';

export interface DiscardEligibilityInput {
  tab: TabItem;
  isVisible: boolean;
  hasLiveView: boolean;
  isCurrentlyAudible: boolean;
  hasActiveDownload: boolean;
  hasActiveMediaCapture: boolean;
  hasUnsavedFormData: boolean;
  pinnedExempt: boolean;
  idleMs: number;
  thresholdMs: number | null;
  bypassTimeout?: boolean;
}

export type DiscardEligibilityResult =
  | { eligible: true }
  | { eligible: false; reason: DiscardBlockReason };

export function evaluateDiscardEligibility(
  input: DiscardEligibilityInput
): DiscardEligibilityResult {
  const { tab } = input;
  if (tab.isDiscarded) {
    return { eligible: false, reason: 'already-discarded' };
  }
  if (!input.hasLiveView) {
    return { eligible: false, reason: 'no-live-view' };
  }
  if (input.isVisible) {
    return { eligible: false, reason: 'visible' };
  }
  if (
    tab.url.startsWith('kinex://') ||
    tab.url.startsWith('nook://') ||
    tab.url === 'about:blank'
  ) {
    return { eligible: false, reason: 'internal-page' };
  }
  if (input.pinnedExempt && (tab.location === 'pinned' || tab.location === 'topApp')) {
    return { eligible: false, reason: 'pinned-exempt' };
  }
  if (tab.isAudible || input.isCurrentlyAudible) {
    return { eligible: false, reason: 'audible' };
  }
  if (input.hasActiveDownload) {
    return { eligible: false, reason: 'active-download' };
  }
  if (input.hasActiveMediaCapture) {
    return { eligible: false, reason: 'media-capture' };
  }
  if (input.hasUnsavedFormData) {
    return { eligible: false, reason: 'unsaved-form-data' };
  }
  if (!input.bypassTimeout) {
    if (input.thresholdMs === null || input.idleMs < input.thresholdMs) {
      return { eligible: false, reason: 'below-idle-threshold' };
    }
  }
  return { eligible: true };
}
