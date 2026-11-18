import { describe, expect, it } from 'vitest';
import { encodeQrMatrix, MAX_QR_BYTES } from './qrcode';

describe('qrcode encoder', () => {
  it('produces a square matrix with the version-correct dimensions', () => {
    const qr = encodeQrMatrix('https://example.com');
    expect(qr.errorCorrectionLevel).toBe('M');
    expect(qr.version).toBeGreaterThanOrEqual(1);
    expect(qr.size).toBe(qr.version * 4 + 17);
    expect(qr.modules).toHaveLength(qr.size);
    for (const row of qr.modules) {
      expect(row).toHaveLength(qr.size);
      expect(row.every((cell) => typeof cell === 'boolean')).toBe(true);
    }
  });

  it('is deterministic for identical input', () => {
    expect(encodeQrMatrix('https://kinex.browser/a?b=1')).toEqual(
      encodeQrMatrix('https://kinex.browser/a?b=1')
    );
  });

  it('selects a larger version for longer input', () => {
    const shortQr = encodeQrMatrix('https://a.co');
    const longQr = encodeQrMatrix(`https://example.com/${'x'.repeat(120)}`);
    expect(longQr.version).toBeGreaterThanOrEqual(shortQr.version);
    expect(longQr.size).toBe(longQr.version * 4 + 17);
  });

  it('bounds input length', () => {
    expect(() => encodeQrMatrix('a'.repeat(MAX_QR_BYTES + 1))).toThrow(RangeError);
    expect(encodeQrMatrix('a'.repeat(MAX_QR_BYTES)).size).toBeGreaterThan(0);
  });

  it('draws finder patterns in three corners', () => {
    const qr = encodeQrMatrix('hello');
    const size = qr.size;
    expect(qr.modules[0]![0]).toBe(true);
    expect(qr.modules[3]![3]).toBe(true);
    expect(qr.modules[0]![7]).toBe(false);
    expect(qr.modules[0]![size - 1]).toBe(true);
    expect(qr.modules[size - 1]![0]).toBe(true);
  });
});
