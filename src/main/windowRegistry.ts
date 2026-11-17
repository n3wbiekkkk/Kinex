import type { BrowserWindow } from 'electron';
import type { PersistedWindowState } from '../shared/types';

export interface RegisteredWindow {
  id: string;
  win: BrowserWindow;
  state: PersistedWindowState;
}

export class WindowSessionRegistry {
  private readonly byId = new Map<string, RegisteredWindow>();

  register(id: string, win: BrowserWindow, state: PersistedWindowState): RegisteredWindow {
    const record = { id, win, state: { ...state } };
    this.byId.set(id, record);
    return record;
  }

  unregister(id: string): void {
    this.byId.delete(id);
  }

  get(id: string): RegisteredWindow | undefined {
    return this.byId.get(id);
  }

  find(win: BrowserWindow): RegisteredWindow | undefined {
    for (const record of this.byId.values()) {
      if (record.win === win) return record;
    }
    return undefined;
  }

  list(): RegisteredWindow[] {
    return [...this.byId.values()];
  }

  update(id: string, patch: Partial<PersistedWindowState>): void {
    const record = this.byId.get(id);
    if (record) record.state = { ...record.state, ...patch };
  }

  capture(id: string): PersistedWindowState | undefined {
    const record = this.byId.get(id);
    if (!record) return undefined;
    if (!record.win.isDestroyed()) {
      const bounds = record.win.getNormalBounds();
      record.state = {
        ...record.state,
        bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
        isMaximized: record.win.isMaximized(),
      };
    }
    return record.state;
  }

  states(): PersistedWindowState[] {
    return this.list().map((record) => ({ ...record.state }));
  }
}
