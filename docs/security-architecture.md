# Kinex security architecture

This document describes the implemented v7.0.3 boundaries. It does not certify every website, operating system permission, or signed update flow. Verification procedures and remaining gaps are in [Testing](quality/testing.md) and [Build and signing](quality/build-and-signing.md).

## Privileged application and website boundaries

`src/main/index.ts` owns the Electron application. `KinexWindowManager` owns browser state, native windows, and application commands. Untrusted websites run in separate `WebContentsView` instances managed by `TabManager` or `AuxiliaryWindowManager`.

Website views and their popups explicitly enable sandboxing, context isolation, and web security. They disable Node integration, worker and subframe Node integration, webviews, and insecure mixed content. Website views receive no preload. Popup creation preserves the opener's session and explicitly removes preload access.

The internal shell, overlay, and auxiliary headers use `src/preload/shell.ts`. The bridge exposes named state, intent, context-menu, focus, and auxiliary-window operations through `kinexAPI`. It does not expose `ipcRenderer`, arbitrary channel names, filesystem access, or process execution. Listener registration returns an unsubscribe function and does not pass Electron event objects into application JavaScript.

Every main-process IPC handler requires all of the following:

- A registered `WebContents` ID with an authorized role.
- A sender frame that is exactly the sender's main frame.
- An exact allowed internal document URL after removing its query and fragment.
- A payload accepted by the endpoint's typed runtime validator.

The shell and overlay can dispatch browser intents. Auxiliary headers can request only their own window information and supported actions. Context menus require the shell role. A website that navigates to a `kinex:` page still has no preload and does not become an authorized application renderer.

## Navigation and transport

`NavigationManager` enforces URL policy on direct navigation, redirects, and new windows. Ordinary browser navigation permits HTTP, HTTPS, Kinex internal pages, the legacy `nook:` alias, and `about:blank`. Renderer intents reject explicit filesystem, script, data, and blob URLs. Website-created blob previews are permitted only when their embedded origin matches the source website.

`mailto:` and `tel:` external actions require a native confirmation. Other external schemes are rejected. Internal shell and header views reject navigation or redirects to a different document. File URL prefix matches do not establish trust.

HTTPS-only mode upgrades eligible HTTP navigation. DNS, certificate, offline, and timeout failures do not silently downgrade to HTTP. An explicit fallback prompt is limited to a failed HTTPS upgrade with a matching transport error. Fallback decisions and certificate exceptions belong to the Electron session, so different profiles and private sessions do not share them.

The existing certificate warning permits an explicit unsafe continuation. Its temporary exception includes the origin, certificate fingerprint, and error. A navigation generation prevents a delayed prompt answer from authorizing a different navigation. This is a narrow user decision, not a global certificate-verification override.

## Profiles, Spaces, and private windows

An Electron partition owns cookies, local storage, IndexedDB, caches, service workers, and authentication state. Profiles have distinct persistent partitions. Spaces assigned to the same Profile intentionally share its website identity and storage.

Moving a tab or changing a Space's Profile destroys the previous website view before recreating it in the destination session. Little Kinex recreates its window when the active Profile changes rather than navigating with the previous Profile's cookies.

Each private window receives a unique nonpersistent partition with cache disabled. Its browsing URLs and downloads do not enter regular browsing or download history. Private Shields feedback redacts blocked hostnames. Closing the window destroys its popups and requests storage, cache, HTTP authentication, and connection cleanup. Cleanup attempts each operation independently. Files explicitly downloaded in a private window remain on disk.

Private browsing is local session isolation. It does not hide network activity from websites or network operators.

## Permissions and macOS consent

`PermissionManager` keys saved decisions by `partition`, canonical `origin`, and `permission`. Camera and microphone decisions use separate `media:video` and `media:audio` keys. A microphone grant cannot authorize a subsequent camera request.

Unscoped legacy decisions are discarded during state loading. Legacy combined `media` grants do not satisfy the new camera or microphone keys. Those capabilities require fresh consent. Settings revocation targets the same Profile, origin, and capability tuple.

Known sensitive capabilities prompt only for eligible secure origins or loopback development origins. Unknown capabilities and dangerous device permissions are denied. Private sessions deny sensitive requests. A pending native permission prompt is invalidated by navigation, renderer termination, or destruction before an answer can become a grant. Media activity tracking clears its event listeners on navigation, crash, or destruction.

Regular screen capture uses the system picker when Electron and macOS provide it. The fallback supplies no capture source. Private screen capture supplies no source. Camera, microphone, location, and screen sharing still require applicable macOS consent and hardware verification. Entitlements and usage descriptions prepare the signed bundle; they do not establish successful hardware access.

## Internal content security policies

