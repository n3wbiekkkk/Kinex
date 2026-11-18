/**
 * Minimal dependency-free, byte-mode QR encoder (error-correction level M).
 * Produces a deterministic boolean matrix. No DOM, no Electron, no globals
 * beyond TypedArrays/TextEncoder; safe in both Node and the renderer.
 */

export interface QrMatrix {
  version: number;
  size: number;
  errorCorrectionLevel: 'M';
  /** `modules[row][col]`; true = dark module. */
  modules: boolean[][];
}

/** Input is bounded so the chosen version stays within the supported table. */
export const MAX_QR_BYTES = 200;

interface VersionSpec {
  version: number;
  ecPerBlock: number;
  groups: Array<{ count: number; data: number }>;
  totalCodewords: number;
}

const VERSION_SPECS: readonly VersionSpec[] = [
  { version: 1, ecPerBlock: 10, groups: [{ count: 1, data: 16 }], totalCodewords: 26 },
  { version: 2, ecPerBlock: 16, groups: [{ count: 1, data: 28 }], totalCodewords: 44 },
  { version: 3, ecPerBlock: 26, groups: [{ count: 1, data: 44 }], totalCodewords: 70 },
  { version: 4, ecPerBlock: 18, groups: [{ count: 2, data: 32 }], totalCodewords: 100 },
  { version: 5, ecPerBlock: 24, groups: [{ count: 2, data: 43 }], totalCodewords: 134 },
  { version: 6, ecPerBlock: 16, groups: [{ count: 4, data: 27 }], totalCodewords: 172 },
  { version: 7, ecPerBlock: 18, groups: [{ count: 4, data: 31 }], totalCodewords: 196 },
  { version: 8, ecPerBlock: 22, groups: [{ count: 2, data: 38 }, { count: 2, data: 39 }], totalCodewords: 242 },
  { version: 9, ecPerBlock: 22, groups: [{ count: 3, data: 36 }, { count: 2, data: 37 }], totalCodewords: 292 },
  { version: 10, ecPerBlock: 26, groups: [{ count: 4, data: 43 }, { count: 1, data: 44 }], totalCodewords: 346 },
];

const ALIGNMENT_POSITIONS: Readonly<Record<number, readonly number[]>> = {
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  8: [6, 24, 42],
  9: [6, 26, 46],
  10: [6, 28, 50],
};

// GF(256) tables for the QR primitive polynomial 0x11D.
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) GF_EXP[i] = GF_EXP[i - 255]!;
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a]! + GF_LOG[b]!]!;
}

/** Generator polynomial coefficients, highest degree first (monic). */
function rsGenerator(degree: number): number[] {
  let poly = [1]; // low-degree first
  for (let i = 0; i < degree; i += 1) {
    const root = GF_EXP[i]!;
    const next = new Array<number>(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j += 1) {
      next[j]! ^= gfMul(poly[j]!, root);
      next[j + 1]! ^= poly[j]!;
    }
    poly = next;
  }
  return poly.reverse();
}

function rsRemainder(data: readonly number[], degree: number): number[] {
  const generator = rsGenerator(degree);
  const remainder = new Array<number>(degree).fill(0);
  for (const byte of data) {
    const factor = byte ^ remainder[0]!;
    remainder.shift();
    remainder.push(0);
    for (let i = 0; i < degree; i += 1) {
      remainder[i]! ^= gfMul(generator[i + 1]!, factor);
    }
  }
  return remainder;
}

function dataCapacity(spec: VersionSpec): number {
  return spec.groups.reduce((sum, group) => sum + group.count * group.data, 0);
}

function selectVersion(byteLength: number): VersionSpec {
  for (const spec of VERSION_SPECS) {
    const countBits = spec.version <= 9 ? 8 : 16;
    const neededBits = 4 + countBits + byteLength * 8;
    if (neededBits <= dataCapacity(spec) * 8) return spec;
  }
  throw new RangeError('Input is too long for the supported QR versions');
}

class BitBuffer {
  readonly bits: number[] = [];

  put(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i -= 1) this.bits.push((value >>> i) & 1);
  }
}

function buildDataCodewords(bytes: Uint8Array, spec: VersionSpec): number[] {
  const capacity = dataCapacity(spec);
  const countBits = spec.version <= 9 ? 8 : 16;
  const buffer = new BitBuffer();
  buffer.put(0b0100, 4); // byte mode
  buffer.put(bytes.length, countBits);
  for (const byte of bytes) buffer.put(byte, 8);

  const capacityBits = capacity * 8;
  const terminator = Math.min(4, Math.max(0, capacityBits - buffer.bits.length));
  if (terminator > 0) buffer.put(0, terminator);
  while (buffer.bits.length % 8 !== 0) buffer.bits.push(0);

  const codewords: number[] = [];
  for (let i = 0; i < buffer.bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j += 1) byte = (byte << 1) | buffer.bits[i + j]!;
    codewords.push(byte);
  }
  let pad = 0xec;
  while (codewords.length < capacity) {
    codewords.push(pad);
    pad = pad === 0xec ? 0x11 : 0xec;
  }
  return codewords;
}

function splitIntoBlocks(data: readonly number[], spec: VersionSpec): number[][] {
  const blocks: number[][] = [];
  let offset = 0;
  for (const group of spec.groups) {
    for (let i = 0; i < group.count; i += 1) {
      blocks.push(data.slice(offset, offset + group.data));
      offset += group.data;
    }
  }
  return blocks;
}

