# Test Kinex 7.0.3

Run these checks from the repository root after [building the local environment](build-and-signing.md). Use disposable profiles. Do not point tests at your normal Kinex user-data directory.

## Run the automated gates

Use the existing npm commands:

```sh
npm run typecheck
npm run lint
npm run test:pure
npm run test:native
npm run build
npm run test:integration
npm run test:e2e
npm run test:keyboard
npm run test:experience
npm run test:shields
npm run test:security
npm run test:shields-startup
```

`npm test` runs the full Vitest suite. `npm run test:all` sequences typecheck, Vitest, Electron integration, E2E, keyboard, experience, Shields, security, and Shields startup checks. Compiler lint is a separate gate. It enables TypeScript's unused-local and unused-parameter checks without adding a lint dependency.

`test:pure` excludes the native Shields tests and `features.test.ts`. It covers input and sender boundaries, navigation, permission decisions, persistence, download naming, session cleanup, and updater file serving. Some tests use controlled Electron API boundaries; they do not prove hardware or full browser behavior.

`test:native` runs the real native Shields tests and the mixed feature tests. A failure to compile or load `adblock-rs/js/index.node` is a native toolchain or installation failure. Record it separately from an assertion failure. Do not globally skip native tests or report their absence as passing. See [native build recovery](build-and-signing.md#recover-a-native-build-failure).

## Understand the Electron checks

The Electron runners use temporary data directories and local HTTP fixtures. The main integration fixture redirects Downloads to its temporary directory. Test mode disables the production single-instance lock and automatic update checks. It does not disable sandboxing, context isolation, web security, or TLS verification.

| Gate | Observable behavior |
| --- | --- |
| `test:integration` | Navigation, profile cookies, private storage and history, real renderer crash recovery, reopen cleanup, Memory Saver, tab restoration, Reader Mode, Find, zoom, PDF output, and download pause/resume |
| `test:e2e` | Browser UI workflows, IPC rejection, unsafe navigation, session restoration, and layout checks |
| `test:keyboard` | Native Chromium key events across browser commands, tabs, Spaces, Split View, dialogs, focus, reduced motion, and context menus |
| `test:experience` | Native focus ownership, split-pane command targets, Profile reassignment, popup shortcuts, fullscreen bounds, and power-event listener cleanup |
| `test:shields` | Real bundled rules, network and cosmetic filtering, per-site disabling, custom element rules, private redaction, and Shields UI |
| `test:security` | Actual website API isolation, cross-profile IndexedDB/cache/service-worker isolation, scoped permissions, revocation, private purge, internal CSP, tab security preferences, and rejection of unknown Profiles |
| `test:shields-startup` | Real native worker initialization, concurrent-start coalescing, request readiness, failure/disposal lifecycle, filter matching, and timer responsiveness |

`test:experience` simulates Electron power and thermal events. It does not measure real thermal behavior. Keyboard automation exercises Chromium key events; it does not establish every macOS native-menu accessibility path.

Run desktop tests serially on an unlocked macOS graphical session. Another application taking foreground focus can invalidate native focus assertions. Preserve a failed report before investigating. Distinguish a product focus defect, a test timing assumption, and external focus interference using the focused `WebContents` and window state. Repetition alone does not turn a failed gate into a pass.

## Retain and interpret evidence

The v7.0.3 implementation records evidence under [`artifacts/v7.0.3`](../../artifacts/v7.0.3). Individual logs are observations at their recorded source state, not a guarantee that every later edit has passed.

| Evidence | Recorded scope |
| --- | --- |
| `pure.txt`, `native-tests.txt`, `unit.txt` | Separate pure/native runs and complete Vitest observations |
| `build.txt`, `clean-install.txt`, `native-build.txt` | Production build, locked clean installation, and native toolchain output |
| `integration.txt`, `e2e.txt`, `security-integration.txt`, `shields-integration.txt` | Individual Electron runs |
| `keyboard/keyboard-results.json`, `keyboard.txt` | Keyboard assertions and input transcript |
| `experience.json`, `experience.txt` | Individual focus and window integration observation |
| `all-tests-focus-failure.txt` | Preserved failed combined run at the experience test's native Tab-focus assertion |
| `all-tests.txt` | Combined-run output; inspect its final exit and assertions before assigning a result |
| `packaging-final.txt`, `packaged-final.json`, `packaged-final.txt` | Unsigned arm64 bundle generation and packaged smoke test |
| `final-audit.json`, `audit.txt` | Dependency audit observation |
| `shields-init-before.json`, `shields-init-after.json` | Initialization measurements with workload, versions, timing samples, and correctness checks |
| `website-probe-final.json`, `website-probe-final.txt` | Public website probe results, including blockers and authentication walls |

Earlier combined runs failed on instantaneous native focus assumptions. The drivers now wait for actual focus and retain their assertions. The synchronized full suite passed in all-tests-synchronized.txt; the failures remain evidence. Final targeted tests also exercise real DOM fullscreen, Canvas/WebGL2, local upload and clipboard rejection. See the release report for remaining limits.

The historical files `BENCHMARKS.md`, `SHIELDS_BENCHMARKS.md`, and earlier quality reports contain observations from older code and runtimes. They do not override the v7.0.3 raw evidence. Compiler success alone does not establish packaged startup, native loading, or browser compatibility.

## Test a packaged application

After creating the arm64 bundle, run:

```sh
node tests/integration/run-packaged.mjs --out=artifacts/ci/packaged.json
```

The default app is `release/mac-arm64/Kinex.app`. Supply `--app=/absolute/path/Kinex.app` to inspect another local bundle. The runner checks metadata, executable and addon architecture, real native Shields initialization, sandboxed navigation, and persisted state with temporary data.

An unsigned packaged smoke test does not verify Developer ID signing, notarization, Gatekeeper acceptance, hardware permissions, or authenticated update installation. Those remain separate release gates.

## Measure startup, memory, and lifecycle behavior

Use the repository's existing measurement commands:

```sh
npm run bench
npm run bench:memory-saver
npm run test:leak
npm run test:shields-startup
node tests/perf/run-shields-benchmark.mjs
```

`run-benchmarks.mjs` records fresh and warm startup, local multi-origin tab creation and switching, and process-tree memory/CPU. Its default tab counts include 1, 5, 10, 25, and 50. `--quick` changes the workload and run count, so do not compare it as an equivalent full run.

The Shields initialization check alternates five fresh Electron processes per method and verifies real bundled filtering. `ELECTRON_RUN_AS_NODE` excludes renderer and window startup. A lower main-thread timer gap is evidence about initialization responsiveness, not proof of lower complete application startup time.

A leak run reports live WebContents, heap growth, descendant process RSS, and restart/restore cycles. Chromium spare renderers and allocator retention mean residual RSS alone does not prove a leak. Preserve workload correctness checks and failure counts alongside timings. Record the hardware, operating system, Electron/Chromium/Node versions, run count, median, and range before comparing results.

## Verify public website compatibility

Run the public probe after building:

```sh
node tests/perf/run-live-probe.mjs --out=artifacts/ci/website-probe.json
```

Record the scenario and resulting origin. A redirect to a login or marketing page establishes that page's result only. Authentication, OAuth, MFA, editing, meetings, uploads, clipboard, real media devices, and DRM playback require authorized manual verification. Use the statuses and procedures in the release compatibility matrix. An inaccessible site is blocked or failed, never passed.

## CI and release boundaries

CI uses a pinned macOS runner, Node 24, locked dependencies, Rust/Xcode checks, separate pure/native tests, real Electron tests, unsigned arm64 packaging, and packaged startup. Its GitHub token has read permission. Artifacts upload even after a failed gate. A workflow configuration review is not an executed GitHub Actions result.

After successful main-push CI, the release workflow verifies the exact commit again and publishes a DMG and ZIP. Explicit version tags remain supported. Without Apple credentials, 0.x previews publish as unsigned manual downloads; production and signed automatic-installation artifacts require signing and notarization. No push, tag publication, release, or deployment is needed for local checks.

After packaging, run `node tests/integration/run-dmg.mjs`. It verifies the versioned arm64 image with hdiutil, mounts it read-only without Finder browsing, and invokes the existing packaged smoke test against its actual Kinex.app using disposable data. It then unmounts the image. Evidence is written to `artifacts/ci/dmg.json`; signature acceptance of a downloaded/quarantined app is not established by this local test.
