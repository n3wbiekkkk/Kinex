<div align="center">
  <img src="build/icon.png" alt="Kinex Browser" width="112" height="112" />
  <h1>Kinex</h1>
  <p>A fast, private, workspace-driven macOS browser built on Chromium and Electron.</p>
  <p>
    <a href="LICENSE"><img src="https://img.shields.io/badge/License-GPLv3-blue.svg?style=flat-square" alt="License: GPL v3" /></a>
    <img src="https://img.shields.io/badge/Platform-macOS%20arm64-black?style=flat-square" alt="Platform: macOS" />
    <img src="https://img.shields.io/badge/Engine-Chromium%20%2F%20Electron-47848F?style=flat-square" alt="Engine: Chromium" />
  </p>
</div>

---

## Features

- **Workspace Sidebar & Spaces**: Organize browsing into distinct Spaces with isolated cookie/login Profiles, custom themes over native macOS frosted glass (`under-window` vibrancy), and a full-height inset web viewport.
- **Favorites, Pinned Folders & Today Tabs**: Keep core web apps in Favorites, organize Pinned tabs into collapsible Folders (closing resets back to the pinned URL), and clear ephemeral Today tabs into the Archive with one click.
- **Command Bar (`⌘T` / `⌘L`)**: Instant fuzzy navigation across open tabs, pinned items, history, search engines (Google, DuckDuckGo, Bing, Perplexity, Kagi), and browser actions.
- **Split View (`⌘⇧\`) & Little Kinex (`⌥⌘N`)**: View two pages side-by-side with an adjustable split divider, or open quick links in a floating Little Kinex window and promote them into any Space.
- **Boosts Studio & Element Zapper (`⌘⇧B`)**: Customize per-domain CSS, JavaScript, fonts, Smart Dark Invert, or click any element on a page to hide it permanently.
- **Privacy & Security**:
  - Sandboxed `WebContentsView` tabs (`contextIsolation: true`, `nodeIntegration: false`, `webSecurity: true`)
  - **HTTPS-Only Mode** with automatic fallback for local/legacy hosts and TLS certificate warnings
  - **Ad & Tracker Shields** (`webRequest` filtering) and **Clean Copy URL** (`⌘⇧C` strips `utm_*`, `fbclid`, `gclid`, etc.)
  - **Per-Origin Site Permissions** & one-click **Clear Browsing Data** in `Settings > Privacy & Security`
  - **Air Traffic Control** domain routing into designated Spaces and **Private Windows** (`⌘⇧N`)
- **In-App Auto-Updater**: Built on `electron-updater` / `Squirrel.Mac`, supporting GitHub Releases or local release feeds.
- **Migration & Import**: Import bookmarks and folders from Arc (`StorableSidebar.json`), Chrome (`Bookmarks`), or HTML bookmark exports.

## Keyboard Shortcuts (macOS)

| Action | Shortcut |
| --- | --- |
| Command Bar (New Tab) | `⌘T` |
| Edit Current URL | `⌘L` |
| Toggle Sidebar | `⌘S` |
| Toggle Split View | `⌘⇧\` |
| Pin / Unpin Tab | `⌘D` |
| Copy Clean URL | `⌘⇧C` |
| Little Kinex | `⌥⌘N` |
| New Private Window | `⌘⇧N` |
| Boosts Studio | `⌘⇧B` |
| Find in Page | `⌘F` |
| Zoom In / Out / Reset | `⌘+` / `⌘-` / `⌘0` |
| Switch Spaces | `⌃⌘←` / `⌃⌘→` |
| Jump to Tab 1–9 | `⌘1` – `⌘9` |
| Settings | `⌘,` |
| Developer Tools | `⌥⌘I` |

## Development

Requires **Node.js >= 22** and **npm**.

```bash
npm install
npm run typecheck
npm test
npm start
```

### Build & Package (`Kinex.app`)

```bash
npm run package:mac
```

Packaged artifacts (`Kinex.app`, `Kinex-<version>-arm64-mac.zip`, and `latest-mac.yml`) are written to `release/`.

## License

Kinex is licensed under the **GNU General Public License v3.0 (GPL-3.0-only)**. See [LICENSE](LICENSE) for the full text.
