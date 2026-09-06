import { hexCorner, hexToWorld, offsetToHex } from '@loyalj/hex-world';
import type { HexMap, HexLayout, TerrainDefinition, MapImageTransform } from '@loyalj/hex-world';

/**
 * The minimap's terrain raster. The library's `drawMapImage` fills one canvas
 * path per cell, so its cost grows with the map: a 500×500 map is a quarter
 * of a million sub-pixel hex fills per redraw, ten times a second during a
 * stroke. This module goes the other way round — for each pixel of the
 * image, find the cell under its centre and take that cell's colour — so a
 * redraw costs the same for any map size, and a brush stroke repaints only
 * the pixels its cells cover. Rivers and roads stay canvas strokes drawn over
 * the raster; they exist only where the flags are set, so those passes are
 * proportional to river and road length, not area.
 *
 * Everything here is pure (typed arrays in, typed arrays out) apart from
 * {@link strokeCellSpokes}, which takes a 2D context.
 */

export interface CellPos { col: number; row: number }

/** Half-open pixel rectangle within an image. */
export interface PixelRect { x0: number; y0: number; x1: number; y1: number }

/** Inclusive cell range. */
export interface CellRange { c0: number; c1: number; r0: number; r1: number }

export interface WorldBounds { minX: number; maxX: number; minZ: number; maxZ: number }

/**
 * World-space bounding box of every hex corner in the map — the same answer
 * as the library's `getMapWorldBounds`, from the rim cells only. Cell centres
 * are linear in column within a row and monotonic in row within a column,
 * so the extremes sit on the four edges: O(width + height), not O(cells).
 */
export function mapWorldBounds(map: HexMap, layout: HexLayout): WorldBounds {
  const { f0, f1, f2, f3, startAngle } = layout.orientation;
  const size = layout.size;
  const w = map.width, h = map.height;
  if (w === 0 || h === 0) return { minX: 0, maxX: 0, minZ: 0, maxZ: 0 };

  // Corner offsets relative to a cell centre — the same for every cell.
  let offMinX = Infinity, offMaxX = -Infinity, offMinZ = Infinity, offMaxZ = -Infinity;
  for (let i = 0; i < 6; i++) {
    const angle = (2 * Math.PI * (startAngle + i)) / 6;
    const ox = size * Math.cos(angle);
    const oz = size * Math.sin(angle);
    if (ox < offMinX) offMinX = ox;
    if (ox > offMaxX) offMaxX = ox;
    if (oz < offMinZ) offMinZ = oz;
    if (oz > offMaxZ) offMaxZ = oz;
  }

  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  const visit = (col: number, row: number): void => {
    const q = col - (row - (row & 1)) / 2;
    const x = (f0 * q + f1 * row) * size + layout.originX;
    const z = (f2 * q + f3 * row) * size + layout.originZ;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  };
  for (let row = 0; row < h; row++) { visit(0, row); visit(w - 1, row); }
  for (let col = 0; col < w; col++) { visit(col, 0); visit(col, h - 1); }

  return {
    minX: minX + offMinX, maxX: maxX + offMaxX,
    minZ: minZ + offMinZ, maxZ: maxZ + offMaxZ,
  };
}

/** The world ↔ pixel mapping for an image of `bounds` at `scale` px per unit — the library's transform, rebuilt here from rim-only bounds. */
export function makeMapTransform(bounds: WorldBounds, scale: number, padding: number): MapImageTransform {
  return {
    width:  Math.ceil((bounds.maxX - bounds.minX) * scale) + padding * 2,
    height: Math.ceil((bounds.maxZ - bounds.minZ) * scale) + padding * 2,
    scale,
    padding,
    bounds,
    worldToImage(x, z, out) {
      const px = (x - bounds.minX) * scale + padding;
      const py = (z - bounds.minZ) * scale + padding;
      if (out) { out.x = px; out.y = py; return out; }
      return { x: px, y: py };
    },
    imageToWorld(px, py, out) {
      const x = (px - padding) / scale + bounds.minX;
      const z = (py - padding) / scale + bounds.minZ;
      if (out) { out.x = x; out.z = z; return out; }
      return { x, z };
    },
  };
}

export interface RasterStyle {
  terrainDefinitions: TerrainDefinition[];
  /** 0xRRGGBB behind the map and under unknown terrain indices. */
  background: number;
  /** Each elevation step brightens a cell by this fraction. 0 disables. */
  elevationShading?: number;
  /** Per-cell 0xRRGGBB blended over the terrain at `tintAlpha`; null leaves the cell alone. */
  cellTint?: (col: number, row: number) => number | null | undefined;
  tintAlpha?: number;
  /** Fog RGBA per cell (visible, explored, reveal, -), as `FogData.rawData`. */
  fog?: { rawData: Uint8Array } | null;
  /** How far explored-but-not-visible cells darken, 0–1. */
  fogDimOpacity?: number;
  /** Leave never-explored cells as background. */
  fogHideUnexplored?: boolean;
}

