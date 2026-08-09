import * as THREE from 'three';
import {
  HexMap, HexWorld, ChunkManager, FogData,
  loadHexPack, formatSeason, cameraGroundFootprint,
  DEFAULT_RESOURCE_DESCRIPTORS,
  offsetToHex, hexToOffset, hexRange,
  attachSeasonalTint, attachWindSway, attachScatterTexture, styleScatterTexture,
  createRockMaterial,
  createPineGeometry, createBroadleafGeometry, createBushGeometry,
  BROADLEAF_CANOPY_COLOR, BUSH_COLOR,
} from '@loyalj/hex-world';
import type {
  ScatterDefinition, HexCoord, TerrainDefinition, TerrainDescriptor, TerrainAssetRegistry,
  LiquidTypeDescriptor, WeatherType, FactionDescriptor, ResourceDescriptor,
  TerritoryLayer, ResourceLayer, HexLayout, SeasonScope,
} from '@loyalj/hex-world';

/** How much freedom the camera has. See {@link EditorScene.setCameraMode}. */
export type CameraMode = 'rts' | 'free';

/**
 * The two presets behind the View ▸ Camera switch. `rts` is what the editor
 * shipped with; `free` exists because a tilt floor above roughly half the
 * vertical FOV never lets the horizon into frame, which silently hides the sky
 * dome's best hours, sunsets, and the god rays.
 */
const CAMERA_MODES: Record<CameraMode, { minPitch: number; maxPitch: number; yaw: boolean }> = {
  rts:  { minPitch: 30, maxPitch: 66, yaw: false },
  free: { minPitch: 6,  maxPitch: 80, yaw: true  },
};

const MAP_WIDTH    = 100;
const MAP_HEIGHT   = 100;
const CHUNK_SIZE   = 32;
const LOAD_RADIUS  = 5;

/**
 * Feature layers every map the editor makes carries, in the order the scatter
 * brushes and the generators address them: 0 conifers, 1 rocks, 2 broadleaf
 * trees, 3 bushes. Exported because the New Map dialog builds its own maps and
 * has to match — `setFeatureLevel` ignores a layer past the end rather than
 * failing, so a short map loses those brushes without saying so.
 */
export const FEATURE_LAYERS = 4;

/**
 * Starting faction roster for the ownership brush. Ownership lives in the
 * map's metadata channel, so these ids travel with the saved map — keep them
 * short and stable.
 */
export const DEFAULT_FACTIONS: FactionDescriptor[] = [
  { id: 'red',   name: 'Kelmar',   color: 0xdd4433 },
  { id: 'blue',  name: 'Ossiran',  color: 0x3377dd },
  { id: 'green', name: 'Verdanth', color: 0x44aa55 },
  { id: 'gold',  name: 'Sarrow',   color: 0xddaa33 },
];

export interface WeatherSettings {
  /** Strength 0–1: particle density/opacity and cloud-shadow darkness. */
  intensity: number;
  /** Cloud shadows on the terrain and water. */
  clouds: boolean;
  /** Wind in world units/sec, on the ground plane. */
  windX: number;
  windY: number;
}

