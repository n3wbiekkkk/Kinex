# Kinex engineering handoff

## Default delivery rules

The owner requests implementation, verification, and a push after every completed task. This supersedes the original overhaul prompt's local-only/no-commit/no-push restrictions. Ordinary fixes do not need another confirmation. The owner also authorizes the signed update publication pipeline described below.

1. Inspect `git status`, the affected implementation, callers, and existing tests. Preserve unrelated work, including untracked `.perch/` and `artifacts/ci/`.
2. Implement the smallest complete fix. Add a meaningful regression test for each meaningful bug fix. Preserve security checks and existing behavior; investigate failing tests instead of weakening assertions.
3. Before each delivery push to `main`, allocate a new patch version with `npm version patch --no-git-tag-version`; keep package.json and package-lock.json synchronized. If the owner specifies an unused version explicitly, use that version instead. A rerun of the same commit keeps its version. Update the current README version and CHANGELOG.
4. Run the relevant checks from package.json, review `git diff --check` and the complete diff, then commit only the task's files and push. Never force-push, amend another person's work, move existing release tags, or discard user changes. If credentials/network/verification block delivery, retain the work and report the exact blocker.
5. Inspect GitHub CI for the pushed SHA. Report source push, CI, publication, and installed-update validation separately. Record new evidence and remaining blockers in the appropriate linked document below. A push alone does not prove an installable update exists.

The current line is **0.7.x preview**. **1.0.0 is reserved for production** and requires explicit owner direction. Obsolete 7.0.x numbering must not be revived. Future explicit user instructions override these defaults.

## Update contract

- Each completed push to `main` must have a new version so the existing Update button can detect an upgrade. Commits collected into one push receive one version. Feature branches and PRs validate code but do not publish updates.
- `.github/workflows/ci.yml` verifies the source and unsigned arm64 package. `.github/workflows/release.yml` starts after successful main-push CI, checks out that exact SHA, verifies again, signs/notarizes, smoke-tests, and publishes. Explicit version-tag pushes remain supported and undergo verification too.
- Keep publication restricted to trusted repository main-push runs and version tags. Preserve pinned actions, limited token permissions, credential-free checkout, and release serialization. A stale run must not replace the newer main update feed. Prepare assets as a draft before making the release Latest; published artifacts are immutable.
- Preserve the legacy HTTPS feed `/releases/latest/download/latest-mac.yml`. GitHub Latest excludes prereleases, so 0.x previews use Latest without the GitHub prerelease flag. Their version and documentation still identify them as previews.
- Every distributed macOS update, including 0.x, requires Developer ID signing compatible with the old installed app and notarization. Keep signature, OS, HTTPS, and downgrade protections enabled. Local unsigned packaging is a test artifact.
- Missing credentials are a release blocker, not a reason to publish unsigned updates. Configure `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID` through trusted repository or `release` environment secrets. Never request secret values in chat or commit them.
- For feed changes, old-client qualification, signing setup, or publication failures, read [update compatibility](docs/quality/update-compatibility.md) and [build/signing procedures](docs/quality/build-and-signing.md) before editing.

## Security and product invariants

- Treat every website and IPC payload as hostile. Keep privileged UI/preloads separate from website WebContents. Require sandboxing, context isolation, web security, and disabled Node integration (including workers/subframes) for websites. Expose only narrowly typed preload APIs.
- Validate IPC sender, main frame, role, exact internal URL, payload, and permissions at the boundary. Protect paths against traversal and symlink escapes. Avoid arbitrary process, filesystem, or external-protocol access from websites.
- Apply navigation policy by context; validate external application handoffs and window.open. Keep legitimate same-origin blob previews working. Never disable TLS or Electron protections for compatibility.
- Deny sensitive permissions until explicit consent; scope grants and revocation to origin/profile/capability. Keep camera and microphone distinct. Invalidate prompts on navigation/destruction; respect macOS consent.
- Isolate profile sessions and private browsing, including permissions, popups, storage, service workers, and caches. Private state must not enter persistent session recovery or logs. Develop with disposable test profiles, never real browsing data.
- Keep internal CSP strict without imposing it on external websites. Preserve atomic state writes, corruption recovery, schema compatibility, and shutdown cleanup.
- Preserve Spaces, Profiles, Split View, Reader Mode, Kinex Shields, Memory Saver, keyboard-first interaction, accessibility/reduced motion, visual identity, and smooth animation. Avoid unrelated features, AI, unnecessary dependencies, and rewrites.
- Keep expensive Shields parsing and other avoidable blocking work off Main. Filtering failures must remain visible and contained. Preserve per-site exceptions, native engine verification, cleanup, and cross-profile boundaries.
- Optimize only against reproducible measurements; retain failures and environment differences. Never claim a feature, website login, DRM, packaging, or installation works without executing the corresponding check. Never hide failing/skipped tests or replace real engine tests with mocks.

## Navigation and verification

Main/window/tab/session behavior lives in `src/main/`; site filtering in `src/main/shields/`; privileged bridges in `src/preload/`; typed contracts in `src/shared/`; UI in `src/renderer/`. Read package.json for the authoritative scripts, versions, packaging, and dependencies.

- For TypeScript/application changes, run typecheck, lint, unit tests, and production build, plus the affected real Electron suites. For IPC/navigation/permissions/private state/updater boundaries, run `test:security`; for Shields, run native, real Shields integration, and cold-start checks. For tabs/focus/shortcuts, run E2E, keyboard, and experience checks. For packaging changes, launch the actual packaged app with disposable data.
- Native validation needs an Apple Silicon Mac, Node 24, Rust/Cargo, and Xcode tools. `npm ci` builds adblock-rs; `npx --no-install install-electron` downloads the pinned runtime. Treat native compilation/loader failures separately from assertion failures.
- Read [test procedures](docs/quality/testing.md) when selecting or changing checks; [security architecture](docs/security-architecture.md) for trust-boundary changes; [compatibility matrix](docs/quality/compatibility-matrix.md) for website/media claims; [performance evidence](docs/quality/performance-v7.0.3.md) and [BENCHMARKS.md](BENCHMARKS.md) before performance claims.

## Recorded state and open gates

The overhaul migrated Electron 36 to pinned Electron 45 and hardened permissions, IPC, navigation, persistence, downloads, Shields, and shutdown. The original implementation/evidence retains its historical 7.0.3 filename: [engineering report](docs/quality/v7.0.3-report.md), [decisions](docs/quality/v7.0.3-decisions.tsv). Preserve historical results; append new evidence instead of retroactively changing failed checks into passes.

At this handoff, repository and release-environment signing-secret name lists were empty. The local old 0.7.0 executable had a Developer ID signature; the local new package was ad-hoc signed. Signed installation is **BLOCKED**, irrespective of green source CI. The last inspected public Latest was the obsolete v7.0.2; recheck the live feed before asserting publication.

Authenticated website/MFA flows, protected playback/DRM, signed hardware permission flows, and old-client signed installation remain unverified. The compatibility matrix gives individual results; the historical report retains the combined-suite native-focus failure. Current commit/CI state is obtained from Git/GitHub rather than cached here.
