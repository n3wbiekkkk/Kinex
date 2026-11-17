# Changelog

All notable releases of **Kinex Browser** follow a traditional, lightweight, privacy-focused macOS desktop browser roadmap with zero AI features.

## [0.7.4] - 2026-11-17

Pre-production preview. Automatic signed publication is configured, but remains blocked by unavailable signing/notarization credentials.

- Record engineering rules, prior evidence, release blockers, and the default verify/commit/push workflow in AGENTS.md.
- Start release verification after successful CI for each versioned main push; retain explicit tag releases. Check out the verified SHA, reject reused tags, serialize publication, and prevent stale builds from replacing Latest.
- Upload complete signed assets as a draft before publication; preserve published artifacts on reruns.
- Use npm versioning in the local release helper so package.json and package-lock.json remain synchronized. Remove the unverified automatic-installation claim and add regression coverage for patch/minor/no-bump behavior.

## [0.7.3] - 2026-11-17

Pre-production preview. Version numbering was reset from 7.0.3 to 0.7.3: the 0.x line is pre-production, and 1.0.0 is reserved for the production release. This build is unsigned and not notarized. See [verification and remaining gates](docs/quality/v7.0.3-report.md) for evidence recorded during the 7.0.3 implementation.

### Changed

- Upgrade Electron 36.9.5 to pinned 45.3.3, Chromium 156, embedded Node 24.22.3. The minimum macOS version is 13.
- Update Vite, Vitest, electron-builder, and Node definitions. Pin a patched minimatch override for build tooling. The final locked audit reports no advisories.
- Compile cold Shields filters in a worker. Hold initial intercepted requests until initialization completes. Preserve native filtering and show initialization failures.
- Prepare arm64 packaging, targeted hardened-runtime entitlements, signing gates, pinned CI actions, and real packaged startup verification.

### Fixed

- Preserve the 0.7.x update feed by publishing signed artifacts through GitHub Latest. Prevent 0.x installations from selecting the obsolete misnumbered 7.0.1/7.0.2/7.0.3 builds. Signing credentials and publication remain prerequisites, not verified installation claims.

- Scope site permissions and revocation to the owning Profile. Separate microphone and camera grants. Reject stale prompts, unknown permissions, untrusted IPC frames, and insecure LAN update feeds.
- Scope TLS exceptions to the session, origin, certificate fingerprint, and error. Preserve legitimate same-origin blob previews in sandboxed popups.
- Prevent older asynchronous saves from overwriting final shutdown state. Validate corrupted collections and split state, preserve damaged originals, and retain valid tabs and profiles.
- Avoid download filename overwrite after 99 collisions and collisions between concurrent regular/private downloads.
- Recreate Little Kinex after a Profile change. Destroy private popups before cleanup and attempt all purge operations independently.
- Apply per-site Shields exceptions inside third-party frames. Preserve concurrent list settings, reject insecure redirect chains and corrupt native caches, cancel disposed updates, and clean cosmetic state.
- Apply nonce-authorized internal scripts and script-disabled Reader responses. Harden local update file serving and retain updater lifecycle across macOS window close.

### Verification limits

- Automated unit, browser, security, keyboard, native startup, stress, and unsigned packaged checks are recorded in the report. A prior combined-suite native focus failure remains explicitly recorded.
- Login, MFA, signed hardware consent, signing/notarization, signed installation, and protected Netflix playback are not passing claims.

## [7.0.2] - 2026-11-17
### Added
- **Kinex Shields Native Blocking Engine (`adblock-rs` + `tldts`)**: Replaced legacy 26-domain suffix filtering with a native Rust `adblock-rs` content-blocking subsystem (`MPL-2.0`) supporting EasyList/ABP filter syntax, resource-type matching, Public Suffix List first/third-party classification, vetted local scriptlets (`nobab`, `abort-on-property-read/write`, `set-constant`, `no-setTimeout/Interval-if`, `nowebrtc`, `no-fetch-if`), and redirect stubs (`noopjs`, `1x1.gif`, `2x2.png`).
- **Offline Filter Lists & Safe HTTPS Updates**: Bundled 7 compressed upstream filter lists (`EasyList`, `EasyPrivacy`, `uBlock Origin Filters`, `uBlock Origin Privacy`, `uBlock Quick Fixes`, `Peter Lowe's`, `Fanboy Cookie`) in `resources/filters/` with HTTPS-only list refresh, 12 MB validation/null-byte/HTML rejection, atomic disk replacement, automatic rollback on bad fetches, and binary `.bin` cache serialization (`3.88 ms` warm deserialization).
- **Per-Tab Network Coordinator & Cosmetic Filtering**: Single unified `webRequest.onBeforeRequest` coordinator across regular, Space profile, isolated Private Window (with redacted `[Private request blocked]` stats), and Little Kinex sessions; isolated-world (`99`) cosmetic CSS + procedural filtering (`:has`, `:has-text`, `:upward`) with serialized key cleanup so site toggles apply immediately without page reload.
- **Kinex Shields Panel & Settings (`⌘⇧K`)**: Added toolbar Shields toggle + per-tab blocked badge, detailed per-tab request inspector, reload banner, `Standard` / `Aggressive` / `Disabled` precedence (`exact host > registrable eTLD+1 domain > global`), hover/keyboard **Element Picker**, and `Settings -> Shields & Filters` list/rule management.
- **Benchmarks & Shields Test Suite**: Added [SHIELDS_BENCHMARKS.md](SHIELDS_BENCHMARKS.md), `npm run test:shields`, `tests/perf/run-shields-benchmark.mjs`, and `tests/perf/run-shields-compatibility.mjs`.

