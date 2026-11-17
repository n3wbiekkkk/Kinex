const definitions = [
  ['new-tab', 'New Tab', 'Tabs', 'CmdOrCtrl+T', 'Open the Command Bar to navigate or search'],
  ['edit-url', 'Focus Address Bar', 'Navigation', 'CmdOrCtrl+L', 'Edit the current URL'],
  ['close-tab', 'Close Tab', 'Tabs', 'CmdOrCtrl+W', 'Close the focused tab'],
  ['reopen-closed-tab', 'Reopen Closed Tab', 'Tabs', 'CmdOrCtrl+Shift+T', 'Restore the last closed tab'],
  ['duplicate-current-tab', 'Duplicate Tab', 'Tabs', '', 'Open a copy of the focused page'],
  ['pin-tab', 'Pin / Unpin Tab', 'Tabs', 'CmdOrCtrl+D', 'Keep the focused tab in Pinned'],
  ['favorite-tab', 'Add / Remove Favorite', 'Tabs', '', 'Keep the focused tab in Favorites'],
  ['close-other-tabs', 'Close Other Tabs', 'Tabs', '', 'Archive other Today tabs in this Space'],
  ['next-tab', 'Next Tab', 'Tabs', 'Ctrl+Tab', 'Switch to the next tab in this Space'],
  ['previous-tab', 'Previous Tab', 'Tabs', 'Ctrl+Shift+Tab', 'Switch to the previous tab in this Space'],
  ['reload', 'Reload Page', 'Navigation', 'CmdOrCtrl+R', 'Reload the focused page'],
  ['stop-loading', 'Stop Loading', 'Navigation', 'CmdOrCtrl+.', 'Stop the current navigation'],
  ['back', 'Back', 'Navigation', 'CmdOrCtrl+[', 'Go back in page history'],
  ['forward', 'Forward', 'Navigation', 'CmdOrCtrl+]', 'Go forward in page history'],
  ['find-in-page', 'Find in Page', 'Tools', 'CmdOrCtrl+F', 'Search text in the focused page'],
  ['print-page', 'Print Page', 'Tools', 'CmdOrCtrl+P', 'Open the native print dialog'],
  ['save-page-pdf', 'Save Page as PDF', 'Tools', 'CmdOrCtrl+Shift+P', 'Export the focused page to a PDF file'],
  ['toggle-reader-mode', 'Open / Close Reader Mode', 'Tools', 'Alt+CmdOrCtrl+R', 'Read an article without page scripts'],
  ['open-settings', 'Open Settings', 'Kinex', 'CmdOrCtrl+,', 'Manage preferences and browser data'],
  ['manage-extensions', 'Manage Extensions', 'Kinex', '', 'Install and review Manifest V3 extensions'],
  ['open-shortcuts', 'Keyboard Shortcuts', 'Kinex', '', 'View the complete shortcut reference'],
  ['open-downloads', 'Open Downloads', 'Tools', 'CmdOrCtrl+J', 'Pause, resume and open downloaded files'],
  ['open-history', 'Open History', 'Tools', 'CmdOrCtrl+Y', 'Find and reopen visited pages'],
  ['open-archive', 'Closed & Archived Tabs', 'Tabs', '', 'Restore tabs or closed tab groups'],
  ['clear-history', 'Clear History', 'Tools', '', 'Review privacy controls before clearing browsing history'],
  ['toggle-sidebar', 'Toggle Sidebar', 'View', 'Alt+CmdOrCtrl+S', 'Show or hide the workspace sidebar'],
  ['toggle-sidebar-collapse', 'Collapse / Expand Sidebar', 'View', 'Ctrl+CmdOrCtrl+S', 'Animate the sidebar between compact and full width'],
  ['toggle-hover-peek', 'Toggle Hover Peek', 'View', '', 'Preview the collapsed sidebar by hovering its edge'],
  ['new-split', 'Toggle Split View', 'View', 'CmdOrCtrl+Shift+\\', 'View two pages side by side'],
  ['next-pane', 'Focus Other Split Pane', 'View', 'Alt+CmdOrCtrl+Right', 'Switch keyboard focus between split panes'],
  ['focus-next', 'Focus Next Browser Region', 'View', 'F6', 'Cycle content, sidebar and toolbar'],
  ['focus-previous', 'Focus Previous Browser Region', 'View', 'Shift+F6', 'Cycle browser regions in reverse'],
  ['focus-content', 'Focus Website Content', 'View', '', 'Return keyboard focus to the current page'],
  ['focus-sidebar', 'Focus Sidebar', 'View', '', 'Navigate tabs, Favorites and Spaces using the keyboard'],
  ['focus-toolbar', 'Focus Toolbar', 'View', '', 'Navigate page and split controls using the keyboard'],
  ['new-space', 'New Space', 'Spaces', '', 'Create a workspace with a name, theme and Profile'],
  ['rename-space', 'Rename Space', 'Spaces', '', 'Edit the active workspace'],
  ['next-space', 'Next Space', 'Spaces', 'Ctrl+CmdOrCtrl+Right', 'Switch to the next workspace'],
  ['previous-space', 'Previous Space', 'Spaces', 'Ctrl+CmdOrCtrl+Left', 'Switch to the previous workspace'],
  ['toggle-dark-mode', 'Toggle Dark Mode', 'View', '', 'Switch the active Space between Light and Dark'],
  ['toggle-adblock', 'Toggle Ad & Tracker Shields', 'Tools', '', 'Enable or disable request blocking'],
  ['open-shields', 'Open Kinex Shields', 'Tools', 'CmdOrCtrl+Shift+K', 'Inspect blocked items and per-site protection'],
  ['activate-element-picker', 'Pick Element to Block', 'Tools', '', 'Visually select and hide an unwanted page element'],
  ['toggle-boosts', 'Open Boosts Studio', 'Tools', 'CmdOrCtrl+Shift+B', 'Edit per-site CSS, JavaScript and hidden elements'],
  ['new-window', 'New Window', 'Kinex', 'CmdOrCtrl+N', 'Open a new browser window'],
  ['little-kinex', 'Open Little Kinex', 'Kinex', 'Alt+CmdOrCtrl+N', 'Open a floating browser window'],
  ['open-private-window', 'New Private Window', 'Kinex', 'CmdOrCtrl+Shift+N', 'Open a separate ephemeral browsing session'],
  ['copy-url', 'Copy Clean URL', 'Navigation', 'CmdOrCtrl+Shift+C', 'Copy the page address without tracking parameters'],
  ['zoom-in', 'Zoom In', 'View', 'CmdOrCtrl+=', 'Increase page zoom'],
  ['zoom-out', 'Zoom Out', 'View', 'CmdOrCtrl+-', 'Decrease page zoom'],
  ['zoom-reset', 'Actual Size', 'View', 'CmdOrCtrl+0', 'Reset page zoom'],
  ['devtools', 'Developer Tools', 'Tools', 'Alt+CmdOrCtrl+I', 'Inspect the focused page'],
  ['check-updates', 'Check for Updates', 'Kinex', '', 'Check the configured update feed'],
  ['close-window', 'Close Window', 'Kinex', 'CmdOrCtrl+Shift+W', 'Close the focused window'],
] as const;