export function fullRect(transform: MapImageTransform): PixelRect {
  return { x0: 0, y0: 0, x1: transform.width, y1: transform.height };
}

/**
 * Paint the terrain into `pixels` (RGBA, `transform.width × transform.height`)
 * over `rect`, defaulting to the whole image. Each pixel's centre is mapped
 * back to world space and rounded to its hex, so the shapes are exact at any
 * scale and the cost is the rectangle's area.
 */
export function rasterTerrain(
  pixels:    Uint8ClampedArray,
  transform: MapImageTransform,
  map:       HexMap,
  layout:    HexLayout,
  style:     RasterStyle,
  rect:      PixelRect = fullRect(transform),
): void {
  const { width, scale, padding, bounds } = transform;
  const { b0, b1, b2, b3 } = layout.orientation;
  const size = layout.size, originX = layout.originX, originZ = layout.originZ;
  const w = map.width, h = map.height;

  // Colour table by terrain index — one lookup per pixel instead of a Map hit.
  const table = new Float32Array(256 * 3);
  const known = new Uint8Array(256);
  for (const def of style.terrainDefinitions) {
    if (def.index < 0 || def.index >= 256) continue;
    table[def.index * 3]     = def.color.r;
    table[def.index * 3 + 1] = def.color.g;
    table[def.index * 3 + 2] = def.color.b;
    known[def.index] = 1;
  }
  const bgR = (style.background >> 16) & 255;
  const bgG = (style.background >> 8)  & 255;
  const bgB =  style.background        & 255;
  const shading = style.elevationShading ?? 0;
  const fog     = style.fog?.rawData ?? null;
  const dim     = style.fogDimOpacity ?? 0.5;
  const hide    = style.fogHideUnexplored ?? false;
  const tint    = style.cellTint;
  const tintA   = style.tintAlpha ?? 0.45;

  const x0 = Math.max(0, rect.x0), x1 = Math.min(width, rect.x1);
  const y0 = Math.max(0, rect.y0), y1 = Math.min(transform.height, rect.y1);

  for (let py = y0; py < y1; py++) {
    const pz = ((py + 0.5 - padding) / scale + bounds.minZ - originZ) / size;
    let o = (py * width + x0) * 4;
    for (let px = x0; px < x1; px++, o += 4) {
      const pxl = ((px + 0.5 - padding) / scale + bounds.minX - originX) / size;
      // Fractional axial → nearest hex (cube rounding, same as hexRound).
      const fq = b0 * pxl + b1 * pz;
      const fr = b2 * pxl + b3 * pz;
      const fs = -fq - fr;
      let q = Math.round(fq), r = Math.round(fr);
      const s  = Math.round(fs);
      const dq = Math.abs(q - fq), dr = Math.abs(r - fr), ds = Math.abs(s - fs);
      if (dq > dr && dq > ds) q = -r - s;
      else if (dr > ds)       r = -q - s;
      const row = r;
      const col = q + (r - (r & 1)) / 2;

      let R: number, G: number, B: number;
      paint: {
        if (col < 0 || col >= w || row < 0 || row >= h) break paint;
        const t = map.getTerrain(col, row);
        if (!known[t]) break paint;
        let visible = true;
        if (fog) {
          const base = (row * w + col) * 4;
          visible = fog[base] === 255;
          if (!(fog[base + 1] === 255) && hide) break paint;
        }
        R = table[t * 3]; G = table[t * 3 + 1]; B = table[t * 3 + 2];
        if (shading !== 0) {
          const f = Math.max(0, 1 + map.getElevation(col, row) * shading);
          R = Math.min(1, R * f); G = Math.min(1, G * f); B = Math.min(1, B * f);
        }
        if (tint) {
          const c = tint(col, row);
          if (c !== null && c !== undefined) {
            R += (((c >> 16) & 255) / 255 - R) * tintA;
            G += (((c >> 8)  & 255) / 255 - G) * tintA;
            B += (( c        & 255) / 255 - B) * tintA;
          }
        }
        if (fog && !visible && dim > 0) {
          const k = 1 - dim;
          R *= k; G *= k; B *= k;
        }
        pixels[o] = R * 255; pixels[o + 1] = G * 255; pixels[o + 2] = B * 255; pixels[o + 3] = 255;
        continue;
      }
      pixels[o] = bgR; pixels[o + 1] = bgG; pixels[o + 2] = bgB; pixels[o + 3] = 255;
    }
  }
}

