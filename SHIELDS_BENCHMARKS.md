# Kinex Shields Engine & Compatibility Benchmarks

> **No-AI Policy**: Kinex Shields uses deterministic native Rust filter evaluation (`adblock-rs`), Public Suffix List host parsing (`tldts`), and local isolated-world DOM matching. Zero AI models, heuristics services, or remote telemetry APIs are used.

---

## 1. Test Hardware & Environment

- **Machine**: Apple M5 (`arm64`), 10 CPU cores, 16 GB RAM
- **OS**: macOS (`Darwin 27.2.0`)
- **Runtime**: Electron `36.9.5` (Chromium `136`), Node `v24.22.3`, Rust `1.98.1`
- **Native Engine Binding**: `adblock-rs@0.13.5` (`napi-1` Mach-O `arm64`, built to `node_modules/adblock-rs/js/index.node`, `4.3 MB`)

---

## 2. Engine Evaluation: `adblock-rs` vs `@ghostery/adblocker` (Phase 1)

Both candidate engines were evaluated directly inside Electron `36.9.5` (`arm64`) on an identical `139,607` non-comment EasyList + EasyPrivacy + uBlock Origin ruleset across `10,000` URL classification queries:

| Metric | `adblock-rs` (Fast) | `adblock-rs` (Source Index Enabled) | `@ghostery/adblocker@2.20.3` |
| --- | --- | --- | --- |
| Parse & Compile | `56.29 ms` | `61.16 ms` | `196.80 ms` |
| Serialize Size | `6.07 MB` | `10.61 MB` | `5.25 MB` |
| Warm Deserialize Latency | `1.13 ms` | `1.83 ms` | `11.39 ms` |
| Match 10k Mean / p95 | `2.11 µs` / `2.62 µs` | `2.87 µs` / `3.46 µs` | `3.24 µs` / `4.62 µs` |
| Process RSS Delta | `+36.25 MB` | `+50.31 MB` | `+147.28 MB` |
| V8 JS Heap Delta | `0 MB` (`-6 MB`) | Native Rust heap | `+56.39 MB` |

**Selection**: Kinex chose **`adblock-rs`** (`MPL-2.0`) with `FilterSet(true)` source attribution enabled for accurate per-list UI reporting in Kinex Shields (`EasyList`, `EasyPrivacy`, `uBlock Origin Filters`, etc.), keeping V8 JS heap free of large rule tables and achieving `~3.2x` faster parse and `~6.2x` faster warm deserialization than `@ghostery/adblocker`.

---

## 3. Rule Scaling Micro-Benchmark (`10k` → `170,813` Bundled Rules)

Measured via `node tests/perf/run-shields-benchmark.mjs` against all 7 bundled gzipped filter lists (`170,813` non-comment lines across `standard` + `aggressive` tiers):

| Configuration | Active Rules | Parse Time | Warm Deser | Serialized Size | RSS Delta | 10k Query Total | Mean / Median / p95 Match |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Legacy Suffix Set (`adblock.ts` removed) | `26` | `0.00 ms` | `0.00 ms` | `0.00 MB` | Baseline | `8.18 ms` | `0.82 / 0.33 / 0.58 µs` |
| `adblock-rs` Subset (`10k`) | `10,000` | `4.00 ms` | `0.11 ms` | `0.57 MB` | `+2.44 MB` | `18.80 ms` | `1.88 / 1.71 / 2.33 µs` |
| `adblock-rs` Subset (`50k`) | `50,000` | `13.96 ms` | `0.64 ms` | `3.49 MB` | `+19.05 MB` | `19.92 ms` | `1.99 / 1.79 / 2.38 µs` |
| `adblock-rs` Subset (`100k`) | `100,000` | `34.00 ms` | `1.38 ms` | `7.24 MB` | `+40.70 MB` | `26.44 ms` | `2.64 / 2.42 / 3.00 µs` |
| **All 7 Bundled Lists** | **`170,813`** | **`62.60 ms`** | **`2.65 ms`** | **`12.32 MB`** | **`+61.58 MB`** | **`29.32 ms`** | **`2.93 / 2.67 / 3.62 µs`** |

### Main-Process Warm Cache Optimization (`Standard` Tier `145,405` Rules)

Measured in Electron (`ELECTRON_RUN_AS_NODE=1`) constructing `KinexShieldsEngine` cleanly:

