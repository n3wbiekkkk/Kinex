# Update compatibility for the 0.7.x preview line

Kinex 0.7.5 is a pre-production preview. Version 1.0.0 remains reserved for the first production release. The package and lockfile declare 0.7.5, and packaged validation reads the expected version from package.json.

## Older 0.7.x clients

Older clients read https://github.com/n3wbiekkkk/Kinex/releases/latest/download/latest-mac.yml. GitHub's Latest endpoint excludes releases marked prerelease. The release workflow therefore publishes with `--latest` and without the GitHub prerelease flag. A 0.x release remains a preview by version and documentation; this flag choice makes the existing client feed work.

After each successful main-push CI run, the workflow checks out the tested SHA, derives its version tag from package.json, rejects a tag already assigned to another commit, and prepares signed artifacts as a draft before making them Latest. Explicit tag pushes remain supported and must match package.json. Each delivery push gets a new patch version under [the repository rules](../../AGENTS.md). Stale runs do not replace the newer main update feed; published assets are preserved on reruns. The workflow validates the version and requires Developer ID signing and notarization for published update artifacts, including previews. Local unsigned packages are manual testing artifacts.

The actual electron-updater version comparator was exercised with current version 0.7.0 and candidate 0.7.3. It accepts the upgrade. It also accepts the future 1.0.0 production upgrade. The existing operating-system compatibility check remains active, and automatic downgrades remain disabled.

A guard prevents the new 0.x client from treating the obsolete misnumbered 7.0.1, 7.0.2 and 7.0.3 builds as upgrades if a stale feed still exposes them. This guard cannot modify an already installed older executable; the server-side Latest release must still be updated during publication.

## Signing blocks installation

The local 0.7.0 archive contains a signed executable. The inspected 0.7.3 local package has an ad-hoc signature; no signed 0.7.5 package has been qualified. No matching Developer ID identity was found in the local keychain, and the repository and release environment list no signing secrets.

Electron's macOS updater requires a signed application. A correct version comparison and downloadable ZIP do not establish a successful installation. The old signed installation needs an update signed with the compatible publisher identity. Signing checks have not been disabled.

Configure the signing and notarization credentials described in [Build and signing](build-and-signing.md) through the trusted CI secret configuration. Never commit a certificate password, private key, or Apple app-specific password. Publication remains blocked until those credentials are available.

No release was published by this change. The inspected live Latest release was v7.0.2, so the public feed is not yet serving the new 0.7.x preview.

## Qualification procedure

1. Build and sign the new 0.7.x version with the publisher identity compatible with the old application, then notarize and verify it.
2. Package the signed app, its ZIP/blockmap, and matching latest-mac.yml. Verify version and hashes.
3. Copy an old 0.7.x application and its test profile into a disposable environment. Point only that test copy at the local release directory.
4. Verify detection, full download, signature checks, installation, relaunch at the new version, and preserved tabs/profiles. Do not test installation over a real user application or profile.
5. Publish the qualified artifacts as GitHub Latest only after that signed installation succeeds, then verify the existing HTTPS feed from an old test client.

Implemented checks cover version selection, obsolete-release rejection, OS-check composition, disabled downgrades, and packaged startup. Signed update installation remains BLOCKED by credentials.

References: [Electron autoUpdater](https://www.electronjs.org/docs/latest/api/auto-updater) and [Electron code signing](https://www.electronjs.org/docs/latest/tutorial/code-signing).

## Automatic publication regression evidence (2026-11-17)

Local typecheck, compiler lint, production build, and 105 tests across 20 files passed. This includes eight release regressions: three real npm version/lockfile cases, main-push version selection and explicit-tag mismatch, annotated tag reuse rejection using real Git refs, stale-commit publication suppression, draft-before-Latest publication ordering, and missing-signing-credential rejection. The external GitHub publication command is replaced only in these offline workflow tests; these tests do not establish a real release or installation.

Actionlint 1.7.12 passed both workflow files. The complete macOS browser suite, newly versioned package, and live publication still require their CI runs. Signing and installed-update qualification remain blocked as described above.
