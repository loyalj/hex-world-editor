import { describe, expect, it } from 'vitest';
import { HexMap, offsetNeighbor } from '@loyalj/hex-world';
import { EDGE_DIRS } from '../src/tools/hexPath.ts';
import {
  auditRivers, cellKey, computeRiverFlow, downstreamOf, reverseStem, riverBasins, riverDestination,
  riverStem, riverSystem, upstreamOf,
} from '../src/tools/riverGraph.ts';
import { WATER } from './helpers.ts';

const isWater = (t: number): boolean => t === WATER;

/** Link a → b with a river edge (both half-edges). */
function link(map: HexMap, a: [number, number], b: [number, number]): void {
  for (let e = 0; e < 6; e++) {
    const nb = offsetNeighbor(a[0], a[1], EDGE_DIRS[e]);
    if (nb.col === b[0] && nb.row === b[1]) {
      map.setRiverOutgoing(a[0], a[1], e);
      map.setRiverIncoming(b[0], b[1], (e + 3) % 6);
      return;
    }
  }
  throw new Error(`${a} and ${b} are not neighbours`);
}

/** A chain along row `row` from colA to colB, flowing east. */
function chain(map: HexMap, row: number, colA: number, colB: number): void {
  for (let c = colA; c < colB; c++) link(map, [c, row], [c + 1, row]);
}

function makeMap(): HexMap {
  return new HexMap({ width: 12, height: 12, featureLayerCount: 4 });
}

describe('river graph walks', () => {
  it('follows a chain downstream and back up', () => {
    const map = makeMap();
    chain(map, 4, 2, 6);
    expect(downstreamOf(map, 3, 4)).toEqual({ col: 4, row: 4 });
    expect(downstreamOf(map, 6, 4)).toBeNull();
    expect(upstreamOf(map, 4, 4)).toEqual([{ col: 3, row: 4 }]);
    expect(upstreamOf(map, 2, 4)).toEqual([]);
  });

  it('a system is everything connected, tributaries included', () => {
    const map = makeMap();
    chain(map, 4, 2, 6);
    chain(map, 8, 1, 3); // a separate river
    // Tributary from (4,3) into (4,4) if they neighbour; find any neighbour of (4,4) not on the chain.
    const nb = offsetNeighbor(4, 4, EDGE_DIRS[0]);
    link(map, [nb.col, nb.row], [4, 4]);
    const system = riverSystem(map, 2, 4);
    expect(system.length).toBe(6);
    expect(system.some(c => c.col === nb.col && c.row === nb.row)).toBe(true);
    expect(system.some(c => c.row === 8)).toBe(false);
    expect(riverSystem(map, 0, 0)).toEqual([]);
  });

  it('accumulated flow counts everything upstream', () => {
    const map = makeMap();
    chain(map, 4, 2, 6);
    const nb = offsetNeighbor(4, 4, EDGE_DIRS[0]);
    link(map, [nb.col, nb.row], [4, 4]);
    const flow = computeRiverFlow(map);
    expect(flow.get(cellKey(map, 2, 4))).toBe(1);
    expect(flow.get(cellKey(map, 3, 4))).toBe(2);
    expect(flow.get(cellKey(map, 4, 4))).toBe(4); // 3 from the chain + the tributary
    expect(flow.get(cellKey(map, 6, 4))).toBe(6);
  });

  it('the stem follows the biggest tributary upstream', () => {
    const map = makeMap();
    chain(map, 4, 1, 6);           // long branch: 1..4 → 5 → 6
    const nb = offsetNeighbor(5, 4, EDGE_DIRS[0]);
    link(map, [nb.col, nb.row], [5, 4]); // short branch into (5,4)
    const stem = riverStem(map, 6, 4);
    expect(stem[0]).toEqual({ col: 1, row: 4 });
    expect(stem[stem.length - 1]).toEqual({ col: 6, row: 4 });
    expect(stem.length).toBe(6);
    // From the short branch, the stem runs through it and on to the mouth.
    const fromTrib = riverStem(map, nb.col, nb.row);
    expect(fromTrib[0]).toEqual({ col: nb.col, row: nb.row });
    expect(fromTrib[fromTrib.length - 1]).toEqual({ col: 6, row: 4 });
  });

  it('destination reports water, land dead ends, and loops', () => {
    const map = makeMap();
    chain(map, 4, 2, 6);
    expect(riverDestination(map, isWater, 2, 4)).toEqual({ col: 6, row: 4, kind: 'land', length: 5 });
    map.setTerrain(6, 4, WATER);
    expect(riverDestination(map, isWater, 3, 4)).toEqual({ col: 6, row: 4, kind: 'water', length: 4 });
    const loop = makeMap();
    link(loop, [2, 8], [3, 8]);
    link(loop, [3, 8], [2, 8]);
    expect(riverDestination(loop, isWater, 2, 8)?.kind).toBe('cycle');
    expect(riverDestination(map, isWater, 0, 0)).toBeNull();
  });

  it('basins group rivers by where they end', () => {
    const map = makeMap();
    chain(map, 4, 2, 6);
    chain(map, 8, 1, 3);
    const nb = offsetNeighbor(4, 4, EDGE_DIRS[0]);
    link(map, [nb.col, nb.row], [4, 4]);
    const basins = riverBasins(map, isWater);
    const mouth = cellKey(map, 6, 4);
    expect(basins.get(cellKey(map, 2, 4))).toBe(mouth);
    expect(basins.get(cellKey(map, nb.col, nb.row))).toBe(mouth);
    expect(basins.get(cellKey(map, 1, 8))).toBe(cellKey(map, 3, 8));
    expect(new Set(basins.values()).size).toBe(2);
  });
});

