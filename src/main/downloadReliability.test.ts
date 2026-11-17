import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DownloadItem, Session } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: vi.fn() }, shell: {} }));

import { app } from 'electron';
import { DownloadManager, getUniqueDownloadSavePath } from './downloadManager';

const temporaryDirs: string[] = [];

function directory() {
  const result = fs.mkdtempSync(path.join(os.tmpdir(), 'kinex-download-'));
  temporaryDirs.push(result);
  return result;
}

function download(filename: string) {
  const item = new EventEmitter();
  return Object.assign(item, {
    getFilename: () => filename,
    setSavePath: vi.fn(),
    getURL: () => 'https://example.org/file',
    getReceivedBytes: () => 0,
    getTotalBytes: () => 100,
    canResume: () => false,
    isPaused: () => false,
    getMimeType: () => 'application/octet-stream',
    cancel: vi.fn(() => item.emit('done', {}, 'cancelled')),
  });
}

afterEach(() => {
  vi.clearAllMocks();
  for (const dir of temporaryDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('download filename safety', () => {
  it('never returns an existing filename after more than 99 collisions', () => {
    const dir = directory();
    fs.writeFileSync(path.join(dir, 'report.pdf'), 'original');
    for (let i = 1; i < 120; i++) fs.writeFileSync(path.join(dir, `report (${i}).pdf`), 'original');
    const target = getUniqueDownloadSavePath(dir, 'report.pdf');
    expect(target).toBe(path.join(dir, 'report (120).pdf'));
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'report (99).pdf'), 'utf8')).toBe('original');
  });

  it('keeps dot names and traversal filenames inside the download directory', () => {
    const dir = directory();
    for (const filename of ['.', '..', '', '\0', '../../report.pdf', '..\\..\\file.pdf']) {
      const target = getUniqueDownloadSavePath(dir, filename);
      expect(path.dirname(target)).toBe(dir);
      expect(path.basename(target)).not.toBe('.');
      expect(path.basename(target)).not.toBe('..');
    }
  });

  it('does not follow or overwrite an existing dangling symlink', () => {
    const dir = directory();
    const destination = path.join(dir, 'outside', 'report.pdf');
    fs.symlinkSync(destination, path.join(dir, 'report.pdf'));
    expect(getUniqueDownloadSavePath(dir, 'report.pdf')).toBe(path.join(dir, 'report (1).pdf'));
    expect(fs.lstatSync(path.join(dir, 'report.pdf')).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(destination)).toBe(false);
  });

  it('reserves distinct paths across concurrent regular and private downloads until completion', () => {
    const dir = directory();
    vi.mocked(app.getPath).mockReturnValue(dir);
    const manager = new DownloadManager(() => {});
    const regular = new EventEmitter();
    const privateSession = new EventEmitter();
    manager.attachRegularSession(regular as Session);
    manager.attachPrivateSession(privateSession as Session);
    const first = download('report.pdf');
    const second = download('report.pdf');
    regular.emit('will-download', {}, first as unknown as DownloadItem);
    privateSession.emit('will-download', {}, second as unknown as DownloadItem);
    expect(first.setSavePath).toHaveBeenCalledWith(path.join(dir, 'report.pdf'));
    expect(second.setSavePath).toHaveBeenCalledWith(path.join(dir, 'report (1).pdf'));
    expect(manager.getDownloads()).toHaveLength(1);
    first.emit('done', {}, 'cancelled');
    const third = download('report.pdf');
    regular.emit('will-download', {}, third as unknown as DownloadItem);
    expect(third.setSavePath).toHaveBeenCalledWith(path.join(dir, 'report.pdf'));
    manager.dispose();
    expect(second.cancel).toHaveBeenCalledOnce();
    expect(third.cancel).toHaveBeenCalledOnce();
  });

  it('cancels requests when path selection fails or the manager has shut down', () => {
    vi.mocked(app.getPath).mockReturnValue(directory());
    const manager = new DownloadManager(() => {});
    const regular = new EventEmitter();
    manager.attachRegularSession(regular as Session);
    const item = download('report.pdf');
    item.setSavePath.mockImplementation(() => { throw new Error('File unavailable'); });
    const preventDefault = vi.fn();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    regular.emit('will-download', { preventDefault }, item);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(manager.getDownloads()).toEqual([]);
    expect(warning).toHaveBeenCalledOnce();
    manager.dispose();
    regular.emit('will-download', { preventDefault }, download('after-close.pdf'));
    expect(preventDefault).toHaveBeenCalledTimes(2);
    warning.mockRestore();
  });
});
