import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InstalledExtension } from '../shared/types';
import { extractCrxZip, parseCrx3, verifyCrx3Signature, type ParsedCrx3 } from './crx';
import { ExtensionManager } from './extensionManager';
import { MAX_EXTENSION_BYTES, parseWebStoreUrl } from './extensionSupport';
import { buildCrxDownloadUrl } from './webStore';

const temporaryDirs: string[] = [];
const RUNTIME_ID = 'a'.repeat(32);

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirs.push(dir);
  return dir;
}

function varint(value: number): Buffer {
  const bytes: number[] = [];
  let rest = value;
  do {
    let byte = rest & 0x7f;
    rest = Math.floor(rest / 128);
    if (rest) byte |= 0x80;
    bytes.push(byte);
  } while (rest);
  return Buffer.from(bytes);
}

function protoField(field: number, value: Buffer): Buffer {
  return Buffer.concat([varint(field * 8 + 2), varint(value.length), value]);
}

interface ZipEntry {
  name: string;
  content: Buffer;
  attrs?: number;
  flags?: number;
  method?: 0 | 8;
  /** Test-only overrides so size guards can be exercised without huge allocations. */
  uncompressedSize?: number;
  compressedSize?: number;
}

function makeZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const method = entry.method ?? 0;
    const payload = method === 8 ? zlib.deflateRawSync(entry.content) : entry.content;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(entry.flags ?? 0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(entry.compressedSize ?? payload.length, 18);
    local.writeUInt32LE(entry.uncompressedSize ?? entry.content.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x031e, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(entry.flags ?? 0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(entry.compressedSize ?? payload.length, 20);
    central.writeUInt32LE(entry.uncompressedSize ?? entry.content.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(entry.attrs ?? ((0o100600 << 16) >>> 0), 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + payload.length;
  }
  const centralBuffer = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuffer, eocd]);
}

const manifest = {
  manifest_version: 3,
  name: 'CRX Fixture',
  version: '1.0.0',
  permissions: ['storage'],
  host_permissions: [],
  content_scripts: [{ matches: ['http://127.0.0.1/*'], js: ['content.js'] }],
  action: { default_popup: 'popup.html' },
};

function extensionZip(overrides: ZipEntry[] = [], manifestOverrides: Record<string, unknown> = {}): Buffer {
  return makeZip([
    { name: 'manifest.json', content: Buffer.from(JSON.stringify({ ...manifest, ...manifestOverrides })) },
    { name: 'content.js', content: Buffer.from('document.body.dataset.crx = "yes";') },
    { name: 'popup.html', content: Buffer.from('<!doctype html><title>Popup</title>') },
    ...overrides,
  ]);
}

function makeCrx3(zip: Buffer, keyPair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })): { buffer: Buffer; crxId: string } {
  const publicKey = keyPair.publicKey.export({ type: 'spki', format: 'der' });
  const signature = crypto.sign('sha256', zip, keyPair.privateKey);
  const proof = Buffer.concat([protoField(1, publicKey), protoField(2, signature)]);
  const idBytes = crypto.createHash('sha256').update(publicKey).digest().subarray(0, 16);
  const crxId = [...idBytes]
    .map((byte) => String.fromCharCode(97 + (byte >> 4)) + String.fromCharCode(97 + (byte & 0x0f))).join('');
  const header = Buffer.concat([protoField(2, proof), protoField(4, idBytes)]);
  const prefix = Buffer.alloc(12);
  prefix.write('Cr24', 0, 'ascii');
  prefix.writeUInt32LE(3, 4);
  prefix.writeUInt32LE(header.length, 8);
  return { buffer: Buffer.concat([prefix, header, zip]), crxId };
}

