import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { Engine } from 'adblock-rs';
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
  private nativeBindings: typeof import('adblock-rs') | null | undefined;
  private updateController: AbortController | null = null;
  private updateGeneration = 0;
  private disposed = false;
  private initialized = false;
  private initializationPromise: Promise<{ updatedLists: ShieldsFilterListMeta[] }> | null = null;
  private initializationWorker: Worker | null = null;
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
    if (!this.initialized) return { rulesChanged };
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
    if (this.disposed) return { updatedLists: this.settings.filterLists };
    this.rebuildSync();
    this.initialized = true;
    return { updatedLists: this.settings.filterLists };
  }

  initialize(): Promise<{ updatedLists: ShieldsFilterListMeta[] }> {
    if (this.initializationPromise) return this.initializationPromise;
    if (this.initialized || this.disposed) return Promise.resolve({ updatedLists: this.settings.filterLists });
    this.initializationPromise = (async () => {
      while (!this.disposed && !this.initialized) {
        const signature = this.initializationSignature();
        const prepared = await this.prepareCacheInWorker();
        if (this.disposed) break;
        if (signature !== this.initializationSignature()) continue;
        if (!prepared.ready) {
          this.engineError = prepared.error || 'Failed to initialize Shields in worker';
          this.initialized = true;
          break;
        }
        this.initializeSync();
      }
      return { updatedLists: this.settings.filterLists };
    })();
    return this.initializationPromise;
  }

  async whenInitialized(): Promise<void> {
    await this.initialize();
  }

  private initializationSignature(): string {
    return `${this.tierSignature(this.settings.filterLists, 'aggressive')}:${this.needsAggressiveTier(this.settings)}`;
  }

  private prepareCacheInWorker(): Promise<{ ready: boolean; error?: string }> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: { ready: boolean; error?: string }) => {
        if (settled) return;
        settled = true;
        this.initializationWorker = null;
        resolve(result);
      };
      try {
        const worker = new Worker(path.join(__dirname, 'initializeWorker.js'), {
          workerData: { userDataDir: this.userDataDir, settings: this.settings },
        });
        this.initializationWorker = worker;
        worker.once('message', (result: { ready: boolean; error?: string }) => finish(result));
        worker.once('error', (error) => finish({ ready: false, error: error.message }));
        worker.once('exit', (code) => finish({ ready: false, error: `Shields initialization worker exited (${code})` }));
      } catch (error) {
        finish({ ready: false, error: error instanceof Error ? error.message : 'Unable to start Shields worker' });
      }
    });
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
    if (this.disposed) return null;
    const native = this.loadNativeBindings();
    if (!native) return null;
    const { Engine, FilterSet } = native;
    const lists = this.listsForTier(tier, this.settings.filterLists);
    const sig = this.tierSignature(this.settings.filterLists, tier);
    const cacheDir = path.join(this.userDataDir, 'shields-cache');
    const cachePath = path.join(cacheDir, `${sig}.bin`);
    const countsPath = path.join(cacheDir, `${sig}.counts.json`);

    // Fast path: deserialize precompiled engine directly without decompressing filter lists on warm launch
    if (fs.existsSync(cachePath)) {
      try {
        if (fs.statSync(cachePath).size > 128 * 1024 * 1024) throw new Error('Oversized Shields cache');
        if (fs.statSync(countsPath).size > 64 * 1024) throw new Error('Oversized Shields cache metadata');
        const bin = fs.readFileSync(cachePath);
        const metadata = JSON.parse(fs.readFileSync(countsPath, 'utf8')) as {
          sha256?: string; counts?: Record<string, number>;
        };
        const parsedCounts = metadata.counts;
        if (metadata.sha256 !== crypto.createHash('sha256').update(bin).digest('hex') ||
            !parsedCounts || !lists.every((list) => Number.isSafeInteger(parsedCounts[list.id]) && parsedCounts[list.id] >= 0)) {
          throw new Error('Invalid Shields cache metadata');
        }
        const engine = new Engine(new FilterSet(true));
        engine.deserialize(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength));
        engine.useResources(this.resources);
        this.settings = {
          ...this.settings,
          filterLists: this.settings.filterLists.map((l) =>
            Number.isSafeInteger(parsedCounts[l.id]) && parsedCounts[l.id] >= 0
              ? { ...l, ruleCount: parsedCounts[l.id] } : l
          ),
        };
        const sourceLists = this.listsForTier(tier, this.settings.filterLists);
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
    const missing = lists.filter((list) => !updatedCounts.has(list.id));
    const loadError = missing.length > 0
      ? `Unable to load filter lists: ${missing.map((list) => list.name).join(', ')}`
      : undefined;
    this.settings = {
      ...this.settings,
      filterLists: this.settings.filterLists.map((l) =>
        updatedCounts.has(l.id) ? { ...l, ruleCount: updatedCounts.get(l.id)! }
          : missing.some((item) => item.id === l.id) ? { ...l, ruleCount: 0, lastError: l.lastError ?? 'Filter list unavailable' } : l
      ),
    };
    if (lists.length > 0 && loadedLists.length === 0) {
      this.engineError = loadError;
      return null;
    }

    try {
      const sourceLists = loadedLists.map((l) => l.meta);
      const filterSet = new FilterSet(true);
      for (const loaded of loadedLists) {
        filterSet.addFilters(loaded.rawText);
      }
      const engine = new Engine(filterSet);
      engine.useResources(this.resources);
      try {
        if (loadError) throw new Error(loadError);
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
        const metadataTmp = `${countsPath}.${process.pid}.tmp`;
        fs.writeFileSync(metadataTmp, JSON.stringify({
          sha256: crypto.createHash('sha256').update(serialized).digest('hex'),
          counts: Object.fromEntries(updatedCounts),
        }));
        fs.renameSync(metadataTmp, countsPath);
      } catch {
        // Non-fatal cache write error
      }
      this.engineError = loadError;
      return { engine, sourceLists, signature: sig };
    } catch (err) {
      this.engineError = err instanceof Error ? err.message : 'Failed to initialize Shields engine';
      return null;
    }
  }

  private loadNativeBindings(): typeof import('adblock-rs') | null {
    if (this.nativeBindings !== undefined) return this.nativeBindings;
    try {
      this.nativeBindings = require('adblock-rs') as typeof import('adblock-rs');
    } catch (err) {
      this.nativeBindings = null;
      this.engineError = `Shields native engine unavailable: ${err instanceof Error ? err.message : 'load failed'}`;
    }
    return this.nativeBindings;
  }

  private rebuildSync(): void {
    this.standardRuntime = this.buildTier('standard') ?? this.standardRuntime;
    const standardError = this.engineError;
    if (this.needsAggressiveTier(this.settings)) {
      this.aggressiveRuntime = this.buildTier('aggressive') ?? this.aggressiveRuntime;
    } else {
      this.aggressiveRuntime = null;
    }
    this.engineError = standardError ?? this.engineError;
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
    if (!this.initialized || this.disposed) return null;
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
    pageUrl?: string;
    resourceType: string;
    method?: string;
  }): NetworkEvaluationResult {
    const resolved = this.resolveModeForPage(params.pageUrl || params.sourceUrl || params.url);
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

    let res: ReturnType<Engine['urlCosmeticResources']> | undefined;
    if (runtime) {
      try {
        res = runtime.engine.urlCosmeticResources(pageUrl);
      } catch (err) {
        this.engineError = err instanceof Error ? err.message : 'Failed to evaluate cosmetic rules';
      }
    }
    if (!res) {
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
    if (this.disposed) return { lists: this.settings.filterLists, updatedCount: 0 };
    if (!this.initialized) await this.initialize();
    if (this.disposed) return { lists: this.settings.filterLists, updatedCount: 0 };
    if (this.updatePromise) return this.updatePromise;
    const generation = this.updateGeneration;
    const controller = new AbortController();
    this.updateController = controller;

    this.updatePromise = (async () => {
      let updatedCount = 0;
      for (const list of this.settings.filterLists) {
        if (!list.enabled) continue;
        const download = await downloadAndVerifyFilterList(list.sourceUrl, fetchImpl, controller.signal);
        if (this.disposed || generation !== this.updateGeneration) {
          return { lists: this.settings.filterLists, updatedCount };
        }
        const current = this.settings.filterLists.find((item) => item.id === list.id);
        if (!current?.enabled || current.sourceUrl !== list.sourceUrl) continue;
        let metadata: Partial<ShieldsFilterListMeta>;
        try {
          if (!download.ok) throw new Error(download.error);
          const native = this.loadNativeBindings();
          if (!native) throw new Error(this.engineError);
          const { Engine, FilterSet } = native;
          const probeFs = new FilterSet(false);
          probeFs.addFilters(download.text);
          new Engine(probeFs);
          writeFilterListAtomically(this.userDataDir, list.id, download.text);
          updatedCount += 1;
          metadata = {
            ruleCount: download.ruleCount,
            lastUpdatedAt: Date.now(),
            lastError: undefined,
          };
        } catch (err) {
          metadata = {
            lastError: err instanceof Error ? err.message : 'Invalid filter list syntax',
          };
        }
        this.settings = {
          ...this.settings,
          filterLists: this.settings.filterLists.map((item) => item.id === list.id ? { ...item, ...metadata } : item),
        };
      }

      this.settings = {
        ...this.settings,
        lastGlobalUpdateAt: Date.now(),
      };
      this.rebuildSync();
      return { lists: this.settings.filterLists, updatedCount };
    })().finally(() => {
      this.updatePromise = null;
      this.updateController = null;
    });

    return this.updatePromise;
  }

  restoreDefaultLists(): ShieldsFilterListMeta[] {
    this.updateGeneration += 1;
    this.updateController?.abort();
    const defaults = createDefaultShieldsFilterLists();
    this.settings = {
      ...this.settings,
      filterLists: defaults,
    };
    if (this.initialized) this.rebuildSync();
    return this.settings.filterLists;
  }

  dispose(): void {
    this.disposed = true;
    this.updateGeneration += 1;
    this.updateController?.abort();
    void this.initializationWorker?.terminate();
    this.standardRuntime = null;
    this.aggressiveRuntime = null;
  }
}
