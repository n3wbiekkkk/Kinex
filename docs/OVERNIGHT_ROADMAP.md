# Kinex overnight roadmap

This roadmap contains the 24 numbered milestones in the request. The final verification and release milestone is number 24. Checks run before the final milestone are limited to the Node and web TypeScript checks and targeted unit tests. Each milestone is committed after its checks pass. Pre-existing updater, media-component, and DRM work is preserved outside these commits unless it is required by a milestone.

## Milestones

- [x] 1. Optimize CI and release caching for npm, Electron, and Cargo. Ignore documentation-only changes, cancel stale CI runs, and separate fast checks from heavy Electron and packaging checks.
- [ ] 2. Install local CRX3 packages with zip-slip protection and an "Install from .crx..." settings action.
- [ ] 3. Install CRX3 packages from Chrome Web Store URLs after explicit permission consent. Support extension action badge text and colors in the top controls.
- [ ] 4. Add optional automatic Picture-in-Picture on tab switches, audio indicators, and a sidebar mute toggle.
- [ ] 5. Add safe inline math, unit conversions with click-to-copy, sleeping-tab badges, and Space-jump badges to the Command Bar.
- [ ] 6. Add passphrase-encrypted AES-256-GCM `.kinex-sync` import, export, and automatic folder backups. Exclude private windows, cookies, and passwords.
- [ ] 7. Add per-site and per-Space permission management for camera, microphone, notifications, clipboard, and protected media. Record WebAuthn and passkey verification limits.
- [ ] 8. Add `kinex://performance` telemetry for tabs, estimated sleeping memory, and Shields counts. Update the reproducible benchmark runner.
- [ ] 9. Guard macOS-only APIs and provide Windows and Linux fallbacks. Fix compiler lint warnings in affected code.
- [ ] 10. Add GPU-composited transitions for the Command Bar, Settings, Boosts, and extension popups. Respect reduced motion and native focus.
- [ ] 11. Add an animated collapsible sidebar, optional hover peek, and Space accent transitions.
- [ ] 12. Polish drag indicators, split divider hover and 50/50 reset, and animated download progress.
- [ ] 13. Add customizable shortcuts with conflict detection and reset. Add a dismissible three-tip first-run welcome card.
- [ ] 14. Make Settings searchable and add appearance, layout, zoom, startup, search-engine, and download preferences.
- [ ] 15. Add searchable History, Bookmarks, and Downloads views. Add timed and per-Space browsing-data deletion.
- [ ] 16. Expand Shields and privacy settings, including custom filters, site exceptions, URL cleaning, HTTPS-only mode, cookie and referrer controls, WebRTC policy, and settings reset.
- [ ] 17. Add the native web context menu for links, images, selected text, and pages.
- [ ] 18. Wire developer tools, JavaScript console, view source, and macOS swipe navigation with an accessible edge indicator.
- [ ] 19. Add Reader appearance controls and a per-Space Reading List.
- [ ] 20. Add Shift-click Link Peek with a sandboxed WebContentsView, expand, split, Escape, and backdrop actions.
- [ ] 21. Add configurable tab auto-archiving, a searchable archive, and nested Space folders.
- [ ] 22. Add MHTML webpage saving and a site-control popover with connection, Shields, cookies, and permission controls.
- [ ] 23. Add Zen Focus Mode and per-Space distraction blocking.
- [ ] 24. Update release documentation and limitations, run the complete verification suite, fix regressions, allocate a preview version, commit, and push to `main`.

## Verification record

Milestone checkboxes are marked only after the requested implementation and available targeted checks are complete. Operating-system, signing, network, DRM, WebAuthn, and passkey checks that need unavailable external facilities are recorded here rather than implied by source-level tests.
