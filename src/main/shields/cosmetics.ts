import type { WebContents } from 'electron';
import type { KinexShieldsEngine } from './engine';

const ISOLATED_WORLD_ID = 99;

export function buildCosmeticCss(selectors: string[]): string {
  const safe = selectors
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s.length <= 512 && !/[{}\n\r;]/.test(s));
  if (safe.length === 0) return '';
  return `${safe.join(', ')} { display: none !important; visibility: hidden !important; }`;
}

export class ShieldsCosmeticInjector {
  private readonly cssKeysByWc = new Map<number, string[]>();
  private readonly applyChainByWc = new Map<number, Promise<void>>();
  private readonly generationByWc = new Map<number, number>();

  constructor(private readonly engine: KinexShieldsEngine) {}

  async clearInjectedCss(wc: WebContents): Promise<void> {
    if (wc.isDestroyed()) {
      this.cssKeysByWc.delete(wc.id);
      return;
    }
    const existing = this.cssKeysByWc.get(wc.id) ?? [];
    this.cssKeysByWc.delete(wc.id);
    for (const key of existing) {
      try {
        await wc.removeInsertedCSS(key);
      } catch {
        // Ignore stale keys from prior navigations
      }
    }
  }

  private trackInsertedKey(wcId: number, key: string): void {
    const cur = this.cssKeysByWc.get(wcId) ?? [];
    cur.push(key);
    this.cssKeysByWc.set(wcId, cur);
  }

  applyForWebContents(wc: WebContents, pageUrl?: string): Promise<void> {
    if (wc.isDestroyed()) return Promise.resolve();
    const wcId = wc.id;
    const gen = (this.generationByWc.get(wcId) ?? 0) + 1;
    this.generationByWc.set(wcId, gen);

    const prev = this.applyChainByWc.get(wcId) ?? Promise.resolve();
    const next = prev
      .catch(() => {})
      .then(() => this.runApplyForWebContents(wc, wcId, gen, pageUrl))
      .finally(() => {
        if (this.applyChainByWc.get(wcId) === next) {
          this.applyChainByWc.delete(wcId);
        }
      });
    this.applyChainByWc.set(wcId, next);
    return next;
  }

  private async runApplyForWebContents(
    wc: WebContents,
    wcId: number,
    gen: number,
    pageUrl?: string
  ): Promise<void> {
    if (wc.isDestroyed() || this.generationByWc.get(wcId) !== gen) return;
    const url = pageUrl || wc.getURL();
    if (
      !url ||
      url.startsWith('kinex://') ||
      url.startsWith('nook://') ||
      url.startsWith('devtools://') ||
      url === 'about:blank'
    ) {
      await this.clearInjectedCss(wc);
      return;
    }

    await this.clearInjectedCss(wc);
    if (wc.isDestroyed() || this.generationByWc.get(wcId) !== gen) return;

    const cosmetic = this.engine.evaluateCosmeticsForUrl(url);
    if (cosmetic.mode === 'disabled') return;

    const primaryCss = buildCosmeticCss(cosmetic.hideSelectors);
    if (primaryCss) {
      try {
        const key = await wc.insertCSS(primaryCss);
        if (this.generationByWc.get(wcId) !== gen) {
          void wc.removeInsertedCSS(key).catch(() => {});
          return;
        }
        this.trackInsertedKey(wcId, key);
      } catch {
        // Ignore restricted page frames
      }
    }

    // Collect initial classes/IDs strictly inside an isolated world (no page JS globals leaked)
    if (!cosmetic.genericHide && !wc.isDestroyed() && this.generationByWc.get(wcId) === gen) {
      try {
        const tokens = (await wc.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD_ID, [
          {
            code: `(() => {
              const cls = new Set();
              const ids = new Set();
              const all = document.querySelectorAll('[class],[id]');
              for (let i = 0; i < all.length && (cls.size < 900 || ids.size < 400); i++) {
                const el = all[i];
                if (el.id && ids.size < 400) ids.add(el.id);
                if (el.classList && cls.size < 900) {
                  for (let j = 0; j < el.classList.length && cls.size < 900; j++) {
                    cls.add(el.classList[j]);
                  }
                }
              }
              return { classes: Array.from(cls), ids: Array.from(ids) };
            })()`,
          },
        ])) as { classes?: string[]; ids?: string[] } | null;

        if (
          tokens &&
          !wc.isDestroyed() &&
          this.generationByWc.get(wcId) === gen &&
          ((tokens.classes?.length ?? 0) > 0 || (tokens.ids?.length ?? 0) > 0)
        ) {
          const genericSelectors = this.engine.lookupGenericCosmetics(
            url,
            tokens.classes ?? [],
            tokens.ids ?? [],
            cosmetic.exceptions
          );
          const genericCss = buildCosmeticCss(genericSelectors);
          if (genericCss && !wc.isDestroyed()) {
            const key = await wc.insertCSS(genericCss);
            if (this.generationByWc.get(wcId) !== gen) {
              void wc.removeInsertedCSS(key).catch(() => {});
              return;
            }
            this.trackInsertedKey(wcId, key);
          }
        }
      } catch {
        // Isolated world execution failed or page navigated mid-flight
      }
    }

