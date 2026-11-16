import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Engine, FilterSet } from 'adblock-rs';
import { getDomain } from 'tldts';
import {
  createDefaultShieldsFilterLists,
  normalizeShieldsSiteKey,
  resolveEffectiveShieldsMode,
} from '../../shared/domain';
import type {
  PersistedShieldsSettings,
  ShieldsBlockedCategory,
  ShieldsFilterListMeta,
  ShieldsMode,
} from '../../shared/types';
import {
  downloadAndVerifyFilterList,
  loadFilterListFromDisk,
  writeFilterListAtomically,
} from './lists';
import { buildVettedAdblockResources } from './scriptlets';

export interface NetworkEvaluationResult {
  blocked: boolean;
  redirectUrl?: string;
  rewrittenUrl?: string;
  category: ShieldsBlockedCategory;
  listName: string;
  mode: ShieldsMode;
}

export interface CosmeticEvaluationResult {
  mode: ShieldsMode;
  domainKey: string;
  hideSelectors: string[];
  proceduralActions: string[];
  exceptions: string[];
  injectedScript: string;
  genericHide: boolean;
}

const ELECTRON_TO_ADBLOCK_RESOURCE_TYPE: Record<string, string> = {
  mainFrame: 'document',
  subFrame: 'subdocument',
  stylesheet: 'stylesheet',
  script: 'script',
  image: 'image',
  font: 'font',
  object: 'object',
  xhr: 'xmlhttprequest',
  ping: 'ping',
  cspReport: 'csp_report',
  media: 'media',
  webSocket: 'websocket',
  other: 'other',
};

const MAX_RULE_EVAL_EXCEPTIONS_SAFE = 4096;

function categoryForList(list?: ShieldsFilterListMeta, resourceType?: string): ShieldsBlockedCategory {
  if (list?.category === 'privacy') return 'tracker';
  if (list?.category === 'ads') return 'ad';
  if (resourceType === 'ping' || resourceType === 'cspReport' || resourceType === 'webSocket') {
    return 'tracker';
  }
  return list ? 'other' : 'ad';
}

interface TierRuntime {
  engine: Engine;
  sourceLists: ShieldsFilterListMeta[];
  signature: string;
}

export class KinexShieldsEngine {
  private standardRuntime: TierRuntime | null = null;
  private aggressiveRuntime: TierRuntime | null = null;
  private settings: PersistedShieldsSettings;
  private engineError: string | undefined;
  private updatePromise: Promise<{ lists: ShieldsFilterListMeta[]; updatedCount: number }> | null = null;
  private readonly resources = buildVettedAdblockResources();

  constructor(
    private readonly userDataDir: string,
    initialSettings: PersistedShieldsSettings
  ) {
    this.settings = initialSettings;
  }

  getSettings(): PersistedShieldsSettings {
    return this.settings;
  }

  updateSettings(next: PersistedShieldsSettings): { rulesChanged: boolean } {
    const prevSig = this.tierSignature(this.settings.filterLists, 'aggressive');
    const nextSig = this.tierSignature(next.filterLists, 'aggressive');
    const prevStd = this.tierSignature(this.settings.filterLists, 'standard');
    const nextStd = this.tierSignature(next.filterLists, 'standard');
    const rulesChanged = prevSig !== nextSig || prevStd !== nextStd;
    this.settings = next;
    if (rulesChanged) {
      this.rebuildSync();
    } else if (this.needsAggressiveTier(next) && !this.aggressiveRuntime) {
      this.aggressiveRuntime = this.buildTier('aggressive');
    }
    return { rulesChanged };
  }

  isReady(): boolean {
    return Boolean(this.standardRuntime);
  }

  getError(): string | undefined {
    return this.engineError;
  }

  getTotalRuleCount(): number {
    return this.settings.filterLists
      .filter((l) => l.enabled && (this.settings.globalMode === 'aggressive' || l.tier === 'standard'))
      .reduce((acc, l) => acc + l.ruleCount, 0);
  }

  initializeSync(): { updatedLists: ShieldsFilterListMeta[] } {
    this.rebuildSync();
    return { updatedLists: this.settings.filterLists };
  }

  hasWarmCache(): boolean {
    const sig = this.tierSignature(this.settings.filterLists, 'standard');
    return fs.existsSync(path.join(this.userDataDir, 'shields-cache', `${sig}.bin`));
  }

  private needsAggressiveTier(settings: PersistedShieldsSettings): boolean {
    if (settings.globalMode === 'aggressive') return true;
    return Object.values(settings.siteOverrides).some((m) => m === 'aggressive');
  }

  private listsForTier(tier: 'standard' | 'aggressive', lists: ShieldsFilterListMeta[]): ShieldsFilterListMeta[] {
    return lists.filter(
      (l) => l.enabled && (tier === 'aggressive' || l.tier === 'standard')
    );
  }

  private tierSignature(lists: ShieldsFilterListMeta[], tier: 'standard' | 'aggressive'): string {
    const active = this.listsForTier(tier, lists);
    const hash = crypto.createHash('sha1');
    for (const item of active) {
      hash.update(`${item.id}:${item.bundledFile}:${item.lastUpdatedAt ?? 0};`);
    }
    return `${tier}-${hash.digest('hex').slice(0, 12)}`;
  }

