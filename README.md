<div align="center">
  <img src="build/icon.png" alt="Kinex Browser" width="112" height="112" />
  <h1>Kinex Browser (v0.7.8)</h1>
  <p>A fast, memory-efficient, everyday privacy-focused macOS desktop browser built on Chromium and Electron — with zero AI bloat.</p>
  <p>
    <a href="LICENSE"><img src="https://img.shields.io/badge/License-GPLv3-blue.svg?style=flat-square" alt="License: GPL v3" /></a>
    <img src="https://img.shields.io/badge/Platform-macOS%20Apple%20Silicon-black?style=flat-square" alt="Platform: macOS arm64" />
    <img src="https://img.shields.io/badge/Engine-Chromium%20%2F%20Electron%2045-47848F?style=flat-square" alt="Engine: Chromium" />
  </p>
</div>

---

## v0.7.8 verification

Electron is pinned to **45.3.3**, with Chromium **156.0.8078.100** and embedded Node **24.22.3**. Version numbering was reset from 7.0.3 to 0.7.3; the 0.x line is pre-production and 1.0.0 is reserved for the production release. The current local preview is unsigned and not notarized. Free 0.x Releases include an unsigned DMG and ZIP for manual installation. Automatic update installation requires matching Developer ID signing even before 1.0.0; no auto-update manifest is published for unsigned previews. It adds profile-scoped permission grants, stricter IPC and TLS boundaries, recoverable state writes, safer downloads, and worker-based cold Shields initialization. Existing unscoped permission grants require fresh consent.

Read the [release evidence and readiness report](docs/quality/v7.0.3-report.md), [compatibility matrix](docs/quality/compatibility-matrix.md), [security architecture](docs/security-architecture.md), and [test procedures](docs/quality/testing.md). Public landing pages do not establish authenticated app compatibility. Signed distribution and protected playback remain unverified. The report retains an intermittent combined-suite native focus failure.

Every completed main push receives a new patch version. Successful main CI triggers preview publication with DMG verification and mounted-app startup checks. Signing credentials are optional for 0.x manual previews and required for production and signed auto-installation. Contributor rules and handoff notes are in [AGENTS.md](AGENTS.md).

For older 0.7.x installations, see [update compatibility and signing prerequisites](docs/quality/update-compatibility.md).

## Features

- **Kinex Design System & UI (`v0.6.0`–`v0.7.0`)**: Semantic Light/Dark design tokens (`tokens.css`) synchronized across sidebar vibrancy, New Tab canvases, Settings, Downloads, Command Bar, and Split View — plus full `prefers-reduced-motion`, `prefers-reduced-transparency`, and `:focus-visible` keyboard accessibility support.
- **Complete Tab, Space & Navigation Workflow**: Instant cross-Space Tab Search in Command Bar, Recently Closed Tabs & Group Restoration (`⌘⇧T`), Duplicate Tab Detection, profile-isolated Move to Space, Space-scoped Favorites & Folders, drag-and-drop Space reordering, Find in Page match counts (`⌘F`), per-site Zoom memory, Print & Save as PDF (`⌘P` / `⌘⇧P`), script-disabled **Reader Mode** (`⌥⌘R`), live Download Pause/Resume/Speed/ETA, and macOS Default Browser (`http`/`https`) integration.
- **Customizable New Tab Experience (`kinex://newtab`)**: Switch between **Minimal**, **Focus**, and **Personal** presets, adjust subtle backdrop atmospheres (`Clean`, `Mist`, `Dusk`, `Sage`), toggle Clock / Pinned Favorites / Frequently Visited modules in Settings, and keep Light/Dark Space harmony automatically.
- **Workspace Sidebar & Spaces**: Organize browsing into Spaces backed by isolated Chromium cookie/storage Profiles, custom themes over native macOS frosted glass (`under-window` vibrancy), and an inset web viewport.
- **Favorites, Pinned Folders & Today Tabs**: Keep core apps in Favorites, organize Pinned tabs in collapsible Folders (closing resets back to the pinned URL), and archive ephemeral Today tabs with one click.
- **Command Bar (`⌘T` / `⌘L`)**: Instant search across open tabs, pinned items, history, traditional search engines (Google, DuckDuckGo, Bing, Startpage, Kagi), and browser actions.
- **Split View (`⌘⇧\`) & Little Kinex (`⌥⌘N`)**: View two tabs side-by-side with an adjustable ratio slider, or open quick links in a floating Little Kinex window and promote them into any Space.
- **Boosts Studio & Element Zapper (`⌘⇧B`)**: Apply per-domain custom CSS, JavaScript, fonts, Smart Dark Invert, or click any element on a page to hide it persistently.
- **Performance & Memory Saver**:
  - Lazy overlay renderer allocation and deferred startup checks for fast cold/warm launch
  - Configurable **Memory Saver** (`Disabled`, `5m`, `15m`, `30m` default, `60m`) with pinned/favorite exemption; never discards active, Split View, audible, downloading, media-capture, or unsaved-form tabs
  - Native background throttling, debounced async JSON persistence, coalesced IPC broadcasts, and native Rust request filtering
  - Measured startup, 1–50 tab scaling, Memory Saver, and 7-scenario leak stress results documented in [BENCHMARKS.md](BENCHMARKS.md)
- **Privacy & Security**:
  - Sandboxed `WebContentsView` webviews (`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, `webSecurity: true`, `navigateOnDragDrop: false`)
  - Runtime IPC sender verification (`TrustedIpcRegistry`) and strict schema validation (`ipcValidation.ts`)
  - Explicit protocol allowlisting (`https:`, `http:`, `kinex:`, `nook:` -> `kinex://`, `about:blank`) and prompt-gated external handoff (`mailto:`, `tel:`)
  - **HTTPS-Only Mode** with network error classification (never silently downgrading on DNS, offline, timeout, or TLS certificate errors; insecure HTTP fallback requires explicit user confirmation)
  - **Isolated Private Windows (`⌘⇧N`)**: Ephemeral non-persistent Chromium partitions with strict sensitive permission denial, no history/download recording, disabled silent promotion into regular tabs, and session storage/cache purge on close
  - **Kinex Shields (`adblock-rs` + `tldts`)**: Native Rust content-blocking engine with 7 bundled offline filter lists (`EasyList`, `EasyPrivacy`, `uBlock Origin Filters/Privacy/Quick Fixes`, `Peter Lowe's`, and `Fanboy Cookie`), Standard/Aggressive/Disabled global and per-site precedence, dynamic isolated-world cosmetic filtering, Element Picker, HTTPS list updates, and **Clean Copy URL** (`⌘⇧C` / navigation param stripping) — documented in [SHIELDS_BENCHMARKS.md](SHIELDS_BENCHMARKS.md)
