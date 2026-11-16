import fs from 'node:fs';
import path from 'node:path';
import type { NewTabConfig } from '../shared/types';
import { isSafeNavigationUrl } from './security';

export interface NewTabShortcutItem {
  title: string;
  url: string;
  host: string;
}

export interface NewTabRenderContext {
  isDark?: boolean;
  spaceName?: string;
  accent?: string;
  searchEngineName?: string;
  searchEngineTemplate?: string;
  config?: NewTabConfig;
  favorites?: NewTabShortcutItem[];
  frequent?: NewTabShortcutItem[];
  getReaderHtml?: (readerUrl: string) => string | null;
}

let cachedLogoDataUri: string | null = null;

function getKinexLogoDataUri(): string {
  if (cachedLogoDataUri !== null) return cachedLogoDataUri;
  const candidates: string[] = [];
  const distAssets = path.join(__dirname, '../../dist/assets');
  try {
    if (fs.existsSync(distAssets)) {
      for (const f of fs.readdirSync(distAssets)) {
        if (f.startsWith('kinex-logo') && f.endsWith('.png')) {
          candidates.push(path.join(distAssets, f));
        }
      }
    }
  } catch {
    // Ignore unreadable dist assets
  }
  candidates.push(
    path.join(__dirname, '../../src/renderer/assets/kinex-logo.png'),
    path.join(__dirname, '../../build/icon.png')
  );
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        const b64 = fs.readFileSync(p).toString('base64');
        cachedLogoDataUri = `data:image/png;base64,${b64}`;
        return cachedLogoDataUri;
      }
    } catch {
      // Ignore unreadable candidate
    }
  }
  cachedLogoDataUri = '';
  return '';
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderShortcutTiles(items: NewTabShortcutItem[], sectionLabel: string): string {
  if (items.length === 0) return '';
  const tiles = items
    .slice(0, 6)
    .map((item) => {
      if (!isSafeNavigationUrl(item.url)) return '';
      const initial = escapeHtml((item.host || item.title || 'K').charAt(0).toUpperCase());
      return `<a class="tile" href="${escapeHtml(item.url)}" title="${escapeHtml(item.url)}">
        <span class="tile-mark">${initial}</span>
        <span class="tile-meta">
          <span class="tile-title">${escapeHtml(item.title)}</span>
          <span class="tile-host">${escapeHtml(item.host)}</span>
        </span>
      </a>`;
    })
    .filter(Boolean)
    .join('');
  if (!tiles) return '';
  return `<section class="section">
    <div class="section-label">${escapeHtml(sectionLabel)}</div>
    <div class="tiles">${tiles}</div>
  </section>`;
}

function getBackgroundCss(background: NewTabConfig['background'], isDark: boolean): string {
  if (background === 'mist') {
    return isDark
      ? 'radial-gradient(920px 520px at 50% -8%, rgba(124, 140, 255, 0.11), transparent 72%), #101116'
      : 'radial-gradient(920px 520px at 50% -8%, rgba(82, 68, 243, 0.08), transparent 72%), #f5f6f9';
  }
  if (background === 'dusk') {
    return isDark
      ? 'radial-gradient(880px 500px at 78% 12%, rgba(167, 139, 250, 0.1), transparent 70%), radial-gradient(720px 440px at 18% 90%, rgba(56, 189, 248, 0.07), transparent 70%), #0e1017'
      : 'radial-gradient(880px 500px at 78% 12%, rgba(99, 102, 241, 0.07), transparent 70%), radial-gradient(720px 440px at 18% 90%, rgba(14, 165, 233, 0.05), transparent 70%), #f4f5f8';
  }
  if (background === 'sage') {
    return isDark
      ? 'radial-gradient(900px 520px at 50% -10%, rgba(52, 211, 153, 0.09), transparent 72%), #0f1513'
      : 'radial-gradient(900px 520px at 50% -10%, rgba(47, 111, 78, 0.08), transparent 72%), #f2f5f2';
  }
  return isDark ? '#101116' : '#f6f7f9';
}

