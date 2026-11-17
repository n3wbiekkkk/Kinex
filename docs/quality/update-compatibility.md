# Releases and update compatibility

Kinex 0.7.12 is a pre-production preview. The owner prefers free distribution without Apple Developer membership. Version 1.0.0 remains reserved for production.

## Free preview Releases

GitHub Releases do not require Apple signing credentials. After successful main-push CI, the release workflow checks out the tested SHA, verifies it again, builds an Apple Silicon DMG and ZIP, verifies the DMG, and launches its actual mounted app with disposable data. Each delivery push gets a new patch version under [the repository rules](../../AGENTS.md).

Without signing credentials, 0.x releases publish as explicitly unsigned, not-notarized manual downloads. Download the DMG or ZIP from the [Latest Release](https://github.com/n3wbiekkkk/Kinex/releases/latest). Gatekeeper may block downloaded unsigned applications; local package startup does not establish acceptance of a quarantined download. No protection bypass is included.

The workflow does not upload latest-mac.yml or blockmaps for unsigned previews. Downloading a release and installing an automatic signed update are different capabilities. Existing signed installations cannot be promised automatic replacement with an unsigned preview; they require a separate manual installation or a compatible signed update.

Complete signing/notarization credentials select signed packaging. Missing credentials must not block unsigned 0.x previews; they still block production releases. See [build/signing procedures](build-and-signing.md).

## Signed automatic installation

Older clients read https://github.com/n3wbiekkkk/Kinex/releases/latest/download/latest-mac.yml. Signed releases retain that endpoint. GitHub Latest excludes releases marked prerelease, so the workflow uses Latest without the prerelease flag; 0.x remains a preview by version and documentation. An unsigned Latest intentionally has no automatic-installation manifest, so an older automatic client may report an unavailable feed. Use the release page for its manual download.

The actual electron-updater comparator was previously exercised with current version 0.7.0 and candidate 0.7.3; it accepts that upgrade and the future 1.0.0 upgrade. The OS compatibility check remains active and automatic downgrades remain disabled. The new 0.x client rejects obsolete misnumbered 7.0.1, 7.0.2 and 7.0.3 candidates. This guard cannot modify already installed older executables.

The inspected old local 0.7.0 executable had a Developer ID signature and the local new package was ad-hoc signed. No matching signing identity was found locally, and the inspected repository/release secret-name lists were empty. Signed installation remains **BLOCKED** by credentials. Signature checks have not been disabled.

For a future signed update, use the publisher identity compatible with the old app, notarize and verify the package, then exercise detection, download, signature verification, installation, relaunch, and state preservation using disposable old-client copies. This has not been verified successfully.

References: [Electron autoUpdater](https://www.electronjs.org/docs/latest/api/auto-updater) and [Electron code signing](https://www.electronjs.org/docs/latest/tutorial/code-signing).

## Publication safety and evidence

Explicit version-tag pushes remain supported and must match package.json. The workflow rejects version tags owned by another commit, serializes releases, skips stale commits, uploads complete assets as a draft before exposing Latest, and preserves published assets on reruns.

The 0.7.5 local evidence recorded typecheck, compiler lint, production build, 105 tests, and actionlint 1.7.12 passing. Its later CI run failed at fullscreen after eight experience groups; the unbounded page API promise outlasted the process timeout. These failures are not reclassified as passes. The corrected harness requests transitions without awaiting page API promises over IPC, waits for real native/DOM fullscreen state, and explicitly restores focus after private-window closure. Its first local execution exposed DOM exit occurring after the native event; the bounded predicate now waits for both states.

The release-mode regression failed before the fix because a credential-free 0.x preview returned exit 1. Tests now cover unsigned preview publication, production credential enforcement, complete-credential signed selection, DMG inclusion, and signed-only update metadata. Real DMG and updated CI outcomes must be recorded after execution; offline publication tests replace only the external GitHub command and do not establish live publication or signed installation.


### Local 0.7.6 results

Typecheck, compiler lint, production build, 110 tests across 20 files, and actionlint passed. The corrected experience integration passed all ten groups locally. Unsigned arm64 packaging produced `Kinex-0.7.6-arm64.dmg` and `Kinex-0.7.6-arm64-mac.zip`. The DMG checksum verification, read-only mount, and mounted application smoke test passed: version 0.7.6, arm64 executable/addon, 145405 real Shields rules, sandboxed navigation, and shutdown persistence. Evidence remains in `artifacts/ci/dmg.json` locally; CI retains the equivalent artifact.

These local results do not establish completed GitHub CI/publication, Gatekeeper acceptance of an internet download, or signed automatic installation. hdiutil on the local OS emitted a detach deprecation warning but unmounted the image successfully.


### Subsequent CI and release verification

The 0.7.6 main CI passed every gate, including mounted DMG startup (run 44031436005). Release run 44032071242 then failed its separate E2E verification during private-window operations with `CDP WebSocket error`; no 0.7.6 release was published by that workflow.

The private header's close IPC destroys the requesting WebContents. The E2E driver previously required a reply from that destroyed sender. Version 0.7.7 accepts only the specific CDP transport-closure errors at this intentional close operation, then independently requires both private header and private page targets to disappear. All other errors and cookie/storage/IPC isolation assertions remain active. Additional checkpoints distinguish storage verification from intentional closure; other private-target transport failures must still fail verification.


A controlled real-Electron regression kept the private close RPC pending until renderer destruction. The old driver failed with `CDP WebSocket error`; the fixed E2E suite passed the same forced-close condition and retains that condition in its normal run. Local normal E2E, 110 tests, production build, actionlint, and mounted 0.7.7 DMG startup passed. The 0.7.7 image again loaded 145405 real Shields rules. Signing/Gatekeeper acceptance remains unverified; updated remote CI and Release results must be inspected independently.


### Native fullscreen transition ordering

The 0.7.7 CI passed the repaired private-close E2E but failed waiting for fullscreen exit in experience integration (run 44033764785). A local real-Electron probe disproved the premise that DOM fullscreen/layout readiness means native macOS entry is complete: it recorded `nativeEntered=false` and `win.isFullScreen()=false` at DOM readiness. A second probe waited for the real `enter-full-screen` event and recorded both true, then completed the suite. This matches [Electron's documented asynchronous macOS fullscreen contract](https://www.electronjs.org/docs/latest/api/browser-window#winsetfullscreenflag).

The 0.7.8 regression now observes native enter/leave events before issuing the opposite operation and retains all native bounds, DOM, shell visibility, and existing timeout assertions. Previous failed runs remain failed evidence; this is not a retry-to-green policy.


Local 0.7.8 validation passed all ten experience groups with native enter/leave assertions, 110 unit/regression tests, production compilation, and DMG verification with real mounted-app startup and Shields initialization. The same arm64 DMG/ZIP targets are retained. Remote CI and publication are separate pending qualifications.


### 0.7.9 downloaded-app signature defect

The user's downloaded 0.7.8 DMG was mounted at `/Volumes/Kinex 0.7.8-arm64`. Both that application and the local package failed `codesign --verify --deep --strict` with `code has no resources but signature indicates they must be present`. syspolicy_check classified it as a fatal Codesign Error. The existing startup smoke test had not checked bundle integrity. No installed application or real browsing data was modified during diagnosis.

The new packaged integrity gate reproduced that failure before the packaging fix. Explicit ad-hoc signing sealed the bundle, but the first strict-profile probe then failed loading Electron Framework because ad-hoc code has no matching Apple Team ID. A dedicated preview entitlement profile adds the documented library-validation exception while retaining hardened runtime. The production profile remains unchanged. The corrected 0.7.9 image passes strict deep codesign verification, has identifier com.kinex.browser and the runtime flag, and launches the real mounted app with 145405 Shields rules and sandboxed navigation. Typecheck, lint, 112 tests, actionlint, and entitlement plist validation passed locally.

syspolicy_check no longer reports the damaged resource seal, but still reports an ad-hoc publisher and missing notarization ticket; spctl still rejects distribution. Thus default Gatekeeper acceptance is not claimed. No quarantine flags were removed and no system security policy was changed. Use the corrected archive rather than overriding an invalid signature in 0.7.8. A user who elects to trust an intact, unnotarized app can follow Apple's per-app approval procedure; that approval remains a user decision, not an automatic release or test action.


### 0.7.12 update check and fallback for unsigned 0.x previews

In 0.7.9 through 0.7.11, `Settings -> Updates & About` exposed the update feed URL/folder text input and reported `No release manifest (latest-mac.yml) published at this update feed yet` whenever `latest-mac.yml` returned HTTP 404 on unsigned 0.x preview releases.

Version 0.7.12 removes the update feed URL/folder controls from `SettingsView.tsx` and resolves the latest GitHub Release (`api.github.com/repos/n3wbiekkkk/Kinex/releases/latest`, with `HEAD /releases/latest` redirect fallback) when `latest-mac.yml` is absent on the GitHub feed. If the installed version is current or the remote tag is an incompatible legacy 7.0.x build, the updater reports `up-to-date`. If a newer compatible version is available, the updater downloads the release archive over HTTPS, verifies its SHA-256 digest (and `hdiutil verify` for `.dmg` images), reports `downloaded`, and opens the verified installer via `shell.openPath` on `Restart & Update` before quitting. Signed automatic replacement via `Squirrel.Mac` remains gated on Developer ID credentials.


### 0.7.17 extension preview publication

- Source: `main` push `df88d5e` (0.7.17).
- CI: run `44097276096` passed on that SHA, including unit/boundary, real-Electron integration/security, E2E, keyboard/experience, packaged-app launch and DMG mount checks.
- Publication: run `44098361502` passed. `v0.7.17` is Latest and carries `Kinex-0.7.17-arm64.dmg` (sha256 `c8d0124b42f7614ba8b36b3baf53df82935028d77e8b0d91b18b36eef7362464`) and `Kinex-0.7.17-arm64-mac.zip` (sha256 `358d4f3d1dd640b90379dc7ed29c099890491cd53b75e037d3d06d057212b58a`).
- Installed-update validation: **not proven**. No Developer ID secrets are configured, so publication produced an ad-hoc sealed manual preview with no signed auto-installation and no `latest-mac.yml`. DMG verification and mounted-app launch passed in CI with disposable data; Gatekeeper acceptance and signed auto-installation remain unverified.
- Extension scope: unpacked local MV3 folders, per-Profile partition, explicit permission review, `allowFileAccess: false`, no `.crx`/Web Store, and no `chrome.action` badge/command shim. Electron's extension API is a limited DevTools-oriented subset, so full Chrome extension compatibility is not claimed.