  private buildTier(tier: 'standard' | 'aggressive'): TierRuntime | null {
    const lists = this.listsForTier(tier, this.settings.filterLists);
    const sig = this.tierSignature(this.settings.filterLists, tier);
    const cacheDir = path.join(this.userDataDir, 'shields-cache');
    const cachePath = path.join(cacheDir, `${sig}.bin`);
    const countsPath = path.join(cacheDir, `${sig}.counts.json`);

    // Fast path: deserialize precompiled engine directly without decompressing filter lists on warm launch
    if (fs.existsSync(cachePath)) {
      try {
        const bin = fs.readFileSync(cachePath);
        const engine = new Engine(new FilterSet(true));
        engine.deserialize(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength));
        engine.useResources(this.resources);
        let sourceLists = lists;
        if (fs.existsSync(countsPath)) {
          try {
            const parsedCounts = JSON.parse(fs.readFileSync(countsPath, 'utf8')) as Record<string, number>;
            this.settings = {
              ...this.settings,
              filterLists: this.settings.filterLists.map((l) =>
                typeof parsedCounts[l.id] === 'number' ? { ...l, ruleCount: parsedCounts[l.id] } : l
              ),
            };
            sourceLists = this.listsForTier(tier, this.settings.filterLists);
          } catch {
            // Non-fatal counts sidecar read error
          }
        }
        this.engineError = undefined;
        return { engine, sourceLists, signature: sig };
      } catch {
        // Fall through cleanly to rebuild from bundled/downloaded gzip lists
      }
    }

    const loadedLists = lists
      .map((meta) => loadFilterListFromDisk(this.userDataDir, meta))
      .filter((x): x is NonNullable<typeof x> => Boolean(x));

    const updatedCounts = new Map(loadedLists.map((item) => [item.meta.id, item.ruleCount]));
    this.settings = {
      ...this.settings,
      filterLists: this.settings.filterLists.map((l) =>
        updatedCounts.has(l.id) ? { ...l, ruleCount: updatedCounts.get(l.id)! } : l
      ),
    };

