# Changelog

All notable releases of **Kinex Browser** follow a traditional, lightweight, privacy-focused macOS desktop browser roadmap with zero AI features.

## [0.7.13] - 2026-11-17

Pre-production preview. Restore multiple windows and fix native focus races after closing overlays.

- Add `⌘N` New Window (menu and Sidebar) and a per-window session registry. Each regular window owns one Space; selecting a Space already claimed by another window focuses its owner.
- Persist non-private window geometry, maximized state, Space binding and focused window. Cold start restores each window with its Space and Split View; private and Little Kinex windows are never restored.
- Route IPC state and intents to the sending window. Each shell view receives a snapshot for its own Space while Spaces, Profiles, tabs and settings stay shared.
- Replace one-shot focus calls with a bounded native focus request. A closing overlay can no longer retain focus and swallow keystrokes; overlay close restores focus to the remembered origin and retries until the target owns focus.
- Add regression coverage: explicit overlay-close focus check in the experience suite, window persistence recovery tests, and a real Electron multi-window cold-start suite (`npm run test:windows`).

## [0.7.12] - 2026-11-17

Pre-production preview. Simplify the Updates & About settings view and add GitHub Release fallback for unsigned 0.x preview update checks.

- Remove the Update Feed URL/folder input and buttons from `Settings -> Updates & About`, leaving a single browser update row (`Check for Updates` / `Restart & Update`).
- Format updater status and error messages without exposing manifest filenames (`latest-mac.yml`), feed URLs, or internal cache paths.
- When `latest-mac.yml` is absent on the unsigned 0.x preview channel, resolve the latest GitHub Release (`api.github.com` with `/releases/latest` redirect fallback), report `up-to-date` when the installed version is current, and download and verify newer release archives (SHA-256 + `hdiutil verify`) before opening the installer.

## [0.7.11] - 2026-11-17

Pre-production preview. Fix intermittent CDP timeout failures in the website compatibility probe.

- Stop blaming websites for a probe infrastructure defect. The probe opened each site in a new tab, which backgrounded the previous one; a backgrounded tab produces no compositor frames, so `requestAnimationFrame` never fires and `Input.dispatchMouseEvent` is never acknowledged. The unbounded paint wait inside `Runtime.evaluate` then hung until the 5s CDP timeout.
- Make `waitForPaint()` bounded and return `{ painted, visibility }` instead of hanging, so a missing frame is reported rather than surfacing as a timeout.
- Select the tab under test before driving it, record the observed `visibilityState`, and classify CDP timeouts and an un-focusable tab as `failureClass: probe-infrastructure` with verdict `inconclusive`. A probe limitation is never reported as a website PASS or FAIL.
- Add regression coverage for the bounded paint wait and the visibility probe. Reverting `waitForPaint` to the unbounded form makes the hidden-tab check hang 5003ms and fail.
- Four consecutive probe runs, 52 site checks, zero timeouts. Probe wall time fell from about 72s to about 33s because runs no longer wait out timeouts.

## [0.7.10] - 2026-11-17

Pre-production preview. Fix the unreliable Figma compatibility result by correcting a browser loading-state defect.

- Report tab loading only for main-frame loads. Electron emits `did-start-loading` for subframe-only loads too, so a page that injects iframes after its document settles (Figma's homepage) flipped the tab back to loading after it had already settled. The compatibility probe then read `isLoading: true` and recorded FAIL while the document was ready and scroll passed.
- Keep `did-stop-loading` clearing the state only once the main frame is idle, so a real navigation still shows loading.
- Add a unit regression asserting a subframe-only load start never re-enters loading, and an integration regression driving a local fixture that settles and then injects four iframes. Reverting the fix makes that integration check fail.
- Figma now passes the public navigation, scroll, and Tab-focus scenario in two independent probe runs. Authenticated editor, OAuth, and MFA remain BLOCKED.

## [0.7.9] - 2026-11-17

Pre-production packaging fix. The downloaded 0.7.8 app retained an invalid Electron linker signature and failed strict resource-seal validation. Startup smoke tests alone had missed this defect.

- Explicitly ad-hoc sign free preview bundles and nested code with the correct application identifier. Keep hardened runtime and use the dedicated preview entitlement required to load Electron Framework without a Developer ID.
- Keep production entitlements and Developer ID release signing separate and strict. Add configuration regression coverage for this boundary.
- Require strict deep bundle signature verification and the actual hardened-runtime flag before packaged and mounted-DMG startup tests.
- Local corrected DMG startup and Shields loading pass. Developer ID, notarization, automatic signed installation, and normal Gatekeeper acceptance remain unavailable/unverified; a valid resource seal does not make a publisher trusted.

## [0.7.8] - 2026-11-17

Pre-production preview with DMG/ZIP downloads. Fix the fullscreen integration driver's macOS transition ordering: DOM fullscreen can precede native fullscreen completion. Wait for native enter/leave events, assert native and DOM states, and keep the existing timeout/bounds checks. The 0.7.7 private-close regression passed CI; its later fullscreen-exit failure remains recorded in the update evidence.

## [0.7.7] - 2026-11-17

Pre-production preview with DMG/ZIP downloads. Correct the E2E driver's handling of intentional private-window destruction: its IPC sender may close before the CDP reply arrives. Require both private header and page targets to disappear; retain all isolation assertions and reject unrelated errors. The 0.7.6 main CI passed, but its subsequent release verification failed during private-window operations and did not publish.

## [0.7.6] - 2026-11-17

Pre-production preview. Restore free GitHub Releases without requiring an Apple Developer membership.

- Publish unsigned 0.x previews as clearly labeled manual DMG/ZIP downloads when signing credentials are absent. Keep production signing requirements and macOS updater signature checks.
- Publish auto-update manifests only for signed builds, so unsigned previews are not advertised as installable signed updates.
- Add an Apple Silicon DMG target and verify the disk image, mount it read-only, and launch its actual app with disposable data in CI and release qualification.
- Bound fullscreen test transitions by observable DOM/native state and restore native focus after closing private windows. Retain fullscreen layout assertions and add DOM fullscreen assertions; CI confirmation is still required.

## [0.7.5] - 2026-11-17

Pre-production preview. Add executable release-workflow regression checks for version/tag validation, annotated tag reuse, stale main commits, draft publication ordering, and missing signing credentials. Typecheck, lint, build, 105 unit/regression tests, and actionlint pass locally. Signed updates remain blocked by unavailable credentials.

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