    // Post-hydration generic class/ID scans (250ms + 900ms after load) catch SPA-rendered ad slots without continuous polling
    if (!cosmetic.genericHide && !wc.isDestroyed() && this.generationByWc.get(wcId) === gen) {
      const scanTokens = async () => {
        if (wc.isDestroyed() || wc.getURL() !== url || this.generationByWc.get(wcId) !== gen) return;
        try {
          const lateTokens = (await wc.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD_ID, [
            {
              code: `(() => {
                const cls = new Set();
                const ids = new Set();
                const all = document.querySelectorAll('[class],[id]');
                for (let i = 0; i < all.length && (cls.size < 900 || ids.size < 400); i++) {
                  const el = all[i];
                  if (el.id && ids.size < 400) ids.add(el.id);
                  if (el.classList && cls.size < 900) {
                    for (let j = 0; j < el.classList.length && cls.size < 900; j++) cls.add(el.classList[j]);
                  }
                }
                return { classes: Array.from(cls), ids: Array.from(ids) };
              })()`,
            },
          ])) as { classes?: string[]; ids?: string[] } | null;
          if (!lateTokens || wc.isDestroyed() || wc.getURL() !== url || this.generationByWc.get(wcId) !== gen) return;
          const lateSelectors = this.engine.lookupGenericCosmetics(
            url,
            lateTokens.classes ?? [],
            lateTokens.ids ?? [],
            cosmetic.exceptions
          );
          const lateCss = buildCosmeticCss(lateSelectors);
          if (lateCss && !wc.isDestroyed()) {
            const key = await wc.insertCSS(lateCss);
            if (this.generationByWc.get(wcId) !== gen) {
              void wc.removeInsertedCSS(key).catch(() => {});
              return;
            }
            this.trackInsertedKey(wcId, key);
          }
        } catch {}
      };
      for (const delayMs of [250, 900]) {
        const timer = setTimeout(() => void scanTokens(), delayMs);
        timer.unref?.();
      }
    }

    // Safe procedural cosmetic actions (:has-text, :has, :upward) + bounded MutationObserver in isolated world
    if (cosmetic.proceduralActions.length > 0 && !wc.isDestroyed() && this.generationByWc.get(wcId) === gen) {
      try {
        await wc.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD_ID, [
          {
            code: buildSafeProceduralObserverCode(cosmetic.proceduralActions),
          },
        ]);
      } catch {
        // Ignore navigation race
      }
    }

    // Vetted allowlisted scriptlets (only assembled from scriptlets.ts templates)
    if (cosmetic.injectedScript && !wc.isDestroyed() && this.generationByWc.get(wcId) === gen) {
      try {
        await wc.executeJavaScript(cosmetic.injectedScript, false);
      } catch {
        // Ignore restricted/sandboxed frames
      }
    }
  }
}

