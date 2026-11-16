import fs from 'node:fs';
import path from 'node:path';

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

export function renderNookInternalHtml(url: string): string {
  const isNewTab = url.includes('newtab');
  const logoUri = getKinexLogoDataUri();
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="color-scheme" content="dark light" />
<title>${isNewTab ? 'New Tab — Kinex' : 'Kinex'}</title>
<style>
  :root {
    --bg: #f6f6fa;
    --surface: #ffffff;
    --surface-hover: #f0eff7;
    --border: rgba(15, 18, 46, 0.09);
    --text: #0b0d36;
    --muted: #656a82;
    --accent: #5244f3;
    --shadow: 0 1px 2px rgba(11, 13, 54, 0.04), 0 10px 28px rgba(11, 13, 54, 0.06);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0f1016;
      --surface: #171923;
      --surface-hover: #202331;
      --border: rgba(255, 255, 255, 0.09);
      --text: #f3f4fa;
      --muted: #8b90a6;
      --accent: #6c63ff;
      --shadow: 0 1px 2px rgba(0, 0, 0, 0.25), 0 16px 36px rgba(0, 0, 0, 0.36);
    }
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    min-height: 100vh;
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter", sans-serif;
    background: var(--bg);
    color: var(--text);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 40px 24px;
    -webkit-font-smoothing: antialiased;
  }
  @keyframes fadeSlideUp {
    from { opacity: 0; transform: translateY(10px); }
    to { opacity: 1; transform: translateY(0); }
  }
  .wrap {
    width: 100%;
    max-width: 580px;
    display: flex;
    flex-direction: column;
    gap: 24px;
  }
  .brand-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    animation: fadeSlideUp 320ms cubic-bezier(0.22, 1, 0.36, 1) both;
  }
  .brand-left {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .logo-badge {
    width: 36px;
    height: 36px;
    border-radius: 10px;
    background: #ffffff;
    border: 1px solid rgba(11, 13, 54, 0.08);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    box-shadow: 0 4px 14px rgba(82, 68, 243, 0.14);
    transition: transform 220ms cubic-bezier(0.22, 1, 0.36, 1);
  }
  .logo-badge:hover { transform: scale(1.06) rotate(-2deg); }
  .logo-badge img { width: 24px; height: 24px; display: block; }
  h1 {
    font-size: 25px;
    font-weight: 650;
    letter-spacing: -0.025em;
  }
  .clock {
    font-size: 13px;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }
  .search-box {
    display: flex;
    align-items: center;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 13px;
    padding: 4px 6px 4px 15px;
    box-shadow: var(--shadow);
    transition: border-color 160ms ease, box-shadow 160ms ease, transform 160ms ease;
    animation: fadeSlideUp 360ms 50ms cubic-bezier(0.22, 1, 0.36, 1) both;
  }
  .search-box:focus-within {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px rgba(82, 68, 243, 0.18), var(--shadow);
  }
  .search-box input {
    flex: 1;
    height: 42px;
    border: none;
    background: transparent;
    color: var(--text);
    font-size: 15px;
    outline: none;
  }
  .search-box input::placeholder { color: var(--muted); }
  .search-box button {
    height: 34px;
    padding: 0 15px;
    border-radius: 9px;
    border: none;
    background: var(--accent);
    color: #fff;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition: opacity 120ms ease, transform 120ms ease;
  }
  .search-box button:hover { opacity: 0.92; }
  .search-box button:active { transform: scale(0.97); }
  .links {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 10px;
    animation: fadeSlideUp 400ms 100ms cubic-bezier(0.22, 1, 0.36, 1) both;
  }
  .link-tile {
    text-decoration: none;
    color: var(--text);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 13px 12px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    transition: background 140ms ease, transform 180ms cubic-bezier(0.22, 1, 0.36, 1), border-color 140ms ease;
  }
  .link-tile:hover {
    background: var(--surface-hover);
    border-color: rgba(82, 68, 243, 0.28);
    transform: translateY(-2px);
  }
  .link-name { font-size: 13px; font-weight: 500; }
  .link-host { font-size: 11px; color: var(--muted); }
  .hints {
    display: flex;
    flex-wrap: wrap;
    gap: 16px;
    justify-content: center;
    font-size: 12px;
    color: var(--muted);
    padding-top: 6px;
    animation: fadeSlideUp 440ms 150ms cubic-bezier(0.22, 1, 0.36, 1) both;
  }
  .hint { display: inline-flex; align-items: center; gap: 6px; }
  kbd {
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 11px;
    padding: 2px 6px;
    border-radius: 5px;
    background: var(--surface);
    border: 1px solid var(--border);
    color: var(--text);
  }
</style>
</head>
<body>
  <main class="wrap">
    <div class="brand-row">
      <div class="brand-left">
        ${logoUri ? `<div class="logo-badge"><img src="${logoUri}" alt="Kinex" /></div>` : ''}
        <h1>Kinex</h1>
      </div>
      <span class="clock" id="clock"></span>
    </div>
    <form class="search-box" onsubmit="event.preventDefault(); const q=document.getElementById('q').value.trim(); if(!q) return; const isUrl=/^(https?:\\/\\/|localhost(:\\d+)?|[a-zA-Z0-9-]+(\\.[a-zA-Z0-9-]+)+)/.test(q); window.location.href=isUrl ? (/^https?:\\/\\//.test(q)?q:(q.startsWith('localhost')?'http://'+q:'https://'+q)) : 'https://www.google.com/search?q='+encodeURIComponent(q);">
      <input id="q" type="text" placeholder="Search the web or enter an address..." autofocus />
      <button type="submit">Open</button>
    </form>
    <div class="links">
      <a class="link-tile" href="https://github.com"><span class="link-name">GitHub</span><span class="link-host">github.com</span></a>
      <a class="link-tile" href="https://www.youtube.com"><span class="link-name">YouTube</span><span class="link-host">youtube.com</span></a>
      <a class="link-tile" href="https://news.ycombinator.com"><span class="link-name">Hacker News</span><span class="link-host">ycombinator.com</span></a>
      <a class="link-tile" href="https://developer.mozilla.org"><span class="link-name">MDN Docs</span><span class="link-host">mozilla.org</span></a>
    </div>
    <div class="hints">
      <span class="hint"><kbd>⌘T</kbd> Command Bar</span>
      <span class="hint"><kbd>⌘S</kbd> Sidebar</span>
      <span class="hint"><kbd>⌘⇧\\</kbd> Split View</span>
      <span class="hint"><kbd>⌥⌘N</kbd> Little Kinex</span>
      <span class="hint"><kbd>⌘,</kbd> Settings</span>
    </div>
  </main>
  <script>
    const el = document.getElementById('clock');
    const tick = () => {
      el.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    };
    tick();
    setInterval(tick, 15000);
  </script>
</body>
</html>`;
}
