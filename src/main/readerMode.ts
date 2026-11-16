import type { WebContents } from 'electron';
import type { ReaderOptions, ReaderTheme } from '../shared/types';

export interface ReaderBlock {
  tag: 'h2' | 'h3' | 'p' | 'blockquote' | 'li' | 'pre';
  text: string;
}

export interface ReaderDocument {
  originalUrl: string;
  title: string;
  byline?: string;
  siteName?: string;
  readingMinutes: number;
  blocks: ReaderBlock[];
}

const VALID_TAGS = new Set<ReaderBlock['tag']>(['h2', 'h3', 'p', 'blockquote', 'li', 'pre']);

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function sanitizeExtractedArticle(
  raw: unknown,
  originalUrl: string
): { ok: true; doc: ReaderDocument } | { ok: false; reason: string } {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, reason: 'Reader view is unavailable for this page.' };
  }
  const obj = raw as Record<string, unknown>;
  const rawTitle = typeof obj.title === 'string' ? obj.title.trim() : '';
  const rawByline = typeof obj.byline === 'string' ? obj.byline.trim() : '';
  const rawSiteName = typeof obj.siteName === 'string' ? obj.siteName.trim() : '';
  const rawBlocks = Array.isArray(obj.blocks) ? obj.blocks : [];

  const blocks: ReaderBlock[] = [];
  let charTotal = 0;
  let paragraphCount = 0;

  for (const b of rawBlocks) {
    if (!b || typeof b !== 'object') continue;
    const tag = (b as { tag?: unknown }).tag;
    const text = (b as { text?: unknown }).text;
    if (typeof tag !== 'string' || !VALID_TAGS.has(tag as ReaderBlock['tag'])) continue;
    if (typeof text !== 'string') continue;
    const trimmed = text.replace(/\s+/g, ' ').trim();
    if (trimmed.length < 12) continue;
    blocks.push({ tag: tag as ReaderBlock['tag'], text: trimmed.slice(0, 8000) });
    charTotal += trimmed.length;
    if (tag === 'p') paragraphCount += 1;
    if (blocks.length >= 250) break;
  }

  if (charTotal < 180 || paragraphCount < 1) {
    return { ok: false, reason: 'Not enough article text detected for Reader Mode.' };
  }

  const words = blocks.reduce((acc, b) => acc + b.text.split(/\s+/).length, 0);
  const readingMinutes = Math.max(1, Math.round(words / 220));

  return {
    ok: true,
    doc: {
      originalUrl,
      title: rawTitle || originalUrl,
      byline: rawByline || undefined,
      siteName: rawSiteName || undefined,
      readingMinutes,
      blocks,
    },
  };
}

const EXTRACTION_SCRIPT = `(() => {
  const root = document.querySelector('article, main, [role="main"]') || document.body;
  if (!root) return null;
  const pickTag = (el) => {
    const t = el.tagName.toLowerCase();
    if (t === 'h1' || t === 'h2') return 'h2';
    if (t === 'h3' || t === 'h4') return 'h3';
    if (t === 'blockquote') return 'blockquote';
    if (t === 'li') return 'li';
    if (t === 'pre') return 'pre';
    return 'p';
  };
  const blocks = [];
  const candidates = root.querySelectorAll('h2, h3, p, blockquote, li, pre');
  for (const el of candidates) {
    if (el.closest('nav, header, footer, aside, [role="navigation"], [aria-hidden="true"], .sidebar')) continue;
    const text = (el.innerText || el.textContent || '').trim();
    if (text.length >= 16) {
      blocks.push({ tag: pickTag(el), text });
    }
    if (blocks.length >= 260) break;
  }
  const bylineEl = document.querySelector('[rel="author"], .author, meta[name="author"]');
  const byline = bylineEl ? (bylineEl.getAttribute('content') || bylineEl.textContent || '').trim() : '';
  const siteEl = document.querySelector('meta[property="og:site_name"]');
  const siteName = siteEl ? (siteEl.getAttribute('content') || '').trim() : location.hostname;
  return {
    title: document.title || '',
    byline,
    siteName,
    blocks
  };
})()`;

