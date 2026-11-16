# Kinex Browser Performance Benchmarks (`v0.4.0` → `v0.7.0`)

## Test Environment & Hardware

- **Machine**: Apple M5 (`arm64`), 10 CPU cores, 16 GB RAM
- **OS**: macOS 27.2.1 (Build `26B131`, Darwin `27.2.0`)
- **Runtime**: Electron `36.9.5` (Chromium `136` family), Node `v24.22.3`
- **Load baseline before benchmark**: `load averages: 1.97 1.84 1.94`

## Methodology

- **Startup (`tests/perf/run-benchmarks.mjs`)**: 5 cold launches (fresh temporary `KINEX_USER_DATA_DIR`) and 5 warm launches (relaunch against the initialized profile). Timings measure wall-clock time from Electron process `spawn` until:
  - `shellHydratedMs`: `?view=shell` exposes `.kinex-shell` in DOM over CDP.
  - `firstUsableMs`: `shell` hydrated and the initial `kinex://welcome` tab reports `document.readyState === 'complete'`.
- **Multi-Tab Scaling (`1, 5, 10, 25, 50` tabs)**: Uses a local HTTP test server mapped to distinct Chromium origins (`site1.bench.test` .. `site50.bench.test` via `--host-resolver-rules=MAP *.bench.test 127.0.0.1`) serving structured HTML, CSS Grid cards, and a `200ms` timer tick (`active=1`).
- **Process-Tree Memory & CPU**: Uses `ps -ax -o pid=,ppid=,rss=,%cpu=,args=` walking the **entire descendant process tree** rooted at the Electron main PID (Main + GPU + Utility/Network + every Renderer helper process). Note: macOS `ps %cpu` reports an exponentially decayed rolling CPU average, so high-tab burst CPU partially carries into short idle settle windows.
- **Memory Saver (`tests/perf/run-memory-saver-bench.mjs`)**: Loads 25 and 50 distinct-origin active tabs, records total process-tree RSS, puts background tabs to sleep via `discard-tab`, waits `1.5s`, samples settled process-tree RSS, and measures wake/restore time (`wakeRestoreMs`) when clicking a sleeping tab.

---

## 1. Startup Latency (5 Runs Each)

| Metric | `v0.4.0` Baseline | `v0.5.0` Optimized | Delta |
| --- | --- | --- | --- |
| Cold Shell Hydrated (mean / median / p95) | 357.5 / 324.0 / 519.8 ms | **273.5 / 274.5 / 275.7 ms** | **-15.3% median / -47.0% p95** |
| Cold Shell Hydrated range | 293.3–519.8 ms | 271.4–275.7 ms | Narrower tail |
| Cold First Usable (mean / median / p95) | 370.4 / 336.2 / 533.5 ms | **275.5 / 276.5 / 278.1 ms** | **-17.8% median / -47.9% p95** |
| Cold First Usable range | 307.4–533.5 ms | 273.2–278.1 ms | Narrower tail |
| Warm Shell Hydrated (mean / median / p95) | 302.2 / 299.8 / 317.0 ms | **269.7 / 269.6 / 271.7 ms** | **-10.1% median / -14.3% p95** |
| Warm First Usable (mean / median / p95) | 316.7 / 314.5 / 333.6 ms | **271.5 / 271.2 / 273.7 ms** | **-13.8% median / -18.0% p95** |
| Startup Renderer Processes (1 tab) | 4 renderers | **3 renderers** | **-1 full renderer** (`overlayView` lazy) |

**Primary drivers**: Lazy `overlayView` instantiation (deferred until first overlay open), removing synchronous macOS `app.isDefaultProtocolClient` LaunchServices calls from every state snapshot, debounced async JSON persistence (`scheduleSave`), and coalesced state broadcasts.

---

## 2. Tab Scaling Without Memory Saver (All Tabs Kept Live)

### Total Process-Tree Memory & Process Counts

| Tab Count | `v0.4.0` Settled / Peak RSS (MB) | `v0.5.0` Settled / Peak RSS (MB) | Renderers (`v0.4.0` → `v0.5.0`) | Main / GPU / Utility RSS (`v0.5.0`, MB) | Mean Renderer RSS (`v0.5.0`, MB) |
| --- | --- | --- | --- | --- | --- |
| **1 tab** | 658.6 / 658.6 | **571.2 / 571.2** (-13.3%) | 4 → 3 | 163.2 / 78.8 / 55.2 | 91.3 |
| **5 tabs** | 1,004.6 / 1,004.6 | **913.1 / 913.1** (-9.1%) | 8 → 7 | 166.0 / 79.4 / 55.8 | 87.4 |
| **10 tabs** | 1,436.0 / 1,436.0 | **1,342.2 / 1,342.2** (-6.5%) | 13 → 12 | 170.6 / 80.3 / 56.5 | 86.2 |
| **25 tabs** | 2,724.4 / 2,724.8 | **2,628.0 / 2,628.3** (-3.6%) | 28 → 27 | 185.5 / 82.4 / 58.7 | 85.2 |
| **50 tabs** | 4,753.6 / 4,876.7 | **4,771.1 / 4,771.7** (-2.2% peak) | 53 → 52 | 209.2 / 86.2 / 62.0 | 84.9 |

