const crypto = require('node:crypto');
const zlib = require('node:zlib');

function varint(value) {
  const bytes = [];
  let rest = value;
  do {
    let byte = rest & 0x7f;
    rest = Math.floor(rest / 128);
    if (rest) byte |= 0x80;
    bytes.push(byte);
  } while (rest);
  return Buffer.from(bytes);
}

function protoField(field, value) {
  return Buffer.concat([varint(field * 8 + 2), varint(value.length), value]);
}

function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const method = entry.method || 0;
    const payload = method === 8 ? zlib.deflateRawSync(entry.content) : entry.content;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(entry.content.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x031e, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(entry.content.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((0o100600 << 16) >>> 0), 38);
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

function makeCrx3(zip) {
  const keyPair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicKey = keyPair.publicKey.export({ type: 'spki', format: 'der' });
  const signature = crypto.sign('sha256', zip, keyPair.privateKey);
  const proof = Buffer.concat([protoField(1, publicKey), protoField(2, signature)]);
  const idBytes = crypto.createHash('sha256').update(publicKey).digest().subarray(0, 16);
  const crxId = [...idBytes]
    .map((byte) => String.fromCharCode(97 + (byte >> 4)) + String.fromCharCode(97 + (byte & 0x0f)))
    .join('');
  const header = Buffer.concat([protoField(2, proof), protoField(4, idBytes)]);
  const prefix = Buffer.alloc(12);
  prefix.write('Cr24', 0, 'ascii');
  prefix.writeUInt32LE(3, 4);
  prefix.writeUInt32LE(header.length, 8);
  return { buffer: Buffer.concat([prefix, header, zip]), crxId };
}

module.exports = { makeZip, makeCrx3 };
