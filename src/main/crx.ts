import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import {
  MAX_EXTENSION_BYTES,
  MAX_EXTENSION_FILES,
  resolveInsideRoot,
} from './extensionSupport';

const CRX_MAGIC = 'Cr24';
export const MAX_CRX_BYTES = 50 * 1024 * 1024;
const MAX_CRX_HEADER_BYTES = 64 * 1024;
const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

export interface CrxKeyProof {
  publicKey: Buffer;
  signature: Buffer;
}

export interface ParsedCrx3 {
  crxId: string;
  proofs: CrxKeyProof[];
  zip: Buffer;
}

interface ProtoField {
  field: number;
  value: Buffer | number;
}

function readVarint(buffer: Buffer, offset: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let pos = offset;
  while (pos < buffer.length && shift < 35) {
    const byte = buffer[pos++];
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return { value, next: pos };
    shift += 7;
  }
  throw new Error('Invalid CRX3 header encoding');
}

function parseProtoFields(buffer: Buffer): ProtoField[] {
  const fields: ProtoField[] = [];
  let pos = 0;
  while (pos < buffer.length) {
    const key = readVarint(buffer, pos);
    pos = key.next;
    const field = Math.floor(key.value / 8);
    const wire = key.value % 8;
    if (field === 0) throw new Error('Invalid CRX3 header field');
    if (wire === 0) {
      const value = readVarint(buffer, pos);
      pos = value.next;
      fields.push({ field, value: value.value });
    } else if (wire === 2) {
      const length = readVarint(buffer, pos);
      pos = length.next;
      if (length.value < 0 || pos + length.value > buffer.length) throw new Error('Invalid CRX3 header length');
      fields.push({ field, value: buffer.subarray(pos, pos + length.value) });
      pos += length.value;
    } else if (wire === 1) {
      if (pos + 8 > buffer.length) throw new Error('Invalid CRX3 header field');
      pos += 8;
    } else if (wire === 5) {
      if (pos + 4 > buffer.length) throw new Error('Invalid CRX3 header field');
      pos += 4;
    } else {
      throw new Error('Unsupported CRX3 header field');
    }
  }
  return fields;
}

function crxIdFromPublicKey(publicKey: Buffer): string {
  const digest = crypto.createHash('sha256').update(publicKey).digest().subarray(0, 16);
  return [...digest]
    .map((byte) => String.fromCharCode(97 + (byte >> 4)) + String.fromCharCode(97 + (byte & 0x0f)))
    .join('');
}

export function parseCrx3(buffer: Buffer): ParsedCrx3 {
  if (buffer.length < 16 || buffer.toString('ascii', 0, 4) !== CRX_MAGIC) {
    throw new Error('Not a CRX3 package');
  }
  if (buffer.readUInt32LE(4) !== 3) throw new Error('Only CRX3 packages are supported');
  const headerSize = buffer.readUInt32LE(8);
  if (headerSize < 2 || headerSize > MAX_CRX_HEADER_BYTES || 12 + headerSize > buffer.length) {
    throw new Error('Invalid CRX3 header size');
  }
  const zip = buffer.subarray(12 + headerSize);
  if (zip.length === 0) throw new Error('CRX3 package has no payload');

  const fields = parseProtoFields(buffer.subarray(12, 12 + headerSize));
  const proofs: CrxKeyProof[] = [];
  for (const field of fields) {
    if ((field.field !== 2 && field.field !== 3) || !Buffer.isBuffer(field.value)) continue;
    const parts = parseProtoFields(field.value);
    const publicKey = parts.find((part) => part.field === 1 && Buffer.isBuffer(part.value))?.value;
    const signature = parts.find((part) => part.field === 2 && Buffer.isBuffer(part.value))?.value;
    if (Buffer.isBuffer(publicKey) && Buffer.isBuffer(signature) && publicKey.length > 0 && signature.length > 0) {
      proofs.push({ publicKey, signature });
    }
  }
  if (proofs.length === 0) throw new Error('CRX3 package has no signing key');

  const ids = new Set(proofs.map((proof) => crxIdFromPublicKey(proof.publicKey)));
  const crxIdField = fields.find((field) => field.field === 4)?.value;
  if (crxIdField !== undefined && (!Buffer.isBuffer(crxIdField) || crxIdField.length !== 16)) {
    throw new Error('Invalid CRX3 id field');
  }
  let crxId = [...ids][0];
  if (Buffer.isBuffer(crxIdField)) {
    const declared = [...crxIdField]
      .map((byte) => String.fromCharCode(97 + (byte >> 4)) + String.fromCharCode(97 + (byte & 0x0f)))
      .join('');
    if (!ids.has(declared)) throw new Error('CRX3 id does not match its signing key');
    crxId = declared;
  }
  if (!/^[a-p]{32}$/.test(crxId)) throw new Error('Invalid CRX3 extension id');
  return { crxId, proofs, zip };
}

