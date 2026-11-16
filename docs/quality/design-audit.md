# Kinex experience design audit

This audit compares the existing v0.7.0 working tree with the experience quality changes. The version stays unchanged.

## Evidence

The initial native-window captures are in `/private/tmp/kinex-quality/before`. The expanded matrix uses `/private/tmp/kinex-quality/before-expanded` and `/private/tmp/kinex-quality/after`. Each matrix manifest records the actual window bounds and captured pixel size. Retina captures have more pixels than the logical window width.

The audit covers New Tab, the sidebar, Favorites, Spaces, Split View, Command Bar, Settings, shortcut reference, Downloads, history search, archived tabs, Reader Mode, Private Window, native tab menus, and a safe native dialog fixture. The matrix uses 880, 1360, and 1720 logical pixels in both Space themes. A private window keeps its own private appearance, regardless of the active Space theme.

The native dialog fixture captures macOS dialog typography and controls. It does not qualify every security confirmation or system permission dialog. Before the changes, history is accessible through Command Bar search, so the baseline history image shows that existing interface. Some original native menu images are clipped because the popup used the current pointer position near the window edge. The updated capture harness anchors the actual popup inside the capture region. Those original images remain unchanged.

## Observed weaknesses

| Area | Observation in the original screenshots | Change |
| --- | --- | --- |
| Command Bar and Settings | The 8 px full-window blur and 66% dark scrim obscure the workspace. Broad shadows dominate both panels. | Remove the backdrop blur, reduce the scrim, and use smaller shadows with opaque panels. |
| Secondary text | Section headings, inactive Spaces, result subtitles, and footer hints are too faint, particularly against tinted sidebar backgrounds. | Increase text contrast in both palettes. Keep disabled controls distinct from ordinary secondary information. |
| Accent buttons | White text on the bright dark-theme accent has weak contrast. | Use dark text on the bright accent in Dark Mode, and white text on the darker accent in Light Mode. |
| Tab titles | Hidden action buttons reserve width even when no actions are visible. Long titles truncate early. | Overlay the action group at the row edge and reserve title space only during interaction. |
| Tab actions | Row actions appear only on mouse hover. A keyboard user can focus an invisible action. | Reveal the same actions for focus within the row. |
| Split View | Both visible tabs have identical active rails, while the toolbar alone identifies the focused pane. | Use a solid accent for the focused tab and a quieter rail for the second visible tab. |
| Keyboard focus | Custom row targets and resize separators need a visible focus state. The address input removes its outline without an equivalent container indicator. | Give custom targets visible rings, highlight separators, and show focus on the address input container. |
| Motion | Panel timing and scale differ across overlays. Close transitions disappear when the native overlay hides. | Use shared duration and easing tokens with a 140 ms closing contract. Input focus remains immediate. |
| Small windows | Settings has a fixed navigation width and rows with long descriptions plus trailing controls. | Reduce the navigation width at smaller windows and allow rows to wrap. |
| Space editor | The Add Profile button wraps into two lines while its adjacent input consumes the row. | Keep button labels on one line and allow text inputs to shrink within their flex container. |
| Native controls | macOS menus and dialogs already have established keyboard and motion behavior. | Keep native menus and dialogs native. |

## Visual language

Kinex keeps its compact workspace sidebar, inset page canvas, and Space colors. The accent rail, restrained selection fill, and consistent keyboard rings identify the active interaction. Opaque overlay surfaces keep text readable without a large blur. Rounded controls share the existing radius scale, and system typography stays consistent with macOS.

The refinement retains the existing layout. It does not add decorative gradients, new icon libraries, or a replacement component system.

## Motion contract

| Token | Value | Use |
| --- | --- | --- |
| `--dur-fast` | 120 ms | Control feedback and backdrop entrance |
| `--dur-med` | 160 ms | Panel entrance and sidebar content appearance |
| `--dur-slow` | 200 ms | Reserved existing panel timing token |
| `--dur-exit` | 140 ms | Overlay exit |
| `--ease-standard` | `cubic-bezier(0.2, 0, 0, 1)` | Opacity and general state feedback |
| `--ease-spring` | `cubic-bezier(0.16, 1, 0.3, 1)` | Short panel movement without overshoot |

The overlay root uses `data-closing="true"` while it exits. Entrance and exit animate opacity and a small transform. The UI does not wait for the animation before accepting input. Native page bounds update immediately. CSS never animates the sidebar width, page position, or split ratio independently of Electron bounds.

`prefers-reduced-motion: reduce` removes movement, repeated animation, smooth scrolling, and transition duration. `prefers-reduced-transparency: reduce` uses opaque shell and panel surfaces. No element has permanent `will-change`.

The runtime `data-low-power="true"` scope also removes nonessential animation and movement. Main enables this scope for an OS CPU speed limit below 100% or serious or critical thermal pressure. Running on battery alone does not change the interface. Physical low-power and thermal behavior requires hardware testing and is not claimed by the CSS checks.

Sidebar removal, tab reorder, and Split View geometry remain immediate. Retaining stale page geometry for an animation would misalign the native views and pointer targets. Their selection, focus, and control feedback still use the shared motion tokens.

## Reproduce the captures

Build the application, then run the native capture harness on macOS with screen capture permission:

```sh
npm run build
node_modules/.bin/electron tests/e2e/capture-screenshots.cjs /private/tmp/kinex-quality/after
```

The harness uses an isolated temporary profile and Downloads directory. Its local article and download fixtures require no account. It captures real native views and OS menus. A four-minute deadline bounds failures.

The existing ten screenshot names remain available for direct comparison. The `matrix` subdirectory contains the full state matrix. The harness asserts that Reader Mode activates, that the local download completes, that private windows open, and that every screenshot decodes as an image. Visual inspection is still required to judge clipping, alignment, and focus visibility.

## Verification status

The original New Tab, Split View, Command Bar, and Settings screenshots were inspected before styling changes. Expanded captures, final visual inspection, animation timing, and keyboard acceptance results are recorded in the accompanying quality report after execution. CSS timing values describe the intended motion; they are not frame-rate measurements.