- **Cold Engine Build** (gunzip 6 `Standard`-tier lists + parse + write `.bin` & `.counts.json`): **`83.65 ms`**
- **Warm Engine Deserialize** (mmap/read cached `.bin` + `.counts.json`): **`3.88 ms`** (**~21.6x faster**)

---

## 4. Browser Application Impact (`v0.7.0` Baseline vs `v7.0.1 + Kinex Shields`)

Measured with `npm run bench` (`tests/perf/run-benchmarks.mjs`, 5 cold launches + 5 warm launches + 1/5/10/25/50 local multi-origin tabs):

| Benchmark Metric | `v0.7.0` (Pre-Shields) | `v7.0.1` + Kinex Shields | Notes |
| --- | --- | --- | --- |
| Cold Shell Hydrated (mean / med / p95) | `278.7 / 282.5 / 283.6 ms` | `443.3 / 445.2 / 449.7 ms` | Deferred `setImmediate` first-ever compile of `145,405` rules |
| Cold First Usable (mean / med / p95) | `280.1 / 284.0 / 284.8 ms` | `445.7 / 448.1 / 452.1 ms` | One-time per fresh profile before `.bin` cache exists |
| Warm First Usable (mean / med / p95) | `275.9 / 277.4 / 282.6 ms` | `381.8 / 378.8 / 396.0 ms` | `.bin` warm cache hit (`3.88 ms` init) + native addon + `webRequest` setup |
| **1 Tab** Settled RSS (`Main / Total`) | `— / 570.4 MB` | `239.0 / 719.5 MB` | Includes Rust `Engine` filter tables (`+~60 MB` main RSS) |
| **5 Tabs** Settled RSS / Median Switch | `—` | `1,112.8 MB` / `4.6 ms` | Nav median `72.5 ms`, idle CPU `2.4%` |
| **10 Tabs** Settled RSS / Median Switch | `—` | `1,591.5 MB` / `2.2 ms` | Nav median `72.7 ms`, idle CPU `3.1%` |
| **25 Tabs** Settled RSS / Median Switch | `—` | `2,984.7 MB` / `2.7 ms` | Nav median `72.5 ms`, idle CPU `3.2%` |
| **50 Tabs** Settled / Peak RSS | `4,771.0 / 4,771.9 MB` | `4,900.5 / 4,951.5 MB` | Median switch `4.7 ms`, idle CPU `5.5%` |

---

## 5. Real-World 8-Website Compatibility Matrix

Measured cleanly across an isolated profile (`tests/perf/run-shields-compatibility.mjs`) comparing `disabled`, `standard`, and `aggressive` modes on live public URLs:

| Website | `Disabled` (Time / Req Blocked) | `Standard` (Time / Ads / Trackers / Total) | `Aggressive` (Time / Ads / Trackers / Total) | Observed Compatibility |
| --- | --- | --- | --- | --- |
| **YouTube** (`aqz-KE-bpKQ`) | `2,405 ms` / `0` | `1,870 ms` / `5` / `4` / `15` | `1,880 ms` / `5` / `6` / `17` | Player loaded (`Big Buck Bunny 60fps 4K`, `media: 1`, `scrollHeight: 2538`) |
| **Twitch** (`twitch.tv`) | `1,869 ms` / `0` | `3,807 ms` / `6` / `4` / `10` | `4,085 ms` / `6` / `4` / `10` | Rendered (`media: 1`, `imgs: 36`) |
| **Reddit** (`reddit.com/r/mac/`) | `3,147 ms` / `0` (`isChallenge: true`) | `1,970 ms` / `2` / `7` / `9` | `1,948 ms` / `2` / `7` / `9` | Rendered cleanly in Standard/Aggressive (`scrollHeight: 1417`, `imgs: 31–32`); Disabled hit transient JS challenge (`scrollHeight: 860`) |
| **GitHub** (`n3wbiekkkk/Kinex`) | `2,409 ms` / `0` | `1,233 ms` / `0` / `3` / `3` | `1,329 ms` / `0` / `4` / `4` | Full render (`textLen: 12720`, `scrollHeight: 6021`) |
| **Google Search** (`electron browser`) | `1,128 ms` / `0` | `1,845 ms` / `1` / `7` / `8` | `1,660 ms` / `3` / `8` / `11` | Search results rendered (`textLen: 3491–4021`, `scrollHeight: 2195–2874`) |
| **Gmail** (`mail.google.com`) | `3,891 ms` / `0` | `1,756 ms` / `0` / `2` / `2` | `1,652 ms` / `0` / `2` / `2` | Workspace Gmail landing rendered (`textLen: 3507`, `scrollHeight: 6734`) |
| **Google Docs** (`docs.google.com`) | `1,661 ms` / `0` | `1,536 ms` / `0` / `1` / `1` | `1,521 ms` / `0` / `1` / `1` | Reached `accounts.google.com` sign-in wall cleanly in all 3 modes (`isAuthWall: true`) |
| **Wikipedia** (`Ad_blocking`) | `1,519 ms` / `0` | `1,121 ms` / `0` / `1` / `1` | `1,119 ms` / `0` / `1` / `1` | Full article intact (`textLen: 47583`, `scrollHeight: 12477`) |