describe('auditRivers', () => {
  it('finds nothing wrong with a downhill river into water', () => {
    const map = makeMap();
    for (let c = 2; c <= 6; c++) map.setElevation(c, 4, 8 - c);
    map.setTerrain(6, 4, WATER);
    chain(map, 4, 2, 6);
    expect(auditRivers(map, isWater, 2)).toEqual([]);
  });

  it('flags uphill runs, land dead ends, and low sources', () => {
    const map = makeMap();
    chain(map, 4, 2, 6);
    map.setElevation(4, 4, 3); // 3→4 climbs into it
    const issues = auditRivers(map, isWater, 2);
    expect(issues.find(i => i.kind === 'uphill')).toMatchObject({ col: 3, row: 4 });
    expect(issues.find(i => i.kind === 'dead-end')).toMatchObject({ col: 6, row: 4 });
    expect(issues.find(i => i.kind === 'low-source')).toMatchObject({ col: 2, row: 4 });
    expect(issues.filter(i => i.kind === 'uphill').length).toBe(1);
  });

  it('flags dangling half-edges and loops', () => {
    const map = makeMap();
    map.setRiverOutgoing(5, 5, 0); // nobody lists us upstream
    map.setRiverIncoming(8, 8, 2); // nobody flows in
    link(map, [2, 8], [3, 8]);
    link(map, [3, 8], [2, 8]);
    map.setElevation(5, 5, 5);
    const issues = auditRivers(map, isWater, 2);
    const dangling = issues.filter(i => i.kind === 'dangling');
    expect(dangling.map(i => [i.col, i.row])).toEqual(expect.arrayContaining([[5, 5], [8, 8]]));
    expect(issues.filter(i => i.kind === 'cycle').length).toBe(2);
  });
});

describe('reverseStem', () => {
  it('turns a chain around, keeping tributaries attached', () => {
    const map = makeMap();
    chain(map, 4, 2, 6);
    const nb = offsetNeighbor(4, 4, EDGE_DIRS[0]);
    link(map, [nb.col, nb.row], [4, 4]);
    const stem = riverStem(map, 4, 4);
    const tx = map.beginEdit();
    const flipped = reverseStem(tx, map, stem, () => true, () => {});
    tx.commit();
    expect(flipped).toBe(4);
    expect(downstreamOf(map, 6, 4)).toEqual({ col: 5, row: 4 });
    expect(downstreamOf(map, 3, 4)).toEqual({ col: 2, row: 4 });
    expect(downstreamOf(map, 2, 4)).toBeNull();
    expect(upstreamOf(map, 4, 4).some(c => c.col === nb.col && c.row === nb.row)).toBe(true);
    expect(auditRivers(map, isWater, -128).filter(i => i.kind === 'dangling')).toEqual([]);
  });

  it('leaves edges alone on either side of a disallowed cell', () => {
    const map = makeMap();
    chain(map, 4, 2, 6);
    const stem = riverStem(map, 2, 4);
    const tx = map.beginEdit();
    const flipped = reverseStem(tx, map, stem, (col) => col !== 4, () => {});
    tx.commit();
    // Only the run from the terminus back to the protected cell flips: 5→6
    // becomes 6→5. Upstream of (4,4) nothing changes — (5,4) can't both keep
    // its old outgoing into the protected cell and gain one toward (6,4).
    expect(flipped).toBe(1);
    expect(downstreamOf(map, 2, 4)).toEqual({ col: 3, row: 4 });
    expect(downstreamOf(map, 3, 4)).toEqual({ col: 4, row: 4 });
    expect(downstreamOf(map, 4, 4)).toEqual({ col: 5, row: 4 });
    expect(downstreamOf(map, 6, 4)).toEqual({ col: 5, row: 4 });
    expect(downstreamOf(map, 5, 4)).toBeNull();
    expect(auditRivers(map, isWater, -128).filter(i => i.kind === 'dangling')).toEqual([]);
  });
});