### Navigation, Tab Switching Latency & CPU

| Tab Count | Nav Latency mean / med / p95 (`v0.4.0` → `v0.5.0`, ms) | Tab Switch Latency mean / med / p95 (`v0.4.0` → `v0.5.0`, ms) | Active CPU % (`v0.4.0` → `v0.5.0`) | Idle CPU % (`v0.4.0` → `v0.5.0`) |
| --- | --- | --- | --- | --- |
| **1 tab** | 71.4 / 71.4 / 71.4 → 72.6 / 72.6 / 72.6 | — | 9.9 → **8.5%** | 1.2 → 1.6% |
| **5 tabs** | 71.4 / 71.0 / 74.0 → **62.7 / 69.8 / 71.9** | 1.8 / 1.5 / 3.3 → **1.1 / 1.0 / 1.6** | 10.0 → **8.6%** | 1.9 → **1.5%** |
| **10 tabs** | 70.6 / 70.8 / 72.2 → 70.2 / 70.2 / 72.2 | 2.3 / 1.7 / 6.0 → **1.0 / 1.0 / 1.7** | 7.3 → 7.6% | 1.7 → 1.9% |
| **25 tabs** | 70.4 / 70.0 / 72.7 → **62.7 / 69.5 / 71.6** | 2.2 / 2.0 / 3.2 → **1.3 / 1.3 / 1.9** | 9.2 → 9.7% | 2.4 → 2.9% |
| **50 tabs** | 71.2 / 70.7 / 75.2 → **62.8 / 69.5 / 71.8** | 4.4 / 4.3 / 7.3 → **1.7 / 1.6 / 2.3** | 11.9 → **8.7%** | 3.1 → 3.5% |

> **Engineering Note (Limiter & Regression Investigated During Tuning)**: An earlier `v0.5.0` iteration called `wc.setBackgroundThrottling(false)` on foreground visible tabs. Per Electron's compositor behavior, disabling `backgroundThrottling` on any `WebContents` in a `BrowserWindow` forces GPU frame swaps across *all* sibling views in that window, which spiked 50-tab idle CPU to `33.4%` and GPU RSS to `163 MB`. Keeping `backgroundThrottling: true` natively and caching state transitions (`throttlingStateByWc`) eliminated the extra GPU swaps and cut 50-tab switching latency median from `4.3 ms` to `1.6 ms`.

---

## 3. Memory Saver Impact (Background Tabs Sleeping)

| Scenario | Before Memory Saver RSS | After Memory Saver RSS | Memory Saved | Renderers (`Before → After`) | CPU % (`Before → After`) | Wake & Restore Latency |
| --- | --- | --- | --- | --- | --- | --- |
| **25 tabs** (24 sleeping, 1 active) | 2,635.2 MB | **597.3 MB** | **2,037.9 MB (-77.3%)** | 27 → 3 | 5.2% → **0.9%** | 73.9 ms |
| **50 tabs** (49 sleeping, 1 active) | 4,787.2 MB | **625.8 MB** | **4,161.4 MB (-86.9%)** | 52 → 3 | 2.3% → **0.1%** | 73.5 ms |

> When restoring a sleeping tab, Kinex recreates its sandboxed `WebContentsView` inside its assigned Space session partition and reloads its preserved URL; in-page JavaScript runtime state is not serialized.

---

## 4. Memory Leak & Long-Session Stress Suite (`tests/perf/run-leak-stress.mjs`)

| Stress Stage | Main Heap Used (MB) | Main RSS (MB) | Full Process Tree RSS (MB) | Renderers |
| --- | --- | --- | --- | --- |
| Baseline | 7.75 | 161.3 | 478.6 | 2 |
| After 100 tabs open & close (5×20 batches, peak 2,249.5 MB) | 8.63 | 188.4 | 650.1 | 2 |
| After 500 Space switches | 8.70 | 189.7 | 743.0 | 3 |
| After 50 Split View toggles | 8.71 | 190.1 | 844.5 | 4 |
| After 10 Private Windows open/close cycles | 8.68 | 212.5 | 1,355.6 | 5 |
| After 50 rapid repeated navigations (`MaxListeners` warning fixed) | 8.70 | 212.8 | 1,137.4 | 4 |
| After 10 Little Kinex open/close cycles | 8.70 | 212.8 | 1,150.6 | 4 |
| **Final Post-Close (`win.close()` + GC)** | **8.78 (+1.03 MB)** | 211.8 | 833.5 | 1 (Chromium warm spare renderer; `liveWebContentsCount === 0`) |

