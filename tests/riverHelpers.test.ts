import { describe, expect, it } from 'vitest';
import { hexToOffset, offsetToHex } from '@loyalj/hex-world';
import { traceDownhill, trimRiverPathAtWater } from '../src/tools/riverTool.ts';
import { makeScene, WATER } from './helpers.ts';

const row5 = (...cols: number[]) => cols.map(c => offsetToHex(c, 5));
const offsets = (path: ReturnType<typeof row5>) => path.map(h => hexToOffset(h));

describe('trimRiverPathAtWater', () => {
  it('leaves an all-land path unchanged', () => {
    const s = makeScene();
    const path = row5(1, 2, 3, 4);
    expect(trimRiverPathAtWater(s, path)).toEqual(path);
  });

  it('keeps exactly one water cell at the end — the estuary', () => {
    const s = makeScene();
    for (const c of [4, 5, 6]) s.map.setTerrain(c, 5, WATER);
    const trimmed = trimRiverPathAtWater(s, row5(1, 2, 3, 4, 5, 6));
    expect(offsets(trimmed)).toEqual(offsets(row5(1, 2, 3, 4)));
  });

  it('may start one cell inside water (a lake outlet)', () => {
    const s = makeScene();
    s.map.setTerrain(1, 5, WATER);
    const path = row5(1, 2, 3, 4);
    expect(trimRiverPathAtWater(s, path)).toEqual(path);
  });

  it('cuts before two consecutive mid-path water cells', () => {
    const s = makeScene();
    s.map.setTerrain(3, 5, WATER);
    s.map.setTerrain(4, 5, WATER);
    // i=3 is water and i=2 is land → keep through i=3 (the estuary cell);
    // the second water cell and everything past it goes.
    const trimmed = trimRiverPathAtWater(s, row5(1, 2, 3, 4, 5, 6));
    expect(offsets(trimmed)).toEqual(offsets(row5(1, 2, 3)));
  });
});

describe('traceDownhill', () => {
  it('follows a gradient into water', () => {
    const s = makeScene();
    // Everything high, except a descending channel along row 5 into water.
    for (let row = 0; row < s.map.height; row++) {
      for (let col = 0; col < s.map.width; col++) s.map.setElevation(col, row, 9);
    }
    const channel = [5, 4, 3, 2, 1];
    channel.forEach((elev, i) => s.map.setElevation(2 + i, 5, elev));
    s.map.setTerrain(7, 5, WATER);
    s.map.setElevation(7, 5, -1);

    const path = traceDownhill(s, 2, 5);
    expect(path.length).toBeGreaterThanOrEqual(2);
    const last = hexToOffset(path[path.length - 1]);
    expect(s.isWater(s.map.getTerrain(last.col, last.row))).toBe(true);
  });

  it('never steps uphill', () => {
    const s = makeScene();
    for (let col = 0; col < s.map.width; col++) {
      for (let row = 0; row < s.map.height; row++) s.map.setElevation(col, row, col);
    }
    const path = traceDownhill(s, 8, 5);
    for (let i = 1; i < path.length; i++) {
      const prev = hexToOffset(path[i - 1]);
      const cur  = hexToOffset(path[i]);
      expect(s.map.getElevation(cur.col, cur.row))
        .toBeLessThanOrEqual(s.map.getElevation(prev.col, prev.row));
    }
  });

  it('stops at a local minimum with no water in reach', () => {
    const s = makeScene();
    for (let row = 0; row < s.map.height; row++) {
      for (let col = 0; col < s.map.width; col++) s.map.setElevation(col, row, 9);
    }
    s.map.setElevation(5, 5, 0); // a pit
    const path = traceDownhill(s, 5, 5);
    expect(path.length).toBe(1);
    expect(hexToOffset(path[0])).toEqual({ col: 5, row: 5 });
  });
});