The shell's `index.html` permits scripts from its own bundle and denies objects, nested frames, base changes, and form submission. Inline styles remain permitted for existing React styles and theme values. The localhost connection allowance supports the development server and its WebSocket connection. There is no `unsafe-eval` allowance.

Internal protocol responses use a fresh script nonce, a default deny policy, data images, no framing, no base changes, no referrer, and MIME sniffing protection. Only generated internal scripts receive the nonce. Reader responses deny scripts entirely. New-tab search uses its authorized submit handler rather than an inline event attribute.

These policies apply to Kinex interfaces. They are not injected as CSP restrictions into external websites. User-configured Boost scripts remain website-context code and do not receive privileged application APIs.

## Shields initialization and failure handling

The native `adblock-rs` engine is loaded inside a guarded boundary. A missing addon or filter failure produces `engineError` and an unavailable-engine state instead of aborting browser startup. The Shields panel displays the failure.

Cold initialization prepares filter caches in `initializeWorker.ts` using a Node worker thread. Main then loads the prepared native cache. Concurrent initialization shares one promise. Session request interceptors wait for initialization before deciding a request, which avoids silently allowing the first requests while filters compile. Disposing the engine terminates the worker and cancels list updates.

If initialization fails, the browser remains usable and filtering may be unavailable. The visible error must not be interpreted as successful protection. Filter update requests are bounded, validate downloaded data, and atomically replace cache files. Overlapping updates coalesce, and downloaded metadata merges into current settings so an in-flight update does not undo a later site exception.

## Persistence, crashes, and downloads

`KinexPersistence` validates serialized collections and restores valid records while repairing malformed splits, references, partitions, and settings. Invalid explicit partitions receive separate recovery partitions. Duplicate tab IDs are not restored as multiple live views. Intentionally empty tab collections remain empty.

Damaged source data is retained as `kinex-state.json.corrupt-<UUID>.json` before recovered state replaces it. Both the backup and newly written state use owner-only file permissions. If backup creation fails, the damaged original is retained. Corruption backups can contain browsing history and deserve the same protection as the state file.

Normal saves prepare unique temporary files asynchronously. A generation check and atomic promotion run in one JavaScript turn. A synchronous final flush invalidates older queued writes so a late write cannot overwrite newer shutdown state. Atomic replacement protects against partial documents; it is not a disk-encryption or power-loss durability guarantee.

A crashed website retains its original URL and receives an internal crash page. Reload returns to that URL. Window cleanup closes website views and popups, clears lookup state and timers, and removes power-monitor listeners. Application disposal also stops Shields, downloads, and the updater. macOS window close keeps the application updater alive until application disposal.

Download names remain inside the configured Downloads directory. Existing files, dangling symlinks, and paths reserved by simultaneous regular or private downloads trigger a different filename. Completion releases reservations. Shutdown cancels tracked download items. Another local process can still replace a chosen path after selection; app-level reservations are not an operating system filesystem transaction.

## Update boundary and verification limits

Remote update feeds require HTTPS. Plain HTTP feeds are limited to loopback addresses, and credential-bearing feed URLs are rejected. A configured local feed is served on loopback and exposes only `latest-mac.yml`, ZIP files, and their blockmaps. The server rejects malformed escapes, traversal, symlink targets, unsupported methods, and unrelated files. File opening uses `O_NOFOLLOW`, and responses stream asynchronously from the opened handle.

The updater coalesces checks, catches download errors, closes local servers, and permits explicit installation only after its downloaded state. Electron's update installation and signing mechanisms remain enabled. Production releases and automatic-installation metadata require real signing and notarization configuration. Free 0.x previews are ad-hoc sealed manual downloads, with strict deep signature verification and a hardened-runtime flag check before packaged startup.

The local evidence does not establish successful Developer ID verification, notarization, Gatekeeper distribution, or installation of an authenticated signed update. No update was published or installed during this implementation. Authenticated provider flows, MFA, and protected DRM playback require separate verification and must not be inferred from a public landing-page result.


## Ad-hoc preview packaging boundary

The default production entitlements retain library validation. The explicit local/CI preview command applies `build/entitlements.preview.mac.plist`, which adds the library-validation exception required for an ad-hoc Electron app to load Electron Framework and native modules. Hardened runtime remains enabled and is checked in the built executable, and website sandbox/Node/IPC boundaries are unchanged. This exception is limited to manual previews; the Developer ID release command does not select it. Regression tests assert that the two profiles remain separate.

Strict deep codesign verification catches missing resource seals and nested signature corruption before the app or mounted DMG is tested. It verifies integrity, not publisher identity or notarization. Gatekeeper can still reject an otherwise intact ad-hoc preview, and this implementation does not remove quarantine or change system security policy.