- **Migration & Import**: Backward-compatible state migration from legacy `NOOK/nook-state.json` and `nook://` URLs while preserving existing `persist:nook-*` profile cookies/sessions, plus Arc (`StorableSidebar.json`), Chrome (`Bookmarks`), and HTML bookmark import.
- **In-App Auto-Updater**: Built on `electron-updater` / `Squirrel.Mac`, validating update feeds (`https://`, localhost, or local release directory) against `latest-mac.yml`.

---

## Architecture Overview

```text
src/
├── main/
│   ├── index.ts              # App lifecycle, custom schemes, runtime-validated IPC handlers
│   ├── windowManager.ts      # KinexWindowManager coordinator, intents, state broadcast & disposal
│   ├── ipcValidation.ts      # Trusted sender registry & exhaustive runtime intent validation
│   ├── navigationManager.ts  # Navigation/redirect guards, HTTPS-only prompt & cert error handling
│   ├── sessionManager.ts     # Profile partitions, kinex/nook protocols, isolated private sessions
│   ├── permissionManager.ts  # Profile-scoped per-origin permission checks, prompts & revocation
│   ├── downloadManager.ts    # Download tracking & tracked-path verification for Finder reveal
│   ├── memorySaver.ts        # Safe background tab discard policy & timeout definitions
│   ├── tabManager.ts         # WebContentsView lifecycle, throttling, discard/restore & recovery
│   ├── viewLayoutManager.ts  # Multi-view geometry & Split View bounds calculation
│   ├── auxiliaryWindows.ts   # Little Kinex & isolated Private Windows
│   ├── appMenu.ts            # Native macOS application menu & accelerators
│   ├── importController.ts   # Arc, Chrome & HTML bookmark import flows
│   ├── persistence.ts        # Atomic JSON state persistence & NOOK -> Kinex migration
│   ├── security.ts           # URL guards, Chromium error classification, tracker stripping
│   ├── shields/              # Kinex Shields: adblock-rs engine, lists, scriptlets, cosmetics, coordinator
│   ├── boosts.ts             # Per-domain CSS/JS injection & Boosts Zapper
│   ├── internalPages.ts      # kinex://welcome, kinex://private, kinex://crashed HTML templates
│   └── updater.ts            # KinexAutoUpdater (remote HTTPS & local feed server)
├── preload/
│   └── shell.ts              # Context-isolated window.kinexAPI bridge (shell/overlay/header only)
├── shared/
│   ├── types.ts              # Shared domain, IPC intent, snapshot & API contracts
│   ├── domain.ts             # Pure navigation normalization, tab/split transitions, Command Bar search
│   └── importer.ts           # Pure Arc, Chrome & HTML bookmark parsers
└── renderer/
    ├── App.tsx               # Shell, Overlay & Little Kinex / Private header router
    └── styles/
        ├── tokens.css        # Light/Dark, contrast, spacing & typography tokens
        └── kinex.css         # Frosted vibrancy shell, overlays & macOS styling
    └── components/           # Sidebar, TopControls, CommandBar, SettingsView, BoostPanel, SpaceEditor
```

