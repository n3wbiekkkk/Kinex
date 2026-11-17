# Website compatibility matrix

Test date: 2026-11-17. macOS 27.2.1, Darwin 27.2.0, Apple M5 arm64, 16 GB RAM. Electron 45.3.3, Chromium 156.0.8078.100, embedded Node 24.22.3. Fresh disposable profile, default Standard Shields.

Evidence: [final public probe](../../artifacts/v7.0.3/website-probe-final.json), [earlier probe](../../artifacts/v7.0.3/website-probe.json), [Figma fix probe](../../artifacts/v7.0.3/website-probe-figma-fix.json), [Figma fix probe rerun](../../artifacts/v7.0.3/website-probe-figma-fix-2.json), [CDP fix probe](../../artifacts/v7.0.3/website-probe-cdp-fix.json), [CDP fix probe rerun](../../artifacts/v7.0.3/website-probe-cdp-fix-2.json), and [local security integration](../../artifacts/v7.0.3/security-integration.txt). The Figma fix probe owns the Figma row; the CDP fix probes own the probe-reliability rows; the final probe owns the rest. A public-page pass is limited to that scenario and does not certify an authenticated application.

Statuses: PASS, FAIL, PARTIAL, BLOCKED, NOT TESTED. BLOCKED means the account, provider, signing, or hardware prerequisite was unavailable. A missing scroll range is PARTIAL, not a scrolling pass.

| Website | Public navigation, redirect, rendering and interaction scenario | Result | Authenticated app, OAuth and MFA | Evidence and limitation |
| --- | --- | --- | --- | --- |
| Google | Open `https://www.google.com/search?q=electron+browser`; correlate redirected target; wheel-scroll and Tab-focus checks | BLOCKED | BLOCKED | Anti-bot challenge. No bypass attempted. Raw row `Google Search`. |
| Gmail | Open `https://mail.google.com/`; correlate redirected target; wheel-scroll and Tab-focus checks | PARTIAL | BLOCKED | Workspace marketing page, not a mailbox. Raw row `Gmail (landing)`. |
| Google Docs | Open `https://docs.google.com/`; correlate redirected target; wheel-scroll and Tab-focus checks | PARTIAL | BLOCKED | Redirected to Google sign-in. Raw row `Google Docs (landing)`. |
| Google Drive | Open `https://drive.google.com/`; correlate redirected target; wheel-scroll and Tab-focus checks | PARTIAL | BLOCKED | Workspace marketing page, not file management. Raw row `Google Drive`. |
| YouTube | Open `https://www.youtube.com/watch?v=aqz-KE-bpKQ`; correlate redirected target; wheel-scroll and Tab-focus checks | PASS | BLOCKED | Public video clock advanced; sound, fullscreen, and PiP were not exercised on this site. Raw row `YouTube`. |
| GitHub | Open `https://github.com/n3wbiekkkk/Kinex`; correlate redirected target; wheel-scroll and Tab-focus checks | PASS | BLOCKED | Public repository rendering, scroll, and Tab focus. Raw row `GitHub`. |
| Reddit | Open `https://www.reddit.com/r/mac/`; correlate redirected target; wheel-scroll and Tab-focus checks | PASS | BLOCKED | Public subreddit rendered after site redirect; no logged-in interaction. Raw row `Reddit`. |
| Discord | Open `https://discord.com/app`; correlate redirected target; wheel-scroll and Tab-focus checks | PARTIAL | BLOCKED | Login page and Tab focus; short document had no scroll range. Raw row `Discord`. |
| Twitch | Open `https://www.twitch.tv/`; correlate redirected target; wheel-scroll and Tab-focus checks | PASS | BLOCKED | Public landing page. No authenticated chat or live media workflow. Raw row `Twitch`. |
| Google Meet | Open `https://meet.google.com/`; correlate redirected target; wheel-scroll and Tab-focus checks | PARTIAL | BLOCKED | Workspace marketing page, not a meeting. Raw row `Google Meet`. |
| Figma | Open `https://www.figma.com/`; correlate redirected target; wheel-scroll and Tab-focus checks | PASS | BLOCKED | Public homepage rendered, scrolled, and Tab-focused with a stable loaded state. The earlier FAIL was a browser loading-state defect, now fixed: subframe loads were reported as tab loading. Authenticated editor not exercised. Raw row `Figma`. |
| Netflix | Open `https://www.netflix.com/`; correlate redirected target; wheel-scroll and Tab-focus checks | PARTIAL | BLOCKED | Public marketing page. Widevine capability probe rejected; protected playback is not established. Raw row `Netflix`. |

## Scenario coverage

| Category | Result | Evidence and limits |
| --- | --- | --- |
| Local navigation, back/forward, reload, tab lifecycle, new windows and downloads | PASS | Main integration and 15 browser E2E workflows. These fixtures do not establish every provider workflow. |
| Split View, Reader Mode, native keyboard commands and reduced motion | PASS | 25 keyboard assertions and focus/window integration. Failed earlier combined runs remain in the release report. |
| Profile cookies, local storage, IndexedDB, CacheStorage and service workers | PASS | Actual isolated Electron sessions in security integration. |
| Local Canvas, WebGL2 and file input upload | PASS | Actual canvas pixel readback, WebGL2 context, and temporary file input in security integration. Native file chooser UI was not automated. |
| Public YouTube video progression | PASS | Final probe observed media time advance. It does not prove audible output or every codec. |
| Real local HTML5 fullscreen entry and exit | PASS | Experience integration calls DOM requestFullscreen and exitFullscreen with native view bounds assertions. |
| Website-specific file upload/download, selection, clipboard, drag/drop and context-menu workflows | NOT TESTED | Local file/download and keyboard context-menu checks do not certify remote provider workflows. |
| Website-specific fonts, canvas correctness, WebGL applications, zoom and responsive editing | NOT TESTED | Rendered landing pages are insufficient. Local Canvas/WebGL2/zoom checks are narrower. |
| Account persistence, login redirects, OAuth popup completion, MFA, editor collaboration | BLOCKED | Authorized test accounts were unavailable. No provider policy bypass attempted. |
| Camera, microphone, geolocation hardware and system screen picker | BLOCKED | Permission policy, revocation and private denial tested. Signed hardware consent and media capture were not executed. |
| Website fullscreen, Picture-in-Picture and audio output | NOT TESTED | API availability is not a successful interaction. |
| Netflix protected playback and Widevine | BLOCKED | Local com.widevine.alpha request returned NotSupportedError even with an explicit temporary-profile mediaKeySystem grant. No licensed CDM or signed provider playback was established. |

