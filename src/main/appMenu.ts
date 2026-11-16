import { Menu, type MenuItemConstructorOptions } from 'electron';
import { BROWSER_COMMANDS, type CommandId } from '../shared/commands';

export interface AppMenuHost {
  executeCommand: (commandId: CommandId) => void;
}

export function buildAndInstallApplicationMenu(host: AppMenuHost): void {
  const command = (id: CommandId): MenuItemConstructorOptions => {
    const definition = BROWSER_COMMANDS.find((c) => c.id === id)!;
    return { label: definition.title, accelerator: definition.accelerator, click: () => host.executeCommand(id) };
  };
  const group = (category: string) => BROWSER_COMMANDS.filter((c) => c.category === category).map((c) => command(c.id));
  const template: MenuItemConstructorOptions[] = [
    { label: 'Kinex', submenu: [
      { role: 'about', label: 'About Kinex' }, command('check-updates'), command('open-settings'),
      { type: 'separator' }, { role: 'services' }, { type: 'separator' },
      { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' },
    ] },
    { label: 'File', submenu: [command('new-tab'), command('edit-url'), command('open-private-window'), command('little-kinex'),
      { type: 'separator' }, command('print-page'), command('save-page-pdf'), command('close-window')] },
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
