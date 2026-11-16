# Kinex experience quality

Keep v0.7.0, the existing intent/state architecture, sandbox boundaries, profile partitions and Memory Saver protections. Do not publish or push. Existing uncommitted work is the baseline.

## Verification contract

- Build and launch the actual Electron app with disposable user data.
- Capture the requested UI states at 880, 1360 and 1720 pixels before and after changes.
- Exercise the twenty requested actions using real keyboard events without DOM clicks or hidden intent dispatch during the acceptance workflow.
- Verify command execution, normalized shortcut collisions, modal trapping/restoration, sidebar operations, split resizing and reduced motion.
- Run existing unit, integration, E2E, Memory Saver and leak checks.
- Record startup, process-tree memory/CPU, tab/palette latency and animation frame intervals. Distinguish one-run observations from statistically supported comparisons.
- Test public real-site interactions. Authentication without an authorized test account remains unverified, never a passing login result.

## Work sequence

1. [x] Read existing architecture and preserve the preexisting diff in /private/tmp/kinex-quality.
2. [ ] Capture baseline screenshots and performance; inspect each surface.
3. [x] Compare two keyboard designs. Choose one shared declarative command registry and main-process execution through the existing intent boundary. Keep native menus; use a narrow input bridge only for declared browser shortcuts, with auxiliary-window context.
4. [ ] Implement commands, fuzzy search, shortcut reference and context/focus routing.
5. [ ] Implement modal focus boundaries, keyboard sidebar/toolbar and drag alternatives.
6. [ ] Refine visual hierarchy and motion with opacity/transform, reduced-motion support and native bounds synchronization.
7. [ ] Correct compatibility probe identity/scroll timing and test real public interactions.
8. [ ] Run keyboard-only acceptance, screenshot matrix, regression suites and performance checks. Fix observed failures.
9. [ ] Deliver evidence, audit, inventory and explicit remaining limitations.

## Architecture decision

Candidate A resolves command recipes in shared code and retains native global shortcuts. Candidate B sends command IDs to main, resolving current focus/window there. Use B's thin main executor over existing intents, with A's declarative metadata for menu, palette and reference. This avoids a second state store and stale split-pane targets. Native menus remain native. No third-party keyboard or animation dependency.

Data contracts: `CommandId` and metadata in `shared/commands.ts`; validated `{ type: 'run-command', commandId }`; `{ type: 'focus-region', region: 'content' | 'sidebar' | 'toolbar' }`; typed `onFocusRequested` preload event. Dynamic move commands use existing intents. Scope all remote input matching to declared browser shortcuts, ignore IME, and never intercept ordinary website keys.

Cross-family design judging is unavailable in this runtime. Two independent inherited-model candidates were compared directly.
