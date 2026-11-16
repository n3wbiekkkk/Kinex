import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { TabItem } from '../shared/types';
import { validateIntent } from './ipcValidation';
import { evaluateDiscardEligibility, MEMORY_SAVER_TIMEOUT_MS } from './memorySaver';
import { KinexPersistence } from './persistence';

function makeTab(overrides: Partial<TabItem> = {}): TabItem {
  return {
    id: 'tab-1',
    spaceId: 'space-personal',
    location: 'unpinned',
    url: 'https://example.org/article',
    title: 'Example Article',
    isLoading: false,
    canGoBack: false,
    canGoForward: false,
    isMuted: false,
    isAudible: false,
    lastActiveAt: 1_000,
    ...overrides,
  };
}

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('Memory Saver discard policy and settings persistence', () => {
  it('blocks discard for visible, split, audible, download, media-capture, form-dirty, and internal tabs', () => {
    const baseInput = {
      tab: makeTab(),
      isVisible: false,
      hasLiveView: true,
      isCurrentlyAudible: false,
      hasActiveDownload: false,
      hasActiveMediaCapture: false,
      hasUnsavedFormData: false,
      pinnedExempt: true,
      idleMs: MEMORY_SAVER_TIMEOUT_MS['30m']! + 1000,
      thresholdMs: MEMORY_SAVER_TIMEOUT_MS['30m'],
    };

    expect(evaluateDiscardEligibility(baseInput)).toEqual({ eligible: true });
    expect(evaluateDiscardEligibility({ ...baseInput, isVisible: true })).toEqual({
      eligible: false,
      reason: 'visible',
    });
    expect(evaluateDiscardEligibility({ ...baseInput, hasLiveView: false })).toEqual({
      eligible: false,
      reason: 'no-live-view',
    });
    expect(evaluateDiscardEligibility({ ...baseInput, tab: makeTab({ isDiscarded: true }) })).toEqual({
      eligible: false,
      reason: 'already-discarded',
    });
    expect(evaluateDiscardEligibility({ ...baseInput, tab: makeTab({ url: 'kinex://welcome' }) })).toEqual({
      eligible: false,
      reason: 'internal-page',
    });
    expect(evaluateDiscardEligibility({ ...baseInput, isCurrentlyAudible: true })).toEqual({
      eligible: false,
      reason: 'audible',
    });
    expect(evaluateDiscardEligibility({ ...baseInput, tab: makeTab({ isAudible: true }) })).toEqual({
      eligible: false,
      reason: 'audible',
    });
    expect(evaluateDiscardEligibility({ ...baseInput, hasActiveDownload: true })).toEqual({
      eligible: false,
      reason: 'active-download',
    });
    expect(evaluateDiscardEligibility({ ...baseInput, hasActiveMediaCapture: true })).toEqual({
      eligible: false,
      reason: 'media-capture',
    });
    expect(evaluateDiscardEligibility({ ...baseInput, hasUnsavedFormData: true })).toEqual({
      eligible: false,
      reason: 'unsaved-form-data',
    });
  });

  it('respects pinned exemption and configurable idle timeouts cleanly', () => {
    const pinnedTab = makeTab({ location: 'pinned', pinnedUrl: 'https://github.com' });
    const favTab = makeTab({ location: 'topApp', pinnedUrl: 'https://github.com' });

    expect(
      evaluateDiscardEligibility({
        tab: pinnedTab,
        isVisible: false,
        hasLiveView: true,
        isCurrentlyAudible: false,
        hasActiveDownload: false,
        hasActiveMediaCapture: false,
        hasUnsavedFormData: false,
        pinnedExempt: true,
        idleMs: 120 * 60_000,
        thresholdMs: MEMORY_SAVER_TIMEOUT_MS['5m'],
      })
    ).toEqual({ eligible: false, reason: 'pinned-exempt' });

    expect(
      evaluateDiscardEligibility({
        tab: favTab,
        isVisible: false,
        hasLiveView: true,
        isCurrentlyAudible: false,
        hasActiveDownload: false,
        hasActiveMediaCapture: false,
        hasUnsavedFormData: false,
        pinnedExempt: false,
        idleMs: 10 * 60_000,
        thresholdMs: MEMORY_SAVER_TIMEOUT_MS['5m'],
      })
    ).toEqual({ eligible: true });

    expect(
      evaluateDiscardEligibility({
        tab: makeTab(),
        isVisible: false,
        hasLiveView: true,
        isCurrentlyAudible: false,
        hasActiveDownload: false,
        hasActiveMediaCapture: false,
        hasUnsavedFormData: false,
        pinnedExempt: true,
        idleMs: 2 * 60_000,
        thresholdMs: MEMORY_SAVER_TIMEOUT_MS['5m'],
      })
    ).toEqual({ eligible: false, reason: 'below-idle-threshold' });

    expect(
      evaluateDiscardEligibility({
        tab: makeTab(),
        isVisible: false,
        hasLiveView: true,
        isCurrentlyAudible: false,
        hasActiveDownload: false,
        hasActiveMediaCapture: false,
        hasUnsavedFormData: false,
        pinnedExempt: true,
        idleMs: 1_000,
        thresholdMs: null,
        bypassTimeout: true,
      })
    ).toEqual({ eligible: true });
  });

  it('validates Memory Saver intents and persists compact settings safely', () => {
    expect(validateIntent({ type: 'set-memory-saver-timeout', timeout: '15m' }).ok).toBe(true);
    expect(validateIntent({ type: 'set-memory-saver-timeout', timeout: '1m' }).ok).toBe(false);
    expect(validateIntent({ type: 'set-memory-saver-exempt-pinned', exempt: false }).ok).toBe(true);
    expect(validateIntent({ type: 'discard-tab', tabId: 'tab-1' }).ok).toBe(true);
    expect(validateIntent({ type: 'discard-tab', tabId: '' }).ok).toBe(false);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kinex-ms-'));
    tempDirs.push(dir);
    const persistence = new KinexPersistence(dir);
    const data = persistence.load();
    data.memorySaverTimeout = '15m';
    data.memorySaverExemptPinned = false;
    persistence.scheduleSave(data, 50);
    persistence.flushPendingSave(data);

    const reloaded = persistence.load();
    expect(reloaded.memorySaverTimeout).toBe('15m');
    expect(reloaded.memorySaverExemptPinned).toBe(false);
  });
});
