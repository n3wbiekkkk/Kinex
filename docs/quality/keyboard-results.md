# Keyboard-only acceptance

The rerunnable gate is `node tests/e2e/run-keyboard-only.mjs --out=artifacts/quality/keyboard` after `npm run build`.

The harness uses actual `WebContents.sendInputEvent` keyDown, char and keyUp events against the genuinely focused native contents. It contains no mouse actions, scripted DOM focus, IPC dispatch or application intent calls during acceptance. Native window activation occurs once at launch. State and DOM reads provide assertions. Text replacement uses End/Backspace events because synthetic Chromium events do not exercise macOS native Edit menu routing.

The latest observed run passed launch, Cmd+T and navigation to a local article. It failed before opening the second tab because `webContents.getFocusedWebContents()` remained null for 1.5 seconds after the first overlay closed. This is a failed acceptance gate, not a complete keyboard-accessibility claim. The full result and key transcript are in `artifacts/quality/keyboard/keyboard-results.json`.

The gate defines all twenty requested actions and additional modal forward/reverse Tab containment, Escape/native focus restoration, sidebar arrows and keyboard reorder, reduced-motion lifecycle, Element Zapper confirm/cancel, and native context-menu opening checks. Checks after the failing action were not executed in the latest run. Native OS menu traversal is explicitly outside Chromium input-event automation.
