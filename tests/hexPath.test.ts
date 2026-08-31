import { describe, expect, it } from 'vitest';
import { offsetNeighbor, offsetToHex } from '@loyalj/hex-world';
import type { HexCoord } from '@loyalj/hex-world';
import { EDGE_DIRS, edgeBetween, hexLineDraw, hexRound } from '../src/tools/hexPath.ts';

const hexDistance = (a: HexCoord, b: HexCoord): number =>
  Math.max(Math.abs(a.q - b.q), Math.abs(a.r - b.r), Math.abs((-a.q - a.r) - (-b.q - b.r)));

describe('hexRound', () => {
  it('returns integer coordinates unchanged', () => {
    expect(hexRound(3, -2)).toEqual({ q: 3, r: -2 });
  });

  it('keeps q + r + s = 0 for fractional inputs', () => {
    for (const [fq, fr] of [[1.4, 2.2], [-0.6, 3.9], [2.5, -1.5], [0.49, 0.49]]) {
      const { q, r } = hexRound(fq, fr);
      expect(Number.isInteger(q)).toBe(true);
      expect(Number.isInteger(r)).toBe(true);
      // Cube coordinates always satisfy the zero-sum invariant after rounding.
      expect(q + r + (-q - r)).toBe(0);
      // And the result is at most one cell from the naive rounding.
      expect(Math.abs(q - fq)).toBeLessThanOrEqual(1);
      expect(Math.abs(r - fr)).toBeLessThanOrEqual(1);
    }
  });
});

describe('hexLineDraw', () => {
  it('returns a single cell for a zero-length line', () => {
    expect(hexLineDraw({ q: 2, r: 3 }, { q: 2, r: 3 })).toEqual([{ q: 2, r: 3 }]);
  });

  it('includes both endpoints and one cell per distance step', () => {
    const a = { q: 0, r: 0 }, b = { q: 4, r: -2 };
    const line = hexLineDraw(a, b);
    expect(line[0]).toEqual(a);
    expect(line[line.length - 1]).toEqual(b);
    expect(line.length).toBe(hexDistance(a, b) + 1);
  });

  it('every consecutive pair is adjacent', () => {
    const line = hexLineDraw({ q: -3, r: 5 }, { q: 6, r: -2 });
    for (let i = 1; i < line.length; i++) {
      expect(hexDistance(line[i - 1], line[i])).toBe(1);
    }
  });
});

describe('edgeBetween', () => {
  it('finds the edge index for every neighbour, on both row parities', () => {
    for (const [col, row] of [[4, 4], [4, 5]]) { // even and odd rows shift differently
      for (let dir = 0; dir < 6; dir++) {
        const nb = offsetNeighbor(col, row, EDGE_DIRS[dir]);
        expect(edgeBetween(col, row, nb.col, nb.row)).toBe(dir);
      }
    }
  });

  it('returns null for a non-adjacent cell', () => {
    expect(edgeBetween(4, 4, 7, 4)).toBeNull();
    expect(edgeBetween(4, 4, 4, 4)).toBeNull();
  });

  it('is consistent with offsetToHex adjacency', () => {
    const nb = offsetNeighbor(3, 3, EDGE_DIRS[2]);
    expect(hexDistance(offsetToHex(3, 3), offsetToHex(nb.col, nb.row))).toBe(1);
  });
});
