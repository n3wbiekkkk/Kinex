import { Menu, type MenuItemConstructorOptions } from 'electron';
import { BROWSER_COMMANDS, type CommandId } from '../shared/commands';
import { isMac } from './platformSupport';

export interface AppMenuHost {
  executeCommand: (commandId: CommandId) => void;
}

/**
 * Build the application menu for the current platform.
 *
 * The `services`, `hide`, `hideOthers` and `unhide` roles are macOS-only. On
 * Windows/Linux they are omitted and their commands plus `quit` are folded
 * into the File menu instead, so the menu stays complete and every platform
 * gets a working, non-throwing template.
 */
export function buildAndInstallApplicationMenu(host: AppMenuHost): void {
  const command = (id: CommandId): MenuItemConstructorOptions => {
    const definition = BROWSER_COMMANDS.find((c) => c.id === id)!;
    return { label: definition.title, accelerator: definition.accelerator, click: () => host.executeCommand(id) };
  };
  const group = (category: string): MenuItemConstructorOptions[] =>
    BROWSER_COMMANDS.filter((c) => c.category === category).map((c) => command(c.id));

  const appCommands: MenuItemConstructorOptions[] = [
    command('check-updates'), command('open-settings'), command('manage-extensions'),
  ];
  const fileCommands: MenuItemConstructorOptions[] = [
    command('new-tab'), command('new-window'), command('edit-url'), command('open-private-window'), command('little-kinex'),
    { type: 'separator' }, command('print-page'), command('save-page-pdf'), command('close-window'),
  ];

  const mac = isMac();
  const appMenuItem: MenuItemConstructorOptions[] = mac ? [{
    label: 'Kinex',
    submenu: [
      { role: 'about', label: 'About Kinex' }, ...appCommands,
      { type: 'separator' }, { role: 'services' }, { type: 'separator' },
      { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' },
    ],
  }] : [];
  const fileSubmenu: MenuItemConstructorOptions[] = mac
    ? fileCommands
    : [...appCommands, { type: 'separator' }, ...fileCommands, { type: 'separator' }, { role: 'quit' }];

  const template: MenuItemConstructorOptions[] = [
    ...appMenuItem,
    { label: 'File', submenu: fileSubmenu },
    { role: 'editMenu' },
    { label: 'Tabs', submenu: group('Tabs') },
    { label: 'View', submenu: [...group('View'), { type: 'separator' }, { role: 'togglefullscreen' }] },
    { label: 'History', submenu: group('Navigation') },
    { label: 'Spaces', submenu: group('Spaces') },
    { label: 'Tools', submenu: group('Tools') },
    { role: 'windowMenu' },
    { role: 'help', submenu: [command('open-shortcuts')] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