export interface SceneApi {
  readonly map: HexMap;
  readonly chunks: ChunkManager;
  hoveredCell: { col: number; row: number } | null;
  brushRadius: number;
  isWater(terrain: number): boolean;
  terrainLookup: Map<number, TerrainDefinition>;
  /** Show or hide the shader hex grid overlay (survives terrain material swaps). */
  setHexGrid(visible: boolean): void;
  /** Enable or disable sun shadows (materials recompile automatically). */
  setShadows(enabled: boolean): void;
  /** Time of day 0–1 (0 = midnight, 0.5 = noon) — follows the clock while it runs. */
  readonly timeOfDay: number;
  /** Jump the sun to a time of day, 0–1. Starts the day/night cycle on first use. */
  setTimeOfDay(time: number): void;
  /** Run or freeze the clock; dayLengthSeconds is real seconds per full cycle. */
  setDayCycle(animate: boolean, dayLengthSeconds: number): void;
  /** Switch weather — rebuilds the precipitation layer and re-styles cloud shadows. */
  setWeather(type: WeatherType, opts: WeatherSettings): void;
  /** Ramp the current weather 0–1 without rebuilding it. */
  setWeatherIntensity(intensity: number): void;
  /**
   * Re-aim the world's shared wind — the one vector behind cloud drift, rain
   * slant, plant sway, and the ripples marching across open water.
   */
  setWind(x: number, y: number): void;
  /**
   * How hard the wind gusts either side of that sustained vector, 0–1. Gusts
   * reach the plants and the rain but not the cloud deck: a whole overcast sky
   * doesn't surge in a two-second squall.
   */
  setGustiness(gustiness: number): void;
  /**
   * Peak-to-peak brightness mottling on the scatter plants and rocks, 0–1 —
   * what stops a flat-shaded canopy reading as plastic beside textured ground.
   * 0 switches it off and gives back the flat colour.
   */
  setScatterTexture(strength: number): void;
  // --- Fog of war ---
  /** The fog state, or null while fog is switched off. Sized to the current map. */
  readonly fog: FogData | null;
  /** Attach or detach fog across terrain, liquids, roads, scatter, and resource icons. */
  setFogEnabled(enabled: boolean): void;
  /** Black out never-seen cells entirely (the memory-tier boundary). */
  setHideUnexplored(enabled: boolean): void;
  readonly hideUnexplored: boolean;
  /** Dim explored-but-not-currently-visible cells to the remembered ghost look. */
  setDimExplored(enabled: boolean): void;
  readonly dimExplored: boolean;
  /** Reveal or re-hide cells for the fog brush. Returns true if anything changed. */
  paintFog(cells: Array<{ col: number; row: number }>, reveal: boolean): boolean;
  /** Explore the whole map, or (with false) forget all of it. */
  setAllFog(explored: boolean): void;
  /** Explored-cell count and map total, for the status strip. */
  readonly fogStats: { explored: number; total: number };

  // --- Sky ---
  // --- Camera ---
  /**
   * Swap how much freedom the camera has. `'rts'` is the classic constrained
   * view — heading pinned looking down −Z, tilt held between 30° and 66°.
   * `'free'` unlocks the heading and lets the tilt drop to 6°, low enough to
   * put the horizon (and so the sky, sunsets, and god rays) on screen.
   */
  setCameraMode(mode: CameraMode): void;
  readonly cameraMode: CameraMode;

  /**
   * The wall of cut earth that gives the map a bottom and four sides. Without
   * it, a low camera angle looks straight under the terrain, which is a
   * surface rather than a solid.
   */
  setSkirt(enabled: boolean): void;
  readonly skirtEnabled: boolean;
  /**
   * Recut the skirt from the current map. Only the perimeter is rebuilt, so
   * this is cheap enough to run after every edit rather than working out
   * whether the edit touched a boundary cell.
   */
  refreshSkirt(): void;

  /** Gradient sky dome plus the matching distance haze on every material. */
  setSky(enabled: boolean): void;
  readonly skyEnabled: boolean;
  /**
   * Crepuscular shafts fanning out from the sun past the ridgelines. Only
   * visible with the sun up and in front of the camera, so scrub the time of
   * day toward dawn or dusk and face the sun to see them at their strongest.
   */
  setGodRays(enabled: boolean): void;
  readonly godRaysEnabled: boolean;

  // --- Seasons ---
  /** Seasons, snow accumulation, and per-liquid ice. Builds the climate on first use. */
  setSeasonsEnabled(enabled: boolean): void;
  readonly seasonsEnabled: boolean;
  /** Scrub the year clock, 0–1 (0 = midwinter, 0.5 = midsummer). */
  setSeasonPhase(phase: number): void;
  /** Run or freeze the year clock; daysPerYear sets how many days a year takes. */
  setSeasonCycle(animate: boolean, daysPerYear: number): void;
  /**
   * Whether the map spans a range of climates ('continental') or is one place
   * that turns together ('local'). Survives the season being toggled off and on.
   */
  setSeasonScope(scope: SeasonScope): void;
  readonly seasonScope: SeasonScope;
  readonly seasonPhase: number;
  /** Human-readable season name for the current phase, e.g. "late spring". */
  readonly seasonLabel: string;

  // --- Territory ---
  readonly territory: TerritoryLayer | null;
  readonly factions: FactionDescriptor[];
  setTerritoryVisible(visible: boolean): void;
  /** Replace the faction roster (colors/names). Cell ownership is untouched. */
  setFactions(factions: FactionDescriptor[]): void;