## [7.0.1] - 2026-11-16
### Fixed
- **Edge-to-Edge HTML5 Video Fullscreen**: Entering HTML5 element fullscreen (e.g., YouTube player fullscreen) now hides the Sidebar, top insets, and sibling Split View panes in the main window (as well as the header bar in Private Windows and Little Kinex) so fullscreen content fills the entire `{ x: 0, y: 0, width, height }` viewport and cleanly restores inset bounds on exit, tab switch, or Space change.
- **Overlay Focus Guard During Navigation Swaps**: Prevented background or newly relocated `WebContentsView` navigation commits from stealing native focus while Command Bar, Settings, Find in Page, or other browser overlays are open.
- **Window View Disposal Safety**: Detached `shellView` and `overlayView` from `mainWindow.contentView` prior to closing their `WebContents`, and dismissed native context menus cleanly on automated test exit.
- **Auto-Updater Feed Migration & GitHub Release Publishing**: Automatically migrates stale legacy Nook update feed paths (`releases.nook.dev` or missing local `Nook/release` folders) to `https://github.com/n3wbiekkkk/Kinex/releases/latest/download`, adds a one-click **Use GitHub Releases** reset in Settings (`Updates & About`), formats HTTP 404/network updater errors clearly, and adds `.github/workflows/release.yml` for tag-triggered macOS release asset uploads.

## [0.7.0] - 2026-11-16
### Added
- **Advanced Tab Experience**:
  - Instant cross-Space Tab Search inside Command Bar (`⌘T` / `⌘L`) matching title, domain, URL, and Space name with query highlighting and favicons.
  - Recently Closed Tabs (`⌘⇧T`) & Batch/Group Restoration (`closedTabs`, `restore-closed-group`) preserving original URL, Space, Profile, folder, and pinned state.
  - Duplicate Tab Detection (`duplicatePolicy`, `resolve-duplicate-open`) letting users switch to an existing tab or intentionally open a duplicate.
  - Complete Tab Context Menu (`Reload`, `Duplicate`, `Pin/Unpin`, `Move to Space`, `Move to Folder`, `Mute/Unmute`, `Copy Clean URL`, `Put Tab to Sleep`, `Close`, `Close Other Tabs`, `Close Tabs to the Right`, `Reopen Closed Tab`).
- **Improved Spaces**:
  - Profile-isolated `Move to Space` (automatically destroys cached views when changing cookie partitions), Space drag-and-drop reordering, Space renaming, Space-scoped Favorites & Pinned Folders, and `⌃1..9` direct Space switching shortcuts.
- **Browsing Essentials**:
  - Live Find in Page match counts (`activeMatchOrdinal/matches`) and clean clearing on close (`Esc`).
  - Per-site Page Zoom persistence (`zoomByHost`) across navigations.
  - Native macOS Print (`⌘P`) and Save Page as PDF (`⌘⇧P`).
  - Privacy-preserving **Reader Mode** (`⌥⌘R`) with font size and Light/Sepia/Dark theme controls, strict HTML escaping, and script-disabled CSP (`default-src 'none'`).
- **Download Manager**:
  - Real `DownloadItem` progress bar, live transfer speed, ETA estimation, `canResume()`-verified Pause/Resume/Cancel, Open completed file, Reveal in Finder, Clear Finished, collision-safe filenames, and private-window exclusion.
- **Navigation, Default Browser & Shortcuts**:
  - Native web content right-click Context Menu (`Open Link in New Tab / Background Tab / Split View / Little Kinex / Private Window`, `Copy Link Address`).
  - Strengthened popup `setWindowOpenHandler` sandbox & session binding.
  - HTTP + HTTPS default browser detection & cold/warm external URL handling.
  - Consistent macOS keyboard shortcuts (`⌘⇧T`, `⌘.`, `⌥⌘R`, `⌘P`, `⌘⇧P`, `⌃1..9`).

### Fixed
- Resolved intermittent main-frame vs sub-frame loading state timing (`did-stop-loading` checking `!wc.isLoadingMainFrame()`).
- Fixed Electron 36 `find-in-page` first-query event emission timing.

## [0.6.0] - 2026-11-16
- Added cohesive Light/Dark Design System (`tokens.css`), customizable New Tab presets (`Minimal`, `Focus`, `Personal`), Command Bar & Settings polish, accessibility (`prefers-reduced-motion`, `prefers-reduced-transparency`, `:focus-visible`), and removed Perplexity AI search preset in favor of Startpage.

## [0.5.0] - 2026-11-16
- Performance engineering: lazy `overlayView`, cached LaunchServices check, async atomic persistence, coalesced IPC broadcasts, `Memory Saver` tab sleep, and leak-free disposal.

## [0.4.0] - 2026-11-16
- Security hardening, modular decomposition of `windowManager.ts`, HTTPS-only upgrade/classification, and isolated Private Windows.
