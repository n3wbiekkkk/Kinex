import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { app } from 'electron';
import type { ShieldsFilterListMeta } from '../../shared/types';

export const MAX_FILTER_LIST_BYTES = 12 * 1024 * 1024;
const MAX_RULE_LINE_LENGTH = 2048;
const FETCH_TIMEOUT_MS = 20_000;

export interface LoadedFilterListText {
  meta: ShieldsFilterListMeta;
  rawText: string;
  ruleCount: number;
}

export function resolveBundledFilterDir(): string {
  const candidates = [
    path.join(app?.getAppPath?.() ?? process.cwd(), 'resources', 'filters'),
    path.join(__dirname, '../../../resources/filters'),
    path.join(process.cwd(), 'resources', 'filters'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(dir)) return dir;
  }
  return candidates[0];
}

export function validateAndNormalizeFilterText(rawInput: string): {
  ok: true;
  text: string;
  ruleCount: number;
} | {
  ok: false;
  reason: string;
} {
  if (!rawInput || typeof rawInput !== 'string') {
    return { ok: false, reason: 'Empty filter list response' };
  }
  if (rawInput.length > MAX_FILTER_LIST_BYTES) {
    return { ok: false, reason: `Filter list exceeds ${MAX_FILTER_LIST_BYTES / (1024 * 1024)} MB safety limit` };
  }
  if (rawInput.includes('\0')) {
    return { ok: false, reason: 'Binary or null-byte payload rejected' };
  }
  const head = rawInput.slice(0, 512).trimStart().toLowerCase();
  if (head.startsWith('<!doctype html') || head.startsWith('<html') || head.startsWith('{')) {
    return { ok: false, reason: 'Remote host returned HTML/JSON instead of an Adblock Plus filter list' };
  }

  const lines = rawInput.split(/\r?\n/);
  const cleanLines: string[] = [];
  let ruleCount = 0;

  for (const rawLine of lines) {
    if (rawLine.length > MAX_RULE_LINE_LENGTH) continue;
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    cleanLines.push(trimmed);
    if (!trimmed.startsWith('!') && !trimmed.startsWith('[')) {
      ruleCount += 1;
    }
  }

  if (ruleCount === 0) {
    return { ok: false, reason: 'Filter list contains zero active rules' };
  }

  return { ok: true, text: cleanLines.join('\n'), ruleCount };
}

export function loadFilterListFromDisk(
  userDataDir: string,
  meta: ShieldsFilterListMeta
): LoadedFilterListText | null {
  const downloadedPath = path.join(userDataDir, 'shields-lists', `${meta.id}.txt.gz`);
  const bundledPath = path.join(resolveBundledFilterDir(), meta.bundledFile);

  for (const candidate of [downloadedPath, bundledPath]) {
    if (!fs.existsSync(candidate)) continue;
    try {
      const gz = fs.readFileSync(candidate);
      const rawText = zlib.gunzipSync(gz, { maxOutputLength: MAX_FILTER_LIST_BYTES }).toString('utf8');
      const validated = validateAndNormalizeFilterText(rawText);
      if (validated.ok) {
        return {
          meta: { ...meta, ruleCount: validated.ruleCount },
          rawText: validated.text,
          ruleCount: validated.ruleCount,
        };
      }
    } catch {
      // Fall back cleanly from corrupt downloaded cache to bundled last-known-good file
    }
  }

  return null;
}

export function writeFilterListAtomically(userDataDir: string, listId: string, cleanText: string): void {
  const dir = path.join(userDataDir, 'shields-lists');
  fs.mkdirSync(dir, { recursive: true });
  const compressed = zlib.gzipSync(Buffer.from(cleanText, 'utf8'));
  const targetPath = path.join(dir, `${listId}.txt.gz`);
  const tmpPath = path.join(dir, `${listId}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmpPath, compressed);
  fs.renameSync(tmpPath, targetPath);
}

export async function downloadAndVerifyFilterList(
  sourceUrl: string,
  fetchImpl: typeof fetch = fetch
): Promise<{ ok: true; text: string; ruleCount: number } | { ok: false; error: string }> {
  let parsed: URL;
  try {
    parsed = new URL(sourceUrl);
  } catch {
    return { ok: false, error: 'Invalid filter list URL' };
  }

  const isLocalLoopback =
    parsed.protocol === 'http:' &&
    (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost');
  if (parsed.protocol !== 'https:' && !isLocalLoopback) {
    return { ok: false, error: 'Filter list subscriptions require HTTPS' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(parsed.toString(), {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'Kinex-Shields-Updater',
        Accept: 'text/plain, text/*;q=0.9',
      },
    });
    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status} while fetching filter list` };
    }

    const contentLen = Number(response.headers.get('content-length') || 0);
    if (Number.isFinite(contentLen) && contentLen > MAX_FILTER_LIST_BYTES) {
      return { ok: false, error: 'Remote filter list exceeds size limit' };
    }

    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    const reader = response.body?.getReader();
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          totalBytes += value.byteLength;
          if (totalBytes > MAX_FILTER_LIST_BYTES) {
            void reader.cancel();
            return { ok: false, error: 'Remote filter list exceeded 12 MB safety limit' };
          }
          chunks.push(value);
        }
      }
    } else {
      const txt = await response.text();
      if (Buffer.byteLength(txt, 'utf8') > MAX_FILTER_LIST_BYTES) {
        return { ok: false, error: 'Remote filter list exceeded 12 MB safety limit' };
      }
      chunks.push(Buffer.from(txt, 'utf8'));
    }

    const combined = Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength))).toString('utf8');
    const validated = validateAndNormalizeFilterText(combined);
    if (!validated.ok) {
      return { ok: false, error: validated.reason };
    }
    return validated;
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Network error updating filter list',
    };
  } finally {
    clearTimeout(timer);
  }
}