  // --- Resources ---
  readonly resources: ResourceLayer | null;
  readonly resourceDescriptors: ResourceDescriptor[];
  setResourcesVisible(visible: boolean): void;

  /**
   * Rebuild the territory and resource overlays from the map's metadata
   * channel. Undo/redo restores that channel behind the layers' backs, so
   * their own dirty flags never fire — the command has to say so.
   */
  refreshGameplayLayers(): void;

  // --- Minimap ---
  /** Hex layout for the world — the world↔cell math a minimap needs. */
  readonly layout: HexLayout;
  /** Resolved terrain definitions (colors and names) for the live palette. */
  readonly terrainDefinitions: TerrainDefinition[];
  /**
   * The ground quad the camera currently covers, screen order TL/TR/BR/BL, or
   * null when the camera sits below the ground plane. Pass `out` to reuse
   * vectors across frames.
   */
  cameraFootprint(out?: THREE.Vector3[]): THREE.Vector3[] | null;
  /** Glide the camera to a world XZ position — the minimap's click-to-jump. */
  focusWorld(x: number, z: number): void;

  /** Smoothed frames per second, for the status strip. */
  readonly fps: number;
  /** Zoom factor for display: 1× at the farthest camera distance, higher when closer in. */
  readonly zoom: number;
  reload(): void;
  replaceMap(newMap: HexMap): void;
  setPathPreview(path: HexCoord[] | null, erasing?: boolean): void;
  rebuildTerrainFromDescriptors(descriptors: TerrainDescriptor[], registry: TerrainAssetRegistry): Promise<void>;
  setLiquidDescriptors(descriptors: LiquidTypeDescriptor[]): void;
  loadAndApplyHexPack(source: File | Blob): Promise<{
    terrainDescriptors: TerrainDescriptor[];
    liquidDescriptors: LiquidTypeDescriptor[];
    maps: Map<string, HexMap>;
  }>;
}

