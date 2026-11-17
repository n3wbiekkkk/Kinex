import type { WebContents } from 'electron';

export type PictureInPictureContents = Pick<WebContents, 'isDestroyed' | 'executeJavaScript'>;

const ENTER_PIP = `(async () => {
  const video = [...document.querySelectorAll('video')].find((item) => !item.paused);
  if (!video || video.disablePictureInPicture || !document.pictureInPictureEnabled || document.pictureInPictureElement) return false;
  try { await video.requestPictureInPicture(); return true; } catch { return false; }
})()`;
const EXIT_PIP = `(async () => {
  if (document.pictureInPictureElement) await document.exitPictureInPicture();
  return true;
})()`;
export { EXIT_PIP };

export async function enterPiP(contents: PictureInPictureContents | undefined): Promise<boolean> {
  if (!contents || contents.isDestroyed()) return false;
  try { return await contents.executeJavaScript(ENTER_PIP, true) === true; } catch { return false; }
}

export async function exitPiP(contents: PictureInPictureContents | undefined): Promise<void> {
  if (!contents || contents.isDestroyed()) return;
  try { await contents.executeJavaScript(EXIT_PIP, true); } catch {}
}

export class AutoPictureInPicture {
  private previousId: string | undefined;
  private readonly activeIds = new Set<string>();

  get activeTabId(): string | undefined { return this.previousId; }

  async select(nextId: string | undefined, getContents: (id: string) => PictureInPictureContents | undefined): Promise<void> {
    if (this.previousId === nextId) return;
    if (this.previousId && this.activeIds.has(this.previousId)) {
      await exitPiP(getContents(this.previousId));
      this.activeIds.delete(this.previousId);
    }
    this.previousId = nextId;
    if (nextId && await enterPiP(getContents(nextId))) this.activeIds.add(nextId);
  }

  async clear(getContents: (id: string) => PictureInPictureContents | undefined): Promise<void> {
    for (const id of this.activeIds) await exitPiP(getContents(id));
    this.activeIds.clear();
    this.previousId = undefined;
  }
}
