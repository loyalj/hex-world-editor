import { describe, expect, it } from 'vitest';
import { HexMap, createLayout, POINTY_TOP, offsetNeighbor, hexToWorld, offsetToHex, ELEVATION_SCALE } from '@loyalj/hex-world';
import { EDGE_DIRS } from '../src/tools/hexPath.ts';
import {
  ARROW_ON_DEEP, ARROW_ON_PALE, ARROW_Y_OFFSET, arrowColorFor, buildFlowArrows,
} from '../src/flowArrows.ts';
import { FLOW_RAMP } from '../src/analysis.ts';

const layout = createLayout(POINTY_TOP, 1);

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

function riverCells(map: HexMap): Array<{ col: number; row: number }> {
  const out: Array<{ col: number; row: number }> = [];
  for (let row = 0; row < map.height; row++) {
    for (let col = 0; col < map.width; col++) if (map.hasRiver(col, row)) out.push({ col, row });
  }
  return out;
}

const opts = {
  tintFor:  () => FLOW_RAMP[0][1],
  surfaceY: (map: HexMap) => (col: number, row: number) => map.getElevation(col, row) * ELEVATION_SCALE,
};

function centre(col: number, row: number): { x: number; z: number } {
  return hexToWorld(layout, offsetToHex(col, row));
}

describe('arrowColorFor', () => {
  it('goes dark on the pale headwater tint and light on the deep main stem', () => {
    expect(arrowColorFor(FLOW_RAMP[0][1])).toBe(ARROW_ON_PALE);
    expect(arrowColorFor(FLOW_RAMP[FLOW_RAMP.length - 1][1])).toBe(ARROW_ON_DEEP);
    expect(arrowColorFor(0xffffff)).toBe(ARROW_ON_PALE);
    expect(arrowColorFor(0x000000)).toBe(ARROW_ON_DEEP);
  });
});

describe('buildFlowArrows', () => {
  it('makes one arrow per river cell with a downstream neighbour, none for the last cell', () => {
    const map = new HexMap({ width: 8, height: 8 });
    link(map, [2, 4], [3, 4]);
    link(map, [3, 4], [4, 4]);
    link(map, [4, 4], [5, 4]);
    const cells = riverCells(map);
    expect(cells.length).toBe(4);
    const g = buildFlowArrows(map, layout, cells, { tintFor: opts.tintFor, surfaceY: opts.surfaceY(map) });
    expect(g.count).toBe(3);
    expect(g.positions.length).toBe(3 * 9 * 3);
    expect(g.colors.length).toBe(3 * 9 * 3);
  });

  it('centres each arrow on its cell, inside the hex, pointing at the downstream cell', () => {
    const map = new HexMap({ width: 8, height: 8 });
    link(map, [2, 4], [3, 4]); // east
    link(map, [3, 4], [3, 5]); // south-ish
    const g = buildFlowArrows(map, layout, riverCells(map), { tintFor: opts.tintFor, surfaceY: opts.surfaceY(map) });
    const arrows: Array<[number, number]> = [[2, 4], [3, 4]];
    arrows.forEach(([col, row], i) => {
      const c = centre(col, row);
      const down = i === 0 ? centre(3, 4) : centre(3, 5);
      const base = i * 27;
      for (let v = 0; v < 9; v++) {
        const x = g.positions[base + v * 3], z = g.positions[base + v * 3 + 2];
        expect(Math.hypot(x - c.x, z - c.z)).toBeLessThan(layout.size * 0.5); // well inside the hex
      }
      // The tip (vertex 0) leads toward the downstream centre; the tail end
      // (midpoint of vertices 4 and 5, the two tail corners) trails.
      const tipX = g.positions[base], tipZ = g.positions[base + 2];
      const tailX = (g.positions[base + 12] + g.positions[base + 15]) / 2;
      const tailZ = (g.positions[base + 14] + g.positions[base + 17]) / 2;
      expect(Math.hypot(down.x - tipX, down.z - tipZ)).toBeLessThan(Math.hypot(down.x - tailX, down.z - tailZ));
      // The shape straddles the centre: tip on one side, tail on the other.
      expect(Math.hypot(tipX - c.x, tipZ - c.z)).toBeCloseTo(Math.hypot(tailX - c.x, tailZ - c.z), 6);
      expect((tipX + tailX) / 2).toBeCloseTo(c.x, 6);
      expect((tipZ + tailZ) / 2).toBeCloseTo(c.z, 6);
    });
  });

  it('floats each arrow just above the cell surface and colours it against its tint', () => {
    const map = new HexMap({ width: 8, height: 8 });
    map.setElevation(2, 4, 6);
    link(map, [2, 4], [3, 4]);
    const g = buildFlowArrows(map, layout, riverCells(map), {
      tintFor: () => FLOW_RAMP[FLOW_RAMP.length - 1][1], surfaceY: opts.surfaceY(map), yOffset: 0.1,
    });
    for (let v = 0; v < 9; v++) expect(g.positions[v * 3 + 1]).toBeCloseTo(6 * ELEVATION_SCALE + 0.1, 6);
    expect(g.colors[0]).toBeCloseTo(((ARROW_ON_DEEP >> 16) & 255) / 255, 6);
    expect(g.colors[1]).toBeCloseTo(((ARROW_ON_DEEP >> 8) & 255) / 255, 6);
    expect(g.colors[2]).toBeCloseTo((ARROW_ON_DEEP & 255) / 255, 6);
    const d = buildFlowArrows(map, layout, riverCells(map), { tintFor: opts.tintFor, surfaceY: opts.surfaceY(map) });
    expect(d.positions[1]).toBeCloseTo(6 * ELEVATION_SCALE + ARROW_Y_OFFSET, 6);
  });

  it('builds nothing for no cells or for cells without rivers', () => {
    const map = new HexMap({ width: 4, height: 4 });
    expect(buildFlowArrows(map, layout, [], { tintFor: opts.tintFor, surfaceY: opts.surfaceY(map) }).count).toBe(0);
    expect(buildFlowArrows(map, layout, [{ col: 1, row: 1 }], { tintFor: opts.tintFor, surfaceY: opts.surfaceY(map) }).count).toBe(0);
  });
});