type Digit = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
export type CommandId = typeof definitions[number][0] | `select-tab-${Digit}` | `select-space-${Digit}`;
export interface BrowserCommand {
  id: CommandId;
  title: string;
  category: string;
  accelerator?: string;
  description: string;
  palette?: boolean;
}

export const BROWSER_COMMANDS: readonly BrowserCommand[] = [
  ...definitions.map(([id, title, category, accelerator, description]) => ({
    id, title, category, accelerator: accelerator || undefined, description,
  })),
  ...Array.from({ length: 9 }, (_, i): BrowserCommand => ({
    id: `select-tab-${i + 1}` as CommandId, title: `Switch to Tab ${i + 1}`,
    category: 'Tabs', accelerator: `CmdOrCtrl+${i + 1}`, description: i === 8 ? 'Select the last tab' : 'Select a tab by its position', palette: false,
  })),
  ...Array.from({ length: 9 }, (_, i): BrowserCommand => ({
    id: `select-space-${i + 1}` as CommandId, title: `Switch to Space ${i + 1}`,
    category: 'Spaces', accelerator: `Ctrl+${i + 1}`, description: 'Select a workspace by its position', palette: false,
  })),
];

const commandIds = new Set<string>(BROWSER_COMMANDS.map((command) => command.id));
export function isCommandId(value: unknown): value is CommandId {
  return typeof value === 'string' && commandIds.has(value);
}

export function formatShortcut(accelerator?: string): string {
  return (accelerator ?? '').replace(/CmdOrCtrl/g, '⌘').replace(/Ctrl/g, '⌃')
    .replace(/Alt/g, '⌥').replace(/Shift/g, '⇧').replace(/Left/g, '←').replace(/Right/g, '→').replace(/\+/g, '');
}

export function normalizeShortcut(accelerator: string, platform = 'darwin'): string {
  const parts = accelerator.toLowerCase().replace(/cmdorctrl/g, platform === 'darwin' ? 'meta' : 'control')
    .replace(/command|cmd/g, 'meta').replace(/ctrl/g, 'control').replace(/option/g, 'alt').split('+');
  const key = parts.pop() ?? '';
  return [...new Set(parts)].sort().concat(key).join('+');
}

export function shortcutConflicts(platform = 'darwin'): string[] {
  const seen = new Set<string>();
  return BROWSER_COMMANDS.flatMap((command) => {
    if (!command.accelerator) return [];
    const key = normalizeShortcut(command.accelerator, platform);
    if (seen.has(key)) return [key];
    seen.add(key);
    return [];
  });
}

export interface ShortcutInput {
  key: string;
  type: string;
  control: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
  isComposing?: boolean;
}

export function matchShortcut(input: ShortcutInput, platform = 'darwin'): CommandId | undefined {
  if (input.type !== 'keyDown' || input.isComposing) return;
  const key = input.key.toLowerCase().replace(/^arrow/, '');
  const chord = [input.alt && 'alt', input.control && 'control', input.meta && 'meta', input.shift && 'shift']
    .filter(Boolean).sort().concat(key).join('+');
  return BROWSER_COMMANDS.find((command) => command.accelerator && normalizeShortcut(command.accelerator, platform) === chord)?.id;
}