---

## Security Model

1. **Privilege Separation**: Only internal UI views (`?view=shell`, `?view=overlay`, `?view=little`, `?view=private`) load `preload/shell.ts`. Untrusted remote `WebContentsView` tabs run with `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, and zero preload access to `window.kinexAPI`.
2. **IPC Defense-in-Depth**: Every `ipcMain.handle('kinex:*')` verifies both sender `webContents.id` role registration and main-frame identity and exact sender document URL before validating all fields with `validateIntent` / `validateTabContextMenuInput` / `validateLittleKinexActionInput`. Download Finder reveals are restricted to paths tracked by `DownloadManager`.
3. **Navigation & HTTPS Protections**: `will-navigate`, `will-redirect`, and `setWindowOpenHandler` block `javascript:`, `file:`, `data:`, `vbscript:`, and unapproved custom schemes across tabs, popups, Little Kinex, and Private Windows. Certificate errors and HTTPS-only upgrade failures require explicit user confirmation and never fail open or downgrade silently on DNS/timeout/offline errors.
4. **Private Session Isolation**: Private windows run on unique non-persistent `kinex-private-*` partitions (`{ cache: false }`), deny sensitive tracking/hardware permissions without persistence, omit history/download tracking, block `"Open in Kinex"` promotion, and purge storage, cache, and auth cache when closed.

---

## Development & Automated Testing

Use **Node.js 24**, npm, Rust/Cargo, and Xcode command-line tools on macOS 13 or newer. Apple Silicon is the locally validated target. See [build and signing](docs/quality/build-and-signing.md).

```bash
npm ci
npx --no-install install-electron
npm run typecheck          # Typecheck Electron main/preload + React renderer
npm test                   # Unit tests (domain, migration, IPC validation, security policies)
npm run test:integration   # Real Electron main-process, session isolation & Memory Saver tests
npm run test:e2e           # Full 15-workflow CDP E2E suite against a local HTTP test server
npm run test:shields       # Kinex Shields network, cosmetic, scriptlet & privacy integration suite
npm run test:leak          # 7-scenario stress & memory leak test suite
npm run test:all           # Unit, native, browser, keyboard, security, and Shields startup checks
npm run lint               # Compiler checks for unused locals and parameters
npm run bench              # Run reproducible startup + 1/5/10/25/50-tab benchmarks
npm run bench:memory-saver # Measure 25/50-tab RSS savings with Memory Saver enabled
npm start                  # Build and launch Kinex locally
```

---

## Packaging and release verification

```bash
npm run package:mac        # Builds dist/, dist-electron/, Kinex.app, arm64 zip, latest-mac.yml
```

1. Ensure `npm run test:all` passes cleanly with zero skipped tests.
2. Keep package and lockfile versions consistent with `npm version <version> --no-git-tag-version`.
3. Run `npm run package:mac` and inspect `release/latest-mac.yml` + `release/mac-arm64/Kinex.app`.
4. Note on macOS signing & notarization: Local `electron-builder` builds are unsigned/ad-hoc signed unless Apple Developer ID certificates (`CSC_LINK`, `CSC_KEY_PASSWORD`) and notarization credentials are configured in CI/release environment.

---

## Feature Verification Status & Limitations

- **Verified by automated unit, integration, and Electron E2E tests**: Workspace/Space creation & switching, Space-scoped cookie/storage profile isolation, tab navigation/back/forward/reload, Split View toggling & layout geometry, Command Bar, Private Window session & permission isolation, tab close & Archive restore, restart persistence, `nook://`/`nook-state.json` migration, IPC validation & sender enforcement, navigation scheme blocking, HTTPS error classification, and view/timer disposal.
- **Partially verified / manual**: Live interactive `dialog.showMessageBox` flows (certificate bypass confirmation, explicit HTTP fallback prompt, OS-level permission prompt), physical camera/microphone capture, and remote GitHub Releases `autoUpdater` upgrade against a signed DMG/ZIP feed (local `latest-mac.yml` generation & feed classification are verified).
- **Blocked release gates**: Developer ID signing, notarization, signed update installation, authenticated provider workflows, and hardware media consent. CI configuration is prepared; these outcomes are not established locally. Automated multi-window restoration and Linux/Windows builds remain outside this release.

## License

Kinex is licensed under the **GNU General Public License v3.0 (GPL-3.0-only)**. See [LICENSE](LICENSE) for the full text.