export async function extractArticleFromWebContents(
  wc: WebContents,
  originalUrl: string
): Promise<{ ok: true; doc: ReaderDocument } | { ok: false; reason: string }> {
  if (wc.isDestroyed()) {
    return { ok: false, reason: 'Tab is not active.' };
  }
  try {
    const raw = await wc.executeJavaScript(EXTRACTION_SCRIPT, true);
    return sanitizeExtractedArticle(raw, originalUrl);
  } catch {
    return { ok: false, reason: 'Unable to extract article text from this page.' };
  }
}

function getThemePalette(theme: ReaderTheme): { bg: string; surface: string; text: string; muted: string; border: string } {
  if (theme === 'sepia') {
    return {
      bg: '#f4ecd8',
      surface: '#ece2c8',
      text: '#382c1e',
      muted: '#73604a',
      border: 'rgba(56, 44, 30, 0.14)',
    };
  }
  if (theme === 'light') {
    return {
      bg: '#fbfbfd',
      surface: '#f2f3f6',
      text: '#161822',
      muted: '#5d6375',
      border: 'rgba(22, 24, 34, 0.1)',
    };
  }
  return {
    bg: '#121318',
    surface: '#1b1d25',
    text: '#eceef5',
    muted: '#9499ad',
    border: 'rgba(255, 255, 255, 0.1)',
  };
}

export function renderReaderHtml(doc: ReaderDocument, options: ReaderOptions): string {
  const palette = getThemePalette(options.theme);
  const fontSize = Math.min(28, Math.max(12, Math.round(options.fontSize || 17)));
  const bodyHtml = doc.blocks
    .map((b) => `<${b.tag}>${escapeHtml(b.text)}</${b.tag}>`)
    .join('\n      ');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="color-scheme" content="${options.theme === 'dark' ? 'dark' : 'light'}" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';" />
<title>${escapeHtml(doc.title)} — Reader</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: ${palette.bg};
    color: ${palette.text};
    font-family: "New York", "Iowan Old Style", Georgia, -apple-system, serif;
    font-size: ${fontSize}px;
    line-height: 1.68;
    padding: 52px 24px 84px;
    -webkit-font-smoothing: antialiased;
  }
  article {
    max-width: 680px;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: 18px;
  }
  .meta {
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif;
    font-size: 12.5px;
    color: ${palette.muted};
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
  }
  h1 {
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", sans-serif;
    font-size: ${Math.round(fontSize * 1.85)}px;
    line-height: 1.2;
    font-weight: 700;
    letter-spacing: -0.025em;
  }
  hr { border: none; border-top: 1px solid ${palette.border}; margin: 4px 0 8px; }
  h2, h3 {
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif;
    line-height: 1.3;
    margin-top: 12px;
  }
  h2 { font-size: ${Math.round(fontSize * 1.32)}px; font-weight: 650; }
  h3 { font-size: ${Math.round(fontSize * 1.15)}px; font-weight: 600; }
  blockquote {
    border-left: 3px solid ${palette.muted};
    padding-left: 16px;
    color: ${palette.muted};
    font-style: italic;
  }
  pre {
    background: ${palette.surface};
    border: 1px solid ${palette.border};
    border-radius: 10px;
    padding: 14px;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: ${Math.max(12, fontSize - 3)}px;
    overflow-x: auto;
    white-space: pre-wrap;
  }
  li { margin-left: 22px; }
</style>
</head>
<body>
  <article>
    <div class="meta">
      ${doc.siteName ? `<span>${escapeHtml(doc.siteName)}</span><span>·</span>` : ''}
      ${doc.byline ? `<span>${escapeHtml(doc.byline)}</span><span>·</span>` : ''}
      <span>${doc.readingMinutes} min read</span>
    </div>
    <h1>${escapeHtml(doc.title)}</h1>
    <hr />
    ${bodyHtml}
  </article>
</body>
</html>`;
}