export async function initScene(container: HTMLElement, terrainDescriptors?: TerrainDescriptor[]): Promise<SceneApi> {
  // Scatter — conifers on 3 density tiers (layer 0). No seasonal tint: a pine
  // that stays green through October is what tells it from the broadleaf below.
  const pineMat = new THREE.MeshLambertMaterial({ color: 0x3f6b2c });
  // A stiff conifer barely moves — which is exactly why it gets the call. Wind
  // sway is opt-in per material for the same reason the seasonal tint is, and
  // the rock below deliberately never receives it.
  attachWindSway(pineMat, { height: 2.0, stiffness: 2.6, amplitude: 0.035, flutter: 0.2 });
  const pineDefinition: ScatterDefinition = {
    id:         'pine',
    name:       'Pine Trees',
    layerIndex: 0,
    tiers: [
      [{ geometry: createPineGeometry(2.0), material: pineMat, yOffset: 0 }],
      [{ geometry: createPineGeometry(1.5), material: pineMat, yOffset: 0 }],
      [{ geometry: createPineGeometry(1.0), material: pineMat, yOffset: 0 }],
    ],
  };

  // Scatter — rocks / boulders on 3 density tiers (layer 1).
  //
  // Largest first, matching every other definition here and the threshold table
  // in ScatterBuilder: tier 0 is the variant a *dense* cell draws, tier 2 the
  // one a sparse cell gets. These ran the other way round, and since the
  // generator only ever sets rock density to 1 — which draws tier 2 and nothing
  // else — every rock on the map was the biggest boulder, towering over sparse
  // pines that are the smallest tier for the same reason.
  //
  // Sized just under the bushes (0.85 → 0.45 wide) so scrub and stone read as
  // things you'd step over, not landmarks.
  // createRockMaterial squashes and stretches each instance from a hash of its
  // own position, so two rocks off the same geometry aren't the same rock. With
  // only a couple of tiers in play that variation is what stops a scree slope
  // reading as a pattern. Flat-shaded, so the deformed facets light correctly.
  const rockMat = createRockMaterial(0x8a7a6a);
  const rock = (radius: number) => ({
    geometry: new THREE.IcosahedronGeometry(radius, 0),
    material: rockMat,
    // An icosahedron's lowest vertex sits at 0.85 of its radius, and
    // createRockMaterial squashes instances to as little as 0.52 of their
    // height — so the shallowest a rock can reach is 0.44r below its centre.
    // Stay under that and even the flattest one is bedded in rather than
    // hovering over its own shadow.
    yOffset:  radius * 0.4,
  });
  const rockDefinition: ScatterDefinition = {
    id:           'rock',
    name:         'Rocks',
    layerIndex:   1,
    tiltStrength: 0.4,
    tiers: [[rock(0.30)], [rock(0.24)], [rock(0.19)]],
  };

  // Scatter — broadleaf woods (layer 2) and low scrub (layer 3). Both turn with
  // the year; `attachSeasonalTint` is the only thing that makes them do it, and
  // both need an explicit summer reference because a vertexColors material's own
  // color is white. Snow is attached for us by `setSeasons`.
  const broadleafMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  // Blossom rides along with the tint — a share of the wood flowers pink or
  // blue as spring passes through, then goes green for the summer.
  attachSeasonalTint(broadleafMat, { summer: BROADLEAF_CANOPY_COLOR, blossomShare: 0.6 });
  attachWindSway(broadleafMat, { height: 1.9, stiffness: 2.0, amplitude: 0.07 });
  const broadleafDefinition: ScatterDefinition = {
    id:           'broadleaf',
    name:         'Broadleaf Trees',
    layerIndex:   2,
    tiltStrength: 0.05,
    tiers: [
      [{ geometry: createBroadleafGeometry(1.9), material: broadleafMat, yOffset: 0 }],
      [{ geometry: createBroadleafGeometry(1.4), material: broadleafMat, yOffset: 0 }],
      [{ geometry: createBroadleafGeometry(1.0), material: broadleafMat, yOffset: 0 }],
    ],
  };

  const bushMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  // A bush is foliage all the way down — skip the green test that keeps the
  // tint off a broadleaf's trunk.
  attachSeasonalTint(bushMat, {
    summer: BUSH_COLOR, select: 0, variance: 0.35, blossomShare: 0.3,
  });
  // Short, soft and mostly leaf, so it moves far more of its own height than a
  // tree does — and bows from near the base rather than holding a trunk stiff.
  attachWindSway(bushMat, { height: 0.6, stiffness: 1.2, amplitude: 0.125, flutter: 0.6 });
  const bushDefinition: ScatterDefinition = {
    id:           'bush',
    name:         'Bushes',
    layerIndex:   3,
    tiltStrength: 0.12,
    tiers: [
      [{ geometry: createBushGeometry(0.85), material: bushMat, yOffset: 0 }],
      [{ geometry: createBushGeometry(0.65), material: bushMat, yOffset: 0 }],
      [{ geometry: createBushGeometry(0.45), material: bushMat, yOffset: 0 }],
    ],
  };

  // Flat-shaded low-poly plants read as plastic beside ground that carries real
  // triplanar texture, so break each facet up with fine procedural mottling.
  // Scale tracks facet size rather than plant size: a pine's cone is one long
  // smooth sweep and takes the coarsest pattern, a bush's lobes are tiny and
  // take the finest. The rock is here too — stone is what most wants grain.
  const scatterTextured: Array<[THREE.Material, number]> = [
    [pineMat, 5], [broadleafMat, 6], [bushMat, 11], [rockMat, 9],
  ];
  for (const [mat, scale] of scatterTextured) attachScatterTexture(mat, { scale });

  const world = await HexWorld.create({
    container,
    map: new HexMap({ width: MAP_WIDTH, height: MAP_HEIGHT, featureLayerCount: FEATURE_LAYERS }),
    terrainDescriptors,
    scatterDefinitions: [pineDefinition, rockDefinition, broadleafDefinition, bushDefinition],
    chunkSize:  CHUNK_SIZE,
    loadRadius: LOAD_RADIUS,
    geometryOptions: { colorMode: 'splat' },
    shadows: true,
    // Streaming builds go off-thread; dirty-chunk rebuilds stay synchronous in
    // the library, so painting still lands on the very next frame.
    chunkWorker: true,
    // On by default: purely visual, and the map edge fading into atmosphere is
    // how the engine is meant to look. Toggle under View.
    sky: true,
    // Also free outside daylight — the pass skips itself whenever the sun is
    // down, behind the camera, or under cloud.
    godRays: true,
    // The whole point of a free camera is looking along the ground, which is
    // exactly the angle that shows the map has no underside.
    skirt: true,
    // On, so the Environment ▸ Wind sliders reach the plants and the water and
    // not just the clouds. The starting vector matches the panel's own defaults
    // (3.4 u/s at 30°) so the sliders read true before anything is touched —
    // mid-slider rather than the old light breeze, because at 1.8 the sway is
    // about 3% of a tree's height and the feature looks switched off.
    wind: { heading: (30 * Math.PI) / 180, speed: 3.4 },
    // Opens in 'free' — the limits here have to match CAMERA_MODES.free or the
    // View ▸ Camera check would be lying until the first switch.
    camera: {
      initialDistance: 60,
      minPitch: CAMERA_MODES.free.minPitch,
      maxPitch: CAMERA_MODES.free.maxPitch,
      minDistance: 6,
      maxDistance: 80,
    },
  });

  // Territory and resources read the map's metadata channel, so they cost
  // nothing until something is actually painted — build them up front and let
  // the tools write through them.
  const territory = world.setFactions(DEFAULT_FACTIONS);
  const resources = world.setResourceTypes(DEFAULT_RESOURCE_DESCRIPTORS);

  // Fog is off to start: an editor that opens onto a black map is useless.
  // The instance is built on demand and rebuilt whenever the map size changes.
  let fog: FogData | null = null;
  let fogEnabled       = false;
  let hideUnexplored   = true;
  let dimExplored      = true;
  let skyEnabled       = true;
  let godRaysEnabled   = true;
  let skirtEnabled     = true;
  let cameraMode: CameraMode = 'free';
  let seasonsEnabled   = false;
  let seasonDaysPerYear = 8;
  let seasonScope: SeasonScope = 'continental';

  function ensureFog(): FogData {
    if (fog && fog.width === world.map.width && fog.height === world.map.height) return fog;
    fog = new FogData(world.map.width, world.map.height);
    if (fogEnabled) world.setFogData(fog);
    return fog;
  }

  function applyFogState(): void {
    world.setFogData(fogEnabled ? ensureFog() : null);
    world.setHideUnexplored(hideUnexplored);
    world.setDimExplored(dimExplored);
  }

  // Smoothed fps — an exponential moving average so the readout doesn't flicker
  let smoothedFps = 0;

  // Reused wind vector — the weather system copies it, so one instance is enough
  const wind = new THREE.Vector2();

  // Hover footprint follows the brush every frame
  world.onFrame = (dt: number) => {
    api.hoveredCell = world.hoveredCell;
    world.overlays.set('hover', world.hoveredCell
      ? hexRange(offsetToHex(world.hoveredCell.col, world.hoveredCell.row), api.brushRadius).map(hexToOffset)
      : null);
    if (dt > 0) smoothedFps = smoothedFps === 0 ? 1 / dt : smoothedFps * 0.9 + (1 / dt) * 0.1;
  };

  const api: SceneApi = {
    get map() { return world.map; },
    get chunks() { return world.chunks; },
    hoveredCell: null,
    brushRadius: 0,
    reload() {
      world.chunks.dispose();
      world.skirt?.rebuild();
    },
    refreshSkirt() { world.skirt?.rebuild(); },
    replaceMap(newMap: HexMap): void {
      world.setMap(newMap);
      // A different map means a different size and a different explored set;
      // ensureFog rebuilds when the dimensions no longer match.
      fog = null;
      applyFogState();
      // setMap already refreshes territory/resources from the new metadata.
    },

    // --- Fog of war ---
    get fog(): FogData | null { return fogEnabled ? fog : null; },
    setFogEnabled(enabled: boolean): void {
      fogEnabled = enabled;
      applyFogState();
    },
    setHideUnexplored(enabled: boolean): void {
      hideUnexplored = enabled;
      world.setHideUnexplored(enabled);
    },
    get hideUnexplored(): boolean { return hideUnexplored; },
    setDimExplored(enabled: boolean): void {
      dimExplored = enabled;
      world.setDimExplored(enabled);
    },
    get dimExplored(): boolean { return dimExplored; },
    paintFog(cells: Array<{ col: number; row: number }>, reveal: boolean): boolean {
      const f = ensureFog();
      let changed = false;
      for (const { col, row } of cells) {
        if (col < 0 || col >= world.map.width || row < 0 || row >= world.map.height) continue;
        if (reveal === f.isExplored(col, row)) continue;
        if (reveal) f.markExplored(col, row);
        else        f.unexplore(col, row);
        changed = true;
      }
      return changed;
    },
    setAllFog(explored: boolean): void {
      const f = ensureFog();
      if (!explored) { f.reset(); return; }
      for (let row = 0; row < world.map.height; row++) {
        for (let col = 0; col < world.map.width; col++) f.markExplored(col, row);
      }
    },
    get fogStats(): { explored: number; total: number } {
      return {
        explored: fog?.exploredCount ?? 0,
        total:    world.map.width * world.map.height,
      };
    },

    // --- Camera ---
    setCameraMode(mode: CameraMode): void {
      cameraMode = mode;
      const preset = CAMERA_MODES[mode];
      world.controls.setPitchLimits(preset.minPitch, preset.maxPitch);
      // Order matters: locking the yaw also aims it back at 0, and doing that
      // after the pitch clamp means both glide to the new mode together.
      world.controls.setYawEnabled(preset.yaw);
    },
    get cameraMode(): CameraMode { return cameraMode; },

    setSkirt(enabled: boolean): void {
      skirtEnabled = enabled;
      world.skirt?.setEnabled(enabled);
    },
    get skirtEnabled(): boolean { return skirtEnabled; },

    // --- Sky ---
    setSky(enabled: boolean): void {
      skyEnabled = enabled;
      world.setSky(enabled);
      // The rays read their overcast off the dome and keep it out of their
      // occlusion pass, so they have to be told when it comes and goes.
      world.godRays?.attachSky(world.sky);
    },
    get skyEnabled(): boolean { return skyEnabled; },
    setGodRays(enabled: boolean): void {
      godRaysEnabled = enabled;
      world.godRays?.setEnabled(enabled);
    },
    get godRaysEnabled(): boolean { return godRaysEnabled; },

    // --- Seasons ---
    setSeasonsEnabled(enabled: boolean): void {
      seasonsEnabled = enabled;
      // Climate is derived from the map, so the first enable after a map swap
      // rebuilds it — setSeasons(false) releases the old one on the way out.
      world.setSeasons(enabled ? { daysPerYear: seasonDaysPerYear, scope: seasonScope } : false);
    },
    get seasonsEnabled(): boolean { return seasonsEnabled; },
    setSeasonPhase(phase: number): void {
      world.setSeason(phase);
      seasonsEnabled = true;
    },
    setSeasonCycle(animate: boolean, daysPerYear: number): void {
      seasonDaysPerYear = daysPerYear;
      if (!seasonsEnabled) return;
      const cycle = world.seasons;
      if (!cycle) return;
      cycle.daysPerYear = daysPerYear;
      cycle.paused      = !animate;
    },
    setSeasonScope(scope: SeasonScope): void {
      seasonScope = scope;
      // Held here as well as on the cycle, because setSeasons(false) throws the
      // cycle away — the scope has to survive a toggle, not just a restyle.
      // Rebuilding preserves where the year is; the library carries that over.
      if (seasonsEnabled) world.setSeasons({ scope });
    },
    get seasonScope(): SeasonScope { return seasonScope; },
    get seasonPhase(): number { return world.seasons?.phase ?? 0.5; },
    get seasonLabel(): string { return formatSeason(world.seasons?.phase ?? 0.5); },

    // --- Territory ---
    get territory(): TerritoryLayer | null { return world.territory; },
    get factions(): FactionDescriptor[] { return territory.factions; },
    setTerritoryVisible(visible: boolean): void { territory.setVisible(visible); },
    setFactions(factions: FactionDescriptor[]): void { world.setFactions(factions); },

    // --- Resources ---
    get resources(): ResourceLayer | null { return world.resources; },
    get resourceDescriptors(): ResourceDescriptor[] { return resources.descriptors; },
    setResourcesVisible(visible: boolean): void { resources.setVisible(visible); },

    refreshGameplayLayers(): void {
      territory.refresh();
      resources.refresh();
    },
    setPathPreview(path: HexCoord[] | null, erasing = false): void {
      if (!path || path.length === 0) {
        world.overlays.set('pathStart', null);
        world.overlays.setPath('pathPreview', null);
        return;
      }
      const color = erasing ? 0xff4444 : 0xffaa22;
      world.overlays.set('pathStart', [hexToOffset(path[0])], { color, opacity: 0.55, yOffset: 0.03 });
      world.overlays.setPath('pathPreview', path.length >= 2 ? path : null, { color });
    },
    isWater(terrain: number): boolean {
      return world.isWater(terrain);
    },
    setHexGrid(visible: boolean): void {
      world.setHexGrid(visible);
    },
    setShadows(enabled: boolean): void {
      world.sunShadows?.setEnabled(enabled);
    },
    get timeOfDay(): number {
      return world.dayNight?.time ?? 0.5;
    },
    setTimeOfDay(time: number): void {
      world.setTimeOfDay(time);
    },
    setDayCycle(animate: boolean, dayLengthSeconds: number): void {
      // The cycle is created lazily by setTimeOfDay — nudge it into existence at
      // the current time so pausing/animating works before the slider is touched.
      world.setTimeOfDay(world.dayNight?.time ?? 0.5);
      const cycle = world.dayNight;
      if (!cycle) return;
      cycle.dayLength = dayLengthSeconds;
      cycle.paused    = !animate;
    },
    setWeather(type: WeatherType, opts: WeatherSettings): void {
      wind.set(opts.windX, opts.windY);
      world.setWeather(type, { intensity: opts.intensity, clouds: opts.clouds, wind });
    },
    setWeatherIntensity(intensity: number): void {
      world.weather?.setIntensity(intensity);
    },
    setWind(x: number, y: number): void {
      // Straight onto the world's shared wind rather than the weather's copy:
      // it exists from construction (so this works before any setWeather call),
      // and it is the same vector the trees and the water read.
      world.wind.base.set(x, y);
    },
    setGustiness(gustiness: number): void {
      world.wind.gustiness = gustiness;
    },
    setScatterTexture(strength: number): void {
      // One strength across all four, but each keeps the scale it was attached
      // with — the slider is "how much", not "how fine".
      for (const [mat] of scatterTextured) {
        styleScatterTexture(mat, { strength, enabled: strength > 0 });
      }
    },
    // --- Minimap ---
    get layout(): HexLayout { return world.layout; },
    get terrainDefinitions(): TerrainDefinition[] { return world.terrainDefinitions; },
    cameraFootprint(out?: THREE.Vector3[]): THREE.Vector3[] | null {
      // Clamp well past the far zoom stop: at shallow pitch the top corners run
      // to the horizon, and an unbounded quad would swamp the whole minimap.
      return cameraGroundFootprint(world.camera, { maxDistance: world.controls.maxDist * 3 }, out);
    },
    focusWorld(x: number, z: number): void {
      world.controls.panTo(x, z);
    },

    get fps(): number {
      return smoothedFps;
    },
    get zoom(): number {
      return world.controls.maxDist / world.controls.currentDistance;
    },
    get terrainLookup(): Map<number, TerrainDefinition> {
      return world.terrainLookup;
    },
    async rebuildTerrainFromDescriptors(descriptors: TerrainDescriptor[], registry: TerrainAssetRegistry): Promise<void> {
      await world.setTerrainDescriptors(descriptors, registry);
    },
    setLiquidDescriptors(descriptors: LiquidTypeDescriptor[]): void {
      world.setLiquidDescriptors(descriptors);
    },
    async loadAndApplyHexPack(source: File | Blob): Promise<{
      terrainDescriptors: TerrainDescriptor[];
      liquidDescriptors: LiquidTypeDescriptor[];
      maps: Map<string, HexMap>;
    }> {
      const pkg = await loadHexPack(source, {
        terrainMaterialOptions: world.terrainMaterialOptions,
      });
      const oldMat = world.applyTerrainDefinitions(pkg.terrainDefinitions, pkg.terrainMaterial);
      if (oldMat !== pkg.terrainMaterial) oldMat.dispose();
      world.setLiquidDescriptors(pkg.liquidDescriptors, pkg.liquidMaterials);
      return { terrainDescriptors: pkg.terrainDescriptors, liquidDescriptors: pkg.liquidDescriptors, maps: pkg.maps };
    },
  };

  return api;
}
