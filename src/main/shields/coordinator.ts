import type { Session } from 'electron';
import { extractHostname } from '../../shared/domain';
import type { ShieldsBlockedCategory, TabShieldsStats } from '../../shared/types';
import { stripTrackingParams } from '../security';
import type { KinexShieldsEngine } from './engine';

const MAX_RECENT_SAMPLES = 25;
const MAX_SEEN_REQUEST_IDS = 4000;

export interface ShieldsCoordinatorHost {
  resolveTabIdByWebContentsId: (wcId: number) => string | undefined;
  isPrivateWebContents: (wcId: number) => boolean;
  onStatsChanged: () => void;
}

export class KinexShieldsCoordinator {
  private readonly attachedSessions = new WeakSet<Session>();
  private readonly statsByTabId = new Map<string, TabShieldsStats>();
  private readonly topPageUrlByWcId = new Map<number, string>();
  private readonly seenRequestIds = new Set<number>();
  private readonly seenRequestQueue: number[] = [];
  private totalBlockedSessionCount = 0;

  constructor(
    private readonly engine: KinexShieldsEngine,
    private readonly host: ShieldsCoordinatorHost
  ) {}

  getTotalBlockedCount(): number {
    return this.totalBlockedSessionCount;
  }

  getTabStatsMap(): Record<string, TabShieldsStats> {
    const out: Record<string, TabShieldsStats> = {};
    for (const [tabId, stats] of this.statsByTabId.entries()) {
      out[tabId] = {
        ...stats,
        recentBlocked: [...stats.recentBlocked],
      };
    }
    return out;
  }

  clearTabStats(tabId: string): void {
    this.statsByTabId.delete(tabId);
  }

  clearWebContentsTracking(wcId: number): void {
    this.topPageUrlByWcId.delete(wcId);
    const auxKey = `aux:${wcId}`;
    this.statsByTabId.delete(auxKey);
  }

  updateTopPageUrl(wcId: number, url: string): void {
    this.topPageUrlByWcId.set(wcId, url);
  }

  resetTabStatsForNavigation(tabId: string): void {
    this.statsByTabId.set(tabId, {
      total: 0,
      ads: 0,
      trackers: 0,
      other: 0,
      recentBlocked: [],
    });
  }

  private recordDedupRequestId(id: number): boolean {
    if (this.seenRequestIds.has(id)) return false;
    this.seenRequestIds.add(id);
    this.seenRequestQueue.push(id);
    if (this.seenRequestQueue.length > MAX_SEEN_REQUEST_IDS) {
      const oldest = this.seenRequestQueue.shift();
      if (oldest !== undefined) this.seenRequestIds.delete(oldest);
    }
    return true;
  }

  private recordBlocked(
    tabKey: string,
    blockedUrl: string,
    resourceType: string,
    category: ShieldsBlockedCategory,
    listName: string,
    isPrivate: boolean
  ): void {
    this.totalBlockedSessionCount += 1;
    // Privacy invariant: keep transient per-tab stats for visible feedback without persisting browsing history
    const current = this.statsByTabId.get(tabKey) ?? {
      total: 0,
      ads: 0,
      trackers: 0,
      other: 0,
      recentBlocked: [],
    };
    const next: TabShieldsStats = {
      total: current.total + 1,
      ads: current.ads + (category === 'ad' ? 1 : 0),
      trackers: current.trackers + (category === 'tracker' ? 1 : 0),
      other: current.other + (category === 'other' ? 1 : 0),
      recentBlocked: current.recentBlocked,
    };
    const host = isPrivate ? '[Private request blocked]' : extractHostname(blockedUrl) || blockedUrl.slice(0, 64);
    const dedupKey = `${category}:${resourceType}:${host}`;
    if (!next.recentBlocked.some((item) => item.id === dedupKey)) {
      next.recentBlocked = [
        { id: dedupKey, host, resourceType, category, listName },
        ...next.recentBlocked,
      ].slice(0, MAX_RECENT_SAMPLES);
    }
    this.statsByTabId.set(tabKey, next);
    this.host.onStatsChanged();
  }

  attachSession(sess: Session): void {
    if (this.attachedSessions.has(sess)) return;
    this.attachedSessions.add(sess);

    sess.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, callback) => {
      const evaluate = () => {
        const wcId = details.webContentsId ?? -1;
        const tabId = wcId > 0 ? this.host.resolveTabIdByWebContentsId(wcId) : undefined;
        const tabKey = tabId ?? (wcId > 0 ? `aux:${wcId}` : 'global');
        const isPrivate = wcId > 0 ? this.host.isPrivateWebContents(wcId) : false;

        if (details.resourceType === 'mainFrame') {
          if (wcId > 0) {
            this.topPageUrlByWcId.set(wcId, details.url);
          }
          if (tabId) {
            this.resetTabStatsForNavigation(tabId);
          } else if (wcId > 0) {
            this.resetTabStatsForNavigation(`aux:${wcId}`);
          }

          const shieldsCfg = this.engine.getSettings();
          const modeInfo = this.engine.resolveModeForPage(details.url);
          if (modeInfo.mode !== 'disabled' && shieldsCfg.stripTrackingParams) {
            const stripped = stripTrackingParams(details.url);
            if (stripped !== details.url && stripped.startsWith('http')) {
              callback({ redirectURL: stripped });
              return;
            }
          }
          callback({ cancel: false });
          return;
        }

        const sourceUrl =
          details.referrer ||
          (wcId > 0 ? this.topPageUrlByWcId.get(wcId) : undefined) ||
          details.url;

        const evalResult = this.engine.evaluateNetworkRequest({
          url: details.url,
          sourceUrl,
          pageUrl: wcId > 0 ? this.topPageUrlByWcId.get(wcId) : undefined,
          resourceType: details.resourceType,
          method: details.method,
        });

        if (evalResult.blocked) {
          if (this.recordDedupRequestId(details.id)) {
            this.recordBlocked(
              tabKey,
              details.url,
              details.resourceType,
              evalResult.category,
              evalResult.listName,
              isPrivate
            );
          }
          if (evalResult.redirectUrl) {
            callback({ redirectURL: evalResult.redirectUrl });
            return;
          }
          callback({ cancel: true });
          return;
        }

        if (evalResult.rewrittenUrl && evalResult.rewrittenUrl !== details.url) {
          callback({ redirectURL: evalResult.rewrittenUrl });
          return;
        }

        callback({ cancel: false });
      };
      if (this.engine.isReady()) evaluate();
      else void this.engine.whenInitialized().then(evaluate, () => callback({ cancel: false }));
    });
  }
}