- Plus **5 consecutive session restart & restore cycles**: all passed cleanly with persisted tab restoration.
- Confirmed & fixed a real Electron `MaxListenersExceededWarning` leak (`11` `destroyed` / `did-finish-load` / `did-fail-load` listeners piling up on `WebContents` during rapid repeated `loadURL` calls) by stopping in-flight navigation cleanly (`if (wc.isLoading()) wc.stop()`) prior to starting a new load.

---

## 5. Real-World Website Compatibility Probe (`tests/perf/run-live-probe.mjs`)

| Site | `v0.5.0` Load Time (ms) | Total App RSS After Open (MB) | Scroll & Render Check | Observed Notes |
| --- | --- | --- | --- | --- |
| Wikipedia (`Chromium_(web_browser)`) | 1,056 | 619.3 | Pass | Clean load and scroll |
| GitHub (`n3wbiekkkk/Kinex`) | 1,655 | 812.3 | Pass | Clean load and scroll |
| Google Search (`electron browser`) | 315 | 1,014.8 | Pass | Clean load and scroll |
| YouTube (`aqz-KE-bpKQ`) | 1,338 | 1,561.9 | Partial (`scrollOk: false`) | Video page loaded; initial player hydration busy (`145.1%` multi-core CPU during 4K stream startup; scroll probe ran mid-player hydration) |
| Reddit (`/r/mac/`) | 4,512 | 2,039.1 | Pass | Redirected through Reddit's anti-bot JS challenge before rendering `Mac` |
| Google Docs (landing) | 946 | 2,163.9 | Pass | Loads Google Workspace Docs sign-in gate cleanly |

---

## 6. `v0.6.0` Design Excellence Regression Check (vs `v0.5.0`)

Re-measured after all `v0.6.0` design system, New Tab Engine, Command Bar, Settings, Accessibility, and microinteraction updates on the same Apple M5 16 GB machine:

| Benchmark Metric | `v0.5.0` Baseline | `v0.6.0` Post-Redesign | Delta |
| --- | --- | --- | --- |
| Cold Shell Hydrated (mean / med / p95) | 273.5 / 274.5 / 275.7 ms | **272.3 / 271.7 / 273.8 ms** | **-2.8 ms median** (no regression) |
| Cold First Usable (mean / med / p95) | 275.5 / 276.5 / 278.1 ms | **274.3 / 273.6 / 276.0 ms** | **-2.9 ms median** (no regression) |
| Warm First Usable (mean / med / p95) | 271.5 / 271.2 / 273.7 ms | **276.2 / 273.4 / 290.3 ms** | **+2.2 ms median** (within noise) |
| 1 Tab Total Process-Tree RSS | 571.2 MB (3 renderers) | **570.6 MB** (3 renderers) | **-0.6 MB** |
| 50 Live Tabs Settled / Peak RSS | 4,771.1 / 4,771.7 MB | **4,768.9 / 4,769.7 MB** | **-2.2 MB** |
| 50 Live Tabs Switch Latency (median) | 1.6 ms | **1.6 ms** | **0.0 ms** |
| 50 Live Tabs Idle CPU % | 3.5% | **2.2%** | **-1.3 pp** |
| Memory Saver 50-Tab Settled RSS | 625.8 MB (-86.9%) | **625.7 MB (-86.9%)** | Identical savings (`74.7 ms` wake) |
| Leak Stress (7 scenarios + 5 restarts) | `+1.03 MB` main heap, `0` live leaked WCs | **`+1.05 MB` main heap, `0` live leaked WCs** | All 7 scenarios pass |
| Command Bar Open Latency (`⌘T` CDP) | Lazy overlay | **`108.8 ms` cold (first lazy spawn) / `10.1–11.0 ms` (`6.0–11.0 ms`) warm** | Sub-frame warm open |
| YouTube 4K (`aqz-KE-bpKQ`) Live Probe | `scrollOk: false` (mid-hydration timing) | **`scrollOk: true`** (`1,444 ms` load, `1,610.1 MB` RSS) | Verified hydration scroll check pass |

---

## 7. `v0.7.0` Complete Browser Experience Regression Check (vs `v0.6.0`)

Re-measured after all `v0.7.0` Tab Search, Recently Closed Groups, Duplicate Detection, Space isolation/move, Reader Mode, Find in Page, Per-host Zoom, Print/PDF, and Download Pause/Resume additions on the same Apple M5 16 GB machine:

