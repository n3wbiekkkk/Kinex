# Changelog

All notable releases of **Kinex Browser** follow a traditional, lightweight, privacy-focused macOS desktop browser roadmap with zero AI features.

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
