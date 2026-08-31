import { offsetNeighbor, DEFAULT_WATER_TERRAIN_INDEX } from '@loyalj/hex-world';
import type { HexMap, MapGeneratorConfig, FbmGeneratorConfig } from '@loyalj/hex-world';
import type { ConfigObj } from './configUI.ts';

/**
 * The wizard's answers, engine-neutral. Sliders are all 0–1; each shape's
 * compile() decides what a value means for its generator, so "Ruggedness 0.7"
 * can be octaves on one engine and sink probability on another.
 */
export interface WizardAnswers {
  shapeId:        string;
  climateId:      string;
  /** 0 = no sea, 1 = drowned. Only meaningful when the shape supports it. */
  seaLevel:       number;
  ruggedness:     number;
  mountainHeight: number;
  coastDetail:    number;
  erosion:        number;
  sizeId:         'small' | 'medium' | 'large' | 'custom';
  customWidth:    number;
  customHeight:   number;
  rivers:         'none' | 'few' | 'some' | 'many';
  roads:          boolean;
  regionCount:    number;
  scatter:        'none' | 'sparse' | 'medium' | 'dense';
  seed:           number;
}

export interface MapSize {
  width:  number;
  height: number;
}

/**
 * Which wizard controls make sense for a shape. Unsupported controls are
 * hidden rather than shown dead — a slider that silently does nothing teaches
 * the user not to trust the ones that work.
 */
export interface ShapeSupports {
  seaLevel:    boolean;
  coastDetail: boolean;
  erosion:     boolean;
  regions:     boolean;
}

/**
 * One entry in the world-shape registry — everything the wizard needs to offer
 * a shape as a card. Adding a generator to the wizard means registering its
 * plugin as usual and adding shape entries that compile onto it; the wizard UI
 * renders whatever is in this registry.
 *
 * compile() receives the real target size so cell-count-dependent knobs
 * (chunk sizes, grid spacings, noise periods) scale with the map. The preview
 * compiles through the same path at preview size, which is what keeps a 56-cell
 * preview looking like the 256-cell map it stands for.
 */
export interface WorldShape {
  id:       string;
  name:     string;
  blurb:    string;
  pluginId: string;
  supports: ShapeSupports;
  /** Answer values this shape resets when picked (typically its natural sea level). */
  defaults?: Partial<WizardAnswers>;
  compile(a: WizardAnswers, size: MapSize): ConfigObj;
}

/**
 * A climate is a set of per-engine config adjustments, keyed by plugin id.
 * A climate that has no entry for a shape's engine simply leaves the compiled
 * config alone — future engines opt in by adding their key.
 */
export interface WizardClimate {
  id:   string;
  name: string;
  /** Four CSS colors for the palette strip on the climate card. */
  swatches: [string, string, string, string];
  apply: Record<string, (config: ConfigObj, a: WizardAnswers) => void>;
}

export const SIZE_PRESETS: Record<'small' | 'medium' | 'large', MapSize> = {
  small:  { width: 64,  height: 64  },
  medium: { width: 100, height: 100 },
  large:  { width: 256, height: 256 },
};

