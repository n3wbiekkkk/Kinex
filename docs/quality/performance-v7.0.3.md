# Kinex 7.0.3 performance evidence

Apple M5 arm64, 10 cores, 16 GB RAM; macOS 27.2.1. Host Node 24.15.0. Runtime changed from Electron 36.9.5 to 45.3.3. Full source measurements are retained in artifacts/v7.0.3.

## Startup and memory

Startup has five fresh-profile cold and five initialized-profile warm samples per version. Baseline and final application runs were sequential, not alternating. Timing ranges overlap. Overall startup improvement is inconclusive; no speedup claim is made. Scaling has one observation per tab count and cannot establish statistical significance. RSS sums shared pages across the process tree.

| Metric | Baseline | Final |
| --- | ---: | ---: |
| Cold first usable, median ms | 404.3 | 394 |
| Warm first usable, median ms | 362.3 | 362 |
| 1 tabs, settled process-tree RSS MB | 707.8 | 805.7 |
| 10 tabs, settled process-tree RSS MB | 1569.7 | 1651.1 |
| 50 tabs, settled process-tree RSS MB | 4898.9 | 5319.5 |

The observed 50-tab memory increase is about 8.6%. This is a runtime comparison, not an isolated code-change attribution. Chromium isolation, sandboxing, and browser features remain enabled. Idle CPU uses ps rolling averages and is not a steady-state CPU guarantee.

## Shields initialization

The rerunnable startup check uses five alternating fresh Electron processes per method. Every measured run initializes 145,405 real rules and blocks the tracker fixture. There are zero reported failures. It measures native filter compilation and a 1 ms Main timer, not window startup.

| Median and range, ms | Synchronous | Worker |
| --- | ---: | ---: |
| Maximum Main timer gap | 84.94 (83.84–85.84) | 8.72 (8.23–9.43) |
| Protection ready | 84.87 (83.76–85.75) | 106.03 (105.32–107.34) |

Worker initialization substantially reduces the measured Main stall while taking longer to become ready. Intercepted initial requests wait during that interval. Warm loading still validates and deserializes the native cache. Existing cache metadata rebuilds once. Filter-setting changes and some update rebuilds remain synchronous; this release does not claim all Main stalls are eliminated.

## Other observations

- Memory Saver reduced the 50-tab process tree from 5455.2 MB to 896.7 MB, with 49 tabs sleeping and 76.9 ms wake restoration in one run.
- Local interaction-to-paint medians were 16.7 ms for six tab switches, 16.7 ms for six Space switches, and 19.3 ms for five warm Command Bar openings. These are one-process observations.
- The interaction measurement recorded a maximum Main timer gap of 109.7 ms including startup/window work. Main responsiveness is improved for filter compilation, not universally bounded.
- The overlay frame observer reported no intervals above 25 ms in its sampled close transitions. It attaches after the opening paint and does not prove every animation is smooth.
- Leak stress passed all seven scenarios and five restart cycles. Final live WebContents count was zero, with about 1.2 MB Main heap growth. Chromium retained processes; zero live contents does not prove zero RSS retention.
- Build output records Vite stage timings. Historical and final build observations differ in tooling and cache state and are not a controlled build-speed comparison.

## Reproduce

Run after npm run build:

```sh
node tests/perf/run-benchmarks.mjs --out=artifacts/performance.json
node tests/perf/run-memory-saver-bench.mjs --out=artifacts/memory-saver.json
node tests/perf/experience-metrics.cjs --out=artifacts/metrics
node tests/perf/run-shields-initialization.mjs
node tests/perf/run-leak-stress.mjs
```

Raw evidence: [baseline](../../artifacts/v7.0.3/baseline-performance.json), [final](../../artifacts/v7.0.3/final-performance.json), [Shields](../../artifacts/v7.0.3/shields-init-after.json), [interaction](../../artifacts/v7.0.3/metrics/experience-metrics.json), and [leak stress](../../artifacts/v7.0.3/leak.txt). Historical BENCHMARKS.md and SHIELDS_BENCHMARKS.md remain historical.
