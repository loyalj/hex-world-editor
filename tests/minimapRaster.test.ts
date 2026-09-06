import { describe, expect, it } from 'vitest';
import {
  HexMap, createLayout, POINTY_TOP, FLAT_TOP, DEFAULT_TERRAIN_DEFINITIONS,
  getMapWorldBounds, getMapImageTransform, worldToHex, hexToOffset,
} from '@loyalj/hex-world';
import type { HexLayout, MapImageTransform, TerrainDefinition } from '@loyalj/hex-world';
import {
  cellsPixelRect, cellsRange, fullRect, makeMapTransform, mapWorldBounds, rasterTerrain,
} from '../src/ui/minimapRaster.ts';
import type { RasterStyle } from '../src/ui/minimapRaster.ts';

const layout = createLayout(POINTY_TOP, 1);
const DEFS   = DEFAULT_TERRAIN_DEFINITIONS;
const BG     = 0x131316;

function setup(width = 6, height = 5, scale = 4): { map: HexMap; transform: MapImageTransform; pixels: Uint8ClampedArray } {
  const map = new HexMap({ width, height });
  const transform = makeMapTransform(mapWorldBounds(map, layout), scale, 2);
  return { map, transform, pixels: new Uint8ClampedArray(transform.width * transform.height * 4) };
}

function style(over: Partial<RasterStyle> = {}): RasterStyle {
  return { terrainDefinitions: DEFS, background: BG, ...over };
}

/** A colour as the raster stores it: floats 0–1 written straight into clamped bytes. */
function bytes(r: number, g: number, b: number): [number, number, number] {
  const out = new Uint8ClampedArray(3);
  out[0] = r * 255; out[1] = g * 255; out[2] = b * 255;
  return [out[0], out[1], out[2]];
}

function pixelAt(pixels: Uint8ClampedArray, transform: MapImageTransform, px: number, py: number): number[] {
  const o = (py * transform.width + px) * 4;
  return [pixels[o], pixels[o + 1], pixels[o + 2], pixels[o + 3]];
}

function defColor(def: TerrainDefinition): [number, number, number] {
  return bytes(def.color.r, def.color.g, def.color.b);
}

describe('mapWorldBounds', () => {
  it('matches the library brute-force bounds from the rim alone', () => {
    const cases: Array<[number, number, HexLayout]> = [
      [1, 1, layout], [5, 4, layout], [12, 7, layout], [3, 9, layout],
      [6, 6, createLayout(POINTY_TOP, 2.5, 10, -4)],
      [7, 5, createLayout(FLAT_TOP, 1)], [4, 8, createLayout(FLAT_TOP, 1.5, -3, 2)],
    ];
    for (const [w, h, lay] of cases) {
      const map = new HexMap({ width: w, height: h });
      const got = mapWorldBounds(map, lay);
      const want = getMapWorldBounds(map, lay);
      for (const k of ['minX', 'maxX', 'minZ', 'maxZ'] as const) expect(got[k]).toBeCloseTo(want[k], 10);
    }
  });

  it('yields the library transform for the same scale and padding', () => {
    const map = new HexMap({ width: 9, height: 6 });
    const got  = makeMapTransform(mapWorldBounds(map, layout), 3, 2);
    const want = getMapImageTransform(map, layout, { scale: 3, padding: 2 });
    expect([got.width, got.height]).toEqual([want.width, want.height]);
    const a = got.worldToImage(4.2, -1.3), b = want.worldToImage(4.2, -1.3);
    expect(a.x).toBeCloseTo(b.x, 10);
    expect(a.y).toBeCloseTo(b.y, 10);
    const c = got.imageToWorld(17, 9), d = want.imageToWorld(17, 9);
    expect(c.x).toBeCloseTo(d.x, 10);
    expect(c.z).toBeCloseTo(d.z, 10);
  });
});

