import { describe, expect, it } from 'vitest';
import { brushFootprint, cellWeight, expectedCells, ringCells, solidCells } from '../src/tools/brushFootprint.ts';
import type { BrushSettings } from '../src/tools/brushFootprint.ts';

const settings = (over: Partial<BrushSettings> = {}): BrushSettings =>
  ({ radius: 2, shape: 'solid', hardness: 1, density: 0.5, ...over });

describe('brushFootprint', () => {
  it('solid covers the filled hex with every cell certain', () => {
    const cells = brushFootprint({ col: 5, row: 5 }, settings());
    expect(cells.length).toBe(solidCells(2));
    expect(cells.every(c => c.weight === 1)).toBe(true);
  });

  it('ring keeps only the outer band', () => {
    const cells = brushFootprint({ col: 5, row: 5 }, settings({ shape: 'ring' }));
    expect(cells.length).toBe(ringCells(2));
    expect(cells.some(c => c.col === 5 && c.row === 5)).toBe(false);
    expect(brushFootprint({ col: 5, row: 5 }, settings({ shape: 'ring', radius: 0 })))
      .toEqual([{ col: 5, row: 5, weight: 1 }]);
  });

  it('spray gives every cell the density as its weight', () => {
    const cells = brushFootprint({ col: 5, row: 5 }, settings({ shape: 'spray', density: 0.3 }));
    expect(cells.length).toBe(solidCells(2));
    expect(cells.every(c => c.weight === 0.3)).toBe(true);
  });

  it('hardness fixes the certain core and fades linearly past it', () => {
    const soft = settings({ radius: 4, hardness: 0.5 });
    expect(cellWeight(0, soft)).toBe(1);
    expect(cellWeight(2, soft)).toBe(1);
    expect(cellWeight(3, soft)).toBeCloseTo(2 / 3);
    expect(cellWeight(4, soft)).toBeCloseTo(1 / 3);
    const hard = settings({ radius: 4, hardness: 1 });
    expect(cellWeight(4, hard)).toBe(1);
    const zero = settings({ radius: 4, hardness: 0 });
    expect(cellWeight(0, zero)).toBe(1);
    expect(cellWeight(4, zero)).toBeCloseTo(0.2);
  });

  it('expected counts are exact for solid and ring, and a rounded share for spray', () => {
    expect(expectedCells(settings({ radius: 3 }))).toBe(37);
    expect(expectedCells(settings({ radius: 3, shape: 'ring' }))).toBe(18);
    expect(expectedCells(settings({ radius: 3, shape: 'spray', density: 0.5 }))).toBe(19);
  });
});