function makeRawCrx3(header: Buffer, zip: Buffer): Buffer {
  const prefix = Buffer.alloc(12);
  prefix.write('Cr24', 0, 'ascii');
  prefix.writeUInt32LE(3, 4);
  prefix.writeUInt32LE(header.length, 8);
  return Buffer.concat([prefix, header, zip]);
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of temporaryDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('CRX3 parsing and signature verification', () => {
  it('parses a signed CRX3, derives its id and verifies the payload', () => {
    const zip = extensionZip();
    const { buffer, crxId } = makeCrx3(zip);
    const parsed = parseCrx3(buffer);
    expect(parsed.crxId).toBe(crxId);
    expect(parsed.zip.equals(zip)).toBe(true);
    expect(verifyCrx3Signature(parsed)).toBe(true);
  });

  it('rejects tampered payloads, bad magic and unsupported versions', () => {
    const zip = extensionZip();
    const { buffer } = makeCrx3(zip);
    const tampered = Buffer.from(buffer);
    tampered[tampered.length - 1] ^= 0xff;
    expect(verifyCrx3Signature(parseCrx3(tampered))).toBe(false);

    const badMagic = Buffer.from(buffer);
    badMagic.write('BAD!', 0, 'ascii');
    expect(() => parseCrx3(badMagic)).toThrow(/Not a CRX3/);
    const badVersion = Buffer.from(buffer);
    badVersion.writeUInt32LE(2, 4);
    expect(() => parseCrx3(badVersion)).toThrow(/CRX3/);
  });

  it('cannot bypass signature validation via the declared id or missing proofs', () => {
    const zip = extensionZip();
    const keyPair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const publicKey = keyPair.publicKey.export({ type: 'spki', format: 'der' });
    const signature = crypto.sign('sha256', zip, keyPair.privateKey);
    const idBytes = crypto.createHash('sha256').update(publicKey).digest().subarray(0, 16);
    const proof = Buffer.concat([protoField(1, publicKey), protoField(2, signature)]);

    expect(() => parseCrx3(makeRawCrx3(protoField(4, idBytes), zip))).toThrow(/no signing key/);

    const wrongId = Buffer.alloc(16, 0);
    expect(() => parseCrx3(makeRawCrx3(
      Buffer.concat([protoField(2, proof), protoField(4, wrongId)]), zip
    ))).toThrow(/does not match/);

    expect(() => parseCrx3(makeRawCrx3(
      Buffer.concat([protoField(2, proof), protoField(4, idBytes.subarray(0, 15))]), zip
    ))).toThrow(/Invalid CRX3 id field/);
  });

  it('rejects a corrupted signature and only accepts a proof matching the declared id', () => {
    const zip = extensionZip();
    const signer = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const signerKey = signer.publicKey.export({ type: 'spki', format: 'der' });
    const otherKey = other.publicKey.export({ type: 'spki', format: 'der' });
    const idBytes = crypto.createHash('sha256').update(signerKey).digest().subarray(0, 16);
    const validSignature = crypto.sign('sha256', zip, signer.privateKey);
    const corruptSignature = Buffer.from(validSignature);
    corruptSignature[0] ^= 0xff;
    const badProof = Buffer.concat([protoField(1, signerKey), protoField(2, corruptSignature)]);
    const badParsed = parseCrx3(makeRawCrx3(
      Buffer.concat([protoField(2, badProof), protoField(4, idBytes)]), zip
    ));
    expect(verifyCrx3Signature(badParsed)).toBe(false);

    // A valid signature from a different key must not authorize the declared id.
    const otherProof = Buffer.concat([
      protoField(1, otherKey),
      protoField(2, crypto.sign('sha256', zip, other.privateKey)),
    ]);
    const wrongKeyParsed = parseCrx3(makeRawCrx3(
      Buffer.concat([protoField(3, otherProof), protoField(2, badProof), protoField(4, idBytes)]), zip
    ));
    expect(verifyCrx3Signature(wrongKeyParsed)).toBe(false);

    const goodProof = Buffer.concat([protoField(1, signerKey), protoField(2, validSignature)]);
    const goodParsed = parseCrx3(makeRawCrx3(
      Buffer.concat([protoField(3, otherProof), protoField(2, goodProof), protoField(4, idBytes)]), zip
    ));
    expect(verifyCrx3Signature(goodParsed)).toBe(true);
  });

  it('extracts ZIP entries safely with deflate support', () => {
    const zip = makeZip([
      { name: 'manifest.json', content: Buffer.from(JSON.stringify(manifest)), method: 8 },
      { name: 'nested/content.js', content: Buffer.from('ok'), method: 8 },
    ]);
    const target = path.join(tempDir('kinex-crx-zip-'), 'ext');
    fs.mkdirSync(target);
    extractCrxZip(zip, target);
    expect(JSON.parse(fs.readFileSync(path.join(target, 'manifest.json'), 'utf8'))).toEqual(manifest);
    expect(fs.readFileSync(path.join(target, 'nested', 'content.js'), 'utf8')).toBe('ok');
  });

  it('blocks zip-slip, absolute paths, symlinks and encrypted entries', () => {
    const cases: Array<{ entry: ZipEntry; message: RegExp }> = [
      { entry: { name: '../escape.txt', content: Buffer.from('bad') }, message: /Unsafe/ },
      { entry: { name: 'a/../../escape.txt', content: Buffer.from('bad') }, message: /Unsafe/ },
      { entry: { name: 'a/b/../../../escape.txt', content: Buffer.from('bad') }, message: /Unsafe/ },
      { entry: { name: '..\\escape.txt', content: Buffer.from('bad') }, message: /Unsafe/ },
      { entry: { name: 'C:/escape.txt', content: Buffer.from('bad') }, message: /Unsafe/ },
      { entry: { name: 'evil\u0000.js', content: Buffer.from('bad') }, message: /Unsafe/ },
      { entry: { name: '/etc/evil.txt', content: Buffer.from('bad') }, message: /Unsafe/ },
      { entry: { name: 'link.js', content: Buffer.from('bad'), attrs: 0xa1ff0000 }, message: /links/ },
      { entry: { name: 'secret.js', content: Buffer.from('bad'), flags: 1 }, message: /Encrypted/ },
      { entry: { name: 'archive.bz2', content: Buffer.from('bad'), method: 12 }, message: /compression/ },
    ];
    for (const [index, testCase] of cases.entries()) {
      const target = path.join(tempDir('kinex-crx-unsafe-'), `ext-${index}`);
      fs.mkdirSync(target);
      expect(() => extractCrxZip(makeZip([testCase.entry]), target)).toThrow(testCase.message);
      expect(fs.readdirSync(target)).toEqual([]);
    }
  });

  it('rejects oversized entries, decompression bombs and duplicate destinations', () => {
    const storedTarget = path.join(tempDir('kinex-crx-oversize-'), 'ext');
    fs.mkdirSync(storedTarget);
    const oversized = makeZip([{
      name: 'big.bin', content: Buffer.from('x'), uncompressedSize: MAX_EXTENSION_BYTES + 1,
    }]);
    expect(() => extractCrxZip(oversized, storedTarget)).toThrow(/too large/);
    expect(fs.readdirSync(storedTarget)).toEqual([]);

    const bombTarget = path.join(tempDir('kinex-crx-bomb-'), 'ext');
    fs.mkdirSync(bombTarget);
    const bomb = makeZip([{ name: 'bomb.bin', content: Buffer.alloc(MAX_EXTENSION_BYTES + 1024), method: 8 }]);
    expect(() => extractCrxZip(bomb, bombTarget)).toThrow(/too large/);

    const dupTarget = path.join(tempDir('kinex-crx-dup-'), 'ext');
    fs.mkdirSync(dupTarget);
    const duplicate = makeZip([
      { name: 'dup.js', content: Buffer.from('a') },
      { name: 'dup.js', content: Buffer.from('b') },
    ]);
    expect(() => extractCrxZip(duplicate, dupTarget)).toThrow(/duplicate/);
  });
});

describe('Chrome Web Store URL validation', () => {
  it('accepts item URLs and bare ids and rejects other hosts or schemes', () => {
    const id = 'a'.repeat(32);
    expect(parseWebStoreUrl(`https://chromewebstore.google.com/detail/some-tool/${id}`)?.extensionId).toBe(id);
    expect(parseWebStoreUrl(id)?.extensionId).toBe(id);
    expect(parseWebStoreUrl(`http://chromewebstore.google.com/detail/tool/${id}`)).toBeNull();
    expect(parseWebStoreUrl(`https://evil.example.com/detail/tool/${id}`)).toBeNull();
    expect(parseWebStoreUrl('https://chromewebstore.google.com/detail/tool/not-an-id')).toBeNull();
  });

  it('only allows the exact allowlisted hosts and HTTPS, with the id in the path', () => {
    const id = 'a'.repeat(32);
    expect(parseWebStoreUrl(`https://chrome.google.com/webstore/detail/tool/${id}`)?.extensionId).toBe(id);
    expect(parseWebStoreUrl(123)).toBeNull();
    expect(parseWebStoreUrl('')).toBeNull();
    expect(parseWebStoreUrl('a'.repeat(2049))).toBeNull();
    expect(parseWebStoreUrl(`//chromewebstore.google.com/detail/tool/${id}`)).toBeNull();
    expect(parseWebStoreUrl(`data:text/html,${id}`)).toBeNull();
    expect(parseWebStoreUrl(`file:///detail/tool/${id}`)).toBeNull();
    expect(parseWebStoreUrl(`https://chromewebstore.google.com.evil.example/detail/tool/${id}`)).toBeNull();
    expect(parseWebStoreUrl(`https://evil.chromewebstore.google.com/detail/tool/${id}`)).toBeNull();
    expect(parseWebStoreUrl(`https://chromewebstore.google.com./detail/tool/${id}`)).toBeNull();
    expect(parseWebStoreUrl(`https://chromewebstore.google.com/detail/tool?x=${id}`)).toBeNull();
  });

  it('builds download URLs only for valid ids and keeps the host/scheme fixed', () => {
    const url = buildCrxDownloadUrl('a'.repeat(32));
    expect(url).not.toBeNull();
    const parsed = new URL(url!);
    expect(parsed.protocol).toBe('https:');
    expect(parsed.hostname).toBe('clients2.google.com');
    expect(parsed.searchParams.get('acceptformat')).toBe('crx3');
    expect(buildCrxDownloadUrl('../'.repeat(10))).toBeNull();
    expect(buildCrxDownloadUrl('not-an-id')).toBeNull();
    expect(buildCrxDownloadUrl('')).toBeNull();
  });
});

describe('CRX and Web Store installation', () => {
  it('installs a local CRX with verified signature, provenance and consent gating', async () => {
    const dir = tempDir('kinex-crx-install-');
    const { buffer, crxId } = makeCrx3(extensionZip());
    const crxPath = path.join(dir, 'fixture.crx');
    fs.writeFileSync(crxPath, buffer);
    const loadExtension = vi.fn(async () => ({ id: RUNTIME_ID }));
    let extensions: InstalledExtension[] = [];
    const manager = new ExtensionManager(dir, {
      getExtensions: () => extensions,
      commitExtensions: (next) => { extensions = next; },
      getSessionForPartition: () => ({ extensions: { getAllExtensions: () => [], loadExtension, removeExtension: vi.fn() } }) as any,
      showToast: () => {},
    });

    const record = await manager.installFromCrx(crxPath, 'space-personal', 'persist:nook-default');
    expect(record.source).toBe('crx');
    expect(record.crxId).toBe(crxId);
    expect(record.enabled).toBe(false);
    expect(record.consented).toBe(false);
    expect(() => manager.setEnabled(record.id, true)).toThrow(/Review and accept/);
    manager.setEnabled(record.id, true, true);
    await vi.waitFor(() => expect(loadExtension).toHaveBeenCalledWith(expect.stringContaining(record.id), { allowFileAccess: false }));

    const corruptPath = path.join(dir, 'corrupt.crx');
    fs.writeFileSync(corruptPath, Buffer.concat([buffer.subarray(0, buffer.length - 4), Buffer.from('0000')]));
    await expect(manager.installFromCrx(corruptPath, 'space-personal', 'persist:nook-default')).rejects.toThrow();
    expect(extensions).toHaveLength(1);
  });

  it('installs a Web Store CRX only when the downloaded id matches the requested id', async () => {
    const dir = tempDir('kinex-crx-store-');
    const itemUrl = `https://chromewebstore.google.com/detail/tool/${'b'.repeat(32)}`;
    const parsed: ParsedCrx3 = parseCrx3(makeCrx3(extensionZip()).buffer);
    let extensions: InstalledExtension[] = [];
    const manager = new ExtensionManager(dir, {
      getExtensions: () => extensions,
      commitExtensions: (next) => { extensions = next; },
      getSessionForPartition: () => ({ extensions: { getAllExtensions: () => [], loadExtension: vi.fn(), removeExtension: vi.fn() } }) as any,
      showToast: () => {},
      downloadWebStoreCrx: async () => parsed,
    });

    await expect(manager.installFromWebStore(itemUrl, 'space-personal', 'persist:nook-default', true)).rejects.toThrow(/does not match/);
    const matchingUrl = `https://chromewebstore.google.com/detail/tool/${parsed.crxId}`;
    const record = await manager.installFromWebStore(matchingUrl, 'space-personal', 'persist:nook-default', true);
    expect(record.source).toBe('webstore');
    expect(record.webStoreUrl).toBe(matchingUrl);
    expect(record.crxId).toBe(parsed.crxId);
    expect(record.enabled).toBe(false);
    expect(record.consented).toBe(false);
  });

  it('never downloads a Web Store CRX without explicit consent or a persistent partition', async () => {
    const dir = tempDir('kinex-crx-consent-');
    const download = vi.fn(async () => parseCrx3(makeCrx3(extensionZip()).buffer));
    const manager = new ExtensionManager(dir, {
      getExtensions: () => [],
      commitExtensions: () => {},
      getSessionForPartition: () => ({ extensions: { getAllExtensions: () => [], loadExtension: vi.fn(), removeExtension: vi.fn() } }) as any,
      showToast: () => {},
      downloadWebStoreCrx: download,
    });
    const url = `https://chromewebstore.google.com/detail/tool/${'b'.repeat(32)}`;

    await expect(manager.installFromWebStore(url, 'space-personal', 'persist:nook-default')).rejects.toThrow(/Confirm/);
    await expect(manager.installFromWebStore(url, 'space-personal', 'persist:nook-default', false)).rejects.toThrow(/Confirm/);
    await expect(manager.installFromWebStore(url, 'space-personal', 'kinex-private-1', true)).rejects.toThrow(/Invalid extension install request/);
    expect(download).not.toHaveBeenCalled();
  });

  it('refuses a Web Store download whose signature does not verify', async () => {
    const dir = tempDir('kinex-crx-store-signature-');
    const parsed = parseCrx3(makeCrx3(extensionZip()).buffer);
    const corruptedZip = Buffer.from(parsed.zip);
    corruptedZip[corruptedZip.length - 1] ^= 0xff;
    const manager = new ExtensionManager(dir, {
      getExtensions: () => [],
      commitExtensions: () => {},
      getSessionForPartition: () => ({ extensions: { getAllExtensions: () => [], loadExtension: vi.fn(), removeExtension: vi.fn() } }) as any,
      showToast: () => {},
      downloadWebStoreCrx: async () => ({ ...parsed, zip: corruptedZip }),
    });
    await expect(manager.installFromWebStore(
      `https://chromewebstore.google.com/detail/tool/${parsed.crxId}`,
      'space-personal', 'persist:nook-default', true
    )).rejects.toThrow(/signature/);
  });
});

  it('preserves the signed worker source and wraps only consented CRX action badges', async () => {
    const dir = tempDir('kinex-crx-badge-worker-');
    const workerSource = 'chrome.runtime.onInstalled.addListener(() => {});';
    const { buffer, crxId } = makeCrx3(extensionZip([], { background: { service_worker: 'worker.js' } }));
    fs.writeFileSync(path.join(dir, 'badge.crx'), buffer);
    const decoded = parseCrx3(buffer);
    fs.writeFileSync(path.join(dir, 'badge.zip'), decoded.zip);
    const complete = extensionZip([
      { name: 'worker.js', content: Buffer.from(workerSource) },
    ], { background: { service_worker: 'worker.js' } });
    const signed = makeCrx3(complete);
    fs.writeFileSync(path.join(dir, 'badge.crx'), signed.buffer);
    let extensions: InstalledExtension[] = [];
    const manager = new ExtensionManager(dir, {
      getExtensions: () => extensions,
      commitExtensions: (next) => { extensions = next; },
      getSessionForPartition: () => ({ extensions: { getAllExtensions: () => [], loadExtension: vi.fn(), removeExtension: vi.fn() } }) as never,
      showToast: () => {},
    });
    const record = await manager.installFromCrx(path.join(dir, 'badge.crx'), 'space-personal', 'persist:nook-default');
    const target = path.join(dir, 'Extensions', record.id);
    const manifest = JSON.parse(fs.readFileSync(path.join(target, 'manifest.json'), 'utf8'));
    expect(signed.crxId).toBe(record.crxId);
    expect(manifest.background.service_worker).toBe('__kinex_action_badge_worker.js');
    expect(fs.readFileSync(path.join(target, 'worker.js.kinex-original'), 'utf8')).toBe(workerSource);
    const wrapper = fs.readFileSync(path.join(target, '__kinex_action_badge_worker.js'), 'utf8');
    expect(wrapper).toContain(signed.crxId);
    const calls: unknown[][] = [];
    const logs: string[] = [];
    const chrome = {
      action: {
        setBadgeText: (details: { text: string }) => calls.push(details.text),
        setBadgeBackgroundColor: (details: { color: string }) => calls.push(details.color),
      },
    };
    new Function('chrome', 'console', 'importScripts', wrapper)(chrome, { log: (message: string) => logs.push(message) }, () => {});
    chrome.action.setBadgeText({ text: '12' });
    chrome.action.setBadgeBackgroundColor({ color: '#112233' });
    expect(calls).toEqual(['12', '#112233']);
    expect(logs).toEqual([
      `kinex-action:${signed.crxId}:text:12`,
      `kinex-action:${signed.crxId}:color:#112233`,
    ]);
  });
