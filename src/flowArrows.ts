import { hexToWorld, offsetToHex } from '@loyalj/hex-world';
import type { HexMap, HexLayout } from '@loyalj/hex-world';
import { downstreamOf } from './tools/riverGraph.ts';
import type { CellPos } from './tools/tool.ts';

/**
 * Direction arrows for the river flow overlay: one small arrow per river
 * cell, centred on the cell and pointing at the cell its river flows into.
 * Colour alone says how much water passes; the arrow says which way. Pure
 * geometry — the scene wraps the arrays in a mesh.
 */

/** Arrow on a pale (headwater) tint. */
export const ARROW_ON_PALE = 0x0b2f5e;
/** Arrow on a deep (main stem) tint. */
export const ARROW_ON_DEEP = 0xf4faff;
/** Lift above the flow tint (which sits 0.02 above the surface). */
export const ARROW_Y_OFFSET = 0.05;

/** Arrow proportions as fractions of the hex size (centre to corner). */
const LENGTH      = 0.62;
const HEAD_LENGTH = 0.36;
const HEAD_HALF_W = 0.19;
const TAIL_HALF_W = 0.06;

export interface FlowArrowOptions {
  /** The flow tint under a cell, 0xRRGGBB — the arrow takes a contrasting colour. */
  tintFor(col: number, row: number): number;
  /** World Y of the cell's surface (water surface for liquid cells). */
  surfaceY(col: number, row: number): number;
  yOffset?: number;
}

export interface FlowArrowGeometry {
  /** xyz triples, 9 vertices per arrow (head triangle + two-triangle tail). */
  positions: Float32Array;
  /** rgb triples 0–1, one per vertex. */
  colors: Float32Array;
  count: number;
}

/** Dark arrow on a light tint, light arrow on a dark one, by relative luminance. */
export function arrowColorFor(tint: number): number {
  const r = ((tint >> 16) & 255) / 255;
  const g = ((tint >> 8)  & 255) / 255;
  const b = ( tint        & 255) / 255;
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance > 0.5 ? ARROW_ON_PALE : ARROW_ON_DEEP;
}

/**
 * Build arrows for every cell in `cells` that has a downstream neighbour.
 * A river's last cell (a mouth at the map edge, a dead end) has nowhere to
 * point and gets none.
 */
export function buildFlowArrows(
  map:    HexMap,
  layout: HexLayout,
  cells:  readonly CellPos[],
  opts:   FlowArrowOptions,
): FlowArrowGeometry {
  const yOffset = opts.yOffset ?? ARROW_Y_OFFSET;
  const size    = layout.size;
  const positions: number[] = [];
  const colors: number[] = [];
  let count = 0;

  for (const { col, row } of cells) {
    const down = downstreamOf(map, col, row);
    if (!down) continue;
    const c = hexToWorld(layout, offsetToHex(col, row));
    const n = hexToWorld(layout, offsetToHex(down.col, down.row));
    const len = Math.hypot(n.x - c.x, n.z - c.z);
    if (len === 0) continue;
    const dx = (n.x - c.x) / len, dz = (n.z - c.z) / len; // along the flow
    const px = -dz, pz = dx;                                // across it
    const y = opts.surfaceY(col, row) + yOffset;

    const half = (LENGTH * size) / 2;
    const tipX = c.x + dx * half,  tipZ = c.z + dz * half;
    const tailX = c.x - dx * half, tailZ = c.z - dz * half;
    const baseX = tipX - dx * HEAD_LENGTH * size, baseZ = tipZ - dz * HEAD_LENGTH * size;
    const hw = HEAD_HALF_W * size, tw = TAIL_HALF_W * size;

    positions.push(
      // Head.
      tipX, y, tipZ,
      baseX + px * hw, y, baseZ + pz * hw,
      baseX - px * hw, y, baseZ - pz * hw,
      // Tail, two triangles.
      baseX + px * tw, y, baseZ + pz * tw,
      tailX + px * tw, y, tailZ + pz * tw,
      tailX - px * tw, y, tailZ - pz * tw,
      baseX + px * tw, y, baseZ + pz * tw,
      tailX - px * tw, y, tailZ - pz * tw,
      baseX - px * tw, y, baseZ - pz * tw,
    );

    const color = arrowColorFor(opts.tintFor(col, row));
    const r = ((color >> 16) & 255) / 255, g = ((color >> 8) & 255) / 255, b = (color & 255) / 255;
    for (let v = 0; v < 9; v++) colors.push(r, g, b);
    count++;
  }

  return { positions: new Float32Array(positions), colors: new Float32Array(colors), count };
}
