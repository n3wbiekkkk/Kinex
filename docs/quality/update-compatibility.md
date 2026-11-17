# Releases and update compatibility

Kinex 0.7.7 is a pre-production preview. The owner prefers free distribution without Apple Developer membership. Version 1.0.0 remains reserved for production.

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
