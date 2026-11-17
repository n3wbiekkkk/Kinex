import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InstalledExtension } from '../shared/types';
import { extractCrxZip, parseCrx3, verifyCrx3Signature, type ParsedCrx3 } from './crx';
import { ExtensionManager } from './extensionManager';
import { parseWebStoreUrl } from './extensionSupport';

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
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(entry.content.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x031e, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(entry.flags ?? 0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(entry.content.length, 24);
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

function extensionZip(overrides: ZipEntry[] = []): Buffer {
  return makeZip([
    { name: 'manifest.json', content: Buffer.from(JSON.stringify(manifest)) },
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

    await expect(manager.installFromWebStore(itemUrl, 'space-personal', 'persist:nook-default')).rejects.toThrow(/does not match/);
    const matchingUrl = `https://chromewebstore.google.com/detail/tool/${parsed.crxId}`;
    const record = await manager.installFromWebStore(matchingUrl, 'space-personal', 'persist:nook-default');
    expect(record.source).toBe('webstore');
    expect(record.webStoreUrl).toBe(matchingUrl);
    expect(record.crxId).toBe(parsed.crxId);
    expect(record.enabled).toBe(false);
  });
});
