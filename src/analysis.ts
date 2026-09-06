import type { HexMap } from '@loyalj/hex-world';

/**
 * Pure math behind the View-menu analysis overlays: the elevation heatmap's
 * color ramps and the contour-line thresholds. The scene owns the overlay
 * meshes; everything here is data-in, color/threshold-out so it can be tested
 * without a renderer.
 */

export interface Range {
  min: number;
  max: number;
}

/**
 * Elevation extents measured separately for land and water. The heatmap
 * normalizes each domain against its own range — a map that is all shallow
 * lakes still gets the full blue ramp, and a lowland map still gets the full
 * land ramp — while contours use `all`.
 */
export interface ElevationRanges {
  all:   Range;
  land:  Range | null;
  water: Range | null;
}

export function computeElevationRanges(map: HexMap, isWater: (terrain: number) => boolean): ElevationRanges {
  let land: Range | null = null;
  let water: Range | null = null;
  for (let row = 0; row < map.height; row++) {
    for (let col = 0; col < map.width; col++) {
      const elev = map.getElevation(col, row);
      const r = isWater(map.getTerrain(col, row))
        ? (water ??= { min: elev, max: elev })
        : (land  ??= { min: elev, max: elev });
      if (elev < r.min) r.min = elev;
      if (elev > r.max) r.max = elev;
    }
  }
  const both = [land, water].filter((r): r is Range => r !== null);
  const all: Range = {
    min: Math.min(...both.map(r => r.min)),
    max: Math.max(...both.map(r => r.max)),
  };
  return { all, land, water };
}

/** A color ramp as [position 0–1, 0xRRGGBB] stops, positions ascending. */
export type Ramp = Array<[number, number]>;

/** Hypsometric land tints — lowland green through dry grass and rock to snow. */
export const LAND_RAMP: Ramp = [
  [0.0,  0x3e7a3a],
  [0.35, 0xc9c35e],
  [0.65, 0x9c6b3f],
  [0.85, 0x8a8a8a],
  [1.0,  0xf2f2f2],
];

/** Bathymetric water tints — deep navy up to shallow sky blue. */
export const WATER_RAMP: Ramp = [
  [0.0, 0x0d2f5e],
  [1.0, 0x5fb0dd],
];

/** Sample a ramp at t (clamped to 0–1), lerping RGB between stops. */
export function rampColor(ramp: Ramp, t: number): number {
  const x = Math.max(0, Math.min(1, t));
  let i = 0;
  while (i < ramp.length - 2 && x > ramp[i + 1][0]) i++;
  const [t0, c0] = ramp[i];
  const [t1, c1] = ramp[i + 1];
  const f = t1 === t0 ? 0 : (x - t0) / (t1 - t0);
  const lerp = (a: number, b: number) => Math.round(a + (b - a) * f);
  return (lerp((c0 >> 16) & 0xff, (c1 >> 16) & 0xff) << 16)
       | (lerp((c0 >> 8)  & 0xff, (c1 >> 8)  & 0xff) << 8)
       |  lerp( c0        & 0xff,  c1        & 0xff);
}

/**
 * Heatmap tint for one cell. Water cells ride the blue ramp over the water
 * range (deeper floor = darker); land cells ride the hypsometric ramp over the
 * land range. A flat domain sits mid-ramp rather than pinning to an extreme.
 */
export function heatmapColor(elev: number, ranges: ElevationRanges, water: boolean): number {
  const range = water ? ranges.water : ranges.land;
  const ramp  = water ? WATER_RAMP : LAND_RAMP;
  if (!range) return rampColor(ramp, 0.5);
  const t = range.max === range.min ? 0.5 : (elev - range.min) / (range.max - range.min);
  return rampColor(ramp, t);
}

/**
 * Elevation thresholds to draw contour lines at: multiples of a round interval
 * within (min, max]. A line at k is the boundary between cells at ≥ k and the
 * cells below, so the map's minimum never earns one (it would just outline the
 * whole map). Anchoring to multiples of the interval — not to the minimum —
 * keeps lines in place while edits shift the extremes, and puts a line at sea
 * level (0) whenever the map crosses it. The interval is the smallest round
 * step that keeps the count at or under `maxLines`.
 */
export function contourThresholds(range: Range, maxLines = 12): number[] {
  const intervals = [1, 2, 5, 10, 20, 50, 100];
  for (const interval of intervals) {
    // `|| 0` folds the -0 that Math.ceil produces for min just below zero.
    const first = Math.ceil((range.min + 1) / interval) * interval || 0;
    const count = first > range.max ? 0 : Math.floor((range.max - first) / interval) + 1;
    if (count > maxLines && interval !== intervals[intervals.length - 1]) continue;
    const out: number[] = [];
    for (let k = first; k <= range.max; k += interval) out.push(k);
    return out;
  }
  return []; // unreachable — the last interval always returns
}

/** River flow tints — a pale headwater blue deepening to a saturated main stem. */
export const FLOW_RAMP: Ramp = [
  [0.0, 0xa9dcf5],
  [0.5, 0x3d8fd6],
  [1.0, 0x0b3f8a],
];

/**
 * Tint for a river cell by accumulated flow. Log-scaled: flow grows by whole
 * tributaries, so a linear ramp would leave every stream but the trunk pale.
 */
export function riverFlowColor(flow: number, maxFlow: number): number {
  if (maxFlow <= 1) return rampColor(FLOW_RAMP, 1);
  return rampColor(FLOW_RAMP, Math.log(Math.max(1, flow)) / Math.log(maxFlow));
}

/** A distinct hue per drainage basin: the golden angle keeps neighbours apart. */
export function basinColor(index: number): number {
  const h = (index * 137.508) % 360;
  return hslToRgb(h / 360, 0.65, 0.55);
}

/**
 * A distinct hue per road network, on the same golden-angle wheel as basins
 * but offset half a turn and lighter, so a road and a river sharing a cell
 * don't collapse into one tint when both overlays are on.
 */
export function roadNetworkColor(index: number): number {
  const h = (180 + index * 137.508) % 360;
  return hslToRgb(h / 360, 0.75, 0.65);
}

function hslToRgb(h: number, s: number, l: number): number {
  const k = (n: number): number => (n + h * 12) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number): number => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return (Math.round(f(0) * 255) << 16) | (Math.round(f(8) * 255) << 8) | Math.round(f(4) * 255);
}