function interleaveCodewords(dataBlocks: number[][], ecBlocks: number[][], spec: VersionSpec): number[] {
  const result: number[] = [];
  const maxDataLength = Math.max(...dataBlocks.map((block) => block.length));
  for (let i = 0; i < maxDataLength; i += 1) {
    for (const block of dataBlocks) if (i < block.length) result.push(block[i]!);
  }
  for (let i = 0; i < spec.ecPerBlock; i += 1) {
    for (const block of ecBlocks) result.push(block[i]!);
  }
  return result;
}

function bchVersionBits(version: number): number {
  let remainder = version << 12;
  for (let i = 17; i >= 12; i -= 1) {
    if ((remainder >>> i) & 1) remainder ^= 0x1f25 << (i - 12);
  }
  return (version << 12) | remainder;
}

/** 15 format bits for EC level M (00) and mask pattern 0 (000). */
const FORMAT_M_MASK_0 = 0x5412;

function drawFinder(modules: boolean[][], reserved: boolean[][], row: number, col: number): void {
  const size = modules.length;
  for (let dr = -4; dr <= 4; dr += 1) {
    for (let dc = -4; dc <= 4; dc += 1) {
      const r = row + dr;
      const c = col + dc;
      if (r < 0 || c < 0 || r >= size || c >= size) continue;
      const dist = Math.max(Math.abs(dr), Math.abs(dc));
      modules[r]![c] = dist <= 1 || dist === 3;
      reserved[r]![c] = true;
    }
  }
}

function drawAlignment(modules: boolean[][], reserved: boolean[][], row: number, col: number): void {
  for (let dr = -2; dr <= 2; dr += 1) {
    for (let dc = -2; dc <= 2; dc += 1) {
      const r = row + dr;
      const c = col + dc;
      modules[r]![c] = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
      reserved[r]![c] = true;
    }
  }
}

export function encodeQrMatrix(text: string): QrMatrix {
  if (typeof text !== 'string') throw new TypeError('QR input must be a string');
  const bytes = new TextEncoder().encode(text);
  if (bytes.length > MAX_QR_BYTES) throw new RangeError('QR input exceeds the byte limit');

  const spec = selectVersion(bytes.length);
  const dataCodewords = buildDataCodewords(bytes, spec);
  const dataBlocks = splitIntoBlocks(dataCodewords, spec);
  const ecBlocks = dataBlocks.map((block) => rsRemainder(block, spec.ecPerBlock));
  const codewords = interleaveCodewords(dataBlocks, ecBlocks, spec);

  const size = spec.version * 4 + 17;
  const modules: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const reserved: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));

  drawFinder(modules, reserved, 3, 3);
  drawFinder(modules, reserved, 3, size - 4);
  drawFinder(modules, reserved, size - 4, 3);

  for (let i = 0; i < size; i += 1) {
    if (!reserved[6]![i]) {
      modules[6]![i] = i % 2 === 0;
      reserved[6]![i] = true;
    }
    if (!reserved[i]![6]) {
      modules[i]![6] = i % 2 === 0;
      reserved[i]![6] = true;
    }
  }

  const positions = ALIGNMENT_POSITIONS[spec.version] ?? [];
  for (const row of positions) {
    for (const col of positions) {
      if ((row === 6 && col === 6) || (row === 6 && col === size - 7) || (row === size - 7 && col === 6)) {
        continue;
      }
      drawAlignment(modules, reserved, row, col);
    }
  }

  // Reserve format-info modules and the fixed dark module.
  for (let i = 0; i <= 8; i += 1) {
    reserved[8]![i] = true;
    reserved[i]![8] = true;
  }
  for (let i = 0; i < 8; i += 1) {
    reserved[8]![size - 1 - i] = true;
    reserved[size - 1 - i]![8] = true;
  }
  if (spec.version >= 7) {
    for (let i = 0; i < 18; i += 1) {
      const a = size - 11 + Math.floor(i / 3);
      const b = i % 3;
      reserved[b]![a] = true;
      reserved[a]![b] = true;
    }
  }

  // Place data bits in the standard upward/downward zig-zag, skipping column 6.
  let bitIndex = 0;
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vertical = 0; vertical < size; vertical += 1) {
      const row = upward ? size - 1 - vertical : vertical;
      for (let offset = 0; offset < 2; offset += 1) {
        const col = right - offset;
        if (reserved[row]![col]) continue;
        let dark = bitIndex < codewords.length * 8 ? ((codewords[bitIndex >>> 3]! >>> (7 - (bitIndex & 7))) & 1) === 1 : false;
        bitIndex += 1;
        if ((row + col) % 2 === 0) dark = !dark; // fixed mask pattern 0
        modules[row]![col] = dark;
      }
    }
    upward = !upward;
  }

  // Format information (level M, mask 0).
  const formatBit = (i: number): boolean => ((FORMAT_M_MASK_0 >>> i) & 1) === 1;
  for (let i = 0; i <= 5; i += 1) modules[8]![i] = formatBit(i);
  modules[8]![7] = formatBit(6);
  modules[8]![8] = formatBit(7);
  modules[7]![8] = formatBit(8);
  for (let i = 9; i <= 14; i += 1) modules[14 - i]![8] = formatBit(i);
  for (let i = 0; i <= 7; i += 1) modules[size - 1 - i]![8] = formatBit(i);
  for (let i = 8; i <= 14; i += 1) modules[8]![size - 15 + i] = formatBit(i);
  modules[size - 8]![8] = true;

  if (spec.version >= 7) {
    const versionBits = bchVersionBits(spec.version);
    for (let i = 0; i < 18; i += 1) {
      const bit = ((versionBits >>> i) & 1) === 1;
      const a = size - 11 + Math.floor(i / 3);
      const b = i % 3;
      modules[b]![a] = bit;
      modules[a]![b] = bit;
    }
  }

  return { version: spec.version, size, errorCorrectionLevel: 'M', modules };
}
