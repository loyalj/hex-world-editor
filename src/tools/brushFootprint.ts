import { hexRange, hexToOffset, offsetToHex } from '@loyalj/hex-world';
import { brushCells } from './tool.ts';
import type { CellPos } from './tool.ts';

export type BrushShape = 'solid' | 'ring' | 'spray';

export const BRUSH_SHAPE_LABELS: Record<BrushShape, string> = {
  solid: 'brush',
  ring:  'ring',
  spray: 'spray',
};

/** Largest brush radius the size slider and bracket keys reach (469 cells). */
export const MAX_BRUSH_RADIUS = 12;

/**
 * Everything that shapes a stamp. `hardness` and `density` are 0–1 fractions:
 * hardness is the share of the radius that paints for certain before the
 * probability falls off (1 = hard-edged); density is the spray's per-cell
 * chance.
 */
export interface BrushSettings {
  radius: number;
  shape: BrushShape;
  hardness: number;
  density: number;
}

/** One cell of a stamp: where, and the chance it paints (1 = always). */
export interface WeightedCell extends CellPos {
  weight: number;
}

/**
 * The cells a stamp can reach, each with its paint probability. Solid and
 * spray cover the full hex of the radius; ring keeps only its outermost band
 * (a single cell at radius 0). Hardness softens the solid shape's rim: cells
 * within `hardness × radius` always paint, and beyond that the chance falls
 * linearly, reaching zero one step past the radius so the outermost ring
 * still has a chance. Spray applies one flat probability everywhere, and
 * ring is always deterministic — a broken ring is no ring.
 */
export function brushFootprint(center: CellPos, settings: BrushSettings): WeightedCell[] {
  const { radius, shape } = settings;
  const origin = offsetToHex(center.col, center.row);
  const out: WeightedCell[] = [];
  for (const hex of hexRange(origin, radius)) {
    const distance = Math.max(
      Math.abs(hex.q - origin.q),
      Math.abs(hex.r - origin.r),
      Math.abs((-hex.q - hex.r) - (-origin.q - origin.r)),
    );
    if (shape === 'ring' && distance !== radius) continue;
    const off = hexToOffset(hex);
    out.push({ col: off.col, row: off.row, weight: cellWeight(distance, settings) });
  }
  return out;
}

/** Paint probability for a cell at a given hex distance from the stamp's centre. */
export function cellWeight(distance: number, settings: BrushSettings): number {
  const { radius, shape } = settings;
  if (shape === 'ring') return 1;
  if (shape === 'spray') return clamp01(settings.density);
  const hardness = clamp01(settings.hardness);
  const inner = hardness * radius;
  if (distance <= inner) return 1;
  // Falls from 1 at the inner edge to 0 at radius + 1.
  return clamp01(1 - (distance - inner) / (radius + 1 - inner));
}

/** Cells a stamp reaches — the hover footprint (weights ignored). */
export function brushReach(center: CellPos, settings: BrushSettings): CellPos[] {
  return brushFootprint(center, settings).map(({ col, row }) => ({ col, row }));
}

/** Cells covered by a filled hex brush of the given radius: 1, 7, 19, 37… */
export const solidCells = brushCells;

/** Cells in the outer band of a radius-r hex: 1, 6, 12, 18… */
export const ringCells = (r: number): number => (r === 0 ? 1 : 6 * r);

/**
 * How many cells a stamp is expected to paint: exact for solid and ring, an
 * average for spray. Status-strip copy uses it.
 */
export function expectedCells(settings: BrushSettings): number {
  const { radius, shape } = settings;
  if (shape === 'ring') return ringCells(radius);
  if (shape === 'spray') return Math.round(solidCells(radius) * clamp01(settings.density));
  return solidCells(radius);
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}
