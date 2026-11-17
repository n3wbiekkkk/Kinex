# Build and sign Kinex for macOS

These instructions build the version declared in package.json locally. Signing and distribution are separate from compilation and unsigned package validation. Do not disable Gatekeeper, remove quarantine attributes, or disable Electron security settings to make a build pass.

## Prepare the development environment

Use an Apple Silicon Mac with Node 24, npm, Rust/Cargo, and Xcode command-line tools. CI uses Node 24 and verifies the `arm64` architecture. `package.json` declares additional compatible Node ranges, but Node 24 is the validation path for this release.

Check the toolchain:

```sh
node --version
npm --version
uname -m
xcode-select -p
rustc --version
cargo --version
```

Kinex pins Electron `45.3.3`. The observed runtime reports Chromium `156.0.8078.100` and embedded Node `24.22.3`. The Node executable used to build the repository is separate from Electron's embedded Node runtime.

The package declares macOS `13.0` as its minimum version. The recorded local execution used Apple Silicon on Darwin `27.2.0`; it does not establish testing on macOS 13 or Intel hardware.

## Install and build

Install exactly the locked JavaScript dependencies and download the pinned Electron binary:

```sh
npm ci
npx --no-install install-electron
npm run typecheck
npm run lint
npm run build
```

`adblock-rs` builds its Rust N-API addon during its dependency `postinstall`. Keep dependency install scripts enabled for a complete native installation. Rust crates, npm packages, and the Electron binary require network access unless already cached. The Electron 45 package exposes `install-electron` for explicit binary installation; do not assume a JavaScript-only install includes the application binary.

The production build compiles main, preload, and shared TypeScript to `dist-electron`, typechecks the renderer, and creates the Vite renderer bundle in `dist`. `vite.config.mts` keeps the Vite configuration explicitly ESM.

Run [the automated checks](testing.md) before packaging. A native compiler or loader failure is not an ordinary unit assertion failure.

## Recover a native build failure

After installing the missing Rust or Xcode prerequisite, rebuild only the existing addon and rerun its checks:

```sh
npm run build:native
npm run test:native
npm run test:shields
npm run test:shields-startup
```

The expected addon is `node_modules/adblock-rs/js/index.node`. Inspect its architecture when diagnosing a loader failure:

```sh
file node_modules/adblock-rs/js/index.node
```

Keep the compiler error, platform, architecture, and runtime versions in the report. Do not replace the engine with a mock or globally skip Shields tests. A browser startup failure is contained by the application and displayed as an engine error, but unavailable filtering is still a failed protection gate.

## Build an unsigned validation bundle

Use this local validation command when Developer ID credentials are unavailable:

```sh
CSC_IDENTITY_AUTO_DISCOVERY=false npx --no-install electron-builder --mac --arm64 --publish never
node tests/integration/run-packaged.mjs --out=artifacts/ci/packaged.json
```

Run `npm run build` before that command. `npm run package:mac` also builds and passes `--publish never`; the explicit command above fixes the target architecture for release validation.

The expected bundle is `release/mac-arm64/Kinex.app`, with `Kinex-<version>-arm64.dmg`, a ZIP, and generated update metadata in `release`. Run `node tests/integration/run-dmg.mjs` to verify the image and launch the application mounted from it; test profiles remain disposable. The native addon must appear under `Contents/Resources/app.asar.unpacked/node_modules/adblock-rs/js/index.node`. The package also includes `dist`, `dist-electron`, bundled filter resources, the icon, and application metadata.

Unsigned package execution validates local loading and behavior only. The 0.x preview line may be published as free unsigned DMG/ZIP downloads for manual installation, clearly labeled as not notarized. Gatekeeper may block downloaded unsigned applications. This does not establish signed automatic-update compatibility; never disable signature or Gatekeeper checks as a workaround. The recorded `packaged.json` explicitly leaves signing unestablished.

## Configure legitimate signing and notarization

The macOS package enables hardened runtime. `build/entitlements.mac.plist` applies to the application and inherited helpers. It requests JIT execution and the camera, audio-input, and location resources used by browser features. `NSCameraUsageDescription`, `NSMicrophoneUsageDescription`, and `NSLocationWhenInUseUsageDescription` provide the corresponding application explanations. Per-site browser consent and macOS consent still apply.

The targeted resource entitlements follow Apple's [camera](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.device.camera), [audio input](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.device.audio-input), and [location](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.personal-information.location) definitions. They do not disable sandboxing, web security, certificate validation, or library validation.

Configure these values in a secure local environment or the repository's protected `release` environment:

| Name | Required value |
| --- | --- |
| `CSC_LINK` | Developer ID signing certificate reference accepted by electron-builder |
| `CSC_KEY_PASSWORD` | Password for that certificate |
| `APPLE_ID` | Apple account used for notarization |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific notarization password |
| `APPLE_TEAM_ID` | The corresponding Apple developer team |

Never put certificate contents, passwords, account tokens, or secret values in source control, documentation, commands retained in shared logs, or test artifacts. This implementation did not create credentials or modify repository secrets.

With legitimate credentials already supplied through the secure environment, build without publishing:

```sh
npx --no-install electron-builder --mac --arm64 --publish never --config.forceCodeSigning=true --config.mac.notarize=true
codesign --verify --deep --strict release/mac-arm64/Kinex.app
xcrun stapler validate release/mac-arm64/Kinex.app
spctl --assess --type execute --verbose release/mac-arm64/Kinex.app
node tests/integration/run-packaged.mjs --out=artifacts/ci/packaged-signed.json
```

Treat any failed signature, stapling, or Gatekeeper assessment as a failed release gate. Validate camera, microphone, location, and screen capture on the signed bundle after explicit user consent. The current local unsigned evidence does not establish those outcomes.

## Verify updates without publishing

The configured update provider uses `latest-mac.yml` and ZIP artifacts. Local file-server regression tests exercise malformed requests, traversal, symlink rejection, and normal artifact delivery. Remote update feeds require HTTPS, with HTTP reserved for loopback testing. The application retains Electron's update mechanisms rather than bypassing signing checks.

A complete signed-update qualification requires two legitimately signed versions, authenticated artifact delivery, and a disposable installed test copy. Verify detection, version ordering, download failure/retry, signature rejection, installation, relaunch, and preserved state. No successful signed installation is established by this task's evidence.

The repository's release workflow starts after successful main-push CI and also supports explicit version-tag pushes. Each delivery push must increase the package version; see [AGENTS.md](../../AGENTS.md). Publication uses the exact verified commit, rejects reused version tags, and prepares complete assets as a draft before making them Latest. Unsigned 0.x previews may publish DMG/ZIP downloads without signing credentials. Only signed/notarized builds publish latest-mac.yml and blockmaps for automatic installation; production releases require signing credentials. The 1.0.0 version remains the first production release. GitHub releases use its Latest feed for compatibility with older clients; the 0.x preview designation is independent of GitHub's prerelease flag. Unsigned preview Releases require manual installation and disclose their signing limitations in release notes. Local verification does not require a release tag or publication. Pushing completed work to main starts the authorized CI/publication pipeline; missing signing secrets select manual-preview packaging for 0.x and fail production releases with explicit errors. All commands above use `--publish never`.