function buildSafeProceduralObserverCode(rawActions: string[]): string {
  const payload = JSON.stringify(rawActions.slice(0, 80));
  return `(() => {
    try {
      if (window.__kinexCosmeticObserver) {
        window.__kinexCosmeticObserver.disconnect();
        window.__kinexCosmeticObserver = null;
      }
      const raw = ${payload};
      const specs = [];
      for (const item of raw) {
        try {
          const parsed = JSON.parse(item);
          if (parsed && Array.isArray(parsed.selector) && parsed.selector.length > 0) {
            specs.push(parsed);
          }
        } catch {}
      }
      if (specs.length === 0) return;

      const applyProcedural = () => {
        for (const spec of specs) {
          const steps = spec.selector;
          const base = steps[0];
          if (!base || base.type !== 'css-selector' || typeof base.arg !== 'string') continue;
          let candidates;
          try { candidates = Array.from(document.querySelectorAll(base.arg)).slice(0, 120); } catch { continue; }
          for (let el of candidates) {
            let matched = true;
            for (let i = 1; i < steps.length; i++) {
              const step = steps[i];
              if (!el) { matched = false; break; }
              if (step.type === 'has-text' && typeof step.arg === 'string') {
                if (!(el.textContent || '').includes(step.arg)) { matched = false; break; }
              } else if (step.type === 'has' && typeof step.arg === 'string') {
                try { if (!el.querySelector(step.arg)) { matched = false; break; } } catch { matched = false; break; }
              } else if (step.type === 'upward') {
                if (typeof step.arg === 'number' || /^\\d+$/.test(String(step.arg))) {
                  let n = Number(step.arg);
                  while (n-- > 0 && el) el = el.parentElement;
                } else if (typeof step.arg === 'string') {
                  try { el = el.closest(step.arg); } catch { matched = false; break; }
                }
              } else {
                matched = false;
                break;
              }
            }
            if (matched && el && el.style) {
              el.style.setProperty('display', 'none', 'important');
              el.dataset.kinexHidden = '1';
            }
          }
        }
      };

      applyProcedural();
      let timer = null;
      let pendingCount = 0;
      const obs = new MutationObserver((mutations) => {
        pendingCount += mutations.length;
        if (pendingCount > 400) pendingCount = 400;
        if (timer) return;
        timer = setTimeout(() => {
          timer = null;
          pendingCount = 0;
          applyProcedural();
        }, 250);
      });
      if (document.documentElement) {
        obs.observe(document.documentElement, { childList: true, subtree: true });
      }
      window.__kinexCosmeticObserver = obs;
    } catch {}
  })();`;
}