export function verifyCrx3Signature(parsed: ParsedCrx3): boolean {
  for (const proof of parsed.proofs) {
    if (crxIdFromPublicKey(proof.publicKey) !== parsed.crxId) continue;
    try {
      const key = crypto.createPublicKey({ key: proof.publicKey, format: 'der', type: 'spki' });
      if (crypto.verify('sha256', parsed.zip, key, proof.signature)) return true;
    } catch {
      // Try the next proof.
    }
  }
  return false;
}

function findEndOfCentralDirectory(zip: Buffer): number {
  const searchStart = Math.max(0, zip.length - (65535 + 22));
  for (let pos = zip.length - 22; pos >= searchStart; pos -= 1) {
    if (zip.readUInt32LE(pos) === EOCD_SIGNATURE) return pos;
  }
  throw new Error('Invalid CRX3 ZIP payload');
}

/** Extract a CRX ZIP into targetDir with strict file-count, size, path and symlink checks. */
export function extractCrxZip(zip: Buffer, targetDir: string): void {
  const eocd = findEndOfCentralDirectory(zip);
  const entryCount = zip.readUInt16LE(eocd + 10);
  const centralOffset = zip.readUInt32LE(eocd + 16);
  if (entryCount === 0 || entryCount > MAX_EXTENSION_FILES || centralOffset + 46 > zip.length) {
    throw new Error('Invalid CRX3 ZIP directory');
  }

  let fileCount = 0;
  let totalBytes = 0;
  const written = new Set<string>();
  let pos = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (pos + 46 > zip.length || zip.readUInt32LE(pos) !== CENTRAL_SIGNATURE) {
      throw new Error('Invalid CRX3 ZIP entry');
    }
    const flags = zip.readUInt16LE(pos + 8);
    const method = zip.readUInt16LE(pos + 10);
    const compressedSize = zip.readUInt32LE(pos + 20);
    const uncompressedSize = zip.readUInt32LE(pos + 24);
    const nameLength = zip.readUInt16LE(pos + 28);
    const extraLength = zip.readUInt16LE(pos + 30);
    const commentLength = zip.readUInt16LE(pos + 32);
    const externalAttrs = zip.readUInt32LE(pos + 38);
    const localOffset = zip.readUInt32LE(pos + 42);
    const name = zip.subarray(pos + 46, pos + 46 + nameLength).toString('utf8');
    pos += 46 + nameLength + extraLength + commentLength;

    if ((flags & 1) !== 0) throw new Error('Encrypted CRX3 ZIP entries are not supported');
    if (((externalAttrs >>> 16) & 0xf000) === 0xa000) throw new Error('CRX3 ZIP links are not supported');
    if (method !== 0 && method !== 8) throw new Error('Unsupported CRX3 ZIP compression');
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) throw new Error('ZIP64 is not supported');
    if (name.includes('\0') || name.includes('\\') || name.startsWith('/') || /(^|\/)\.\.(\/|$)/.test(name)) {
      throw new Error('Unsafe CRX3 ZIP filename');
    }
    if (name.startsWith('.') || name.includes('/.')) continue;
    if (!name.endsWith('/') && !/^[a-zA-Z0-9._\-/]+$/.test(name)) throw new Error('Unsafe CRX3 ZIP filename');
    const relative = name.endsWith('/') ? name.slice(0, -1) : name;
    const destination = relative ? resolveInsideRoot(targetDir, relative) : null;
    if (name.endsWith('/')) {
      if (destination) fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
      continue;
    }
    if (!destination || written.has(destination)) throw new Error('Unsafe or duplicate CRX3 ZIP path');
    written.add(destination);

    fileCount += 1;
    totalBytes += uncompressedSize;
    if (fileCount > MAX_EXTENSION_FILES || totalBytes > MAX_EXTENSION_BYTES) {
      throw new Error('CRX3 package is too large');
    }

    if (localOffset + 30 > zip.length || zip.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
      throw new Error('Invalid CRX3 ZIP local header');
    }
    const localNameLength = zip.readUInt16LE(localOffset + 26);
    const localExtraLength = zip.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    if (dataStart + compressedSize > zip.length) throw new Error('Truncated CRX3 ZIP payload');
    const compressed = zip.subarray(dataStart, dataStart + compressedSize);
    const content = method === 8 ? zlib.inflateRawSync(compressed, { maxOutputLength: MAX_EXTENSION_BYTES }) : compressed;
    if (content.length !== uncompressedSize) throw new Error('CRX3 ZIP entry size mismatch');

    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    fs.writeFileSync(destination, content, { mode: 0o600, flag: 'wx' });
  }
}
