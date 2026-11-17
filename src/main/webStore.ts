import https from 'node:https';
import type { IncomingMessage } from 'node:http';
import { parseCrx3, verifyCrx3Signature, type ParsedCrx3, MAX_CRX_BYTES } from './crx';
import { RUNTIME_ID_RE } from './extensionSupport';

const DOWNLOAD_HOSTS = new Set([
  'clients2.google.com',
  'clients2.googleusercontent.com',
  'clients2.googleusercontent.cn',
  'storage.googleapis.com',
]);
const MAX_DOWNLOAD_BYTES = MAX_CRX_BYTES;
const DOWNLOAD_TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 4;

export function buildCrxDownloadUrl(extensionId: string): string | null {
  if (!RUNTIME_ID_RE.test(extensionId)) return null;
  const chromeVersion = /^\d+\.\d+\.\d+\.\d+$/.test(process.versions.chrome) ? process.versions.chrome : '120.0.0.0';
  const params = new URLSearchParams({
    response: 'redirect',
    acceptformat: 'crx3',
    prodversion: chromeVersion,
    x: `id=${extensionId}&uc`,
  });
  return `https://clients2.google.com/service/update2/crx?${params.toString()}`;
}

function request(url: string, redirectsLeft: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      reject(new Error('Invalid CRX download URL'));
      return;
    }
    if (parsed.protocol !== 'https:' || !DOWNLOAD_HOSTS.has(parsed.hostname.toLowerCase())) {
      reject(new Error('CRX download host is not allowed'));
      return;
    }
    const req = https.get(url, { timeout: DOWNLOAD_TIMEOUT_MS }, (response: IncomingMessage) => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        if (redirectsLeft === 0) {
          reject(new Error('Too many CRX download redirects'));
          return;
        }
        let next: string;
        try {
          next = new URL(response.headers.location, url).toString();
        } catch {
          reject(new Error('Invalid CRX download redirect'));
          return;
        }
        request(next, redirectsLeft - 1).then(resolve, reject);
        return;
      }
      if (status !== 200) {
        response.resume();
        reject(new Error(`CRX download failed (HTTP ${status})`));
        return;
      }
      const length = Number(response.headers['content-length']);
      if (Number.isFinite(length) && length > MAX_DOWNLOAD_BYTES) {
        response.resume();
        reject(new Error('CRX package is too large'));
        return;
      }
      const chunks: Buffer[] = [];
      let total = 0;
      response.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > MAX_DOWNLOAD_BYTES) {
          response.destroy(new Error('CRX package is too large'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => resolve(Buffer.concat(chunks)));
      response.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('CRX download timed out')));
    req.on('error', reject);
  });
}

export async function downloadWebStoreCrx(extensionId: string): Promise<ParsedCrx3> {
  const url = buildCrxDownloadUrl(extensionId);
  if (!url) throw new Error('Invalid Chrome Web Store extension id');
  const buffer = await request(url, MAX_REDIRECTS);
  const parsed = parseCrx3(buffer);
  if (parsed.crxId !== extensionId) throw new Error('Downloaded extension id does not match the Web Store item');
  if (!verifyCrx3Signature(parsed)) throw new Error('CRX3 signature verification failed');
  return parsed;
}
