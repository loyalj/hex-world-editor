import { describe, expect, it } from 'vitest';
import { HexMap } from '@loyalj/hex-world';
import {
  computeElevationRanges, contourThresholds, heatmapColor, rampColor,
  LAND_RAMP, WATER_RAMP,
} from '../src/analysis.ts';
import { WATER } from './helpers.ts';

const isWater = (t: number) => t === WATER;

/** A map whose left `waterCols` columns are water at `waterElev`, the rest land rising left to right. */
function makeMap(waterCols: number, waterElev = -2): HexMap {
  const map = new HexMap({ width: 6, height: 4, featureLayerCount: 4 });
  for (let row = 0; row < map.height; row++) {
    for (let col = 0; col < map.width; col++) {
      if (col < waterCols) {
        map.setTerrain(col, row, WATER);
        map.setElevation(col, row, waterElev);
      } else {
        map.setElevation(col, row, col); // 0-elevation default terrain is land
      }
    }
  }
  return map;
}

describe('computeElevationRanges', () => {
  it('measures land and water separately, and the union as all', () => {
    const ranges = computeElevationRanges(makeMap(2, -3), isWater);
    expect(ranges.water).toEqual({ min: -3, max: -3 });
    expect(ranges.land).toEqual({ min: 2, max: 5 });
    expect(ranges.all).toEqual({ min: -3, max: 5 });
  });

  it('a landlocked map has no water range', () => {
    const ranges = computeElevationRanges(makeMap(0), isWater);
    expect(ranges.water).toBeNull();
    expect(ranges.land).toEqual({ min: 0, max: 5 });
    expect(ranges.all).toEqual(ranges.land);
  });
});

describe('rampColor', () => {
  it('returns the exact stop colors at the extremes and clamps beyond them', () => {
    expect(rampColor(LAND_RAMP, 0)).toBe(LAND_RAMP[0][1]);
    expect(rampColor(LAND_RAMP, 1)).toBe(LAND_RAMP[LAND_RAMP.length - 1][1]);
    expect(rampColor(LAND_RAMP, -5)).toBe(LAND_RAMP[0][1]);
    expect(rampColor(LAND_RAMP, 5)).toBe(LAND_RAMP[LAND_RAMP.length - 1][1]);
  });

  it('lerps channel-wise between two stops', () => {
    const mid = rampColor([[0, 0x000000], [1, 0x2040ff]], 0.5);
    expect(mid).toBe(0x102080);
  });
});

describe('heatmapColor', () => {
  it('pins land extremes to the ends of the land ramp', () => {
    const ranges = computeElevationRanges(makeMap(2), isWater);
    expect(heatmapColor(2, ranges, false)).toBe(LAND_RAMP[0][1]);
    expect(heatmapColor(5, ranges, false)).toBe(LAND_RAMP[LAND_RAMP.length - 1][1]);
  });

  it('water uses the blue ramp, normalized over the water range only', () => {
    const map = makeMap(2);
    map.setElevation(0, 0, -6); // one deep cell so water spans -6..-2
    const ranges = computeElevationRanges(map, isWater);
    expect(heatmapColor(-6, ranges, true)).toBe(WATER_RAMP[0][1]);
    expect(heatmapColor(-2, ranges, true)).toBe(WATER_RAMP[1][1]);
  });

  it('a flat domain sits mid-ramp instead of pinning to an extreme', () => {
    const ranges = computeElevationRanges(makeMap(2), isWater); // all water at -2
    expect(heatmapColor(-2, ranges, true)).toBe(rampColor(WATER_RAMP, 0.5));
  });
});

describe('contourThresholds', () => {
  it('a small range gets a line at every step above the minimum', () => {
    expect(contourThresholds({ min: 0, max: 5 })).toEqual([1, 2, 3, 4, 5]);
  });

  it('never draws a line at the minimum — it would outline the whole map', () => {
    expect(contourThresholds({ min: 3, max: 4 })).toEqual([4]);
  });

  it('a flat map has no contours', () => {
    expect(contourThresholds({ min: 2, max: 2 })).toEqual([]);
  });

  it('widens the interval to keep within the line budget, anchored at zero', () => {
    // -3..40 at interval 1 or 2 blows the default budget of 12; interval 5
    // gives 0,5,…,40 — nine lines, including one at sea level.
    expect(contourThresholds({ min: -3, max: 40 }))
      .toEqual([0, 5, 10, 15, 20, 25, 30, 35, 40]);
  });

  it('honors a custom budget', () => {
    expect(contourThresholds({ min: 0, max: 10 }, 5)).toEqual([2, 4, 6, 8, 10]);
  });

  it('the full elevation span still resolves to a round interval', () => {
    const out = contourThresholds({ min: -128, max: 127 });
    expect(out.length).toBeLessThanOrEqual(12);
    expect(out.every(k => k % 50 === 0)).toBe(true);
  });
});