---

## 6. Bundled Filter Lists & Upstream Licenses

All 7 default lists ship pre-compressed inside `resources/filters/` (`~1.64 MB` total) for offline first-launch readiness and safe rollback:

| List ID | Name | Tier | Gzipped Size | Upstream License |
| --- | --- | --- | --- | --- |
| `easylist` | EasyList | Standard | `694 KB` | `GPL-3.0+ / CC BY-SA 3.0+` |
| `easyprivacy` | EasyPrivacy | Standard | `440 KB` | `GPL-3.0+ / CC BY-SA 3.0+` |
| `ublock-filters` | uBlock Origin Filters | Standard | `114 KB` | `GPL-3.0` |
| `ublock-privacy` | uBlock Origin Privacy | Standard | `48 KB` | `GPL-3.0` |
| `ublock-quickfixes` | uBlock Quick Fixes | Standard | `21 KB` | `GPL-3.0` |
| `peter-lowe` | Peter Lowe's Ad & Tracking Servers | Standard | `23 KB` | Permissive attribution |
| `fanboy-cookies` | Fanboy Cookie & Annoyance Notices | Aggressive | `301 KB` | `GPL-3.0+ / CC BY-SA 3.0+` |

---

## 7. Honest Protection Scope & Known Limitations

### Fully Supported
- **Network Blocking & Resource Typing**: Single `webRequest.onBeforeRequest` coordinator per Electron session (regular Spaces, partitioned profiles, isolated Private Windows, Little Kinex, popups) using PSL eTLD+1 (`tldts`) 1p/3p origin resolution and request deduplication.
- **Filter List Management**: Offline bundled defaults + HTTPS-only manual/periodic updates validated for size (`<= 12 MB`), non-HTML/non-null text content, line length caps, and atomic replacement with automatic rollback.
- **Cosmetic Hiding & Element Picker**: Author-origin `insertCSS` + serialized per-`WebContents` CSS key tracking (`removeInsertedCSS` works immediately without page reload), isolated-world `99` `MutationObserver` + post-hydration sweeps (`250 ms` / `900 ms`), procedural selectors (`:has-text`, `:has`, `:upward`, etc.), and hover/keyboard Element Picker (`inspect`/`select`/save/delete).
- **Precedence & Privacy Isolation**: Exact host override > registrable eTLD+1 domain > global default (`standard` / `aggressive` / `disabled`), tracking URL query parameter stripping, and Private Window hostname redaction (`[Private request blocked]`).

### Partially Supported
- **Scriptlet Injection**: Enforces strict local allowlisting over 8 vetted scriptlet families (`nobab.js`, `abort-on-property-read.js`, `abort-on-property-write.js`, `set-constant.js`, `no-setTimeout-if.js`, `no-setInterval-if.js`, `nowebrtc.js`, `no-fetch-if.js`) and common redirect stubs (`noopjs`, `noopcss`, `nooptext`, `noopjson`, `noop-vmap.xml`, `1x1.gif`, `2x2.png`, GA/GPT shims). Specialized upstream uBO scriptlets outside this vetted set are intentionally skipped rather than executing arbitrary unvetted strings.
- **Dynamic Streaming DAI / SSAI Ads**: Client-side request rules and cosmetic overlays apply on streaming sites, while server-stitched dynamic ad insertion (same-origin video segment SSAI) cannot be separated purely at `webRequest` URL inspection.

### Unsupported
- **DNS-Level CNAME Cloaking Resolution**: Electron's `webRequest` API exposes destination URLs and resource types without OS/DoH CNAME chains. Performing side-channel DNS lookups per subresource would introduce latency and privacy leakage, so first-party CNAME-cloaked trackers are not uncloaked today.
- **Per-Request Header Cookie Strip / Custom Chromium `net::` C++ Hooks**: Kinex preserves stock Electron 36 Chromium builds without custom C++ Chromium patches.