## Reproduce automated checks

Run `npm run build`, then `node tests/perf/run-live-probe.mjs --out=artifacts/compatibility.json`. The runner retains requested/final URLs, runtime, native target identity, checks, and limitations. It does not enter credentials. Google anti-bot outcomes and per-site network timing can vary; retain each run rather than replacing a failure with an unrelated pass. A result with `failureClass: probe-infrastructure` is a probe limitation, not a website verdict.

For the recorded Figma failure, open the public homepage through the probe, let its scroll and Tab checks run, and compare `page.ready` with the final application tab loading state. The document was ready and scroll passed, while `loaded` was false. This was a browser loading-state defect, not a Figma or editor failure.

Root cause: Electron emits `did-start-loading` for a subframe-only load as well as for a main-frame load. `NavigationManager` reported every `did-start-loading` as tab loading, so a page that keeps injecting iframes after its document settles (Figma's homepage) flipped the tab back to loading after the probe had already seen it idle. The probe's `loaded` check then read `isLoading: true` and recorded FAIL. The fix reports loading only when `webContents.isLoadingMainFrame()` is true; `did-stop-loading` already clears it only once the main frame is idle.

Regression coverage: `src/main/navigationBoundaries.test.ts` asserts a subframe-only `did-start-loading` never re-enters loading, and `tests/integration/electron-integration.cjs` drives a local `/late-subframes` fixture that settles and then injects four iframes, sampling the tab state for two seconds. Reverting the fix makes that integration check fail with the tab flipping to loading.

## Probe reliability: CDP timeouts

Intermittent `CDP Input.dispatchMouseEvent timed out` and `CDP Runtime.evaluate timed out` results on GitHub, Google Search, YouTube, and Twitch were a probe infrastructure defect, not a browser or website defect.

Root cause: the probe opened each site in a new tab, which backgrounded the previous one. A backgrounded tab stops producing compositor frames, so `requestAnimationFrame` never fires and `Input.dispatchMouseEvent` is never acknowledged. The probe's `waitForPaint()` awaited two animation frames inside a `Runtime.evaluate` with `awaitPromise: true`, so on a hidden tab that call hung until the 5s CDP timeout and the site was recorded as a failure. Measured directly: a hidden tab fires zero animation frames, `Runtime.evaluate` without a promise still answers in 1ms, `Input.dispatchKeyEvent` still answers in 1ms, and both the paint wait and `Input.dispatchMouseEvent` time out at 5001ms. `Page.bringToFront` does not help because the tab is hidden by native view visibility, not CDP tab order; selecting the tab in the application does.

Fix: `waitForPaint()` is now bounded and returns `{ painted, visibility }` instead of hanging, and the probe selects the tab under test before driving it, records the observed `visibilityState`, and classifies CDP timeouts and an un-focusable tab as `failureClass: 'probe-infrastructure'` with verdict `inconclusive`. A website is never reported as PASS or FAIL from a probe limitation.

Regression coverage: `tests/perf/compatibilityProbe.test.mjs` asserts the paint wait settles and reports `painted: false` when frames never fire, settles immediately when `requestAnimationFrame` is unavailable, and reports visibility state. Reverting `waitForPaint` to the unbounded form makes those checks fail, with the hidden-tab case hanging 5003ms.

Result: four consecutive probe runs, 52 site checks, zero timeouts, and probe wall time dropped from about 72s to about 33s because runs no longer wait out 5s timeouts.

## Verify remaining workflows manually

1. Use a legitimately signed test build and disposable Personal, Work, and private profiles.
2. For each site, sign in with an authorized test account. Follow redirects and MFA normally. Restart the browser and confirm persistence only in the expected regular profile.
3. Open a second profile and a private window. Verify that authentication, documents, cookies, and permission decisions do not cross profiles. Close private windows and retest with a fresh private partition.
4. In Gmail/Docs/Drive/Figma, create disposable content, type and select text, copy/paste, drag a temporary file, upload/download it, test collaboration, reload, and exercise OAuth popups. Delete only test content you created.
5. In YouTube/Twitch/Netflix, verify actual playback, audio, fullscreen and PiP. Record codec, protected-content outcome, and provider error verbatim without credentials.
6. In Meet/Discord, grant and revoke camera/microphone separately, exercise the macOS screen picker, cancel it, and verify the private policy. Never auto-select a capture source.
7. Record version, OS, scenario, result, evidence and reproduction for every failure. Keep BLOCKED or NOT TESTED when a prerequisite prevents execution.

Widevine licensing and provider acceptance are separate from Chromium API availability. See the [Google Widevine overview](https://developers.google.com/widevine/drm/overview) and [Electron CDM documentation](https://github.com/electron/electron/blob/main/docs/tutorial/testing-widevine-cdm.md). No DRM support claim is made.
