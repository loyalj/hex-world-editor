import { describe, expect, it } from 'vitest';
import { HexMap, POINTY_TOP, offsetNeighbor } from '@loyalj/hex-world';
import { EDGE_DIRS } from '../src/tools/hexPath.ts';
import { cellKey } from '../src/tools/riverGraph.ts';
import { auditRoads, roadCrossesEdge, roadDegree, roadNeighborsOf, roadNetworks } from '../src/tools/roadGraph.ts';
import { WATER } from './helpers.ts';

const isWater = (t: number): boolean => t === WATER;

function makeMap(): HexMap {
  return new HexMap({ width: 12, height: 12, featureLayerCount: 4 });
}

/** Lay a road along row `row` from colA to colB, both half-edges of every hop. */
function road(map: HexMap, row: number, colA: number, colB: number): void {
  for (let c = colA; c < colB; c++) {
    const e = EDGE_DIRS.findIndex(d => {
      const nb = offsetNeighbor(c, row, d);
      return nb.col === c + 1 && nb.row === row;
    });
    map.setRoadEdge(c, row, e, true, POINTY_TOP);
  }
}

describe('road graph', () => {
  it('walks paired road edges to the neighbours they join', () => {
    const map = makeMap();
    road(map, 4, 2, 6);
    const byCol = (a: { col: number }, b: { col: number }): number => a.col - b.col;
    expect(roadNeighborsOf(map, 3, 4).sort(byCol)).toEqual([{ col: 2, row: 4 }, { col: 4, row: 4 }]);
    expect(roadNeighborsOf(map, 2, 4)).toEqual([{ col: 3, row: 4 }]);
    expect(roadNeighborsOf(map, 8, 8)).toEqual([]);
  });

  it('ignores a half-edge the neighbour does not answer', () => {
    const map = makeMap();
    map.setRoad(3, 3, 0, true);
    expect(map.hasRoads(3, 3)).toBe(true);
    expect(roadCrossesEdge(map, 3, 3, 0)).toBe(false);
    expect(roadNeighborsOf(map, 3, 3)).toEqual([]);
    // Still a road cell, so it is a network — of one.
    expect(roadNetworks(map).get(cellKey(map, 3, 3))).toBe(cellKey(map, 3, 3));
  });

  it('groups cells by connected network, keyed to the lowest cell', () => {
    const map = makeMap();
    road(map, 4, 2, 6);
    road(map, 8, 1, 3);
    // A spur off the first road: the cell across edge 0 from (4, 4).
    const nb = offsetNeighbor(4, 4, EDGE_DIRS[0]);
    map.setRoadEdge(4, 4, 0, true, POINTY_TOP);

    const nets = roadNetworks(map);
    const first = Math.min(cellKey(map, 2, 4), cellKey(map, nb.col, nb.row));
    for (let c = 2; c <= 6; c++) expect(nets.get(cellKey(map, c, 4))).toBe(first);
    expect(nets.get(cellKey(map, nb.col, nb.row))).toBe(first);
    for (let c = 1; c <= 3; c++) expect(nets.get(cellKey(map, c, 8))).toBe(cellKey(map, 1, 8));
    expect(nets.size).toBe(9);
    expect(new Set(nets.values()).size).toBe(2);
    expect(nets.has(cellKey(map, 7, 4))).toBe(false);
  });

  it('is empty on a map without roads', () => {
    expect(roadNetworks(makeMap()).size).toBe(0);
  });
});

describe('auditRoads', () => {
  it('finds nothing wrong with a paired road on flat land', () => {
    const map = makeMap();
    road(map, 4, 2, 6);
    expect(auditRoads(map, isWater, 3)).toEqual([]);
  });

  it('flags a half-edge with no partner, and one leading off the map', () => {
    const map = makeMap();
    road(map, 4, 2, 6);
    map.setRoad(3, 4, 0, true);
    map.setRoad(0, 0, EDGE_DIRS.findIndex(d => offsetNeighbor(0, 0, d).col < 0), true);
    const issues = auditRoads(map, isWater, 1);
    expect(issues.map(i => [i.kind, i.col, i.row])).toEqual([
      ['dangling', 0, 0],
      ['dangling', 3, 4],
    ]);
    expect(issues[0].detail).toBe('edge leads off the map');
    expect(issues[1].detail).toMatch(/has no partner/);
  });

  it('flags roads on water and across cliffs, cliffs once per pair', () => {
    const map = makeMap();
    road(map, 4, 2, 6);
    map.setTerrain(3, 4, WATER);
    map.setElevation(5, 4, 4); // 4 → 0 either side: a cliff both ways
    const issues = auditRoads(map, isWater, 1);
    expect(issues.map(i => [i.kind, i.col, i.row])).toEqual([
      ['water', 3, 4],
      ['cliff', 4, 4],
      ['cliff', 5, 4],
    ]);
    expect(issues[1].detail).toBe('0 → 4 toward 5, 4');
    expect(issues[2].detail).toBe('4 → 0 toward 6, 4');
  });

  it('flags a short spur off a junction but not its own ends', () => {
    const map = makeMap();
    road(map, 4, 2, 8);
    // A one-cell spur hanging off (5, 4).
    map.setRoadEdge(5, 4, 0, true, POINTY_TOP);
    const spur = offsetNeighbor(5, 4, EDGE_DIRS[0]);
    expect(roadDegree(map, 5, 4)).toBe(3);
    const issues = auditRoads(map, isWater, 3);
    expect(issues).toEqual([{
      col: spur.col, row: spur.row, kind: 'spur', detail: '1 cell off the junction at 5, 4',
    }]);
    // Below the threshold the spur is long enough to be deliberate.
    expect(auditRoads(map, isWater, 1)).toEqual([]);
  });

  it('flags networks shorter than the threshold, once each', () => {
    const map = makeMap();
    road(map, 4, 2, 6);
    road(map, 8, 1, 3);
    const issues = auditRoads(map, isWater, 4);
    expect(issues).toEqual([{ col: 1, row: 8, kind: 'fragment', detail: 'network of 3 cells' }]);
    expect(auditRoads(map, isWater, 3)).toEqual([]);
  });
});