describe('rasterTerrain', () => {
  it('colours every pixel by the cell under its centre, background outside the map', () => {
    const { map, transform, pixels } = setup();
    map.setTerrain(2, 3, DEFS[1].index);
    map.setTerrain(4, 0, DEFS[2].index);
    rasterTerrain(pixels, transform, map, layout, style());

    let inside = 0, outside = 0;
    for (let py = 0; py < transform.height; py++) {
      for (let px = 0; px < transform.width; px++) {
        const world = transform.imageToWorld(px + 0.5, py + 0.5);
        const { col, row } = hexToOffset(worldToHex(layout, world.x, world.z));
        const got = pixelAt(pixels, transform, px, py);
        if (map.inBounds(col, row)) {
          inside++;
          const def = DEFS.find(d => d.index === map.getTerrain(col, row))!;
          expect(got).toEqual([...defColor(def), 255]);
        } else {
          outside++;
          expect(got).toEqual([0x13, 0x13, 0x16, 255]);
        }
      }
    }
    expect(inside).toBeGreaterThan(0);
    expect(outside).toBeGreaterThan(0);
  });

  it('brightens by elevation, clamping at white', () => {
    const { map, transform, pixels } = setup(3, 3, 6);
    map.setElevation(1, 1, 5);
    rasterTerrain(pixels, transform, map, layout, style({ elevationShading: 0.04 }));
    const p = centrePixel(transform, 1, 1);
    const def = DEFS.find(d => d.index === map.getTerrain(1, 1))!;
    const f = 1 + 5 * 0.04;
    expect(pixelAt(pixels, transform, p.x, p.y)).toEqual([
      ...bytes(Math.min(1, def.color.r * f), Math.min(1, def.color.g * f), Math.min(1, def.color.b * f)), 255,
    ]);
  });

  it('blends the cell tint at its alpha and leaves untinted cells alone', () => {
    const { map, transform, pixels } = setup(3, 3, 6);
    rasterTerrain(pixels, transform, map, layout, style({
      cellTint: (c, r) => (c === 1 && r === 1 ? 0xff0000 : null), tintAlpha: 0.5,
    }));
    const def = DEFS.find(d => d.index === map.getTerrain(1, 1))!;
    const t = centrePixel(transform, 1, 1);
    expect(pixelAt(pixels, transform, t.x, t.y)).toEqual([
      ...bytes(def.color.r + (1 - def.color.r) * 0.5, def.color.g * 0.5, def.color.b * 0.5), 255,
    ]);
    const u = centrePixel(transform, 0, 0);
    expect(pixelAt(pixels, transform, u.x, u.y)).toEqual([...defColor(def), 255]);
  });

  it('hides unexplored cells as background and dims explored ones out of sight', () => {
    const { map, transform, pixels } = setup(3, 3, 6);
    const raw = new Uint8Array(9 * 4);
    const at = (c: number, r: number) => (r * 3 + c) * 4;
    raw[at(0, 0)] = 255; raw[at(0, 0) + 1] = 255; // visible + explored
    raw[at(1, 1) + 1] = 255;                      // explored, not visible
    rasterTerrain(pixels, transform, map, layout, style({
      fog: { rawData: raw }, fogDimOpacity: 0.5, fogHideUnexplored: true,
    }));
    const def = DEFS.find(d => d.index === map.getTerrain(0, 0))!;
    const a = centrePixel(transform, 0, 0);
    expect(pixelAt(pixels, transform, a.x, a.y)).toEqual([...defColor(def), 255]);
    const b = centrePixel(transform, 1, 1);
    expect(pixelAt(pixels, transform, b.x, b.y)).toEqual([
      ...bytes(def.color.r * 0.5, def.color.g * 0.5, def.color.b * 0.5), 255,
    ]);
    const c = centrePixel(transform, 2, 2);
    expect(pixelAt(pixels, transform, c.x, c.y)).toEqual([0x13, 0x13, 0x16, 255]);
  });

  it('a rect repaint over the edited cells reproduces the full redraw exactly', () => {
    const { map, transform, pixels: full } = setup(8, 7, 4);
    rasterTerrain(full, transform, map, layout, style());
    const patched = full.slice();

    map.setTerrain(3, 2, DEFS[3].index);
    map.setTerrain(4, 2, DEFS[3].index);
    rasterTerrain(full, transform, map, layout, style());

    const rect = cellsPixelRect([{ col: 3, row: 2 }, { col: 4, row: 2 }], transform, layout)!;
    expect(rect.x1 - rect.x0).toBeLessThan(transform.width);
    expect(rect.y1 - rect.y0).toBeLessThan(transform.height);
    rasterTerrain(patched, transform, map, layout, style(), rect);
    expect(patched).toEqual(full);
  });

  it('a rect over the corner cells covers every map pixel and stays inside the image', () => {
    const { transform } = setup(4, 4, 5);
    const rect = cellsPixelRect([{ col: 0, row: 0 }, { col: 3, row: 3 }], transform, layout)!;
    const full = fullRect(transform);
    // The image carries 2px of padding; the rect may stop inside it but never past it.
    expect(rect.x0).toBeGreaterThanOrEqual(full.x0);
    expect(rect.y0).toBeGreaterThanOrEqual(full.y0);
    expect(rect.x1).toBeLessThanOrEqual(full.x1);
    expect(rect.y1).toBeLessThanOrEqual(full.y1);
    expect(rect.x0).toBeLessThanOrEqual(transform.padding);
    expect(rect.y0).toBeLessThanOrEqual(transform.padding);
    expect(rect.x1).toBeGreaterThanOrEqual(full.x1 - transform.padding);
    expect(rect.y1).toBeGreaterThanOrEqual(full.y1 - transform.padding);
    expect(cellsPixelRect([], transform, layout)).toBeNull();
  });
});

describe('cellsRange', () => {
  it('grows the bounding box by one cell and clamps to the map', () => {
    const map = new HexMap({ width: 10, height: 10 });
    expect(cellsRange([{ col: 4, row: 5 }, { col: 6, row: 5 }], map)).toEqual({ c0: 3, c1: 7, r0: 4, r1: 6 });
    expect(cellsRange([{ col: 0, row: 9 }], map)).toEqual({ c0: 0, c1: 1, r0: 8, r1: 9 });
    expect(cellsRange([], map)).toBeNull();
  });
});

/** The pixel under a cell's centre. */
function centrePixel(transform: MapImageTransform, col: number, row: number): { x: number; y: number } {
  const hex = { q: col - (row - (row & 1)) / 2, r: row };
  const { f0, f1, f2, f3 } = layout.orientation;
  const x = (f0 * hex.q + f1 * hex.r) * layout.size + layout.originX;
  const z = (f2 * hex.q + f3 * hex.r) * layout.size + layout.originZ;
  const p = transform.worldToImage(x, z);
  return { x: Math.floor(p.x), y: Math.floor(p.y) };
}