/**
 * The pixels these cells' hexes cover, plus a one-pixel margin for the
 * rounding at their edges, clamped to the image. Null for no cells.
 */
export function cellsPixelRect(cells: Iterable<CellPos>, transform: MapImageTransform, layout: HexLayout): PixelRect | null {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const { col, row } of cells) {
    const p = hexToWorld(layout, offsetToHex(col, row));
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z;
    if (p.z > maxZ) maxZ = p.z;
  }
  if (minX === Infinity) return null;
  const r = layout.size; // circumradius: every corner lies within it
  const a = transform.worldToImage(minX - r, minZ - r);
  const b = transform.worldToImage(maxX + r, maxZ + r);
  return {
    x0: Math.max(0, Math.floor(a.x) - 1),
    y0: Math.max(0, Math.floor(a.y) - 1),
    x1: Math.min(transform.width,  Math.ceil(b.x) + 1),
    y1: Math.min(transform.height, Math.ceil(b.y) + 1),
  };
}

/**
 * The cell range to re-stroke around these cells: their bounding box grown
 * by one, since a neighbour's river or road spoke ends on the shared edge.
 * Clamped to the map; null for no cells.
 */
export function cellsRange(cells: Iterable<CellPos>, map: HexMap): CellRange | null {
  let c0 = Infinity, c1 = -Infinity, r0 = Infinity, r1 = -Infinity;
  for (const { col, row } of cells) {
    if (col < c0) c0 = col;
    if (col > c1) c1 = col;
    if (row < r0) r0 = row;
    if (row > r1) r1 = row;
  }
  if (c0 === Infinity) return null;
  return {
    c0: Math.max(0, c0 - 1), c1: Math.min(map.width - 1, c1 + 1),
    r0: Math.max(0, r0 - 1), r1: Math.min(map.height - 1, r1 + 1),
  };
}

export function mapRange(map: HexMap): CellRange {
  return { c0: 0, c1: map.width - 1, r0: 0, r1: map.height - 1 };
}

/** One river-or-road pass: which cells carry it, which of their edges, and how it strokes. */
export interface SpokePass {
  color: string;
  width: number;
  cellHas(col: number, row: number): boolean;
  edgeHas(col: number, row: number, edge: number): boolean;
}

/**
 * Stroke centre→edge-midpoint spokes for every pass, cell by cell over the
 * range, passes in order (roads under rivers: a bridge reads better than a
 * severed river). Edge `i` spans corners `i` and `i + 1`, matching the
 * terrain mesh, so spokes from neighbouring cells meet at the shared
 * midpoint. `alphaFor` dims a cell's strokes to match fogged terrain; 0 skips
 * the cell.
 */
export function strokeCellSpokes(
  ctx:       CanvasRenderingContext2D,
  layout:    HexLayout,
  transform: MapImageTransform,
  range:     CellRange,
  passes:    readonly SpokePass[],
  alphaFor?: (col: number, row: number) => number,
): void {
  if (passes.length === 0) return;
  ctx.lineCap  = 'round';
  ctx.lineJoin = 'round';
  const pt = { x: 0, y: 0 };
  const cx = new Float64Array(6);
  const cz = new Float64Array(6);
  for (let row = range.r0; row <= range.r1; row++) {
    for (let col = range.c0; col <= range.c1; col++) {
      let any = false;
      for (const p of passes) if (p.cellHas(col, row)) { any = true; break; }
      if (!any) continue;
      const alpha = alphaFor ? alphaFor(col, row) : 1;
      if (alpha <= 0) continue;

      const hex    = offsetToHex(col, row);
      const centre = hexToWorld(layout, hex);
      transform.worldToImage(centre.x, centre.z, pt);
      const ox = pt.x, oz = pt.y;
      for (let i = 0; i < 6; i++) {
        const c = hexCorner(layout, hex, i);
        transform.worldToImage(c.x, c.z, pt);
        cx[i] = pt.x; cz[i] = pt.y;
      }

      ctx.globalAlpha = alpha;
      for (const p of passes) {
        if (!p.cellHas(col, row)) continue;
        let drew = false;
        ctx.beginPath();
        for (let i = 0; i < 6; i++) {
          if (!p.edgeHas(col, row, i)) continue;
          const i1 = (i + 1) % 6;
          ctx.moveTo(ox, oz);
          ctx.lineTo((cx[i] + cx[i1]) * 0.5, (cz[i] + cz[i1]) * 0.5);
          drew = true;
        }
        if (!drew) continue;
        ctx.strokeStyle = p.color;
        ctx.lineWidth   = p.width;
        ctx.stroke();
      }
    }
  }
  ctx.globalAlpha = 1;
}
