import { describe, expect, it } from 'vitest';
import { decodeBits, encodeBits } from '../src/scene.ts';

function roundTrip(count: number, pattern: (i: number) => boolean): Set<number> {
  const b64 = encodeBits(count, pattern);
  const out = new Set<number>();
  decodeBits(b64, count, i => out.add(i));
  return out;
}

describe('encodeBits / decodeBits', () => {
  it('round-trips an arbitrary pattern', () => {
    const pattern = (i: number) => i % 3 === 0 || i === 41;
    const out = roundTrip(100, pattern);
    for (let i = 0; i < 100; i++) expect(out.has(i)).toBe(pattern(i));
  });

  it('handles all-clear and all-set', () => {
    expect(roundTrip(50, () => false).size).toBe(0);
    expect(roundTrip(50, () => true).size).toBe(50);
  });

  it('bit counts that do not divide by 8 keep their tail bits', () => {
    const out = roundTrip(13, i => i === 12);
    expect(out).toEqual(new Set([12]));
  });

  it('survives a map-sized mask', () => {
    // 256×256 cells — the chunked string conversion must not overflow.
    const count = 256 * 256;
    const out = roundTrip(count, i => i === 0 || i === count - 1);
    expect(out).toEqual(new Set([0, count - 1]));
  });

  it('decoding tolerates a mask shorter than the cell count', () => {
    const b64 = encodeBits(8, i => i < 8); // one byte
    const out = new Set<number>();
    decodeBits(b64, 64, i => out.add(i)); // pretend it's a bigger map
    expect(out).toEqual(new Set([0, 1, 2, 3, 4, 5, 6, 7]));
  });
});
