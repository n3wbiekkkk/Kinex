import type { WebContents } from 'electron';
import { matchesDomainPattern } from '../shared/domain';
import type { BoostRule } from '../shared/types';

export function compileBoostCss(boosts: BoostRule[], url: string): string {
  const active = boosts.filter((b) => b.enabled && matchesDomainPattern(url, b.domainPattern));
  if (active.length === 0) return '';

  const chunks: string[] = [];
  for (const boost of active) {
    if (boost.filterInvert) {
      chunks.push(
        'html { filter: invert(0.92) hue-rotate(180deg) !important; background: #111 !important; } img, video, picture, canvas { filter: invert(1) hue-rotate(180deg) !important; }'
      );
    }
    if (boost.fontFamily?.trim()) {
      const safeFont = boost.fontFamily.replace(/[{};]/g, '');
      chunks.push(`* { font-family: ${safeFont}, system-ui, sans-serif !important; }`);
    }
    if (boost.zappedSelectors.length > 0) {
      chunks.push(`${boost.zappedSelectors.join(', ')} { display: none !important; }`);
    }
    if (boost.css.trim()) {
      chunks.push(boost.css);
    }
  }
  return chunks.join('\n');
}

export async function applyBoostsToWebContents(
  wc: WebContents,
  boosts: BoostRule[],
  injectedKeys: Map<number, string[]>
): Promise<void> {
  if (wc.isDestroyed()) return;
  const url = wc.getURL();
  if (!url || url.startsWith('kinex://') || url.startsWith('nook://')) return;

  const existingKeys = injectedKeys.get(wc.id) ?? [];
  for (const key of existingKeys) {
    try {
      await wc.removeInsertedCSS(key);
    } catch {
      // Page navigated; prior CSS key is already gone
    }
  }
  injectedKeys.set(wc.id, []);

  const css = compileBoostCss(boosts, url);
  if (css) {
    try {
      const key = await wc.insertCSS(css, { cssOrigin: 'user' });
      injectedKeys.set(wc.id, [key]);
    } catch {
      // Ignore failed CSS injection on restricted pages
    }
  }

  const active = boosts.filter((b) => b.enabled && matchesDomainPattern(url, b.domainPattern));
  const zoomBoost = active.find((b) => typeof b.zoomFactor === 'number' && b.zoomFactor > 0);
  if (zoomBoost?.zoomFactor) {
    wc.setZoomFactor(zoomBoost.zoomFactor);
  }

  for (const boost of active) {
    if (boost.js.trim()) {
      try {
        await wc.executeJavaScript(`(() => {\n${boost.js}\n})();`);
      } catch {
        // Ignore user script runtime error
      }
    }
  }
}

export async function runElementZapper(wc: WebContents): Promise<string | null> {
  if (wc.isDestroyed()) return null;
  const script = `
    new Promise((resolve) => {
      if (window.__kinexZapperCleanup) {
        window.__kinexZapperCleanup(null);
      }
      const overlay = document.createElement('div');
      overlay.id = '__kinex_zapper_overlay';
      overlay.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #8b7cf8;background:rgba(139,124,248,0.18);border-radius:6px;transition:all 60ms ease;display:none;';
      const badge = document.createElement('div');
      badge.style.cssText = 'position:fixed;bottom:16px;left:50%;transform:translateX(-50%);z-index:2147483647;background:#161722;color:#f4f4fb;padding:8px 14px;border-radius:999px;font:12px/1.3 -apple-system,sans-serif;box-shadow:0 8px 28px rgba(0,0,0,0.45);border:1px solid rgba(255,255,255,0.14);pointer-events:none;';
      badge.textContent = 'Kinex Zap Mode — Tab selects, arrows change level, Enter hides, Esc cancels';
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
            if (document.querySelectorAll(candidate).length === 1) return candidate;
          } catch {}
          cur = cur.parentElement;
          depth++;
        }
        return parts.join(' > ');
      }

      let currentTarget = null;
      const highlight = (el) => {
        if (!el || el === overlay || el === badge) return;
        currentTarget = el;
        const rect = el.getBoundingClientRect();
        overlay.style.display = 'block';
        overlay.style.left = rect.left + 'px';
        overlay.style.top = rect.top + 'px';
        overlay.style.width = rect.width + 'px';
        overlay.style.height = rect.height + 'px';
        const sel = buildSelector(el);
        badge.textContent = sel ? 'Zap: ' + sel + ' (Enter to hide, Esc to cancel)' : 'Select element to zap';
      };

      const onMove = (e) => highlight(document.elementFromPoint(e.clientX, e.clientY));

      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, {
        acceptNode: (el) => el !== overlay && el !== badge && el.getClientRects().length && buildSelector(el)
          ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP,
      });

      const cleanup = (result) => {
        window.removeEventListener('mousemove', onMove, true);
        window.removeEventListener('click', onClick, true);
        window.removeEventListener('keydown', onKey, true);
        overlay.remove();
        badge.remove();
        delete window.__kinexZapperCleanup;
        resolve(result);
      };

      const onClick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        const sel = buildSelector(currentTarget || e.target);
        cleanup(sel);
      };

      const onKey = (e) => {
        if (e.isComposing || !['Escape', 'Enter', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.key === 'Escape') { cleanup(null); return; }
        if (e.key === 'Enter') { if (currentTarget) cleanup(buildSelector(currentTarget)); return; }
        let next;
        if (e.key === 'Tab') {
          if (currentTarget) walker.currentNode = currentTarget;
          next = e.shiftKey ? walker.previousNode() : walker.nextNode();
          if (!next) { walker.currentNode = document.body; next = walker.nextNode(); }
        } else if (currentTarget) {
          next = e.key === 'ArrowUp' ? currentTarget.parentElement
            : e.key === 'ArrowDown' ? currentTarget.firstElementChild
              : e.key === 'ArrowLeft' ? currentTarget.previousElementSibling : currentTarget.nextElementSibling;
        } else next = walker.nextNode();
        if (next && buildSelector(next)) { next.scrollIntoView({ block: 'nearest', behavior: 'instant' }); highlight(next); }
      };

      window.__kinexZapperCleanup = cleanup;
      window.addEventListener('mousemove', onMove, true);
      window.addEventListener('click', onClick, true);
      window.addEventListener('keydown', onKey, true);
    });
  `;
  try {
    const result = await wc.executeJavaScript(script, true);
    return typeof result === 'string' ? result : null;
  } catch {
    return null;
  }
}