export function renderKinexInternalHtml(
  url: string,
  context: NewTabRenderContext = {}
): string {
  if (url.startsWith('kinex://reader')) {
    const readerHtml = context.getReaderHtml?.(url);
    if (readerHtml) return readerHtml;
    return `<!doctype html><html lang="en"><head><meta charset="utf-8" /><title>Reader Mode — Kinex</title></head><body style="font-family:-apple-system,sans-serif;background:#121318;color:#eceef5;display:flex;align-items:center;justify-content:center;min-height:100vh;"><p>Reader Mode session expired. Return to the original page.</p></body></html>`;
  }

  if (url.startsWith('kinex://crashed') || url.startsWith('nook://crashed')) {
    let targetUrl = '';
    let reason = 'The page renderer process terminated unexpectedly.';
    try {
      const parsed = new URL(url.replace(/^nook:\/\//i, 'kinex://'));
      const candidate = parsed.searchParams.get('url') ?? '';
      targetUrl = isSafeNavigationUrl(candidate) ? candidate : '';
      reason = parsed.searchParams.get('reason') ?? reason;
    } catch {
      // Ignore malformed crash query
    }
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="color-scheme" content="dark light" />
<title>Tab Crashed — Kinex</title>
<style>
  :root { --bg: #f6f7f9; --surface: #ffffff; --border: rgba(15,18,30,0.09); --text: #14161f; --muted: #5c6275; --accent: #4f5bd5; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #101116; --surface: #171820; --border: rgba(255,255,255,0.09); --text: #f3f4fa; --muted: #8b90a6; --accent: #7c8cff; }
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { min-height: 100vh; font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif; background: var(--bg); color: var(--text); display: flex; align-items: center; justify-content: center; padding: 24px; -webkit-font-smoothing: antialiased; }
  .card { max-width: 440px; width: 100%; background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 24px; display: flex; flex-direction: column; gap: 12px; }
  h1 { font-size: 17px; font-weight: 600; letter-spacing: -0.015em; }
  p { font-size: 13px; color: var(--muted); line-height: 1.5; word-break: break-word; }
  a.btn { display: inline-flex; align-self: flex-start; padding: 8px 14px; border-radius: 8px; background: var(--accent); color: #fff; text-decoration: none; font-size: 13px; font-weight: 500; }
</style>
</head>
<body>
  <div class="card">
    <h1>This tab stopped responding</h1>
    <p>${escapeHtml(reason)}</p>
    ${targetUrl ? `<p>${escapeHtml(targetUrl)}</p><a class="btn" href="${escapeHtml(targetUrl)}">Reload Page</a>` : ''}
  </div>
</body>
</html>`;
  }

  if (url.startsWith('kinex://private') || url.startsWith('nook://private')) {
    const logoUri = getKinexLogoDataUri();
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="color-scheme" content="dark" />
<title>Private Window — Kinex</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { min-height: 100vh; font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif; background: radial-gradient(840px 440px at 50% -10%, rgba(124, 140, 255, 0.1), transparent 72%), #101116; color: #f3f4fa; display: flex; align-items: center; justify-content: center; padding: 32px; -webkit-font-smoothing: antialiased; }
  .wrap { max-width: 500px; width: 100%; display: flex; flex-direction: column; gap: 20px; }
  .head { display: flex; align-items: center; gap: 12px; }
  .logo-badge { width: 34px; height: 34px; border-radius: 9px; background: #ffffff; border: 1px solid rgba(255,255,255,0.16); display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; box-shadow: 0 4px 14px rgba(0, 0, 0, 0.32); }
  .logo-badge img { width: 22px; height: 22px; display: block; object-fit: contain; }
  .badge { font-size: 11px; font-weight: 600; letter-spacing: 0.03em; text-transform: uppercase; color: #c7d0ff; background: rgba(124,140,255,0.16); border: 1px solid rgba(124,140,255,0.28); padding: 3px 8px; border-radius: 999px; margin-left: auto; }
  h1 { font-size: 21px; font-weight: 650; letter-spacing: -0.02em; }
  p { font-size: 13.5px; color: rgba(243, 244, 250, 0.62); line-height: 1.6; }
  .search-box { display: flex; align-items: center; gap: 8px; background: #171821; border: 1px solid rgba(255,255,255,0.1); border-radius: 12px; padding: 5px 6px 5px 14px; transition: border-color 140ms ease, box-shadow 140ms ease; }
  .search-box:focus-within { border-color: rgba(124, 140, 255, 0.72); box-shadow: 0 0 0 3px rgba(124, 140, 255, 0.16); }
  .search-box input { flex: 1; height: 36px; background: transparent; border: none; color: #fff; font-size: 14px; outline: none; }
  .search-box input::placeholder { color: rgba(243, 244, 250, 0.4); }
  .search-box button { height: 32px; background: #5b68e8; color: #fff; border: none; border-radius: 8px; padding: 0 14px; font-size: 12.5px; font-weight: 500; cursor: pointer; }
  .search-box button:hover { background: #6b77f2; }
</style>
</head>
<body>
  <main class="wrap">
    <div class="head">
      ${logoUri ? `<div class="logo-badge"><img src="${logoUri}" alt="Kinex" /></div>` : ''}
      <h1>Private Browsing</h1>
      <span class="badge">Isolated</span>
    </div>
    <p>Pages viewed in this window use an ephemeral in-memory session. Cookies, cache, and local storage are cleared when this window closes. Browsing and download history are not recorded. Files you download remain on disk.</p>
    <form class="search-box" onsubmit="event.preventDefault(); const q=document.getElementById('pq').value.trim(); if(!q) return; const isUrl=/^(https?:\\/\\/|localhost(:\\d+)?|[a-zA-Z0-9-]+(\\.[a-zA-Z0-9-]+)+)/.test(q); window.location.href=isUrl ? (/^https?:\\/\\//.test(q)?q:(q.startsWith('localhost')?'http://'+q:'https://'+q)) : 'https://duckduckgo.com/?q='+encodeURIComponent(q);">
      <input id="pq" type="text" placeholder="Search privately with DuckDuckGo or enter a URL..." autofocus />
      <button type="submit">Go</button>
    </form>
  </main>
</body>
</html>`;
  }

  const isNewTab = url.includes('newtab');
  const isDark = context.isDark ?? true;
  const accent = /^#[0-9a-fA-F]{3,8}$/.test(context.accent ?? '')
    ? context.accent!
    : isDark
      ? '#7c8cff'
      : '#4f5bd5';
  const cfg: NewTabConfig = context.config ?? {
    preset: 'minimal',
    background: 'clean',
    showClock: true,
    showFavorites: true,
    showFrequent: false,
  };
  const engineName = context.searchEngineName || 'Google';
  const engineTemplate =
    context.searchEngineTemplate && /^https:\/\/.+\?/.test(context.searchEngineTemplate)
      ? context.searchEngineTemplate
      : 'https://www.google.com/search?q=%s';
  const searchBaseJson = JSON.stringify(engineTemplate);
  const logoUri = getKinexLogoDataUri();

  const favoriteItems: NewTabShortcutItem[] =
    context.favorites && context.favorites.length > 0
      ? context.favorites
      : [
          { title: 'GitHub', url: 'https://github.com', host: 'github.com' },
          { title: 'Hacker News', url: 'https://news.ycombinator.com', host: 'ycombinator.com' },
          { title: 'MDN Docs', url: 'https://developer.mozilla.org', host: 'mozilla.org' },
        ];
  const frequentItems = context.frequent ?? [];

  const showFavoritesBlock =
    cfg.preset === 'minimal'
      ? false
      : cfg.showFavorites && favoriteItems.length > 0;
  const showFrequentBlock =
    cfg.preset === 'personal' && cfg.showFrequent && frequentItems.length > 0;

  const surfaceVars = isDark
    ? `--bg-canvas: ${getBackgroundCss(cfg.background, true)};
       --surface: #171820;
       --surface-hover: #1e202a;
       --border: rgba(255, 255, 255, 0.08);
       --border-strong: rgba(255, 255, 255, 0.14);
       --text: #f3f4f8;
       --muted: rgba(243, 244, 248, 0.56);
       --subtle: rgba(243, 244, 248, 0.36);
       --accent: ${accent};
       --shadow: 0 2px 10px rgba(0, 0, 0, 0.22), 0 18px 40px rgba(0, 0, 0, 0.34);`
    : `--bg-canvas: ${getBackgroundCss(cfg.background, false)};
       --surface: #ffffff;
       --surface-hover: #f9fafb;
       --border: rgba(15, 18, 32, 0.09);
       --border-strong: rgba(15, 18, 32, 0.15);
       --text: #151720;
       --muted: rgba(21, 23, 32, 0.6);
       --subtle: rgba(21, 23, 32, 0.42);
       --accent: ${accent};
       --shadow: 0 1px 3px rgba(15, 18, 32, 0.04), 0 10px 28px rgba(15, 18, 32, 0.06);`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="color-scheme" content="${isDark ? 'dark' : 'light'}" />
<title>${isNewTab ? 'New Tab — Kinex' : 'Welcome — Kinex'}</title>
<style>
  :root {
    ${surfaceVars}
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    min-height: 100vh;
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter", system-ui, sans-serif;
    background: var(--bg-canvas);
    color: var(--text);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 40px 24px 56px;
    -webkit-font-smoothing: antialiased;
  }
  @keyframes fadeUp {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: translateY(0); }
  }
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after {
      animation-duration: 0.01ms !important;
      transition-duration: 0.01ms !important;
    }
  }
  .wrap {
    width: 100%;
    max-width: ${cfg.preset === 'personal' ? '640px' : '540px'};
    display: flex;
    flex-direction: column;
    gap: ${cfg.preset === 'focus' ? '26px' : '22px'};
  }
  .hero {
    display: flex;
    align-items: center;
    justify-content: space-between;
    animation: fadeUp 240ms cubic-bezier(0.22, 1, 0.36, 1) both;
  }
  .hero.focus-hero {
    flex-direction: column;
    align-items: flex-start;
    gap: 6px;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 11px;
  }
  .logo-badge {
    width: 30px;
    height: 30px;
    border-radius: 8px;
    background: #ffffff;
    border: 1px solid rgba(15, 18, 32, 0.08);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
  }
  .logo-badge img { width: 19px; height: 19px; display: block; object-fit: contain; }
  h1 {
    font-size: 19px;
    font-weight: 620;
    letter-spacing: -0.02em;
  }
  .space-tag {
    font-size: 11.5px;
    color: var(--subtle);
    font-weight: 500;
  }
  .clock {
    font-size: ${cfg.preset === 'focus' ? '44px' : '13px'};
    font-weight: ${cfg.preset === 'focus' ? '600' : '500'};
    letter-spacing: ${cfg.preset === 'focus' ? '-0.04em' : '0'};
    line-height: 1.05;
    color: ${cfg.preset === 'focus' ? 'var(--text)' : 'var(--muted)'};
    font-variant-numeric: tabular-nums;
  }
  .search-form {
    display: flex;
    align-items: center;
    gap: 8px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 13px;
    padding: 5px 6px 5px 15px;
    box-shadow: var(--shadow);
    transition: border-color 140ms ease, box-shadow 140ms ease;
    animation: fadeUp 280ms 30ms cubic-bezier(0.22, 1, 0.36, 1) both;
  }
  .search-form:focus-within {
    border-color: var(--border-strong);
    box-shadow: 0 0 0 3px ${isDark ? 'rgba(124, 140, 255, 0.16)' : 'rgba(79, 91, 213, 0.12)'}, var(--shadow);
  }
  .search-form input {
    flex: 1;
    height: 38px;
    border: none;
    background: transparent;
    color: var(--text);
    font-size: 14.5px;
    outline: none;
  }
  .search-form input::placeholder { color: var(--subtle); }
  .search-form button {
    height: 32px;
    padding: 0 14px;
    border-radius: 9px;
    border: none;
    background: var(--accent);
    color: #fff;
    font-size: 12.5px;
    font-weight: 550;
    cursor: pointer;
    transition: opacity 120ms ease, transform 120ms ease;
  }
  .search-form button:hover { opacity: 0.9; }
  .search-form button:active { transform: scale(0.97); }
  .section {
    display: flex;
    flex-direction: column;
    gap: 8px;
    animation: fadeUp 320ms 60ms cubic-bezier(0.22, 1, 0.36, 1) both;
  }
  .section-label {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    color: var(--subtle);
    padding-left: 2px;
  }
  .tiles {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 9px;
  }
  .tile {
    text-decoration: none;
    color: var(--text);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 11px;
    padding: 10px 12px;
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
    transition: background 120ms ease, border-color 120ms ease, transform 140ms cubic-bezier(0.22, 1, 0.36, 1);
  }
  .tile:hover {
    background: var(--surface-hover);
    border-color: var(--border-strong);
    transform: translateY(-1px);
  }
  .tile-mark {
    width: 26px;
    height: 26px;
    border-radius: 7px;
    background: ${isDark ? 'rgba(255,255,255,0.06)' : 'rgba(15,18,32,0.05)'};
    border: 1px solid var(--border);
    color: var(--muted);
    font-size: 12px;
    font-weight: 600;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }
  .tile-meta { display: flex; flex-direction: column; min-width: 0; }
  .tile-title { font-size: 12.5px; font-weight: 540; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tile-host { font-size: 11px; color: var(--subtle); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .hints {
    display: flex;
    flex-wrap: wrap;
    gap: 14px;
    justify-content: center;
    font-size: 11.5px;
    color: var(--subtle);
    padding-top: 2px;
    animation: fadeUp 340ms 90ms cubic-bezier(0.22, 1, 0.36, 1) both;
  }
  .hint { display: inline-flex; align-items: center; gap: 5px; }
  kbd {
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 10.5px;
    padding: 2px 5px;
    border-radius: 5px;
    background: var(--surface);
    border: 1px solid var(--border);
    color: var(--muted);
  }
  @media (max-width: 600px) {
    .tiles { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  }
</style>
</head>
<body>
  <main class="wrap">
    ${
      cfg.preset === 'focus'
        ? `<div class="hero focus-hero">
            <div class="brand">
              ${logoUri ? `<div class="logo-badge"><img src="${logoUri}" alt="Kinex" /></div>` : ''}
              <span class="space-tag">${escapeHtml(context.spaceName ? `${context.spaceName} Space` : 'Kinex')}</span>
            </div>
            ${cfg.showClock ? '<div class="clock" id="clock"></div>' : '<h1>Kinex</h1>'}
          </div>`
        : `<div class="hero">
            <div class="brand">
              ${logoUri ? `<div class="logo-badge"><img src="${logoUri}" alt="Kinex" /></div>` : ''}
              <div>
                <h1>Kinex</h1>
                ${context.spaceName ? `<div class="space-tag">${escapeHtml(context.spaceName)}</div>` : ''}
              </div>
            </div>
            ${cfg.showClock ? '<span class="clock" id="clock"></span>' : ''}
          </div>`
    }

    <form class="search-form" onsubmit="event.preventDefault(); const q=document.getElementById('q').value.trim(); if(!q) return; const isUrl=/^(https?:\\/\\/|localhost(:\\d+)?|[a-zA-Z0-9-]+(\\.[a-zA-Z0-9-]+)+)/.test(q); const tpl=${searchBaseJson}; window.location.href=isUrl ? (/^https?:\\/\\//.test(q)?q:(q.startsWith('localhost')?'http://'+q:'https://'+q)) : tpl.replace('%s', encodeURIComponent(q));">
      <input id="q" type="text" placeholder="Search ${escapeHtml(engineName)} or enter an address..." autofocus />
      <button type="submit">Go</button>
    </form>

    ${showFavoritesBlock ? renderShortcutTiles(favoriteItems, 'Favorites') : ''}
    ${showFrequentBlock ? renderShortcutTiles(frequentItems, 'Frequently Visited') : ''}

    <div class="hints">
      <span class="hint"><kbd>⌘T</kbd> Command Bar</span>
      <span class="hint"><kbd>⌘S</kbd> Sidebar</span>
      <span class="hint"><kbd>⌘⇧\\</kbd> Split</span>
      <span class="hint"><kbd>⌘,</kbd> Settings</span>
    </div>
  </main>
  <script>
    const el = document.getElementById('clock');
    if (el) {
      const tick = () => {
        el.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      };
      tick();
      setInterval(tick, 15000);
    }
  </script>
</body>
</html>`;
}

export const renderNookInternalHtml = renderKinexInternalHtml;