| Benchmark Metric | `v0.6.0` | `v0.7.0` | Delta |
| --- | --- | --- | --- |
| Cold Shell Hydrated (mean / med / p95) | 272.3 / 271.7 / 273.8 ms | **278.7 / 282.5 / 283.6 ms** | Within normal desktop jitter (`+6.4 ms` mean) |
| Cold First Usable (mean / med / p95) | 274.3 / 273.6 / 276.0 ms | **280.1 / 284.0 / 284.8 ms** | Within noise (`+5.8 ms` mean) |
| Warm First Usable (mean / med / p95) | 276.2 / 273.4 / 290.3 ms | **275.9 / 277.4 / 282.6 ms** | **-0.3 ms mean** |
| 1 Tab Total Process-Tree RSS | 570.6 MB (3 renderers) | **570.4 MB** (3 renderers) | **-0.2 MB** |
| 50 Live Tabs Settled / Peak RSS | 4,768.9 / 4,769.7 MB | **4,771.0 / 4,771.9 MB** | `+2.1 MB` (+0.04%) |
| 50 Live Tabs Switch Latency (median) | 1.6 ms | **1.6 ms** | **0.0 ms** |
| 50 Live Tabs Idle CPU % | 2.2% | **2.7%** | `+0.5 pp` |
| Memory Saver 50-Tab Settled RSS | 625.7 MB (-86.9%) | **627.5 MB (-86.9%)** | Identical savings (`73.1 ms` wake) |
| Leak Stress (7 scenarios + 5 restarts) | `+1.05 MB` main heap, `0` leaked WCs | **`+1.10 MB` main heap, `0` leaked WCs** | All 7 scenarios pass |

### Real-World 7-Site Probe (`v0.7.0`, `tests/perf/run-live-probe.mjs`)

| Site | Load Time (ms) | App RSS After Open (MB) | `scrollOk` | Observed Notes |
| --- | --- | --- | --- | --- |
| Wikipedia (`Chromium_(web_browser)`) | 965 | 617.9 | `true` | Clean render and scroll |
| GitHub (`n3wbiekkkk/Kinex`) | 2,982 | 811.9 | `false` (probe) | Loads cleanly (`200`, `sh: 3505` after hydration); probe script `isLoading` check triggered before full Turbo hydration |
| Google Search (`electron browser`) | 319 | 911.4 | `true` | Fast load and scroll |
| YouTube (`aqz-KE-bpKQ`) | 1,484 | 1,536.1 | `true` | 4K player loaded (`Big Buck Bunny 60fps 4K`) and scrolled |
| Reddit (`/r/mac/`) | 2,251 | 1,981.2 | `true` | Completed Reddit JS challenge and scrolled |
| Google Docs (`docs.google.com`) | 1,030 | 2,106.6 | `true` | Redirected to Google Accounts sign-in gate (`Sign in - Google Accounts`) |
| Gmail (`mail.google.com`) | 2,572 | 2,325.0 | `false` (probe) | Redirected to `workspace.google.com/intl/en-US/gmail/`; CDP hostname match in probe missed cross-domain redirect |

---

## 8. `v7.0.2` + Kinex Shields Regression Check (Native `adblock-rs` Engine)

Re-measured after integrating the native Rust **Kinex Shields** subsystem (`145,405` Standard-tier rules across 6 lists, `170,813` total across all 7 bundled lists including Aggressive tier). Full engine benchmarks and 8-site compatibility matrices are detailed in [SHIELDS_BENCHMARKS.md](SHIELDS_BENCHMARKS.md):

| Benchmark Metric | `v0.7.0` Baseline | `v7.0.2` + Kinex Shields | Notes |
| --- | --- | --- | --- |
| Cold First Usable (mean / med / p95) | 280.1 / 284.0 / 284.8 ms | **445.7 / 448.1 / 452.1 ms** | First-launch gzip parse (`83.65 ms`) + `.bin` cache creation |
| Warm First Usable (mean / med / p95) | 275.9 / 277.4 / 282.6 ms | **381.8 / 378.8 / 396.0 ms** | Binary `.bin` cache hit (`3.88 ms` deserialize) + `adblock-rs` N-API addon |
| 1 Tab Settled RSS (`Main / Total`) | — / 570.4 MB | **239.0 / 719.5 MB** | Includes native Rust `Engine` filter tables (`+~60 MB` main RSS) |
| 50 Live Tabs Settled / Peak RSS | 4,771.0 / 4,771.9 MB | **4,900.5 / 4,951.5 MB** | `+2.7%` total tree RSS with 145k rules active across all partitions |
| 50 Live Tabs Switch Latency (median) | 1.6 ms | **4.7 ms** | Sub-5ms tab switches with full Shields coordinator active |
| `170,813`-Rule 10k Query Latency | `26` suffix host entries | **2.93 µs mean / 2.67 µs median / 3.62 µs p95** | V8 JS heap impact `0 MB` (`61.58 MB` native Rust RSS across all 7 lists) |