    try {
      const sourceLists = loadedLists.map((l) => l.meta);
      const filterSet = new FilterSet(true);
      for (const loaded of loadedLists) {
        filterSet.addFilters(loaded.rawText);
      }
      const engine = new Engine(filterSet);
      engine.useResources(this.resources);
      try {
        fs.mkdirSync(cacheDir, { recursive: true });
        for (const existing of fs.readdirSync(cacheDir)) {
          if (existing.startsWith(`${tier}-`) && (existing.endsWith('.bin') || existing.endsWith('.counts.json'))) {
            try {
              fs.unlinkSync(path.join(cacheDir, existing));
            } catch {}
          }
        }
        const serialized = Buffer.from(engine.serialize());
        const tmp = path.join(cacheDir, `${sig}.${process.pid}.tmp`);
        fs.writeFileSync(tmp, serialized);
        fs.renameSync(tmp, cachePath);
        fs.writeFileSync(countsPath, JSON.stringify(Object.fromEntries(updatedCounts)));
      } catch {
        // Non-fatal cache write error
      }
      this.engineError = undefined;
      return { engine, sourceLists, signature: sig };
    } catch (err) {
      this.engineError = err instanceof Error ? err.message : 'Failed to initialize Shields engine';
      return null;
    }
  }

  private rebuildSync(): void {
    this.standardRuntime = this.buildTier('standard');
    if (this.needsAggressiveTier(this.settings)) {
      this.aggressiveRuntime = this.buildTier('aggressive');
    } else {
      this.aggressiveRuntime = null;
    }
  }

  resolveModeForPage(pageUrl: string): { mode: ShieldsMode; source: 'internal' | 'site' | 'domain' | 'global'; domainKey: string } {
    let host = '';
    try {
      host = new URL(pageUrl).hostname.toLowerCase();
    } catch {
      host = '';
    }
    const registrable = host ? getDomain(host) : null;
    return resolveEffectiveShieldsMode(this.settings, pageUrl, registrable);
  }

  private runtimeForMode(mode: ShieldsMode): TierRuntime | null {
    if (mode === 'disabled') return null;
    if (mode === 'aggressive') {
      if (!this.aggressiveRuntime) {
        this.aggressiveRuntime = this.buildTier('aggressive');
      }
      return this.aggressiveRuntime ?? this.standardRuntime;
    }
    return this.standardRuntime;
  }

  evaluateNetworkRequest(params: {
    url: string;
    sourceUrl: string;
    resourceType: string;
    method?: string;
  }): NetworkEvaluationResult {
    const resolved = this.resolveModeForPage(params.sourceUrl || params.url);
    if (resolved.mode === 'disabled') {
      return { blocked: false, category: 'other', listName: '', mode: 'disabled' };
    }

    const runtime = this.runtimeForMode(resolved.mode);
    if (!runtime) {
      return { blocked: false, category: 'other', listName: '', mode: resolved.mode };
    }

    const adblockType = ELECTRON_TO_ADBLOCK_RESOURCE_TYPE[params.resourceType] || 'other';
    try {
      const result = runtime.engine.check(
        params.url,
        params.sourceUrl || params.url,
        adblockType,
        (params.method || 'GET').toLowerCase(),
        true
      );
      const srcIdx = result.filter?.source_location?.source_index;
      const matchedList = typeof srcIdx === 'number' ? runtime.sourceLists[srcIdx] : undefined;
      return {
        blocked: result.should_block,
        redirectUrl: result.redirect ?? undefined,
        rewrittenUrl: result.rewritten_url ?? undefined,
        category: categoryForList(matchedList, params.resourceType),
        listName: matchedList?.name || 'Kinex Shields',
        mode: resolved.mode,
      };
    } catch {
      return { blocked: false, category: 'other', listName: '', mode: resolved.mode };
    }
  }

  evaluateCosmeticsForUrl(pageUrl: string): CosmeticEvaluationResult {
    const resolved = this.resolveModeForPage(pageUrl);
    if (resolved.mode === 'disabled' || !this.settings.cosmeticFilteringEnabled) {
      return {
        mode: resolved.mode,
        domainKey: resolved.domainKey,
        hideSelectors: [],
        proceduralActions: [],
        exceptions: [],
        injectedScript: '',
        genericHide: true,
      };
    }

    const runtime = this.runtimeForMode(resolved.mode);
    const customSelectors = [
      ...(resolved.domainKey ? this.settings.customCosmeticRules[resolved.domainKey] ?? [] : []),
      ...(resolved.domainKey
        ? this.settings.customCosmeticRules[normalizeShieldsSiteKey(pageUrl)] ?? []
        : []),
    ];

    if (!runtime) {
      return {
        mode: resolved.mode,
        domainKey: resolved.domainKey,
        hideSelectors: Array.from(new Set(customSelectors)),
        proceduralActions: [],
        exceptions: [],
        injectedScript: '',
        genericHide: false,
      };
    }

    const res = runtime.engine.urlCosmeticResources(pageUrl);
    const combinedHide = Array.from(new Set([...res.hide_selectors, ...customSelectors]));
    return {
      mode: resolved.mode,
      domainKey: resolved.domainKey,
      hideSelectors: combinedHide.slice(0, MAX_RULE_EVAL_EXCEPTIONS_SAFE),
      proceduralActions: res.procedural_actions,
      exceptions: res.exceptions,
      injectedScript: res.injected_script,
      genericHide: res.generichide,
    };
  }

  lookupGenericCosmetics(pageUrl: string, classes: string[], ids: string[], exceptions: string[]): string[] {
    const resolved = this.resolveModeForPage(pageUrl);
    if (resolved.mode === 'disabled' || !this.settings.cosmeticFilteringEnabled) return [];
    const runtime = this.runtimeForMode(resolved.mode);
    if (!runtime) return [];
    try {
      return runtime.engine.hiddenClassIdSelectors(
        classes.slice(0, 1200),
        ids.slice(0, 600),
        exceptions.slice(0, 2000)
      );
    } catch {
      return [];
    }
  }

  async updateAllEnabledLists(fetchImpl: typeof fetch = fetch): Promise<{
    lists: ShieldsFilterListMeta[];
    updatedCount: number;
  }> {
    if (this.updatePromise) return this.updatePromise;

    this.updatePromise = (async () => {
      let updatedCount = 0;
      const nextLists: ShieldsFilterListMeta[] = [];
      for (const list of this.settings.filterLists) {
        if (!list.enabled) {
          nextLists.push(list);
          continue;
        }
        const download = await downloadAndVerifyFilterList(list.sourceUrl, fetchImpl);
        if (!download.ok) {
          nextLists.push({ ...list, lastError: download.error });
          continue;
        }
        // Parse-test in isolation BEFORE replacing persisted list
        try {
          const probeFs = new FilterSet(false);
          probeFs.addFilters(download.text);
          new Engine(probeFs);
        } catch (err) {
          nextLists.push({
            ...list,
            lastError: err instanceof Error ? err.message : 'Invalid filter list syntax',
          });
          continue;
        }

        writeFilterListAtomically(this.userDataDir, list.id, download.text);
        updatedCount += 1;
        nextLists.push({
          ...list,
          ruleCount: download.ruleCount,
          lastUpdatedAt: Date.now(),
          lastError: undefined,
        });
      }

      this.settings = {
        ...this.settings,
        filterLists: nextLists,
        lastGlobalUpdateAt: Date.now(),
      };
      this.rebuildSync();
      return { lists: nextLists, updatedCount };
    })().finally(() => {
      this.updatePromise = null;
    });

    return this.updatePromise;
  }

  restoreDefaultLists(): ShieldsFilterListMeta[] {
    const defaults = createDefaultShieldsFilterLists();
    this.settings = {
      ...this.settings,
      filterLists: defaults,
    };
    this.rebuildSync();
    return this.settings.filterLists;
  }
}