export async function runShieldsElementPicker(wc: WebContents): Promise<string | null> {
  if (wc.isDestroyed()) return null;
  const script = `
    new Promise((resolve) => {
      if (window.__kinexPickerCleanup) {
        window.__kinexPickerCleanup(null);
      }
      const overlay = document.createElement('div');
      overlay.id = '__kinex_picker_overlay';
      overlay.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #7c8cff;background:rgba(124,140,255,0.20);border-radius:6px;transition:all 60ms ease;display:none;';
      const badge = document.createElement('div');
      badge.style.cssText = 'position:fixed;bottom:18px;left:50%;transform:translateX(-50%);z-index:2147483647;background:#161722;color:#f4f4fb;padding:10px 16px;border-radius:12px;font:12px/1.4 -apple-system,sans-serif;box-shadow:0 10px 30px rgba(0,0,0,0.5);border:1px solid rgba(255,255,255,0.16);max-width:85vw;text-align:center;';
      badge.textContent = 'Kinex Element Picker — Hover or press Tab to target, ↑/↓ parent/child, Enter confirms, Esc cancels';
      document.documentElement.appendChild(overlay);
      document.documentElement.appendChild(badge);

      function buildSelector(el) {
        if (!el || el === document.body || el === document.documentElement) return null;
        if (el.id && /^[a-zA-Z_-][a-zA-Z0-9_-]*$/.test(el.id)) {
          return '#' + CSS.escape(el.id);
        }
        const parts = [];
        let cur = el;
        let depth = 0;
        while (cur && cur.nodeType === 1 && cur !== document.body && depth < 4) {
          let part = cur.tagName.toLowerCase();
          const classes = Array.from(cur.classList).filter(c => c && !c.startsWith('__kinex') && c.length < 36).slice(0, 2);
          if (classes.length > 0) {
            part += '.' + classes.map(c => CSS.escape(c)).join('.');
          } else if (cur.parentElement) {
            const siblings = Array.from(cur.parentElement.children).filter(s => s.tagName === cur.tagName);
            if (siblings.length > 1) {
              part += ':nth-of-type(' + (siblings.indexOf(cur) + 1) + ')';
            }
          }
          parts.unshift(part);
          const candidate = parts.join(' > ');
          try {
            const count = document.querySelectorAll(candidate).length;
            if (count === 1) return candidate;
          } catch {}
          cur = cur.parentElement;
          depth++;
        }
        return parts.join(' > ');
      }

      let currentTarget = null;
      let previewSelector = null;
      const highlight = (el) => {
        if (!el || el === overlay || el === badge || el.id === '__kinex_picker_overlay') return;
        currentTarget = el;
        const rect = el.getBoundingClientRect();
        overlay.style.display = 'block';
        overlay.style.left = rect.left + 'px';
        overlay.style.top = rect.top + 'px';
        overlay.style.width = rect.width + 'px';
        overlay.style.height = rect.height + 'px';
        const sel = buildSelector(el);
        previewSelector = sel;
        let count = 0;
        try { if (sel) count = document.querySelectorAll(sel).length; } catch {}
        badge.textContent = sel
          ? 'Block Rule: ##' + sel + ' (' + count + ' match' + (count === 1 ? '' : 'es') + ') — Click or Enter to save, Esc to cancel'
          : 'Select an element to hide';
      };

      const onMove = (e) => highlight(document.elementFromPoint(e.clientX, e.clientY));

      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, {
        acceptNode: (el) => el !== overlay && el !== badge && el.getClientRects().length && buildSelector(el)
          ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP,
      });

      const cleanup = (sel) => {
        document.removeEventListener('mousemove', onMove, true);
        document.removeEventListener('click', onClick, true);
        document.removeEventListener('keydown', onKey, true);
        overlay.remove();
        badge.remove();
        delete window.__kinexPickerCleanup;
        resolve(sel);
      };

      const onClick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        const target = currentTarget || document.elementFromPoint(e.clientX, e.clientY);
        cleanup(previewSelector || buildSelector(target));
      };

      const onKey = (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          cleanup(null);
        } else if (e.key === 'Tab') {
          e.preventDefault();
          e.stopPropagation();
          walker.currentNode = currentTarget || document.body;
          const next = (e.shiftKey ? walker.previousNode() : walker.nextNode()) || walker.firstChild();
          if (next) highlight(next);
        } else if (e.key === 'ArrowUp' && currentTarget && currentTarget.parentElement && currentTarget.parentElement !== document.body) {
          e.preventDefault();
          e.stopPropagation();
          highlight(currentTarget.parentElement);
        } else if (e.key === 'ArrowDown' && currentTarget && currentTarget.firstElementChild) {
          e.preventDefault();
          e.stopPropagation();
          highlight(currentTarget.firstElementChild);
        } else if (e.key === 'Enter' && currentTarget) {
          e.preventDefault();
          e.stopPropagation();
          cleanup(previewSelector || buildSelector(currentTarget));
        }
      };

      window.__kinexPickerCleanup = cleanup;
      document.addEventListener('mousemove', onMove, true);
      document.addEventListener('click', onClick, true);
      document.addEventListener('keydown', onKey, true);
    });
  `;

  try {
    return await wc.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD_ID, [{ code: script }], true);
  } catch {
    return null;
  }
}

export function stopShieldsElementPicker(wc: WebContents | undefined | null): void {
  if (!wc || wc.isDestroyed()) return;
  void wc
    .executeJavaScriptInIsolatedWorld(ISOLATED_WORLD_ID, [
      { code: 'window.__kinexPickerCleanup?.(null)' },
    ])
    .catch(() => {});
}
