import { describe, expect, it } from 'vitest';
import { POINTY_TOP, hexToOffset, offsetToHex } from '@loyalj/hex-world';
import type { TerrainDefinition } from '@loyalj/hex-world';
import { computeCostPath } from '../src/tools/pathing.ts';
import { edgeBetween, hexLineDraw } from '../src/tools/hexPath.ts';
import { makeScene, WATER } from './helpers.ts';

const NO_COSTS = { elevation: false, terrain: false, roadBonus: false };

describe('computeCostPath', () => {
  it('finds a contiguous path with both endpoints on open ground', () => {
    const s = makeScene();
    const path = computeCostPath(s, offsetToHex(1, 5), offsetToHex(8, 5), NO_COSTS, null)!;
    expect(path).not.toBeNull();
    expect(hexToOffset(path[0])).toEqual({ col: 1, row: 5 });
    expect(hexToOffset(path[path.length - 1])).toEqual({ col: 8, row: 5 });
  });

  it('routes around water through a land gap', () => {
    const s = makeScene();
    // A water wall down column 5, except a gap at row 9.
    for (let row = 0; row < s.map.height; row++) {
      if (row !== 9) s.map.setTerrain(5, row, WATER);
    }
    const path = computeCostPath(s, offsetToHex(2, 2), offsetToHex(8, 2), NO_COSTS, null)!;
    expect(path).not.toBeNull();
    const crossings = path.map(h => hexToOffset(h)).filter(o => o.col === 5);
    expect(crossings.length).toBeGreaterThan(0);
    for (const o of crossings) expect(o.row).toBe(9); // only the gap
  });

  it('returns null when water fully separates the endpoints', () => {
    const s = makeScene();
    for (let row = 0; row < s.map.height; row++) s.map.setTerrain(5, row, WATER);
    expect(computeCostPath(s, offsetToHex(2, 2), offsetToHex(8, 2), NO_COSTS, null)).toBeNull();
  });

  it('cannot end on water for roads, but can for a river estuary', () => {
    const s = makeScene();
    s.map.setTerrain(8, 5, WATER);
    const target = offsetToHex(8, 5);
    expect(computeCostPath(s, offsetToHex(2, 5), target, NO_COSTS, null)).toBeNull();
    const river = computeCostPath(s, offsetToHex(2, 5), target, NO_COSTS, target)!;
    expect(river).not.toBeNull();
    expect(hexToOffset(river[river.length - 1])).toEqual({ col: 8, row: 5 });
    // The estuary exception admits only the endpoint — no other water en route.
    const waterCells = river.filter(h => {
      const o = hexToOffset(h);
      return s.isWater(s.map.getTerrain(o.col, o.row));
    });
    expect(waterCells.length).toBe(1);
  });

  it('avoids a ridge when elevation cost is on', () => {
    const s = makeScene();
    // A tall ridge down column 5 with a flat pass at row 9.
    for (let row = 0; row < s.map.height; row++) {
      if (row !== 9) s.map.setElevation(5, row, 40);
    }
    const withCost = computeCostPath(
      s, offsetToHex(2, 2), offsetToHex(8, 2), { ...NO_COSTS, elevation: true }, null)!;
    const ridgeCells = withCost.map(h => hexToOffset(h))
      .filter(o => s.map.getElevation(o.col, o.row) === 40);
    expect(ridgeCells).toEqual([]);

    // Without the cost the direct route climbs straight over.
    const withoutCost = computeCostPath(s, offsetToHex(2, 2), offsetToHex(8, 2), NO_COSTS, null)!;
    expect(withoutCost.length).toBeLessThan(withCost.length);
  });

  it('weighs terrain road cost when enabled', () => {
    const s = makeScene();
    // Terrain 1 is a deep swamp; pave column 5 with it, gap at row 9. The
    // penalty must exceed the ~14-step detour cost or crossing stays cheaper.
    s.terrainLookup.set(1, { roadCost: 50 } as TerrainDefinition);
    for (let row = 0; row < s.map.height; row++) {
      if (row !== 9) s.map.setTerrain(5, row, 1);
    }
    const path = computeCostPath(
      s, offsetToHex(2, 2), offsetToHex(8, 2), { ...NO_COSTS, terrain: true }, null)!;
    const swampCells = path.map(h => hexToOffset(h)).filter(o => s.map.getTerrain(o.col, o.row) === 1);
    expect(swampCells).toEqual([]);
  });

  it('prefers existing roads when the road bonus is on', () => {
    const s = makeScene();
    // Lay a road along an L-shaped detour (1,5) → (1,2) → (8,2) → (8,5):
    // 13-odd steps at 0.25× beats the 7-step direct route at 1×.
    const waypoints: Array<[number, number]> = [[1, 5], [1, 2], [8, 2], [8, 5]];
    const cells: Array<{ col: number; row: number }> = [];
    for (let i = 0; i < waypoints.length - 1; i++) {
      const seg = hexLineDraw(offsetToHex(...waypoints[i]), offsetToHex(...waypoints[i + 1]))
        .map(h => hexToOffset(h));
      cells.push(...(i === 0 ? seg : seg.slice(1)));
    }
    const tx = s.map.beginEdit();
    for (let i = 0; i < cells.length - 1; i++) {
      const edge = edgeBetween(cells[i].col, cells[i].row, cells[i + 1].col, cells[i + 1].row);
      if (edge !== null) for (const _ of tx.setRoadEdge(cells[i].col, cells[i].row, edge, true, POINTY_TOP)) { /* dirty cells unused */ }
    }
    tx.commit();

    const boosted = computeCostPath(
      s, offsetToHex(1, 5), offsetToHex(8, 5), { ...NO_COSTS, roadBonus: true }, null)!;
    expect(boosted.map(h => hexToOffset(h)).some(o => o.row === 2)).toBe(true);

    const direct = computeCostPath(s, offsetToHex(1, 5), offsetToHex(8, 5), NO_COSTS, null)!;
    expect(direct.map(h => hexToOffset(h)).some(o => o.row === 2)).toBe(false);
  });
});
