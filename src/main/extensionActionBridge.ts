import type { Session } from 'electron';
import type { ExtensionActionBadge, InstalledExtension } from '../shared/types';
import { createBadge } from './extensionActionBadge';

interface BadgeHost {
  getExtension: (id: string) => InstalledExtension | undefined;
  findByRuntimeUrl: (url: string) => InstalledExtension | undefined;
  saveBadge: (id: string, badge: ExtensionActionBadge) => void;
}

export class ExtensionActionBridge {
  private readonly badges = new Map<string, ExtensionActionBadge>();
  private readonly attached = new Set<string>();

  constructor(private readonly host: BadgeHost) {}

  attachSession(partition: string, sess: Session): void {
    if (!partition.startsWith('persist:') || this.attached.has(partition)) return;
    this.attached.add(partition);
    sess.serviceWorkers.on('console-message', (_event, details) => {
      let scope: string;
      try { scope = sess.serviceWorkers.getInfoFromVersionID(details.versionId).scope; } catch { return; }
      const extension = this.host.findByRuntimeUrl(scope);
      const request = parseActionBadgeConsole(details.message, extension?.runtimeId);
      if (!extension || !request) return;
      if ('text' in request) this.setBadgeText(extension.id, request.text);
      else this.setBadgeBackgroundColor(extension.id, request.color);
    });
  }

  getBadge(id: string): ExtensionActionBadge | undefined {
    return this.badges.get(id);
  }

  setBadgeText(id: string, text: unknown): void {
    const extension = this.host.getExtension(id);
    if (!extension?.enabled || !extension.consented) return;
    const badge = createBadge(text, this.badges.get(id)?.color);
    this.badges.set(id, badge);
    this.host.saveBadge(id, badge);
  }

  setBadgeBackgroundColor(id: string, color: unknown): void {
    const extension = this.host.getExtension(id);
    if (!extension?.enabled || !extension.consented) return;
    const badge = createBadge(this.badges.get(id)?.text, color);
    this.badges.set(id, badge);
    this.host.saveBadge(id, badge);
  }

  remove(id: string): void { this.badges.delete(id); }
}

export function parseActionBadgeConsole(message: string, runtimeId?: string): { text: string } | { color: string } | null {
  if (!runtimeId || !/^[a-p]{32}$/.test(runtimeId) || message.length > 256) return null;
  const prefix = `kinex-action:${runtimeId}:`;
  if (!message.startsWith(prefix)) return null;
  const payload = message.slice(prefix.length);
  if (payload.startsWith('text:')) return { text: payload.slice(5) };
  if (/^color:#[a-fA-F0-9]{6}$/.test(payload)) return { color: payload.slice(6) };
  return null;
}