export function resolveSize(a: WizardAnswers): MapSize {
  if (a.sizeId === 'custom') {
    return {
      width:  Math.max(10, Math.min(512, Math.round(a.customWidth)  || 100)),
      height: Math.max(10, Math.min(512, Math.round(a.customHeight) || 100)),
    };
  }
  return SIZE_PRESETS[a.sizeId];
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Mean edge length in cells — the linear scale that grid spacings follow. */
const meanEdge = (s: MapSize): number => (s.width + s.height) / 2;

/** Area relative to the 100×100 reference map — the scale chunk sizes follow. */
const areaFactor = (s: MapSize): number => (s.width * s.height) / (100 * 100);

// A grid spacing far past any map edge: the pass runs but places nothing,
// which is how both engines' river/road passes are switched off.
const NEVER = 100000;

// ---- Shared sub-config builders ----

function chunkedRivers(a: WizardAnswers): MapGeneratorConfig['rivers'] {
  const pct = { none: 0, few: 4, some: 9, many: 16 }[a.rivers];
  return { riverPercentage: pct, extraLakeProbability: 0.25 };
}

function fbmRivers(a: WizardAnswers, size: MapSize): FbmGeneratorConfig['rivers'] {
  if (a.rivers === 'none') return { gridSpacing: NEVER };
  const base = { few: 64, some: 44, many: 26 }[a.rivers];
  return {
    gridSpacing:      Math.max(8, Math.round(base * meanEdge(size) / 100)),
    minSeedElevation: 4,
  };
}

function roadsConfig(a: WizardAnswers, size: MapSize): { gridSpacing: number; maxElevationDiff: number } {
  return {
    gridSpacing:      a.roads ? Math.max(10, Math.round(meanEdge(size) * 0.24)) : NEVER,
    maxElevationDiff: 1,
  };
}

// ---- Chunked-engine shape helper ----

interface ChunkedShapeTuning {
  /** Chunk size range at 100×100 — scaled by map area. */
  chunkMin: number;
  chunkMax: number;
  /** Base jitter before the coast-detail slider adds its share. */
  jitterBase: number;
  jitterSpan: number;
  /** 'accrete' grows one coherent mass per region, 'scatter' grows islands. */
  placement: 'accrete' | 'scatter';
  /** For scatter shapes: 'wide' spreads islands apart, 'narrow' packs chains. */
  channels?: 'wide' | 'narrow';
  /** Chunk stretch factor — lens-shaped chunks read as geology, not blobs. */
  elongation: number;
  /** Multiplier on the gap between region spawn zones — big for continents, so a strait survives chunk spill. */
  regionGap?: number;
  /** Whether this shape raises mountain-range spines across its landmass. */
  ranges: boolean;
  /** Coast-warp amplitude at mid coast-detail; the slider sweeps around it. */
  warp: number;
  /** Whether raise rounds occasionally walk peninsulas out of the mass. */
  peninsulas?: boolean;
  /** Guide arcs per region for scatter seeds — island chains. */
  arcs?: boolean;
  /** Ignore the regions answer and use one whole-map region — chains want to sweep the full frame. */
  singleRegion?: boolean;
  /** Distance-from-coast elevation blend, 0–1: lowland coasts, high interior. */
  shaping?: number;
}

function compileChunked(a: WizardAnswers, size: MapSize, t: ChunkedShapeTuning): ConfigObj {
  // The area factor is floored: at thumbnail scale a pure area scaling shrinks
  // chunks to single-cell speckle and the water gaps to nothing, and the shape
  // stops resembling the map it stands for. Relatively-larger chunks on a tiny
  // map are the more honest preview.
  const af = Math.max(0.3, areaFactor(size));
  const chunkSizeMin = Math.max(4, Math.round(t.chunkMin * af));
  const chunkSizeMax = Math.max(chunkSizeMin + 10, Math.round(t.chunkMax * af));
  const chunkRadius  = Math.sqrt(chunkSizeMax / Math.PI);
  // The edge water buffer scales with the map, or a thumbnail-sized generation
  // loses a third of its rows to a border tuned for 100².
  const border = Math.max(2, Math.round(5 * meanEdge(size) / 100));
  // Range width also shades down at preview sizes, or one range buries a thumbnail.
  const upliftScale = clamp(meanEdge(size) / 100, 0.6, 1);
  const config: MapGeneratorConfig = {
    mapBorderX:        border,
    mapBorderZ:        border,
    regionBorder:      Math.round(border * (t.regionGap ?? 1)),
    regionCount:       t.singleRegion ? 1 : clamp(Math.round(a.regionCount), 1, 4),
    landPercentage:    clamp(Math.round((1 - a.seaLevel) * 100), 10, 95),
    elevationMax:      Math.round(5 + a.mountainHeight * 15),
    chunkSizeMin,
    chunkSizeMax,
    jitterProbability: clamp(t.jitterBase + a.coastDetail * t.jitterSpan, 0, 0.5),
    sinkProbability:   0.08 + a.ruggedness * 0.3,
    seedPlacement:     t.placement,
    scatterGap:        t.channels === undefined ? 0
                     : t.channels === 'wide' ? Math.max(3, Math.round(chunkRadius * 2))
                     : 3,
    seedArcs:          t.arcs ? clamp(Math.round(5 * meanEdge(size) / 100), 3, 7) : 0,
    chunkElongation:   t.elongation,
    peninsulaProbability: t.peninsulas ? 0.08 + a.coastDetail * 0.18 : 0,
    coastWarp:         t.warp * (0.4 + a.coastDetail * 1.2),
    coastShaping:      t.shaping ?? 0,
    mountainRanges:    t.ranges ? Math.max(1, Math.round(meanEdge(size) / 100 * (1 + a.mountainHeight * 2))) : 0,
    rangeUplift:       clamp(Math.round((2 + a.mountainHeight * 5) * upliftScale), 1, 8),
    erosionPercentage: Math.round(a.erosion * 100),
    rivers:            chunkedRivers(a),
    roads:             roadsConfig(a, size),
  };
  return config as ConfigObj;
}

// ---- FBM-engine shape helper ----

interface FbmShapeTuning {
  /** Noise period at 100×100 — scaled by map edge and the coast-detail slider. */
  periodBase: number;
  elevOffset: number;
  /** Elevation scale range the mountain slider moves across. */
  elevScaleLo: number;
  elevScaleHi: number;
  /** false = no sea at all (threshold pinned below any noise value). */
  waterFromSeaLevel: boolean;
  /**
   * FBM's default biome bands assume the sea covers everything below −0.55;
   * with the sea shrunk or removed, the desert band swallows the exposed range
   * and the map reads as a desert planet. Each shape names its own low bands:
   * 'off' disables one, 'shore' puts a thin mud line just above the waterline.
   */
  desertThreshold: number | 'off';
  mudThreshold:    number | 'off' | 'shore';
  rockThreshold: number;
  snowThreshold: number;
}

/** Below any value FBM noise can reach — a band with this threshold never appears. */
const FBM_BAND_OFF = -10;

function compileFbm(a: WizardAnswers, size: MapSize, t: FbmShapeTuning): ConfigObj {
  const detail = t.waterFromSeaLevel ? a.coastDetail : 0.5;
  const waterThreshold = t.waterFromSeaLevel ? -1.5 + a.seaLevel * 1.4 : FBM_BAND_OFF;
  const config: FbmGeneratorConfig = {
    terrain: {
      period:    Math.max(12, Math.round(t.periodBase * (1.25 - detail * 0.75) * meanEdge(size) / 100)),
      octaves:   Math.round(4 + a.ruggedness * 4),
      amplitude: 1.6 + a.ruggedness * 1.6,
      elevScale: Math.round(t.elevScaleLo + a.mountainHeight * (t.elevScaleHi - t.elevScaleLo)),
      elevOffset: t.elevOffset,
      waterThreshold,
      desertThreshold: t.desertThreshold === 'off' ? FBM_BAND_OFF : t.desertThreshold,
      mudThreshold:    t.mudThreshold === 'off'   ? FBM_BAND_OFF
                     : t.mudThreshold === 'shore' ? waterThreshold + 0.08
                     : t.mudThreshold,
      rockThreshold: t.rockThreshold,
      snowThreshold: t.snowThreshold,
    },
    rivers: fbmRivers(a, size),
    roads:  roadsConfig(a, size),
  };
  return config as ConfigObj;
}

// ---- The registries ----

export const WORLD_SHAPES: WorldShape[] = [
  {
    id: 'continents', name: 'Continents',
    blurb: 'Big land masses split by open sea. Good default.',
    pluginId: 'chunk',
    supports: { seaLevel: true, coastDetail: true, erosion: true, regions: true },
    defaults: { seaLevel: 0.48 },
    compile: (a, size) => compileChunked(a, size, {
      chunkMin: 50, chunkMax: 190, jitterBase: 0.05, jitterSpan: 0.4,
      placement: 'accrete', elongation: 2.0, regionGap: 3, ranges: true,
      warp: 3, peninsulas: true, shaping: 0.45,
    }),
  },
  {
    id: 'islands', name: 'Islands',
    blurb: 'Scattered land, lots of coastline.',
    pluginId: 'chunk',
    supports: { seaLevel: true, coastDetail: true, erosion: true, regions: true },
    defaults: { seaLevel: 0.62 },
    compile: (a, size) => compileChunked(a, size, {
      chunkMin: 14, chunkMax: 48, jitterBase: 0.1, jitterSpan: 0.4,
      placement: 'scatter', channels: 'wide', elongation: 1.2, ranges: false,
      warp: 2.5, shaping: 0.35,
    }),
  },
  {
    id: 'archipelago', name: 'Archipelago',
    blurb: 'Dense island chains, narrow channels.',
    pluginId: 'chunk',
    supports: { seaLevel: true, coastDetail: true, erosion: true, regions: true },
    defaults: { seaLevel: 0.78 },
    compile: (a, size) => compileChunked(a, size, {
      chunkMin: 4, chunkMax: 14, jitterBase: 0.15, jitterSpan: 0.35,
      placement: 'scatter', channels: 'narrow', elongation: 2.2, ranges: false,
      warp: 2, arcs: true, singleRegion: true,
    }),
  },
  {
    id: 'solid', name: 'Solid land',
    blurb: 'No sea at all. Rivers and lakes only.',
    pluginId: 'fbm',
    supports: { seaLevel: false, coastDetail: false, erosion: false, regions: false },
    compile: (a, size) => compileFbm(a, size, {
      periodBase: 64, elevOffset: 6, elevScaleLo: 8, elevScaleHi: 24,
      waterFromSeaLevel: false,
      // No sea means the whole low range is exposed: green basins with rare
      // dry mud sinks, not the drained-ocean desert the default bands paint.
      desertThreshold: 'off', mudThreshold: -1.2,
      rockThreshold: 0.42, snowThreshold: 0.72,
    }),
  },
  {
    id: 'highlands', name: 'Highlands',
    blurb: 'Mountainous throughout, deep valleys.',
    pluginId: 'fbm',
    supports: { seaLevel: true, coastDetail: true, erosion: false, regions: false },
    defaults: { seaLevel: 0.12 },
    compile: (a, size) => compileFbm(a, size, {
      periodBase: 48, elevOffset: 8, elevScaleLo: 14, elevScaleHi: 30,
      waterFromSeaLevel: true,
      // Green valleys with a mud shoreline, rocky slopes, snow only on peaks.
      desertThreshold: 'off', mudThreshold: 'shore',
      rockThreshold: 0.35, snowThreshold: 0.8,
    }),
  },
];

export const WIZARD_CLIMATES: WizardClimate[] = [
  {
    id: 'temperate', name: 'Temperate',
    swatches: ['#86b888', '#a08870', '#a3adb5', '#4a8fb5'],
    // The engines' defaults are already temperate — nothing to adjust.
    apply: {},
  },
  {
    id: 'arid', name: 'Arid',
    swatches: ['#c8bea0', '#a08870', '#a3adb5', '#86b888'],
    apply: {
      chunk: (config) => {
        const c = config as MapGeneratorConfig;
        c.temperature = { lowTemperature: 0.3, highTemperature: 1.2 };
        c.climate = {
          evaporationFactor: 0.35, precipitationFactor: 0.15, startingMoisture: 0.04,
        };
      },
      fbm: (config) => {
        const t = (config as FbmGeneratorConfig).terrain!;
        t.desertThreshold = -0.05;
        t.mudThreshold    = 0.08;
        t.rockThreshold   = Math.max(t.rockThreshold ?? 0.42, 0.5);
        t.snowThreshold   = 1.3;
      },
    },
  },
  {
    id: 'frozen', name: 'Frozen',
    swatches: ['#d5e6f5', '#a3adb5', '#86b888', '#4a8fb5'],
    apply: {
      chunk: (config) => {
        const c = config as MapGeneratorConfig;
        c.temperature = { lowTemperature: -0.35, highTemperature: 0.35 };
      },
      fbm: (config) => {
        const t = (config as FbmGeneratorConfig).terrain!;
        // Slide the desert band under the waterline so it never appears, and
        // pull rock/snow down so the cold starts near sea level.
        t.desertThreshold = t.waterThreshold ?? -0.55;
        t.mudThreshold    = (t.waterThreshold ?? -0.55) + 0.06;
        t.rockThreshold   = 0.08;
        t.snowThreshold   = 0.28;
      },
    },
  },
];

export function getShape(id: string): WorldShape {
  return WORLD_SHAPES.find(s => s.id === id) ?? WORLD_SHAPES[0];
}

export function getClimate(id: string): WizardClimate {
  return WIZARD_CLIMATES.find(c => c.id === id) ?? WIZARD_CLIMATES[0];
}

export function defaultAnswers(seed: number): WizardAnswers {
  return {
    shapeId:        'continents',
    climateId:      'temperate',
    seaLevel:       0.48,
    ruggedness:     0.45,
    mountainHeight: 0.5,
    coastDetail:    0.5,
    erosion:        0.5,
    sizeId:         'medium',
    customWidth:    100,
    customHeight:   100,
    rivers:         'some',
    roads:          true,
    regionCount:    2,
    scatter:        'medium',
    seed,
  };
}

export interface CompiledWizard {
  pluginId: string;
  config:   ConfigObj;
  width:    number;
  height:   number;
}

/** Compiles the answers at their real target size. */
export function compileWizard(a: WizardAnswers): CompiledWizard {
  const size   = resolveSize(a);
  const shape  = getShape(a.shapeId);
  const config = shape.compile(a, size);
  getClimate(a.climateId).apply[shape.pluginId]?.(config, a);
  return { pluginId: shape.pluginId, config, width: size.width, height: size.height };
}

// ---- Post-generation passes ----

/**
 * Scales the generated scatter densities up or down one level. The generators
 * write levels 0–3 per feature layer; this remaps rather than rescatters, so
 * the same seed keeps the same woodland footprint at every density.
 */
export function applyScatterDensity(map: HexMap, density: WizardAnswers['scatter']): void {
  if (density === 'medium') return;
  for (let row = 0; row < map.height; row++) {
    for (let col = 0; col < map.width; col++) {
      for (let layer = 0; layer < map.featureLayerCount; layer++) {
        const lvl = map.getFeatureLevel(col, row, layer);
        if (lvl === 0) continue;
        const next = density === 'none'   ? 0
                   : density === 'sparse' ? lvl - 1
                   :                        Math.min(3, lvl + 1);
        if (next !== lvl) map.setFeatureLevel(col, row, layer, next);
      }
    }
  }
}

// ---- Preview stats ----

export interface MapStats {
  landPct:   number;
  waterPct:  number;
  highest:   number;
  /** Land cells with at least one water neighbor. */
  coastline: number;
}

export function computeMapStats(map: HexMap): MapStats {
  const isWater = (col: number, row: number): boolean =>
    map.getTerrain(col, row) === DEFAULT_WATER_TERRAIN_INDEX || map.getElevation(col, row) < 0;

  let water = 0, coastline = 0, highest = -Infinity;
  for (let row = 0; row < map.height; row++) {
    for (let col = 0; col < map.width; col++) {
      if (isWater(col, row)) { water++; continue; }
      const elev = map.getElevation(col, row);
      if (elev > highest) highest = elev;
      for (let d = 0; d < 6; d++) {
        const nb = offsetNeighbor(col, row, d);
        if (map.inBounds(nb.col, nb.row) && isWater(nb.col, nb.row)) { coastline++; break; }
      }
    }
  }
  const total = map.width * map.height;
  return {
    landPct:  Math.round(((total - water) / total) * 100),
    waterPct: Math.round((water / total) * 100),
    highest:  highest === -Infinity ? 0 : highest,
    coastline,
  };
}
