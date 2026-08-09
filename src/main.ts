import {
  FbmPlugin, ChunkPlugin, HexMap, deserializeMap, serializeMapJSON, deserializeMapJSON,
  DEFAULT_TERRAIN_DESCRIPTORS, DEFAULT_LIQUID_DESCRIPTORS,
  hexToOffset, offsetToHex, findPath, offsetNeighbor, POINTY_TOP, hexRange,
  exportHexPack,
} from '@loyalj/hex-world';
import { HeightmapPlugin } from './heightmapPlugin.ts';
import type { HexCoord, TerrainDescriptor, TerrainAssetRegistry, ScatterDescriptor, MapTransaction, MapEdit, LiquidTypeDescriptor, WeatherType, ResourceDescriptor, SeasonScope } from '@loyalj/hex-world';
import { initScene, FEATURE_LAYERS } from './scene.ts';
import { CommandHistory } from './history.ts';
import { renderConfigFields } from './configUI.ts';
import { MapEditCommand } from './commands.ts';
import { Minimap } from './minimap.ts';
import type { ConfigObj } from './configUI.ts';

// ---- Generator registry ----
const PLUGINS = [FbmPlugin, ChunkPlugin, HeightmapPlugin];
let activePlugin = PLUGINS[0];
let activeConfig: ConfigObj = structuredClone(activePlugin.defaultConfig) as ConfigObj;

/**
 * What an exported `.hexpack` says its scatter is, mirroring the definitions
 * `initScene` builds. Tier 0 is the variant a dense cell draws and tier 2 the
 * one a sparse cell gets — so the *largest* model goes first, or a thinly
 * scattered map comes out drawing nothing but its biggest asset.
 */
const SCATTER_DESCRIPTORS: ScatterDescriptor[] = [
  {
    id: 'pine', name: 'Pine Trees', layerIndex: 0,
    tiers: [
      [{ assetId: 'pine-dense',   yOffset: 0 }],
      [{ assetId: 'pine-medium',  yOffset: 0 }],
      [{ assetId: 'pine-sparse',  yOffset: 0 }],
    ],
  },
  {
    id: 'rock', name: 'Rocks', layerIndex: 1,
    tiltStrength: 0.4,
    tiers: [
      [{ assetId: 'rock-large',  yOffset: 0.17 }],
      [{ assetId: 'rock-medium', yOffset: 0.13 }],
      [{ assetId: 'rock-small',  yOffset: 0.10 }],
    ],
  },
  {
    id: 'broadleaf', name: 'Broadleaf Trees', layerIndex: 2,
    tiltStrength: 0.05,
    tiers: [
      [{ assetId: 'broadleaf-dense',  yOffset: 0 }],
      [{ assetId: 'broadleaf-medium', yOffset: 0 }],
      [{ assetId: 'broadleaf-sparse', yOffset: 0 }],
    ],
  },
  {
    id: 'bush', name: 'Bushes', layerIndex: 3,
    tiltStrength: 0.12,
    tiers: [
      [{ assetId: 'bush-dense',  yOffset: 0 }],
      [{ assetId: 'bush-medium', yOffset: 0 }],
      [{ assetId: 'bush-sparse', yOffset: 0 }],
    ],
  },
];

// ---- DOM refs ----
const toggleGridBtn  = document.getElementById('toggle-grid-btn')  as HTMLButtonElement;
const gridCheck      = document.getElementById('grid-check')       as HTMLSpanElement;
const toggleShadowsBtn = document.getElementById('toggle-shadows-btn') as HTMLButtonElement;
const shadowsCheck     = document.getElementById('shadows-check')      as HTMLSpanElement;
const toggleSkyBtn     = document.getElementById('toggle-sky-btn')     as HTMLButtonElement;
const skyCheck         = document.getElementById('sky-check')          as HTMLSpanElement;
const toggleTerritoryBtn = document.getElementById('toggle-territory-btn') as HTMLButtonElement;
const territoryCheck     = document.getElementById('territory-check')      as HTMLSpanElement;
const toggleResourcesBtn = document.getElementById('toggle-resources-btn') as HTMLButtonElement;
const resourcesCheck     = document.getElementById('resources-check')      as HTMLSpanElement;
const undoBtn        = document.getElementById('undo-btn')         as HTMLButtonElement;
const redoBtn        = document.getElementById('redo-btn')         as HTMLButtonElement;
const saveBtn        = document.getElementById('save-btn')         as HTMLButtonElement;
const loadBtn        = document.getElementById('load-btn')         as HTMLButtonElement;
const loadInput      = document.getElementById('load-input')       as HTMLInputElement;
const newMapBtn      = document.getElementById('new-map-btn')      as HTMLButtonElement;
const newMapDialog   = document.getElementById('new-map-dialog')   as HTMLDialogElement;
const dialogCloseBtn = document.getElementById('dialog-close-btn') as HTMLButtonElement;
const mapWidthInput  = document.getElementById('map-width-input')  as HTMLInputElement;
const mapHeightInput = document.getElementById('map-height-input') as HTMLInputElement;
const seedInput      = document.getElementById('seed-input')       as HTMLInputElement;
const genSelect      = document.getElementById('generator-select') as HTMLSelectElement;
const newSeedBtn     = document.getElementById('new-seed-btn')     as HTMLButtonElement;
const configFields   = document.getElementById('config-fields')    as HTMLDivElement;
const createMapBtn   = document.getElementById('create-map-btn')   as HTMLButtonElement;
const viewport       = document.getElementById('viewport')         as HTMLDivElement;

const toolButtons    = document.querySelectorAll<HTMLButtonElement>('.tool-btn');
const scatterTypeBtns = document.querySelectorAll<HTMLButtonElement>('#scatter-type-group .scatter-type-btn');
const densityBtns    = document.querySelectorAll<HTMLButtonElement>('#density-group .density-btn');
const terrainOptions = document.getElementById('terrain-options')  as HTMLElement;
const elevOptions    = document.getElementById('elevation-options') as HTMLElement;
const scatterOptions = document.getElementById('scatter-options')  as HTMLElement;
const riverOptions   = document.getElementById('river-options')    as HTMLElement;
const roadOptions     = document.getElementById('road-options')      as HTMLElement;
const environmentOptions = document.getElementById('environment-options') as HTMLElement;
const territoryOptions = document.getElementById('territory-options') as HTMLElement;
const resourceOptions  = document.getElementById('resource-options')  as HTMLElement;
const fogOptions       = document.getElementById('fog-options')       as HTMLElement;
const roadCostOptions = document.getElementById('road-cost-options') as HTMLElement;
const roadCostElev    = document.getElementById('road-cost-elev')    as HTMLInputElement;
const roadCostTerrain = document.getElementById('road-cost-terrain') as HTMLInputElement;
const roadCostRoads   = document.getElementById('road-cost-roads')   as HTMLInputElement;
const leftPanel          = document.getElementById('left-panel')             as HTMLElement;
const addTerrainDialog   = document.getElementById('add-terrain-dialog')     as HTMLDialogElement;
const terrainDialogTitle = document.getElementById('terrain-dialog-title')    as HTMLElement;
const addTerrainCloseBtw = document.getElementById('add-terrain-close-btn')   as HTMLButtonElement;
const addTerrainName     = document.getElementById('add-terrain-name')       as HTMLInputElement;
const addTerrainColor    = document.getElementById('add-terrain-color')      as HTMLInputElement;
const addTerrainColorLbl = document.getElementById('add-terrain-color-label') as HTMLElement;
const addTerrainImgBtn   = document.getElementById('add-terrain-img-btn')    as HTMLButtonElement;
const addTerrainImgInput = document.getElementById('add-terrain-img-input')  as HTMLInputElement;
const addTerrainImgSt    = document.getElementById('add-terrain-img-status') as HTMLElement;
const addTerrainCost     = document.getElementById('add-terrain-cost')       as HTMLInputElement;
const addTerrainLiquid   = document.getElementById('add-terrain-liquid')     as HTMLSelectElement;
const addTerrainConfirm  = document.getElementById('add-terrain-confirm-btn') as HTMLButtonElement;
const exportPackBtn      = document.getElementById('export-pack-btn')        as HTMLButtonElement;
const openPackBtn        = document.getElementById('open-pack-btn')          as HTMLButtonElement;
const openPackInput      = document.getElementById('open-pack-input')        as HTMLInputElement;
const addTerrainMenuBtn  = document.getElementById('add-terrain-menu-btn')   as HTMLButtonElement;
const liquidMenuBtn      = document.getElementById('liquid-menu-btn')        as HTMLButtonElement;

// Document strip + status strip
const docName     = document.getElementById('doc-name')     as HTMLElement;
const docSize     = document.getElementById('doc-size')     as HTMLElement;
const drawerTitle = document.getElementById('drawer-title') as HTMLElement;
const drawerBadge = document.getElementById('drawer-badge') as HTMLElement;
const drawerHide  = document.getElementById('drawer-hide-btn')       as HTMLButtonElement;
const drawerToggle = document.getElementById('toggle-drawer-btn')    as HTMLButtonElement;
const drawerMenuBtn = document.getElementById('toggle-drawer-menu-btn') as HTMLButtonElement;
const drawerCheck  = document.getElementById('drawer-check')         as HTMLElement;
const statusSwatch = document.getElementById('status-swatch')     as HTMLElement;
const statusTool   = document.getElementById('status-tool-label') as HTMLElement;
const statusPos    = document.getElementById('status-pos')        as HTMLElement;
const statusElev   = document.getElementById('status-elev')       as HTMLElement;
const statusZoom   = document.getElementById('status-zoom')       as HTMLElement;
const statusFps    = document.getElementById('status-fps')        as HTMLElement;

/** Tool metadata for the drawer header and the rail ordering badge. */
const TOOL_META: Record<string, { title: string; badge: string; panel: () => HTMLElement }> = {
  'paint-terrain': { title: 'Terrain',   badge: '1', panel: () => terrainOptions },
  'elevation':     { title: 'Elevation', badge: '2', panel: () => elevOptions },
  'paint-river':   { title: 'River',     badge: '3', panel: () => riverOptions },
  'paint-road':    { title: 'Road',      badge: '4', panel: () => roadOptions },
  'paint-scatter': { title: 'Scatter',   badge: '5', panel: () => scatterOptions },
  'environment':   { title: 'Environment', badge: '6', panel: () => environmentOptions },
  'paint-territory': { title: 'Territory', badge: '7', panel: () => territoryOptions },
  'paint-resource':  { title: 'Resources', badge: '8', panel: () => resourceOptions },
  'paint-fog':       { title: 'Fog of war', badge: '9', panel: () => fogOptions },
};

/** User's drawer preference — the rail/View toggles flip it, tool switches don't. */
let drawerOpen = true;

function updateLeftPanel(): void {
  for (const [tool, meta] of Object.entries(TOOL_META)) {
    meta.panel().classList.toggle('hidden', tool !== activeTool);
  }
  const meta = TOOL_META[activeTool];
  drawerTitle.textContent = meta?.title ?? '';
  drawerBadge.textContent = meta?.badge ?? '';
  leftPanel.classList.toggle('hidden', !drawerOpen);
  drawerCheck.classList.toggle('hidden', !drawerOpen);
}

function setDrawerOpen(open: boolean): void {
  drawerOpen = open;
  updateLeftPanel();
}

const inspSwatch  = document.getElementById('insp-swatch')   as HTMLElement;
const inspPos     = document.getElementById('insp-pos')      as HTMLElement;
const inspTerrain = document.getElementById('insp-terrain')  as HTMLElement;
const inspElev    = document.getElementById('insp-elev')     as HTMLElement;
const inspRiver   = document.getElementById('insp-river')    as HTMLElement;
const inspRoad    = document.getElementById('insp-road')     as HTMLElement;
const inspRoadCost = document.getElementById('insp-roadcost') as HTMLElement;
const inspScatterTrees = document.getElementById('insp-scatter-trees') as HTMLElement;
const inspScatterRocks = document.getElementById('insp-scatter-rocks') as HTMLElement;
const inspScatterBroadleaf = document.getElementById('insp-scatter-broadleaf') as HTMLElement;
const inspScatterBushes    = document.getElementById('insp-scatter-bushes')    as HTMLElement;

// ---- Generator dropdown ----
genSelect.innerHTML = '';
for (const plugin of PLUGINS) {
  const opt = document.createElement('option');
  opt.value = plugin.id;
  opt.textContent = plugin.name;
  genSelect.appendChild(opt);
}

function refreshConfigFields(): void {
  renderConfigFields(configFields, activePlugin.configSchema ?? [], activeConfig, () => {});
}

genSelect.addEventListener('change', () => {
  activePlugin = PLUGINS.find(p => p.id === genSelect.value) ?? PLUGINS[0];
  activeConfig = structuredClone(activePlugin.defaultConfig) as ConfigObj;
  refreshConfigFields();
  refreshDocStrip();
});

// ---- Seed ----
const initialSeed = Math.floor(Math.random() * 0xffffffff);
seedInput.value = String(initialSeed);
newSeedBtn.addEventListener('click', () => {
  seedInput.value = String(Math.floor(Math.random() * 0xffffffff));
  refreshDocStrip();
});

// ---- Editor default terrain set ----
// The library ships water as its only liquid terrain; the editor also offers
// lava and acid out of the box, linked to the built-in liquid descriptors.
// Colors match each liquid's shallowColor so palette swatches read correctly.
// Index 6 is the library's built-in riverbed terrain (carved stream-bed
// blending), so editor liquids start at 7.
const EDITOR_DEFAULT_TERRAINS: TerrainDescriptor[] = [
  ...DEFAULT_TERRAIN_DESCRIPTORS,
  { index: 7, id: 'lava', name: 'Lava', color: 0xd45a10,
    liquidType: 'lava', roadCost: 1, texture: { type: 'procedural' } },
  { index: 8, id: 'acid', name: 'Acid', color: 0x4db318,
    liquidType: 'acid', roadCost: 1, texture: { type: 'procedural' } },
];

// ---- Scene init ----
const scene   = await initScene(viewport, EDITOR_DEFAULT_TERRAINS);
const history = new CommandHistory();

// ---- Terrain descriptor state ----
let terrainDescriptors: TerrainDescriptor[] = [...EDITOR_DEFAULT_TERRAINS];
const terrainAssetBlobs    = new Map<string, Blob>();
const terrainAssetRegistry: TerrainAssetRegistry = new Map();
let pendingTerrainImage: File | null = null;
let editingTerrainIndex: number | null = null;

// ---- Liquid descriptor state ----
let liquidDescriptors: LiquidTypeDescriptor[] = structuredClone(DEFAULT_LIQUID_DESCRIPTORS);

// ---- Document state (drives the doc strip) ----
let documentName = 'untitled';

/** Called after a save so the strip reflects the saved name. */
function markSaved(name?: string): void {
  if (name) documentName = name;
  refreshDocStrip();
}

/** Called after a new/loaded map replaces the current one. */
function markFresh(name: string): void {
  documentName = name;
  refreshDocStrip();
}

function refreshDocStrip(): void {
  docName.textContent = documentName;
  docSize.textContent = `${scene.map.width} × ${scene.map.height}`;
}

// ---- Minimap ----
// Every map mutation funnels through the history, so one invalidate here
// covers paints, floods, undo, and redo. The handful of things that never
// reach the undo stack — fog, overlay visibility, palette swaps — invalidate
// at their own call sites.
const minimap = new Minimap(
  document.getElementById('minimap')         as HTMLElement,
  document.getElementById('minimap-base')    as HTMLCanvasElement,
  document.getElementById('minimap-overlay') as HTMLCanvasElement,
  scene,
);

history.onChange = () => {
  undoBtn.disabled = !history.canUndo;
  redoBtn.disabled = !history.canRedo;
  refreshDocStrip();
  minimap.invalidate();
};
undoBtn.addEventListener('click', () => history.undo());
redoBtn.addEventListener('click', () => history.redo());

// eslint-disable-next-line @typescript-eslint/no-explicit-any
activePlugin.generate(scene.map, activePlugin.defaultConfig as any, initialSeed);
scene.reload();
refreshConfigFields();

// ---- Tool state ----
type ToolId    = 'paint-terrain' | 'elevation' | 'paint-river' | 'paint-road' | 'paint-scatter' | 'environment'
               | 'paint-territory' | 'paint-resource' | 'paint-fog';
type RoadMode  = 'path' | 'straight';
let activeTool        : ToolId   = 'paint-terrain';
let paintTerrainType  : number   = 0;       // Grassland
let paintScatterLevel : number   = 1;       // Sparse
let paintScatterLayer : number   = 0;       // Pines — feature layer, see SCATTER_LAYER_NAMES
type ScatterMode = 'brush' | 'fill';
let scatterMode       : ScatterMode = 'brush';
let scatterElevMin    : number   = -128;
let scatterElevMax    : number   = 127;
let scatterTerrainFilter = new Set<number>();
let elevStep          : number   = 1;
type ElevMode = 'raise-lower' | 'smooth' | 'flatten' | 'noise' | 'set-absolute' | 'slope' | 'erosion';
let elevMode      : ElevMode = 'raise-lower';
let flattenTarget : number   = 0;
let elevSetTarget : number   = 0;
let elevRangeMin  : number   = -128;
let elevRangeMax  : number   = 127;
let contourSnapHeld            = false;
let contourLevel  : number | null = null;
let roadMode          : RoadMode = 'path';
type RiverMode = 'path' | 'straight' | 'waypoint' | 'downhill' | 'erase';
let riverMode         : RiverMode = 'path';
let riverWaypoints    : Array<{ col: number; row: number }> = [];
let riverWaypointActive = false;
type TerrainMode = 'brush' | 'fill';
let terrainMode: TerrainMode = 'brush';
let lockedTerrains = new Set<number>();

function hexRound(fq: number, fr: number): HexCoord {
  const fs = -fq - fr;
  let q = Math.round(fq);
  let r = Math.round(fr);
  const s = Math.round(fs);
  const dq = Math.abs(q - fq);
  const dr = Math.abs(r - fr);
  const ds = Math.abs(s - fs);
  if (dq > dr && dq > ds) q = -r - s;
  else if (dr > ds) r = -q - s;
  return { q, r };
}

function hexLineDraw(start: HexCoord, end: HexCoord): HexCoord[] {
  const n = Math.max(
    Math.abs(end.q - start.q),
    Math.abs(end.r - start.r),
    Math.abs((-end.q - end.r) - (-start.q - start.r)),
  );
  if (n === 0) return [start];
  const result: HexCoord[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    result.push(hexRound(
      start.q + (end.q - start.q) * t,
      start.r + (end.r - start.r) * t,
    ));
  }
  return result;
}

// Per-tool brush radius (0 = single cell)
let terrainBrushRadius : number = 0;
let elevBrushRadius    : number = 0;
let scatterBrushRadius : number = 0;
let territoryBrushRadius : number = 0;
let fogBrushRadius       : number = 1;

// ---- Territory / resource / fog tool state ----
let paintFactionId   = 'red';
let territoryMode : 'claim' | 'release' = 'claim';
let paintResourceId  = '';
let resourceMode  : 'place' | 'erase' = 'place';
let resourceRespectRules = true;
let fogMode       : 'reveal' | 'hide' = 'reveal';

function activeBrushRadius(): number {
  if (activeTool === 'paint-terrain') return terrainBrushRadius;
  if (activeTool === 'elevation')     return elevBrushRadius;
  if (activeTool === 'paint-scatter') return scatterBrushRadius;
  if (activeTool === 'paint-territory') return territoryBrushRadius;
  if (activeTool === 'paint-fog')       return fogBrushRadius;
  return 0;
}

function updateViewportCursor(): void {
  viewport.classList.toggle('is-filling',
    (activeTool === 'paint-terrain' && terrainMode === 'fill') ||
    (activeTool === 'paint-scatter' && scatterMode === 'fill'),
  );
}

function updateElevStepVisibility(): void {
  const isRaiseLower = elevMode === 'raise-lower';
  const isSetAbs     = elevMode === 'set-absolute';
  document.getElementById('elev-step-header')!.classList.toggle('hidden', !isRaiseLower);
  document.getElementById('elev-step-group')!.classList.toggle('hidden', !isRaiseLower);
  document.getElementById('elev-set-target-row')!.classList.toggle('hidden', !isSetAbs);
}

toolButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    if (activeTool === 'paint-road' || activeTool === 'paint-river' ||
        (activeTool === 'elevation' && elevMode === 'slope')) {
      scene.setPathPreview(null);
      pathStart     = null;
      currentPath   = null;
      isPointerDown = false;
    }
    if (riverWaypointActive) cancelWaypointRiver();
    activeTool = btn.dataset['tool'] as ToolId;
    toolButtons.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    scene.brushRadius = activeBrushRadius();
    updateLeftPanel();
    updateViewportCursor();
  });
});

const DEFAULT_TERRAIN_IDS = new Set(DEFAULT_TERRAIN_DESCRIPTORS.map(d => d.id));

function openTerrainDialog(editIndex: number | null, presetLiquid?: string): void {
  editingTerrainIndex = editIndex;
  if (editIndex !== null) {
    const desc = terrainDescriptors.find(d => d.index === editIndex)!;
    terrainDialogTitle.textContent = 'Edit Terrain Type';
    addTerrainConfirm.textContent  = 'Save Changes';
    addTerrainName.value  = desc.name;
    const hex = `#${desc.color.toString(16).padStart(6, '0')}`;
    addTerrainColor.value = hex;
    addTerrainColorLbl.textContent = hex;
    addTerrainCost.value   = String(desc.roadCost ?? 1);
    addTerrainLiquid.value = desc.liquidType ?? '';
    const hasImg = desc.texture.type === 'image'
      && desc.texture.assetId != null
      && terrainAssetRegistry.has(desc.texture.assetId);
    addTerrainImgSt.textContent = hasImg ? 'Using custom image' : 'No image';
    pendingTerrainImage = null;
  } else {
    terrainDialogTitle.textContent = 'Add Terrain Type';
    addTerrainConfirm.textContent  = 'Add Terrain';
    addTerrainName.value  = '';
    addTerrainColor.value = '#7a8a6a';
    addTerrainColorLbl.textContent = '#7a8a6a';
    addTerrainCost.value   = '1';
    addTerrainLiquid.value = presetLiquid ?? '';
    addTerrainImgSt.textContent = 'No image';
    pendingTerrainImage = null;
  }
  addTerrainDialog.showModal();
}

/** One swatch row: color chip, name, and a lock toggle that appears on hover. */
function buildSwatchRow(desc: TerrainDescriptor): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.className = 'swatch-row';
  btn.dataset['terrain'] = String(desc.index);
  if (desc.index === paintTerrainType) btn.classList.add('active');
  if (lockedTerrains.has(desc.index))  btn.classList.add('swatch-row--locked');

  const chip = document.createElement('span');
  chip.className = 'swatch-chip';
  chip.style.background = `#${desc.color.toString(16).padStart(6, '0')}`;
  btn.appendChild(chip);

  const name = document.createElement('span');
  name.className = 'swatch-name';
  name.textContent = desc.name;
  btn.appendChild(name);

  const lockEl = document.createElement('span');
  lockEl.className = 'swatch-lock';
  lockEl.title = 'Lock/unlock — locked terrain cannot be painted over';
  lockEl.textContent = '🔒';
  lockEl.addEventListener('click', e => {
    e.stopPropagation();
    if (lockedTerrains.has(desc.index)) {
      lockedTerrains.delete(desc.index);
      btn.classList.remove('swatch-row--locked');
    } else {
      lockedTerrains.add(desc.index);
      btn.classList.add('swatch-row--locked');
    }
  });
  btn.appendChild(lockEl);

  if (!DEFAULT_TERRAIN_IDS.has(desc.id)) {
    btn.classList.add('swatch-row--custom');
    btn.title = `${desc.name} (right-click to edit)`;
    btn.addEventListener('contextmenu', e => { e.preventDefault(); openTerrainDialog(desc.index); });
  } else {
    btn.title = desc.name;
  }

  btn.addEventListener('click', () => {
    paintTerrainType = desc.index;
    document.querySelectorAll('#terrain-type-group .swatch-row')
      .forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  });
  return btn;
}

/** A labelled palette section: header row, swatch grid, and a "new type" tile. */
function buildPaletteSection(
  label: string,
  descriptors: TerrainDescriptor[],
  opts: { hint?: string; action?: { label: string; onClick: () => void }; presetLiquid?: string },
): HTMLElement {
  const section = document.createElement('div');
  section.className = 'pal-section';

  const head = document.createElement('div');
  head.className = 'pal-head';
  const heading = document.createElement('div');
  heading.className = 'pal-head-label';
  heading.textContent = label;
  head.appendChild(heading);
  if (opts.hint) {
    const hint = document.createElement('div');
    hint.className = 'pal-head-hint';
    hint.textContent = opts.hint;
    head.appendChild(hint);
  }
  if (opts.action) {
    const action = document.createElement('button');
    action.className = 'link-btn';
    action.textContent = opts.action.label;
    action.addEventListener('click', opts.action.onClick);
    head.appendChild(action);
  }
  section.appendChild(head);

  const grid = document.createElement('div');
  grid.className = 'pal-grid';
  for (const desc of descriptors) grid.appendChild(buildSwatchRow(desc));

  const addBtn = document.createElement('button');
  addBtn.className = 'swatch-add';
  addBtn.title = `Add ${label.toLowerCase()} terrain type`;
  addBtn.innerHTML = '<span class="swatch-add-plus">+</span><span>New type</span>';
  addBtn.addEventListener('click', () => openTerrainDialog(null, opts.presetLiquid));
  grid.appendChild(addBtn);

  section.appendChild(grid);
  return section;
}

function renderTerrainPalette(): void {
  const group = document.getElementById('terrain-type-group')!;
  group.innerHTML = '';

  group.appendChild(buildPaletteSection(
    'Solid',
    terrainDescriptors.filter(d => !d.liquidType),
    { hint: 'Alt+click samples' },
  ));
  group.appendChild(buildPaletteSection(
    'Liquid',
    terrainDescriptors.filter(d => d.liquidType),
    {
      action: { label: 'Edit', onClick: () => openLiquidDialog() },
      presetLiquid: liquidDescriptors[0]?.id,
    },
  ));

  renderScatterTerrainFilter();
  // Terrain colors drive the minimap's fills, and a palette edit never touches
  // the undo stack — this is the only signal that they changed.
  minimap.invalidate();
}
renderTerrainPalette();

function renderScatterTerrainFilter(): void {
  const group = document.getElementById('scatter-terrain-filter')!;
  group.innerHTML = '';
  for (const desc of terrainDescriptors) {
    const btn = document.createElement('button');
    btn.className = 'terrain-filter-btn';
    btn.title = desc.name;
    btn.style.background = `#${desc.color.toString(16).padStart(6, '0')}`;
    if (scatterTerrainFilter.has(desc.index)) btn.classList.add('active');
    btn.addEventListener('click', () => {
      if (scatterTerrainFilter.has(desc.index)) {
        scatterTerrainFilter.delete(desc.index);
        btn.classList.remove('active');
      } else {
        scatterTerrainFilter.add(desc.index);
        btn.classList.add('active');
      }
    });
    group.appendChild(btn);
  }
}

// ---- Add Terrain dialog ----
addTerrainCloseBtw.addEventListener('click', () => addTerrainDialog.close());
addTerrainDialog.addEventListener('click', e => { if (e.target === addTerrainDialog) addTerrainDialog.close(); });

addTerrainColor.addEventListener('input', () => { addTerrainColorLbl.textContent = addTerrainColor.value; });
addTerrainImgBtn.addEventListener('click', () => addTerrainImgInput.click());
addTerrainImgInput.addEventListener('change', () => {
  const file = addTerrainImgInput.files?.[0];
  if (!file) return;
  pendingTerrainImage = file;
  addTerrainImgSt.textContent = file.name;
  addTerrainImgInput.value = '';
});

addTerrainConfirm.addEventListener('click', async () => {
  const name      = addTerrainName.value.trim();
  if (!name) { alert('Please enter a terrain name.'); return; }
  const color      = parseInt(addTerrainColor.value.slice(1), 16);
  const roadCost   = parseFloat(addTerrainCost.value) || 1;
  const liquidType = addTerrainLiquid.value || undefined;

  if (editingTerrainIndex !== null) {
    // ---- Edit existing ----
    const idx = terrainDescriptors.findIndex(d => d.index === editingTerrainIndex);
    if (idx >= 0) {
      const existing = terrainDescriptors[idx];
      let texture = existing.texture;
      if (pendingTerrainImage) {
        const assetId = `terrain-img-${existing.index}`;
        const bmp = await createImageBitmap(pendingTerrainImage);
        terrainAssetRegistry.set(assetId, bmp);
        terrainAssetBlobs.set(assetId, pendingTerrainImage);
        texture = { type: 'image' as const, assetId };
      }
      const updated: TerrainDescriptor = { ...existing, name, color, roadCost, texture };
      if (liquidType) updated.liquidType = liquidType; else delete updated.liquidType;
      terrainDescriptors = [
        ...terrainDescriptors.slice(0, idx),
        updated,
        ...terrainDescriptors.slice(idx + 1),
      ];
    }
  } else {
    // ---- Add new ----
    const nextIndex = Math.max(...terrainDescriptors.map(d => d.index)) + 1;
    let assetId: string | undefined;
    if (pendingTerrainImage) {
      assetId = `terrain-img-${nextIndex}`;
      const bmp = await createImageBitmap(pendingTerrainImage);
      terrainAssetRegistry.set(assetId, bmp);
      terrainAssetBlobs.set(assetId, pendingTerrainImage);
    }
    terrainDescriptors = [...terrainDescriptors, {
      index: nextIndex,
      id:    `custom-${nextIndex}`,
      name,
      color,
      texture:  assetId ? { type: 'image' as const, assetId } : { type: 'procedural' as const },
      roadCost,
      ...(liquidType ? { liquidType } : {}),
    }];
  }

  const isEdit = editingTerrainIndex !== null;
  addTerrainConfirm.disabled    = true;
  addTerrainConfirm.textContent = isEdit ? 'Saving…' : 'Applying…';
  await scene.rebuildTerrainFromDescriptors(terrainDescriptors, terrainAssetRegistry);
  addTerrainConfirm.disabled    = false;
  addTerrainConfirm.textContent = isEdit ? 'Save Changes' : 'Add Terrain';

  renderTerrainPalette();
  addTerrainDialog.close();
  pendingTerrainImage = null;
  addTerrainImgSt.textContent = 'No image';
});

// ---- Liquid Types dialog ----
const liquidDialog      = document.getElementById('liquid-dialog')        as HTMLDialogElement;
const liquidCloseBtn    = document.getElementById('liquid-close-btn')     as HTMLButtonElement;
const liquidSelect      = document.getElementById('liquid-select')        as HTMLSelectElement;
const liquidName        = document.getElementById('liquid-name')          as HTMLInputElement;
const liquidShallow     = document.getElementById('liquid-shallow')       as HTMLInputElement;
const liquidShallowLbl  = document.getElementById('liquid-shallow-label') as HTMLElement;
const liquidDeep        = document.getElementById('liquid-deep')          as HTMLInputElement;
const liquidDeepLbl     = document.getElementById('liquid-deep-label')    as HTMLElement;
const liquidFoam        = document.getElementById('liquid-foam')          as HTMLInputElement;
const liquidFoamLbl     = document.getElementById('liquid-foam-label')    as HTMLElement;
const liquidOpacity     = document.getElementById('liquid-opacity')       as HTMLInputElement;
const liquidFlow        = document.getElementById('liquid-flow')          as HTMLInputElement;
const liquidWave        = document.getElementById('liquid-wave')          as HTMLInputElement;
const liquidFoamInt     = document.getElementById('liquid-foam-int')      as HTMLInputElement;
const liquidEmissive    = document.getElementById('liquid-emissive')      as HTMLInputElement;
const liquidEmissiveStr = document.getElementById('liquid-emissive-str')  as HTMLInputElement;
const liquidApplyBtn    = document.getElementById('liquid-apply-btn')     as HTMLButtonElement;

const cssHex = (c: number | undefined, fallback: number): string =>
  `#${(c ?? fallback).toString(16).padStart(6, '0')}`;

/** Rebuild the liquid options in the add-terrain dialog and the liquid manager. */
function refreshLiquidOptions(): void {
  const terrainSel = addTerrainLiquid.value;
  addTerrainLiquid.innerHTML = '<option value="">&#8212; solid &#8212;</option>';
  for (const d of liquidDescriptors) {
    const opt = document.createElement('option');
    opt.value = d.id;
    opt.textContent = d.name;
    addTerrainLiquid.appendChild(opt);
  }
  addTerrainLiquid.value = liquidDescriptors.some(d => d.id === terrainSel) ? terrainSel : '';

  liquidSelect.innerHTML = '';
  for (const d of liquidDescriptors) {
    const opt = document.createElement('option');
    opt.value = d.id;
    opt.textContent = d.name;
    liquidSelect.appendChild(opt);
  }
  const newOpt = document.createElement('option');
  newOpt.value = '__new';
  newOpt.textContent = '+ New liquid…';
  liquidSelect.appendChild(newOpt);
}
refreshLiquidOptions();

function loadLiquidForm(id: string): void {
  const d = liquidDescriptors.find(l => l.id === id);
  liquidName.value        = d?.name ?? '';
  liquidShallow.value     = cssHex(d?.shallowColor, 0x527fb3);
  liquidDeep.value        = cssHex(d?.deepColor,    0x1e477a);
  liquidFoam.value        = cssHex(d?.foamColor,    0xeaf3ff);
  liquidOpacity.value     = String(d?.opacity          ?? 0.82);
  liquidFlow.value        = String(d?.flowSpeed        ?? 1);
  liquidWave.value        = String(d?.waveScale        ?? 1);
  liquidFoamInt.value     = String(d?.foamIntensity    ?? 1);
  liquidEmissive.value    = cssHex(d?.emissiveColor, 0xff5a00);
  liquidEmissiveStr.value = String(d?.emissiveStrength ?? 0);
  liquidShallowLbl.textContent = liquidShallow.value;
  liquidDeepLbl.textContent    = liquidDeep.value;
  liquidFoamLbl.textContent    = liquidFoam.value;
}

function liquidIdFromName(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'liquid';
  if (!liquidDescriptors.some(d => d.id === base)) return base;
  let n = 2;
  while (liquidDescriptors.some(d => d.id === `${base}-${n}`)) n++;
  return `${base}-${n}`;
}

liquidCloseBtn.addEventListener('click', () => liquidDialog.close());
liquidDialog.addEventListener('click', e => { if (e.target === liquidDialog) liquidDialog.close(); });
liquidShallow.addEventListener('input', () => { liquidShallowLbl.textContent = liquidShallow.value; });
liquidDeep.addEventListener('input',    () => { liquidDeepLbl.textContent    = liquidDeep.value; });
liquidFoam.addEventListener('input',    () => { liquidFoamLbl.textContent    = liquidFoam.value; });
liquidSelect.addEventListener('change', () => loadLiquidForm(liquidSelect.value));

function openLiquidDialog(): void {
  refreshLiquidOptions();
  liquidSelect.value = liquidDescriptors[0]?.id ?? '__new';
  loadLiquidForm(liquidSelect.value);
  liquidDialog.showModal();
}

liquidApplyBtn.addEventListener('click', () => {
  const name = liquidName.value.trim();
  if (!name) { alert('Please enter a liquid name.'); return; }
  const isNew = liquidSelect.value === '__new';
  const id    = isNew ? liquidIdFromName(name) : liquidSelect.value;

  const emissiveStrength = parseFloat(liquidEmissiveStr.value) || 0;
  const descriptor: LiquidTypeDescriptor = {
    id,
    name,
    shallowColor:  parseInt(liquidShallow.value.slice(1), 16),
    deepColor:     parseInt(liquidDeep.value.slice(1), 16),
    foamColor:     parseInt(liquidFoam.value.slice(1), 16),
    opacity:       Math.min(1, Math.max(0, parseFloat(liquidOpacity.value) || 0.82)),
    flowSpeed:     Math.max(0, parseFloat(liquidFlow.value) || 1),
    waveScale:     Math.max(0.05, parseFloat(liquidWave.value) || 1),
    foamIntensity: Math.max(0, parseFloat(liquidFoamInt.value) || 0),
    ...(emissiveStrength > 0 ? {
      emissiveColor:    parseInt(liquidEmissive.value.slice(1), 16),
      emissiveStrength,
    } : {}),
  };

  const idx = liquidDescriptors.findIndex(d => d.id === id);
  liquidDescriptors = idx >= 0
    ? [...liquidDescriptors.slice(0, idx), descriptor, ...liquidDescriptors.slice(idx + 1)]
    : [...liquidDescriptors, descriptor];

  scene.setLiquidDescriptors(liquidDescriptors);
  refreshLiquidOptions();
  liquidSelect.value = id;
  liquidDialog.close();
});

scatterTypeBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    paintScatterLayer = parseInt(btn.dataset['scatterLayer']!, 10);
    scatterTypeBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  });
});

densityBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    paintScatterLevel = parseInt(btn.dataset['density']!, 10);
    densityBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  });
});

function wireBrushGroup(groupId: string, setRadius: (r: number) => void): void {
  const group = document.getElementById(groupId)!;
  group.querySelectorAll<HTMLButtonElement>('.brush-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      setRadius(parseInt(btn.dataset['brush']!, 10));
      scene.brushRadius = activeBrushRadius();
      group.querySelectorAll('.brush-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });
}

wireBrushGroup('terrain-brush-group', r => { terrainBrushRadius = r; });
wireBrushGroup('elev-brush-group',    r => { elevBrushRadius    = r; });
wireBrushGroup('scatter-brush-group', r => { scatterBrushRadius = r; });

const scatterModeBtns = document.querySelectorAll<HTMLButtonElement>('#scatter-mode-group .scatter-type-btn');
scatterModeBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    scatterMode = btn.dataset['scatterMode'] as ScatterMode;
    scatterModeBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    updateViewportCursor();
  });
});

(document.getElementById('scatter-elev-min') as HTMLInputElement).addEventListener('input', function () {
  scatterElevMin = Math.max(-128, Math.min(127, parseInt(this.value, 10)));
  if (scatterElevMin > scatterElevMax) scatterElevMax = scatterElevMin;
});
(document.getElementById('scatter-elev-max') as HTMLInputElement).addEventListener('input', function () {
  scatterElevMax = Math.max(-128, Math.min(127, parseInt(this.value, 10)));
  if (scatterElevMax < scatterElevMin) scatterElevMin = scatterElevMax;
});

const terrainModeBtns = document.querySelectorAll<HTMLButtonElement>('#terrain-mode-group .scatter-type-btn');
terrainModeBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    terrainMode = btn.dataset['terrainMode'] as TerrainMode;
    terrainModeBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    updateViewportCursor();
  });
});

const elevStepBtns = document.querySelectorAll<HTMLButtonElement>('#elev-step-group .brush-btn');
elevStepBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    elevStep = parseInt(btn.dataset['step']!, 10);
    elevStepBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  });
});

const elevModeBtns = document.querySelectorAll<HTMLButtonElement>('#elev-mode-group .density-btn');
elevModeBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    if (elevMode === 'slope') {
      scene.setPathPreview(null);
      pathStart     = null;
      currentPath   = null;
      isPointerDown = false;
    }
    elevMode = btn.dataset['elevMode'] as ElevMode;
    elevModeBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    updateElevStepVisibility();
  });
});

(document.getElementById('elev-set-target') as HTMLInputElement).addEventListener('input', function () {
  elevSetTarget = Math.max(-128, Math.min(127, parseInt(this.value, 10) || 0));
});
(document.getElementById('elev-range-min') as HTMLInputElement).addEventListener('input', function () {
  elevRangeMin = Math.max(-128, Math.min(127, parseInt(this.value, 10)));
  if (elevRangeMin > elevRangeMax) elevRangeMax = elevRangeMin;
});
(document.getElementById('elev-range-max') as HTMLInputElement).addEventListener('input', function () {
  elevRangeMax = Math.max(-128, Math.min(127, parseInt(this.value, 10)));
  if (elevRangeMax < elevRangeMin) elevRangeMin = elevRangeMax;
});

const RIVER_HINTS: Record<string, string> = {
  path:     'Hold and drag to place. Shift to erase. <kbd>Esc</kbd> cancels.',
  straight: 'Hold and drag to place. Shift to erase. <kbd>Esc</kbd> cancels.',
  waypoint: 'Click to place waypoints. Double-click or <kbd>↵</kbd> to commit. <kbd>Esc</kbd> cancels.',
  downhill: 'Click a cell to auto-trace downhill to nearest water.',
  erase:    'Click or drag to remove rivers from cells.',
};
const riverHintEl = document.getElementById('river-hint')!;
const riverModeBtns = document.querySelectorAll<HTMLButtonElement>('#river-mode-group .density-btn');
riverModeBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    if (riverWaypointActive) cancelWaypointRiver();
    riverMode = btn.dataset['riverMode'] as RiverMode;
    riverModeBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    riverHintEl.innerHTML = RIVER_HINTS[riverMode] ?? '';
  });
});

const roadModeBtns = document.querySelectorAll<HTMLButtonElement>('#road-mode-group .brush-btn');
roadModeBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    roadMode = btn.dataset['roadMode'] as RoadMode;
    roadModeBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    roadCostOptions.classList.toggle('hidden', roadMode !== 'path');
  });
});

// ---- Environment: time of day + weather ----
// The day/night cycle and the weather system are both created lazily by the
// library, so the scene keeps its static default lighting and clear skies until
// one of these controls is touched.
const todSlider     = document.getElementById('tod-slider')       as HTMLInputElement;
const todValue      = document.getElementById('tod-value')        as HTMLElement;
const todAnimate    = document.getElementById('tod-animate')      as HTMLInputElement;
const dayLengthEl   = document.getElementById('day-length')       as HTMLInputElement;
const dayLengthVal  = document.getElementById('day-length-value') as HTMLElement;
const weatherIntEl  = document.getElementById('weather-intensity')       as HTMLInputElement;
const weatherIntVal = document.getElementById('weather-intensity-value') as HTMLElement;
const windSpeedEl   = document.getElementById('wind-speed')       as HTMLInputElement;
const windSpeedVal  = document.getElementById('wind-speed-value') as HTMLElement;
const windDirEl     = document.getElementById('wind-dir')         as HTMLInputElement;
const windDirVal    = document.getElementById('wind-dir-value')   as HTMLElement;
const weatherClouds = document.getElementById('weather-clouds')   as HTMLInputElement;
const todPresetBtns  = document.querySelectorAll<HTMLButtonElement>('#tod-preset-group button');
const weatherTypeBtns = document.querySelectorAll<HTMLButtonElement>('#weather-type-group button');

let weatherKind: WeatherType = 'clear';

/** Minutes past midnight as "HH:MM". */
function formatClock(minutes: number): string {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** Wind heading in degrees → the ground-plane vector the library drifts clouds along. */
function windVector(): { windX: number; windY: number } {
  const speed = Number(windSpeedEl.value);
  const rad   = (Number(windDirEl.value) * Math.PI) / 180;
  return { windX: Math.cos(rad) * speed, windY: Math.sin(rad) * speed };
}

/** Push the whole weather picture at once — switching type rebuilds the layer. */
function applyWeather(): void {
  scene.setWeather(weatherKind, {
    intensity: Number(weatherIntEl.value) / 100,
    clouds:    weatherClouds.checked,
    ...windVector(),
  });
}

todSlider.addEventListener('input', () => {
  const minutes = Number(todSlider.value);
  todValue.textContent = formatClock(minutes);
  todPresetBtns.forEach(b => b.classList.toggle('active', b.dataset['tod'] === todSlider.value));
  scene.setTimeOfDay(minutes / 1440);
});

todPresetBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    todSlider.value = btn.dataset['tod'] ?? '720';
    todSlider.dispatchEvent(new Event('input'));
  });
});

todAnimate.addEventListener('change', () => {
  scene.setDayCycle(todAnimate.checked, Number(dayLengthEl.value));
});

dayLengthEl.addEventListener('input', () => {
  dayLengthVal.textContent = `${dayLengthEl.value}s`;
  if (todAnimate.checked) scene.setDayCycle(true, Number(dayLengthEl.value));
});

weatherTypeBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    weatherKind = btn.dataset['weather'] as WeatherType;
    weatherTypeBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    applyWeather();
  });
});

weatherIntEl.addEventListener('input', () => {
  weatherIntVal.textContent = `${weatherIntEl.value}%`;
  scene.setWeatherIntensity(Number(weatherIntEl.value) / 100);
});

const onWindChange = (): void => {
  windSpeedVal.textContent = Number(windSpeedEl.value).toFixed(1);
  windDirVal.textContent   = `${windDirEl.value}°`;
  const { windX, windY } = windVector();
  scene.setWind(windX, windY);
};
windSpeedEl.addEventListener('input', onWindChange);
windDirEl.addEventListener('input', onWindChange);

weatherClouds.addEventListener('change', applyWeather);

// Push the controls' starting state now: the library builds its WeatherSystem
// on the first setWeather call, so without this the scene opens with no cloud
// shadows at all and only picks them up once the weather is touched.
applyWeather();

// ---- Seasons ----
const seasonsEnableEl = document.getElementById('seasons-enable')     as HTMLInputElement;
const seasonPhaseEl   = document.getElementById('season-phase')       as HTMLInputElement;
const seasonPhaseVal  = document.getElementById('season-phase-value') as HTMLElement;
const seasonAnimateEl = document.getElementById('season-animate')     as HTMLInputElement;
const seasonDaysEl    = document.getElementById('season-days')        as HTMLInputElement;
const seasonDaysVal   = document.getElementById('season-days-value')  as HTMLElement;
const seasonPresetBtns = document.querySelectorAll<HTMLButtonElement>('#season-preset-group button');
const seasonScopeBtns  = document.querySelectorAll<HTMLButtonElement>('#season-scope-group button');

/** Grey out the season controls until seasons are actually running. */
function updateSeasonControls(): void {
  const on = seasonsEnableEl.checked;
  for (const el of [seasonPhaseEl, seasonAnimateEl, seasonDaysEl]) el.disabled = !on;
  seasonPresetBtns.forEach(b => { b.disabled = !on; });
  seasonScopeBtns.forEach(b => {
    b.disabled = !on;
    b.classList.toggle('active', b.dataset['seasonScope'] === scene.seasonScope);
  });
  seasonPhaseVal.textContent = on ? scene.seasonLabel : 'off';
}

seasonScopeBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    scene.setSeasonScope(btn.dataset['seasonScope'] as SeasonScope);
    updateSeasonControls();
  });
});

/** Push the season controls' current state into the scene. */
function applySeasonControls(): void {
  scene.setSeasonsEnabled(seasonsEnableEl.checked);
  if (seasonsEnableEl.checked) {
    scene.setSeasonPhase(Number(seasonPhaseEl.value) / 100);
    scene.setSeasonCycle(seasonAnimateEl.checked, Number(seasonDaysEl.value));
  }
  updateSeasonControls();
}

seasonsEnableEl.addEventListener('change', applySeasonControls);

seasonPhaseEl.addEventListener('input', () => {
  const phase = Number(seasonPhaseEl.value) / 100;
  scene.setSeasonPhase(phase);
  seasonPhaseVal.textContent = scene.seasonLabel;
  seasonPresetBtns.forEach(b => b.classList.toggle('active', Number(b.dataset['season']) === phase));
});

seasonPresetBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    seasonPhaseEl.value = String(Number(btn.dataset['season']) * 100);
    seasonPhaseEl.dispatchEvent(new Event('input'));
  });
});

seasonAnimateEl.addEventListener('change', () => {
  scene.setSeasonCycle(seasonAnimateEl.checked, Number(seasonDaysEl.value));
});

seasonDaysEl.addEventListener('input', () => {
  seasonDaysVal.textContent = `${seasonDaysEl.value} days`;
  scene.setSeasonCycle(seasonAnimateEl.checked, Number(seasonDaysEl.value));
});

/**
 * Push the environment panel into the scene once at startup.
 *
 * Browsers restore checkbox state across a reload, and restoration does *not*
 * fire `change` — so the panel could come up with seasons ticked while the
 * scene had never been told, and only toggling it twice would bring the two
 * back together. Weather already applied itself this way; the year clock and
 * the day clock didn't. The panel is the source of truth, so read it rather
 * than assuming it matches the defaults.
 */
function applyEnvironmentControls(): void {
  if (todAnimate.checked) scene.setDayCycle(true, Number(dayLengthEl.value));
  applySeasonControls();
}
applyEnvironmentControls();

// ---- Territory ----
/** A colour-chip palette row, matching the terrain palette's look. */
function buildChipRow(
  id: string, name: string, color: number, selected: boolean,
  onPick: () => void,
): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.className = 'swatch-row';
  btn.dataset['id'] = id;
  btn.title = name;
  if (selected) btn.classList.add('active');

  const chip = document.createElement('span');
  chip.className = 'swatch-chip';
  chip.style.background = `#${color.toString(16).padStart(6, '0')}`;
  btn.appendChild(chip);

  const label = document.createElement('span');
  label.className = 'swatch-name';
  label.textContent = name;
  btn.appendChild(label);

  btn.addEventListener('click', onPick);
  return btn;
}

function renderFactionPalette(): void {
  const group = document.getElementById('faction-group')!;
  group.className = 'pal-grid';
  group.innerHTML = '';
  for (const faction of scene.factions) {
    const btn = buildChipRow(faction.id, faction.name, faction.color, faction.id === paintFactionId, () => {
      paintFactionId = faction.id;
      group.querySelectorAll('.swatch-row').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
    group.appendChild(btn);
  }
}
paintFactionId = scene.factions[0]?.id ?? 'red';
renderFactionPalette();

wireBrushGroup('territory-brush-group', r => { territoryBrushRadius = r; });

const territoryModeBtns = document.querySelectorAll<HTMLButtonElement>('#territory-mode-group .scatter-type-btn');
territoryModeBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    territoryMode = btn.dataset['territoryMode'] as 'claim' | 'release';
    territoryModeBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  });
});

/**
 * Wipe ownership or resources across the whole map as one undoable edit.
 * Both live in the metadata channel, so the transaction has to touch every
 * cell it clears for the snapshot to be able to put it back.
 */
function clearMetadataKey(key: string, matches: (col: number, row: number) => boolean): void {
  const { map } = scene;
  const tx = map.beginEdit();
  let count = 0;
  for (let row = 0; row < map.height; row++) {
    for (let col = 0; col < map.width; col++) {
      if (!matches(col, row)) continue;
      tx.setCellData(col, row, key, undefined);
      count++;
    }
  }
  if (count === 0) return;
  commitEdit(tx.commit());
  scene.refreshGameplayLayers();
}

document.getElementById('territory-clear-faction')!.addEventListener('click', () => {
  const territory = scene.territory;
  if (!territory) return;
  clearMetadataKey(territory.ownerKey, (c, r) => territory.ownerOf(c, r) === paintFactionId);
});

document.getElementById('territory-clear-all')!.addEventListener('click', () => {
  const territory = scene.territory;
  if (!territory) return;
  clearMetadataKey(territory.ownerKey, (c, r) => territory.ownerOf(c, r) !== null);
});

// ---- Resources ----
function renderResourcePalette(): void {
  const group = document.getElementById('resource-group')!;
  group.className = 'pal-grid';
  group.innerHTML = '';
  for (const desc of scene.resourceDescriptors) {
    const btn = buildChipRow(desc.id, desc.name, desc.color, desc.id === paintResourceId, () => {
      paintResourceId = desc.id;
      group.querySelectorAll('.swatch-row').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
    group.appendChild(btn);
  }
}
paintResourceId = scene.resourceDescriptors[0]?.id ?? '';
renderResourcePalette();

const resourceModeBtns = document.querySelectorAll<HTMLButtonElement>('#resource-mode-group .scatter-type-btn');
resourceModeBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    resourceMode = btn.dataset['resourceMode'] as 'place' | 'erase';
    resourceModeBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  });
});

(document.getElementById('resource-rules') as HTMLInputElement).addEventListener('change', function () {
  resourceRespectRules = this.checked;
});

document.getElementById('resource-clear-type')!.addEventListener('click', () => {
  const resources = scene.resources;
  if (!resources) return;
  clearMetadataKey(resources.resourceKey, (c, r) => resources.resourceAt(c, r) === paintResourceId);
});

document.getElementById('resource-clear-all')!.addEventListener('click', () => {
  const resources = scene.resources;
  if (!resources) return;
  clearMetadataKey(resources.resourceKey, (c, r) => resources.resourceAt(c, r) !== null);
});

// ---- Fog of war ----
const fogEnableEl     = document.getElementById('fog-enable')           as HTMLInputElement;
const fogHideEl       = document.getElementById('fog-hide-unexplored')  as HTMLInputElement;
const fogDimEl        = document.getElementById('fog-dim-explored')     as HTMLInputElement;
const fogModeBtns     = document.querySelectorAll<HTMLButtonElement>('#fog-mode-group .scatter-type-btn');

/** The brush and the bulk buttons do nothing visible until fog is switched on. */
function updateFogControls(): void {
  const on = fogEnableEl.checked;
  fogHideEl.disabled = !on;
  fogDimEl.disabled  = !on;
  fogModeBtns.forEach(b => { b.disabled = !on; });
  document.getElementById('fog-reveal-all')!.toggleAttribute('disabled', !on);
  document.getElementById('fog-clear-all')!.toggleAttribute('disabled', !on);
}

fogEnableEl.addEventListener('change', () => {
  scene.setFogEnabled(fogEnableEl.checked);
  updateFogControls();
  minimap.invalidate();
});
fogHideEl.addEventListener('change', () => {
  scene.setHideUnexplored(fogHideEl.checked);
  minimap.invalidate();
});
fogDimEl.addEventListener('change', () => {
  scene.setDimExplored(fogDimEl.checked);
  minimap.invalidate();
});

fogModeBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    fogMode = btn.dataset['fogMode'] as 'reveal' | 'hide';
    fogModeBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  });
});

wireBrushGroup('fog-brush-group', r => { fogBrushRadius = r; });

document.getElementById('fog-reveal-all')!.addEventListener('click', () => {
  scene.setAllFog(true);
  minimap.invalidate();
});
document.getElementById('fog-clear-all')!.addEventListener('click', () => {
  scene.setAllFog(false);
  minimap.invalidate();
});

updateFogControls();

// ---- Menu bar ----
// Each .menu-dropdown pairs a .menu-btn with the .menu-panel beside it; opening
// one closes the rest, and any click elsewhere closes all of them.
const menus = [...document.querySelectorAll<HTMLElement>('.menu-dropdown')].map(root => ({
  btn:   root.querySelector<HTMLButtonElement>('.menu-btn')!,
  panel: root.querySelector<HTMLElement>('.menu-panel')!,
}));

function closeMenus(): void {
  for (const m of menus) {
    m.panel.classList.add('hidden');
    m.btn.classList.remove('is-open');
  }
}

for (const menu of menus) {
  menu.btn.addEventListener('click', e => {
    e.stopPropagation();
    const wasOpen = !menu.panel.classList.contains('hidden');
    closeMenus();
    if (!wasOpen) {
      menu.panel.classList.remove('hidden');
      menu.btn.classList.add('is-open');
    }
  });
  // Hovering across the bar with a menu already open switches to that menu.
  menu.btn.addEventListener('pointerenter', () => {
    if (menus.some(m => !m.panel.classList.contains('hidden'))) {
      closeMenus();
      menu.panel.classList.remove('hidden');
      menu.btn.classList.add('is-open');
    }
  });
}
document.addEventListener('click', closeMenus);

addTerrainMenuBtn.addEventListener('click', () => openTerrainDialog(null));
liquidMenuBtn.addEventListener('click', () => openLiquidDialog());

// ---- Tool drawer visibility ----
drawerHide.addEventListener('click', () => setDrawerOpen(false));
drawerToggle.addEventListener('click', () => setDrawerOpen(!drawerOpen));
drawerMenuBtn.addEventListener('click', () => setDrawerOpen(!drawerOpen));

let gridVisible = false;
toggleGridBtn.addEventListener('click', () => {
  gridVisible = !gridVisible;
  scene.setHexGrid(gridVisible);
  gridCheck.classList.toggle('hidden', !gridVisible);
});

let shadowsEnabled = true; // scene starts with shadows on
toggleShadowsBtn.addEventListener('click', () => {
  shadowsEnabled = !shadowsEnabled;
  scene.setShadows(shadowsEnabled);
  shadowsCheck.classList.toggle('hidden', !shadowsEnabled);
});

let skyVisible = true; // scene starts with the sky dome on
toggleSkyBtn.addEventListener('click', () => {
  skyVisible = !skyVisible;
  scene.setSky(skyVisible);
  skyCheck.classList.toggle('hidden', !skyVisible);
});

let territoryVisible = true;
toggleTerritoryBtn.addEventListener('click', () => {
  territoryVisible = !territoryVisible;
  scene.setTerritoryVisible(territoryVisible);
  territoryCheck.classList.toggle('hidden', !territoryVisible);
  minimap.invalidate(); // the minimap tints owned cells only while the overlay is on
});

let resourcesVisible = true;
toggleResourcesBtn.addEventListener('click', () => {
  resourcesVisible = !resourcesVisible;
  scene.setResourcesVisible(resourcesVisible);
  resourcesCheck.classList.toggle('hidden', !resourcesVisible);
});

newMapBtn.addEventListener('click', () => newMapDialog.showModal());
dialogCloseBtn.addEventListener('click', () => newMapDialog.close());
newMapDialog.addEventListener('click', e => { if (e.target === newMapDialog) newMapDialog.close(); });

// ---- Stroke state ----
// One library transaction per stroke: mutations apply live, the transaction
// snapshots touched cells, and commit() yields the undo/redo unit.
let isPointerDown  = false;
let strokeTx       : MapTransaction | null = null;
let strokeVisited  = new Set<number>();

// Path-tool preview state (shared by paint-road and paint-river)
let pathStart   : { col: number; row: number } | null = null;
let currentPath : HexCoord[] | null = null;
let pathErasing = false;
let riverEraseTx            : MapTransaction | null = null;
let strokeRiverEraseVisited = new Set<number>();

/**
 * Commit a finished edit to history (no-op for empty edits).
 *
 * Every edit carries the gameplay-layer refresh, not just the ownership and
 * resource tools: those overlays are built at each cell's surface height, so
 * an elevation undo three strokes later would otherwise leave borders and
 * icons floating at the old altitude.
 */
function commitEdit(edit: MapEdit): void {
  if (edit.isEmpty) return;
  history.commit(new MapEditCommand(edit, () => scene.chunks, () => scene.refreshGameplayLayers()));
}

function cellKey(col: number, row: number): number {
  return row * scene.map.width + col;
}

const EDGE_DIRS = POINTY_TOP.edgeDirections; // road edge i → hex direction EDGE_DIRS[i]

function edgeBetween(fromCol: number, fromRow: number, toCol: number, toRow: number): number | null {
  for (let i = 0; i < 6; i++) {
    const nb = offsetNeighbor(fromCol, fromRow, EDGE_DIRS[i]);
    if (nb.col === toCol && nb.row === toRow) return i;
  }
  return null;
}

function updatePathPreview(): void {
  if (!pathStart) return;
  const end = scene.hoveredCell ?? pathStart;
  const startHex = offsetToHex(pathStart.col, pathStart.row);
  const endHex   = offsetToHex(end.col, end.row);
  if (end.col === pathStart.col && end.row === pathStart.row) {
    currentPath = null;
    scene.setPathPreview([startHex], pathErasing);
    return;
  }
  let path: HexCoord[] | null;
  const activeMode = activeTool === 'paint-road' ? roadMode : riverMode;
  if (activeMode === 'straight') {
    path = hexLineDraw(startHex, endHex);
  } else {
    path = findPath(
      startHex,
      endHex,
      (from, to) => {
        const toOff = hexToOffset(to);
        if (scene.isWater(scene.map.getTerrain(toOff.col, toOff.row))) {
          // Rivers may end one cell into water — the land→water edge is what
          // forms an estuary. Only the drag destination qualifies, so paths
          // never route THROUGH water; roads never enter it at all.
          const isRiverEnd = activeTool === 'paint-river'
            && to.q === endHex.q && to.r === endHex.r;
          return isRiverEnd ? 1 : Infinity;
        }

        let cost = 1;

        if (roadCostElev.checked) {
          const fromOff = hexToOffset(from);
          const diff = Math.abs(
            scene.map.getElevation(toOff.col, toOff.row) -
            scene.map.getElevation(fromOff.col, fromOff.row),
          );
          cost += diff * 1.5;
        }

        if (roadCostTerrain.checked) {
          const def = scene.terrainLookup.get(scene.map.getTerrain(toOff.col, toOff.row));
          cost += (def?.roadCost ?? 1) - 1;
        }

        if (roadCostRoads.checked && scene.map.hasRoads(toOff.col, toOff.row)) {
          cost *= 0.25;
        }

        return cost;
      },
      scene.map,
    );
  }
  if (path && activeTool === 'paint-river' && !pathErasing) {
    path = trimRiverPathAtWater(path);
  }
  currentPath = path;
  scene.setPathPreview(path ?? [startHex], pathErasing);
}

/**
 * Rivers touch water only at their ends: they may START one cell inside water
 * (a lake outlet) and END one cell into water (the land→water edge forms the
 * estuary), but never continue across it — a straight or waypoint line dragged
 * over a bay stops at the first water cell. Erase paths are NOT trimmed, so
 * rivers that pass through generator lakes stay erasable end to end.
 */
function trimRiverPathAtWater(path: HexCoord[]): HexCoord[] {
  const isWaterAt = (h: HexCoord): boolean => {
    const off = hexToOffset(h);
    return scene.map.inBounds(off.col, off.row)
      && scene.isWater(scene.map.getTerrain(off.col, off.row));
  };
  for (let i = 1; i < path.length; i++) {
    if (!isWaterAt(path[i])) continue;
    // Two water cells in a row means the path entered open water — cut before.
    return path.slice(0, isWaterAt(path[i - 1]) ? i : i + 1);
  }
  return path;
}

/**
 * Set when a tool writes ownership or resource data. Those layers watch their
 * own dirty flags, and a transaction write goes straight to the metadata
 * channel underneath them — so the overlays are rebuilt explicitly, once per
 * brush stamp rather than once per cell.
 */
let gameplayDirty = false;

function flushGameplayLayers(): void {
  if (!gameplayDirty) return;
  gameplayDirty = false;
  scene.refreshGameplayLayers();
}

function applyBrush(col: number, row: number): void {
  const r = activeBrushRadius();
  const cells = hexRange(offsetToHex(col, row), r);
  for (const hex of cells) {
    const off = hexToOffset(hex);
    if (off.col >= 0 && off.col < scene.map.width && off.row >= 0 && off.row < scene.map.height) {
      applyTool(off.col, off.row);
    }
  }
  flushGameplayLayers();
  // Mid-stroke feedback: the stroke only commits (and so only reaches
  // history.onChange) on pointer-up. The minimap throttles its own redraws.
  minimap.invalidate();
}

/**
 * Whether a resource type's placement rule admits this cell. Covers the rules
 * that read from the map itself; the climate-gated ones (temperature,
 * moisture) need generator fields the editor doesn't carry, so they are not
 * enforced here.
 */
function canPlaceResource(desc: ResourceDescriptor, col: number, row: number): boolean {
  const rule = desc.placement;
  if (!rule) return true;
  const { map } = scene;

  const terrain = map.getTerrain(col, row);
  const liquid  = scene.isWater(terrain);
  if (rule.requiresLiquid && !liquid) return false;
  if (!rule.requiresLiquid && liquid) return false;
  if (rule.allowedTerrains && !rule.allowedTerrains.includes(terrain)) return false;

  const elevation = map.getElevation(col, row);
  if (rule.minElevation !== undefined && elevation < rule.minElevation) return false;
  if (rule.maxElevation !== undefined && elevation > rule.maxElevation) return false;

  if (rule.requiresRiver && !map.hasRiver(col, row)) return false;
  if (rule.requiresCoast) {
    let coastal = false;
    for (let d = 0; d < 6; d++) {
      const nb = offsetNeighbor(col, row, EDGE_DIRS[d]);
      if (nb.col < 0 || nb.col >= map.width || nb.row < 0 || nb.row >= map.height) continue;
      if (scene.isWater(map.getTerrain(nb.col, nb.row))) { coastal = true; break; }
    }
    if (!coastal) return false;
  }
  if (rule.minFeatureLevel
    && map.getFeatureLevel(col, row, rule.minFeatureLevel.layer) < rule.minFeatureLevel.level) return false;

  return true;
}

function applyTool(col: number, row: number): void {
  const { map, chunks } = scene;
  const key = cellKey(col, row);
  if (strokeVisited.has(key)) return;
  strokeVisited.add(key);

  switch (activeTool) {
    case 'paint-terrain': {
      const prevTerrain = map.getTerrain(col, row);
      if (prevTerrain === paintTerrainType) return;
      if (lockedTerrains.has(prevTerrain)) return;
      const prevElev = map.getElevation(col, row);
      const tx = (strokeTx ??= map.beginEdit());
      tx.setTerrain(col, row, paintTerrainType);
      if (!scene.isWater(paintTerrainType) && scene.isWater(prevTerrain) && prevElev < 0) {
        tx.setElevation(col, row, 0);
      }
      chunks.markDirty(col, row);
      break;
    }
    case 'elevation': {
      const prev = map.getElevation(col, row);
      if (contourLevel !== null && prev !== contourLevel) return;
      let next: number;
      if (elevMode === 'raise-lower') {
        next = prev + elevStep;
      } else if (elevMode === 'smooth') {
        let sum = prev, count = 1;
        for (let dir = 0; dir < 6; dir++) {
          const nb = offsetNeighbor(col, row, EDGE_DIRS[dir]);
          if (nb.col >= 0 && nb.col < map.width && nb.row >= 0 && nb.row < map.height) {
            sum += map.getElevation(nb.col, nb.row);
            count++;
          }
        }
        next = Math.round(sum / count);
      } else if (elevMode === 'flatten') {
        next = flattenTarget;
      } else if (elevMode === 'set-absolute') {
        next = elevSetTarget;
      } else {
        next = prev + Math.floor(Math.random() * 5) - 2;
      }
      next = Math.max(elevRangeMin, Math.min(elevRangeMax, next));
      if (next === prev) return;
      (strokeTx ??= map.beginEdit()).setElevation(col, row, next);
      chunks.markDirty(col, row);
      // Territory borders and resource icons sit on the cell surface, so they
      // have to be rebuilt when the ground moves under them.
      gameplayDirty = true;
      break;
    }
    case 'paint-scatter': {
      const elev = map.getElevation(col, row);
      if (elev < scatterElevMin || elev > scatterElevMax) return;
      if (scatterTerrainFilter.size > 0 && !scatterTerrainFilter.has(map.getTerrain(col, row))) return;
      const layer = paintScatterLayer;
      const next  = paintScatterLevel < 0 ? (Math.floor(Math.random() * 3) + 1) : paintScatterLevel;
      const prev  = map.getFeatureLevel(col, row, layer);
      if (prev === next) return;
      (strokeTx ??= map.beginEdit()).setFeatureLevel(col, row, layer, next);
      chunks.markDirty(col, row);
      break;
    }
    case 'paint-territory': {
      const territory = scene.territory;
      if (!territory) return;
      const next = territoryMode === 'claim' ? paintFactionId : undefined;
      if (territory.ownerOf(col, row) === (next ?? null)) return;
      // Written through the transaction, not TerritoryLayer.claim(), so the
      // metadata snapshot lands in the undo stack with everything else.
      (strokeTx ??= map.beginEdit()).setCellData(col, row, territory.ownerKey, next);
      gameplayDirty = true;
      break;
    }
    case 'paint-resource': {
      const resources = scene.resources;
      if (!resources) return;
      const prev = resources.resourceAt(col, row);
      if (resourceMode === 'erase') {
        if (prev === null) return;
        (strokeTx ??= map.beginEdit()).setCellData(col, row, resources.resourceKey, undefined);
      } else {
        if (!paintResourceId || prev === paintResourceId) return;
        const desc = resources.getDescriptor(paintResourceId);
        if (!desc) return;
        if (resourceRespectRules && !canPlaceResource(desc, col, row)) return;
        (strokeTx ??= map.beginEdit()).setCellData(col, row, resources.resourceKey, paintResourceId);
      }
      gameplayDirty = true;
      break;
    }
    case 'paint-fog': {
      // No-op rather than painting into a detached fog: with the layer off
      // nothing would change on screen, which reads as a broken brush.
      if (!scene.fog) return;
      // Exploration is per-player state rather than map data: it is not part
      // of the map's channels, so it stays out of the undo stack too.
      scene.paintFog([{ col, row }], fogMode === 'reveal');
      minimap.invalidate();
      break;
    }
  }
}

function floodFill(startCol: number, startRow: number): void {
  const { map, chunks } = scene;
  const sourceTerrain = map.getTerrain(startCol, startRow);
  if (sourceTerrain === paintTerrainType) return;
  if (lockedTerrains.has(sourceTerrain)) return;

  const tx = map.beginEdit();
  const visited = new Set<number>();
  let head = 0;
  const queue: Array<{ col: number; row: number }> = [{ col: startCol, row: startRow }];
  visited.add(cellKey(startCol, startRow));

  while (head < queue.length) {
    const { col, row } = queue[head++];
    const prevElev = map.getElevation(col, row);
    tx.setTerrain(col, row, paintTerrainType);
    if (!scene.isWater(paintTerrainType) && scene.isWater(sourceTerrain) && prevElev < 0) {
      tx.setElevation(col, row, 0);
    }
    chunks.markDirty(col, row);

    for (let dir = 0; dir < 6; dir++) {
      const nb = offsetNeighbor(col, row, EDGE_DIRS[dir]);
      if (nb.col < 0 || nb.col >= map.width || nb.row < 0 || nb.row >= map.height) continue;
      const key = cellKey(nb.col, nb.row);
      if (visited.has(key)) continue;
      visited.add(key);
      if (map.getTerrain(nb.col, nb.row) === sourceTerrain) queue.push({ col: nb.col, row: nb.row });
    }
  }

  commitEdit(tx.commit());
}

function floodFillScatter(startCol: number, startRow: number): void {
  const { map, chunks } = scene;
  const sourceTerrain = map.getTerrain(startCol, startRow);
  if (scatterTerrainFilter.size > 0 && !scatterTerrainFilter.has(sourceTerrain)) return;

  const layer = paintScatterLayer;
  const tx = map.beginEdit();
  const visited = new Set<number>();
  let head = 0;
  const queue: Array<{ col: number; row: number }> = [{ col: startCol, row: startRow }];
  visited.add(cellKey(startCol, startRow));

  while (head < queue.length) {
    const { col, row } = queue[head++];
    const elev = map.getElevation(col, row);
    if (elev >= scatterElevMin && elev <= scatterElevMax) {
      const next = paintScatterLevel < 0 ? (Math.floor(Math.random() * 3) + 1) : paintScatterLevel;
      const prev = map.getFeatureLevel(col, row, layer);
      if (prev !== next) {
        tx.setFeatureLevel(col, row, layer, next);
        chunks.markDirty(col, row);
      }
    }
    for (let dir = 0; dir < 6; dir++) {
      const nb = offsetNeighbor(col, row, EDGE_DIRS[dir]);
      if (nb.col < 0 || nb.col >= map.width || nb.row < 0 || nb.row >= map.height) continue;
      const key = cellKey(nb.col, nb.row);
      if (visited.has(key)) continue;
      visited.add(key);
      if (map.getTerrain(nb.col, nb.row) === sourceTerrain) queue.push({ col: nb.col, row: nb.row });
    }
  }
  commitEdit(tx.commit());
}

function applyErosionBrush(brushCol: number, brushRow: number): void {
  const { map, chunks } = scene;
  const cells = hexRange(offsetToHex(brushCol, brushRow), activeBrushRadius())
    .map(h => hexToOffset(h))
    .filter(o => o.col >= 0 && o.col < map.width && o.row >= 0 && o.row < map.height);

  const working = new Map<number, number>();
  for (const { col, row } of cells) working.set(cellKey(col, row), map.getElevation(col, row));
  const prevMap = new Map(working);

  for (let pass = 0; pass < 3; pass++) {
    const snapshot = new Map(working);
    for (const { col, row } of cells) {
      const cur = snapshot.get(cellKey(col, row))!;
      for (let dir = 0; dir < 6; dir++) {
        const nb = offsetNeighbor(col, row, EDGE_DIRS[dir]);
        if (nb.col < 0 || nb.col >= map.width || nb.row < 0 || nb.row >= map.height) continue;
        const nbElev = snapshot.get(cellKey(nb.col, nb.row)) ?? map.getElevation(nb.col, nb.row);
        if (nbElev < cur) {
          working.set(cellKey(col, row), Math.max(elevRangeMin, cur - 1));
          break;
        }
      }
    }
  }

  const tx = map.beginEdit();
  for (const { col, row } of cells) {
    const p = prevMap.get(cellKey(col, row))!;
    const n = working.get(cellKey(col, row))!;
    if (p === n) continue;
    tx.setElevation(col, row, n);
    chunks.markDirty(col, row);
  }
  commitEdit(tx.commit());
}

function computeWaypointPath(
  waypoints: Array<{ col: number; row: number }>,
  cursor:    { col: number; row: number } | null,
): HexCoord[] {
  if (waypoints.length === 0) return [];
  const allPoints = cursor ? [...waypoints, cursor] : [...waypoints];
  if (allPoints.length === 1) return [offsetToHex(allPoints[0].col, allPoints[0].row)];
  const result: HexCoord[] = [];
  for (let i = 0; i < allPoints.length - 1; i++) {
    const seg = hexLineDraw(
      offsetToHex(allPoints[i].col, allPoints[i].row),
      offsetToHex(allPoints[i + 1].col, allPoints[i + 1].row),
    );
    if (i === 0) result.push(...seg);
    else result.push(...seg.slice(1));
  }
  // Waypoint rivers follow the same rule as drag rivers: stop at the shore.
  return trimRiverPathAtWater(result);
}

function traceDownhill(startCol: number, startRow: number): HexCoord[] {
  const { map } = scene;
  const path: HexCoord[] = [];
  let curCol = startCol, curRow = startRow;
  const visited = new Set<number>();
  while (path.length < 500) {
    path.push(offsetToHex(curCol, curRow));
    visited.add(cellKey(curCol, curRow));
    if (scene.isWater(map.getTerrain(curCol, curRow))) break;
    const curElev = map.getElevation(curCol, curRow);
    let bestCol = -1, bestRow = -1;
    let bestPrimary = Infinity; // lower = better (neighbour elevation)
    let bestSecondary = Infinity; // lower = better (1-step lookahead)
    let foundWater = false;
    for (let dir = 0; dir < 6; dir++) {
      const nb = offsetNeighbor(curCol, curRow, EDGE_DIRS[dir]);
      if (nb.col < 0 || nb.col >= map.width || nb.row < 0 || nb.row >= map.height) continue;
      if (visited.has(cellKey(nb.col, nb.row))) continue;
      if (scene.isWater(map.getTerrain(nb.col, nb.row)) && !foundWater) {
        bestCol = nb.col; bestRow = nb.row; foundWater = true; continue;
      }
      if (foundWater) continue;
      const nbElev = map.getElevation(nb.col, nb.row);
      if (nbElev > curElev) continue; // never go uphill
      // 1-step lookahead: lowest elevation reachable from nb
      let lookAhead = nbElev;
      for (let d2 = 0; d2 < 6; d2++) {
        const nb2 = offsetNeighbor(nb.col, nb.row, EDGE_DIRS[d2]);
        if (nb2.col < 0 || nb2.col >= map.width || nb2.row < 0 || nb2.row >= map.height) continue;
        if (visited.has(cellKey(nb2.col, nb2.row))) continue;
        if (scene.isWater(map.getTerrain(nb2.col, nb2.row))) { lookAhead = -Infinity; break; }
        lookAhead = Math.min(lookAhead, map.getElevation(nb2.col, nb2.row));
      }
      if (nbElev < bestPrimary || (nbElev === bestPrimary && lookAhead < bestSecondary)) {
        bestCol = nb.col; bestRow = nb.row; bestPrimary = nbElev; bestSecondary = lookAhead;
      }
    }
    if (bestCol === -1) break; // local minimum — stop
    curCol = bestCol; curRow = bestRow;
  }
  return path;
}

function applyRiverPath(path: HexCoord[], erasing: boolean): void {
  if (path.length < 2) return;
  const { map, chunks } = scene;
  const tx = map.beginEdit();

  if (erasing) {
    // Partial detach: remove only the half-edges the drawn path follows, so
    // tributaries joining the erased river at a confluence stay intact.
    for (let i = 0; i < path.length - 1; i++) {
      const a = hexToOffset(path[i]);
      const b = hexToOffset(path[i + 1]);
      if (!map.inBounds(a.col, a.row) || !map.inBounds(b.col, b.row)) continue;
      const edge = edgeBetween(a.col, a.row, b.col, b.row);
      if (edge === null) continue;
      if (map.getOutgoingRiverDir(a.col, a.row) === edge) tx.removeRiverOutgoing(a.col, a.row);
      tx.removeRiverIncoming(b.col, b.row, (edge + 3) % 6);
      chunks.markDirty(a.col, a.row);
      chunks.markDirty(b.col, b.row);
    }
  } else {
    // Merge with existing rivers instead of clearing: incoming edges are
    // additive (confluences), and replacing a cell's outgoing first detaches
    // the old downstream neighbour's matching incoming edge.
    for (let i = 0; i < path.length; i++) {
      const off = hexToOffset(path[i]);
      if (!map.inBounds(off.col, off.row)) continue;
      if (i > 0) {
        const prev = hexToOffset(path[i - 1]);
        const edge = edgeBetween(prev.col, prev.row, off.col, off.row);
        if (edge !== null) tx.setRiverIncoming(off.col, off.row, (edge + 3) % 6);
      }
      if (i < path.length - 1) {
        const next = hexToOffset(path[i + 1]);
        const edge = edgeBetween(off.col, off.row, next.col, next.row);
        if (edge !== null) {
          const oldOut = map.getOutgoingRiverDir(off.col, off.row);
          if (oldOut >= 0 && oldOut !== edge) {
            const oldNb = offsetNeighbor(off.col, off.row, EDGE_DIRS[oldOut]);
            if (map.inBounds(oldNb.col, oldNb.row)) {
              tx.removeRiverIncoming(oldNb.col, oldNb.row, (oldOut + 3) % 6);
              chunks.markDirty(oldNb.col, oldNb.row);
            }
          }
          tx.setRiverOutgoing(off.col, off.row, edge);
        }
      }
      chunks.markDirty(off.col, off.row);
    }
  }

  commitEdit(tx.commit());
}

function eraseRiverAt(col: number, row: number): void {
  const key = cellKey(col, row);
  if (strokeRiverEraseVisited.has(key)) return;
  strokeRiverEraseVisited.add(key);
  const { map, chunks } = scene;
  if (!map.hasRiver(col, row)) return;
  const tx = (riverEraseTx ??= map.beginEdit());

  // Detach every neighbour half-edge pointing at this cell so no dangling
  // channel stubs survive: upstream cells lose their outgoing into us, the
  // downstream cell loses only OUR incoming edge (its other tributaries stay).
  const mask = map.getIncomingRiverMask(col, row);
  for (let e = 0; e < 6; e++) {
    if (!(mask & (1 << e))) continue;
    const nb = offsetNeighbor(col, row, EDGE_DIRS[e]);
    if (!map.inBounds(nb.col, nb.row)) continue;
    if (map.getOutgoingRiverDir(nb.col, nb.row) === (e + 3) % 6) {
      tx.removeRiverOutgoing(nb.col, nb.row);
      chunks.markDirty(nb.col, nb.row);
    }
  }
  const out = map.getOutgoingRiverDir(col, row);
  if (out >= 0) {
    const nb = offsetNeighbor(col, row, EDGE_DIRS[out]);
    if (map.inBounds(nb.col, nb.row)) {
      tx.removeRiverIncoming(nb.col, nb.row, (out + 3) % 6);
      chunks.markDirty(nb.col, nb.row);
    }
  }

  tx.clearRiver(col, row);
  chunks.markDirty(col, row);
}

function cancelWaypointRiver(): void {
  riverWaypoints     = [];
  riverWaypointActive = false;
  scene.setPathPreview(null);
}

function commitWaypointRiver(): void {
  if (!riverWaypointActive) return;
  const wps = [...riverWaypoints];
  // dblclick fires a second pointerdown before dblclick, so the last waypoint is a duplicate — remove it
  if (wps.length >= 2) {
    const last = wps[wps.length - 1], prev = wps[wps.length - 2];
    if (last.col === prev.col && last.row === prev.row) wps.pop();
  }
  if (wps.length >= 2) applyRiverPath(computeWaypointPath(wps, null), false);
  cancelWaypointRiver();
}

function endStroke(): void {
  if (!isPointerDown) return;
  isPointerDown = false;

  if (activeTool === 'paint-road') {
    if (currentPath && currentPath.length >= 2) {
      const placing = !pathErasing;
      const tx = scene.map.beginEdit();
      for (let i = 0; i < currentPath.length - 1; i++) {
        const a    = hexToOffset(currentPath[i]);
        const b    = hexToOffset(currentPath[i + 1]);
        const edge = edgeBetween(a.col, a.row, b.col, b.row);
        if (edge === null) continue;
        // Paired write keeps both half-edges in agreement.
        for (const c of tx.setRoadEdge(a.col, a.row, edge, placing, POINTY_TOP)) {
          scene.chunks.markDirty(c.col, c.row);
        }
      }
      commitEdit(tx.commit());
    }
    scene.setPathPreview(null);
    pathStart   = null;
    currentPath = null;
    return;
  }

  if (activeTool === 'paint-river') {
    if (riverMode === 'erase') {
      if (riverEraseTx) commitEdit(riverEraseTx.commit());
      riverEraseTx            = null;
      strokeRiverEraseVisited = new Set();
      return;
    }
    // path / straight modes
    if (currentPath) applyRiverPath(currentPath, pathErasing);
    scene.setPathPreview(null);
    pathStart   = null;
    currentPath = null;
    return;
  }

  if (activeTool === 'elevation' && elevMode === 'slope') {
    if (pathStart && currentPath && currentPath.length >= 2) {
      const startOff  = hexToOffset(currentPath[0]);
      const endOff    = hexToOffset(currentPath[currentPath.length - 1]);
      const startElev = scene.map.getElevation(startOff.col, startOff.row);
      const endElev   = scene.map.getElevation(endOff.col,   endOff.row);
      const n = currentPath.length - 1;
      const tx = scene.map.beginEdit();
      for (let i = 0; i <= n; i++) {
        const off = hexToOffset(currentPath[i]);
        if (off.col < 0 || off.col >= scene.map.width || off.row < 0 || off.row >= scene.map.height) continue;
        const prev = scene.map.getElevation(off.col, off.row);
        const next = Math.max(elevRangeMin, Math.min(elevRangeMax,
          Math.round(startElev + (endElev - startElev) * (i / n))));
        if (prev === next) continue;
        tx.setElevation(off.col, off.row, next);
        scene.chunks.markDirty(off.col, off.row);
      }
      commitEdit(tx.commit());
    }
    scene.setPathPreview(null);
    pathStart    = null;
    currentPath  = null;
    contourLevel = null;
    return;
  }

  if (strokeTx) commitEdit(strokeTx.commit());
  flushGameplayLayers();

  strokeTx      = null;
  strokeVisited = new Set();
  contourLevel  = null;
}

viewport.addEventListener('pointerdown', e => {
  if (e.button !== 0) return;
  if (activeTool === 'environment') return;   // scene-wide settings, nothing to paint
  const cell = scene.hoveredCell;
  if (!cell) return;

  // Scatter eyedropper: Alt+click samples density on the active layer
  if (e.altKey && activeTool === 'paint-scatter') {
    e.preventDefault();
    const sampled = scene.map.getFeatureLevel(cell.col, cell.row, paintScatterLayer);
    paintScatterLevel = sampled;
    document.querySelectorAll<HTMLButtonElement>('#density-group .density-btn').forEach(b => {
      b.classList.toggle('active', b.dataset['density'] === String(sampled));
    });
    return;
  }

  // Scatter flood fill
  if (activeTool === 'paint-scatter' && scatterMode === 'fill') {
    floodFillScatter(cell.col, cell.row);
    return;
  }

  // Eyedropper: Alt+click samples terrain without painting
  if (e.altKey && activeTool === 'paint-terrain') {
    e.preventDefault();
    const sampled = scene.map.getTerrain(cell.col, cell.row);
    paintTerrainType = sampled;
    document.querySelectorAll<HTMLElement>('#terrain-type-group .swatch-row').forEach(b => {
      b.classList.toggle('active', b.dataset['terrain'] === String(sampled));
    });
    return;
  }

  // Elevation eyedropper: Alt+click samples elevation into the active target
  if (e.altKey && activeTool === 'elevation' && elevMode !== 'slope' && elevMode !== 'erosion') {
    e.preventDefault();
    const sampled = scene.map.getElevation(cell.col, cell.row);
    elevSetTarget = sampled;
    flattenTarget = sampled;
    (document.getElementById('elev-set-target') as HTMLInputElement).value = String(sampled);
    if (elevMode !== 'set-absolute' && elevMode !== 'flatten') {
      elevMode = 'set-absolute';
      elevModeBtns.forEach(b => b.classList.toggle('active', b.dataset['elevMode'] === 'set-absolute'));
      updateElevStepVisibility();
    }
    return;
  }

  if (activeTool === 'paint-road' || (activeTool === 'paint-river' && (riverMode === 'path' || riverMode === 'straight'))) {
    isPointerDown = true;
    pathErasing = e.shiftKey;
    pathStart   = { col: cell.col, row: cell.row };
    currentPath = null;
    scene.setPathPreview([offsetToHex(cell.col, cell.row)], pathErasing);
    return;
  }

  if (activeTool === 'paint-river' && riverMode === 'waypoint') {
    riverWaypoints.push({ col: cell.col, row: cell.row });
    riverWaypointActive = true;
    scene.setPathPreview(computeWaypointPath(riverWaypoints, null), false);
    return;
  }

  if (activeTool === 'paint-river' && riverMode === 'downhill') {
    const path = traceDownhill(cell.col, cell.row);
    if (path.length >= 2) applyRiverPath(path, false);
    return;
  }

  if (activeTool === 'paint-river' && riverMode === 'erase') {
    isPointerDown           = true;
    riverEraseTx            = null;
    strokeRiverEraseVisited = new Set();
    eraseRiverAt(cell.col, cell.row);
    return;
  }

  if (activeTool === 'elevation' && elevMode === 'slope') {
    isPointerDown = true;
    pathStart   = { col: cell.col, row: cell.row };
    currentPath = null;
    scene.setPathPreview([offsetToHex(cell.col, cell.row)], false);
    return;
  }

  if (activeTool === 'elevation' && elevMode === 'erosion') {
    applyErosionBrush(cell.col, cell.row);
    return;
  }

  // Flood fill: single click commits immediately, no drag
  if (activeTool === 'paint-terrain' && terrainMode === 'fill') {
    floodFill(cell.col, cell.row);
    return;
  }

  isPointerDown = true;
  strokeTx      = null;
  strokeVisited = new Set();
  if (activeTool === 'elevation' && elevMode === 'flatten') {
    flattenTarget = scene.map.getElevation(cell.col, cell.row);
  }
  if (activeTool === 'elevation' && contourSnapHeld) {
    contourLevel = scene.map.getElevation(cell.col, cell.row);
  }
  applyBrush(cell.col, cell.row);
});

viewport.addEventListener('pointermove', (e) => {
  // Waypoint river preview runs even without pointer down
  if (activeTool === 'paint-river' && riverMode === 'waypoint' && riverWaypointActive) {
    const cursor = scene.hoveredCell;
    if (cursor) scene.setPathPreview(computeWaypointPath(riverWaypoints, cursor), false);
    return;
  }

  if (!isPointerDown) return;

  if (activeTool === 'paint-road' || (activeTool === 'paint-river' && (riverMode === 'path' || riverMode === 'straight'))) {
    pathErasing = e.shiftKey;
    updatePathPreview();
    return;
  }

  if (activeTool === 'paint-river' && riverMode === 'erase') {
    const cell = scene.hoveredCell;
    if (cell) eraseRiverAt(cell.col, cell.row);
    return;
  }

  if (activeTool === 'elevation' && elevMode === 'slope') {
    if (!pathStart) return;
    const end = scene.hoveredCell ?? pathStart;
    currentPath = hexLineDraw(offsetToHex(pathStart.col, pathStart.row), offsetToHex(end.col, end.row));
    scene.setPathPreview(currentPath, false);
    return;
  }
  const cell = scene.hoveredCell;
  if (cell) applyBrush(cell.col, cell.row);
});

viewport.addEventListener('pointerup',     endStroke);
viewport.addEventListener('pointercancel', endStroke);
viewport.addEventListener('dblclick', () => {
  if (activeTool === 'paint-river' && riverMode === 'waypoint') commitWaypointRiver();
});

// ---- Inspector update loop ----
function riverLabel(col: number, row: number): string {
  const { map } = scene;
  if (!map.hasRiver(col, row)) return 'none';
  if (map.hasRiverBeginOrEnd(col, row)) return map.hasIncomingRiver(col, row) ? 'terminus' : 'source';
  return 'through';
}

const DENSITY_LABELS = ['none', 'sparse', 'medium', 'dense'];
/** Feature layer index → brush name, matching scene.ts's scatter definitions. */
const SCATTER_LAYER_NAMES = ['Pines', 'Rocks', 'Broadleaf', 'Bushes'];

const ELEV_MODE_LABELS: Record<ElevMode, string> = {
  'raise-lower':  'raise / lower',
  'smooth':       'smooth',
  'flatten':      'flatten',
  'noise':        'noise',
  'set-absolute': 'set absolute',
  'slope':        'slope ramp',
  'erosion':      'erosion',
};

const RIVER_MODE_LABELS: Record<RiverMode, string> = {
  'path':     'path',
  'straight': 'straight',
  'waypoint': 'waypoints',
  'downhill': 'downhill trace',
  'erase':    'erase',
};

/** Cells covered by a hex brush of the given radius: 1, 7, 19, 37… */
const brushCells = (r: number): number => 3 * r * r + 3 * r + 1;

/** Left-hand status text: what the active tool will do on the next click. */
function statusToolText(): string {
  // Brush-mode tools report their footprint; fill mode has none to report.
  const footprint = (mode: 'brush' | 'fill') =>
    mode === 'brush' ? `brush ${brushCells(activeBrushRadius())}` : 'fill';
  switch (activeTool) {
    case 'paint-terrain': {
      const name = scene.terrainLookup.get(paintTerrainType)?.name ?? String(paintTerrainType);
      return `${name} · ${footprint(terrainMode)}`;
    }
    case 'elevation': {
      const mode = ELEV_MODE_LABELS[elevMode];
      const step = elevMode === 'raise-lower' ? ` ${elevStep > 0 ? '+' : ''}${elevStep}` : '';
      return `Elevation · ${mode}${step} · brush ${brushCells(activeBrushRadius())}`;
    }
    case 'paint-scatter': {
      const layer   = SCATTER_LAYER_NAMES[paintScatterLayer] ?? `Layer ${paintScatterLayer}`;
      const density = paintScatterLevel < 0 ? 'random' : DENSITY_LABELS[paintScatterLevel];
      return `${layer} · ${density} · ${footprint(scatterMode)}`;
    }
    case 'paint-river':
      return `River · ${RIVER_MODE_LABELS[riverMode]}`;
    case 'paint-road':
      return `Road · ${roadMode === 'path' ? 'pathfinding' : 'straight'}`;
    case 'environment':
      return `Environment · ${todValue.textContent} · ${weatherKind}`;
    case 'paint-territory': {
      if (territoryMode === 'release') return `Territory · release · brush ${brushCells(activeBrushRadius())}`;
      const name = scene.factions.find(f => f.id === paintFactionId)?.name ?? paintFactionId;
      return `${name} · claim · brush ${brushCells(activeBrushRadius())}`;
    }
    case 'paint-resource': {
      if (resourceMode === 'erase') return 'Resources · erase';
      const name = scene.resourceDescriptors.find(d => d.id === paintResourceId)?.name ?? paintResourceId;
      return `${name} · place${resourceRespectRules ? '' : ' · anywhere'}`;
    }
    case 'paint-fog': {
      const { explored, total } = scene.fogStats;
      const pct = total > 0 ? Math.round((explored / total) * 100) : 0;
      return `Fog · ${fogMode} · brush ${brushCells(activeBrushRadius())} · ${pct}% explored`;
    }
  }
}

let lastPerfWrite = 0;

function updateReadouts(now: number): void {
  const cell = scene.hoveredCell;
  if (cell) {
    const { map } = scene;
    const terrain = map.getTerrain(cell.col, cell.row);
    const elev    = map.getElevation(cell.col, cell.row);
    const hasRoad = map.hasRoads(cell.col, cell.row);
    const desc    = terrainDescriptors.find(d => d.index === terrain);
    const label   = (l: number) => DENSITY_LABELS[map.getFeatureLevel(cell.col, cell.row, l)] ?? '—';

    inspSwatch.style.background   = `#${(desc?.color ?? 0).toString(16).padStart(6, '0')}`;
    inspPos.textContent           = `${cell.col}, ${cell.row}`;
    inspTerrain.textContent       = scene.terrainLookup.get(terrain)?.name ?? String(terrain);
    inspElev.textContent          = String(elev);
    inspRiver.textContent         = riverLabel(cell.col, cell.row);
    inspRoad.textContent          = hasRoad ? 'yes' : 'no';
    inspScatterTrees.textContent     = label(0);
    inspScatterBroadleaf.textContent = label(2);
    inspScatterBushes.textContent    = label(3);
    inspScatterRocks.textContent     = label(1);
    inspRoadCost.textContent      = `${(desc?.roadCost ?? 1).toFixed(1)}×`;

    statusPos.textContent  = `${cell.col}, ${cell.row}`;
    statusElev.textContent = `elev ${elev}`;
  } else {
    inspSwatch.style.background = '';
    inspPos.textContent = inspTerrain.textContent = inspElev.textContent =
      inspRiver.textContent = inspRoad.textContent = inspRoadCost.textContent =
      inspScatterTrees.textContent = inspScatterRocks.textContent =
      inspScatterBroadleaf.textContent = inspScatterBushes.textContent = '—';
    statusPos.textContent = statusElev.textContent = '—';
  }

  minimap.update(now);

  statusTool.textContent = statusToolText();
  const showSwatch = activeTool === 'paint-terrain';
  statusSwatch.classList.toggle('hidden', !showSwatch);
  if (showSwatch) {
    const paint = terrainDescriptors.find(d => d.index === paintTerrainType);
    statusSwatch.style.background = `#${(paint?.color ?? 0).toString(16).padStart(6, '0')}`;
  }

  // Zoom and fps drift constantly — writing them a few times a second keeps
  // the strip readable instead of a blur of changing digits.
  if (now - lastPerfWrite > 250) {
    lastPerfWrite = now;
    statusZoom.textContent = `${scene.zoom.toFixed(1)}×`;
    statusFps.textContent  = `${Math.round(scene.fps)} fps`;
    // While a cycle runs, the clock is the scene's and not the slider's — the
    // control follows the sim rather than driving it.
    if (todAnimate.checked) {
      const minutes = scene.timeOfDay * 1440;
      todSlider.value      = String(Math.round(minutes / 5) * 5);
      todValue.textContent = formatClock(minutes);
    }
    // Same for the year. The enable check matters because a disabled checkbox
    // keeps its state: with seasons switched off nothing is advancing, and the
    // slider would otherwise be dragged to whatever phase the cycle last held.
    if (seasonsEnableEl.checked && seasonAnimateEl.checked) {
      seasonPhaseEl.value        = String(Math.round(scene.seasonPhase * 100));
      seasonPhaseVal.textContent = scene.seasonLabel;
    }
  }

  requestAnimationFrame(updateReadouts);
}
requestAnimationFrame(updateReadouts);

// ---- Save / Load ----
saveBtn.addEventListener('click', () => {
  const seed = parseInt(seedInput.value, 10) >>> 0;
  const json = serializeMapJSON(scene.map, { generatorId: activePlugin.id, seed }, SCATTER_DESCRIPTORS, terrainDescriptors, liquidDescriptors);
  const url  = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `${documentName}.hexmap.json`;
  a.click();
  URL.revokeObjectURL(url);
  markSaved();
});

loadBtn.addEventListener('click', () => loadInput.click());

loadInput.addEventListener('change', async () => {
  const file = loadInput.files?.[0];
  if (!file) return;
  loadInput.value = '';
  try {
    let loaded: HexMap;
    if (file.name.endsWith('.json')) {
      const result = deserializeMapJSON(await file.text());
      loaded = result.map;
      if (result.metadata.seed !== undefined) seedInput.value = String(result.metadata.seed);
      if (result.metadata.generatorId) {
        const plugin = PLUGINS.find(p => p.id === result.metadata.generatorId);
        if (plugin) {
          activePlugin    = plugin;
          genSelect.value = plugin.id;
          activeConfig    = structuredClone(plugin.defaultConfig) as ConfigObj;
          refreshConfigFields();
        }
      }
      // Restore terrain types from the save file. Image-backed textures fall back
      // to procedural since pixel data is not embedded in JSON (use HexPack for that).
      terrainDescriptors = result.terrainDescriptors.length > 0
        ? result.terrainDescriptors
        : [...EDITOR_DEFAULT_TERRAINS];
      terrainAssetBlobs.clear();
      terrainAssetRegistry.clear();
      await scene.rebuildTerrainFromDescriptors(terrainDescriptors, terrainAssetRegistry);
      liquidDescriptors = result.liquidDescriptors.length > 0
        ? result.liquidDescriptors
        : structuredClone(DEFAULT_LIQUID_DESCRIPTORS);
      scene.setLiquidDescriptors(liquidDescriptors);
      renderTerrainPalette();
      refreshLiquidOptions();
    } else {
      loaded = deserializeMap(new Uint8Array(await file.arrayBuffer()));
    }
    scene.replaceMap(loaded);
    history.clear();
    markFresh(file.name.replace(/\.(hxmp|hexmap\.json|json)$/i, ''));
  } catch (err) {
    alert(`Failed to load map: ${err instanceof Error ? err.message : String(err)}`);
  }
});

// ---- Export / Import HexPack ----
exportPackBtn.addEventListener('click', async () => {
  const seed = parseInt(seedInput.value, 10) >>> 0;
  const blob = await exportHexPack({
    name:               'Map Pack',
    terrainDescriptors,
    liquidDescriptors,
    scatterDescriptors: SCATTER_DESCRIPTORS,
    textureAssets:      terrainAssetBlobs,
    maps: [{
      id:       'map-1',
      name:     'My Map',
      map:      scene.map,
      metadata: { generatorId: activePlugin.id, seed },
      format:   'json',
    }],
  });
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href     = url;
  a.download = `${documentName}.hexpack`;
  a.click();
  URL.revokeObjectURL(url);
  markSaved();
});

openPackBtn.addEventListener('click', () => openPackInput.click());
openPackInput.addEventListener('change', async () => {
  const file = openPackInput.files?.[0];
  if (!file) return;
  openPackInput.value = '';
  try {
    const { terrainDescriptors: pkgDescs, liquidDescriptors: pkgLiquids, maps } = await scene.loadAndApplyHexPack(file);
    terrainDescriptors = pkgDescs;
    liquidDescriptors  = pkgLiquids.length > 0 ? pkgLiquids : structuredClone(DEFAULT_LIQUID_DESCRIPTORS);
    terrainAssetBlobs.clear();
    terrainAssetRegistry.clear();
    renderTerrainPalette();
    refreshLiquidOptions();
    if (maps.size > 0) {
      scene.replaceMap([...maps.values()][0]);
      history.clear();
      markFresh(file.name.replace(/\.hexpack$/i, ''));
    }
  } catch (err) {
    alert(`Failed to load pack: ${err instanceof Error ? err.message : String(err)}`);
  }
});

// ---- Right click ----

/**
 * Text fields where the browser's own menu is worth keeping — cut, paste and
 * spellcheck are things it does that we don't reimplement. Everything else
 * (sliders, swatches, checkboxes, the chrome, the map) has no use for it.
 */
function isTextEntry(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  if (el.isContentEditable || el instanceof HTMLTextAreaElement) return true;
  return el instanceof HTMLInputElement && (el.type === 'text' || el.type === 'number');
}

// The editor handles its own right button — camera rotate on the map, edit-type
// on a terrain swatch — so the browser menu only ever lands on top of a gesture
// already in progress. The library suppresses it on the canvas it owns; this
// covers the panels and chrome around it.
document.addEventListener('contextmenu', e => {
  if (!isTextEntry(e.target)) e.preventDefault();
});

// ---- Keyboard shortcuts ----
const TOOL_HOTKEYS: Record<string, ToolId> = {
  '1': 'paint-terrain',
  '2': 'elevation',
  '3': 'paint-river',
  '4': 'paint-road',
  '5': 'paint-scatter',
  '6': 'environment',
  '7': 'paint-territory',
  '8': 'paint-resource',
  '9': 'paint-fog',
};

window.addEventListener('keyup', (e) => {
  if (e.key === 'Alt') viewport.classList.remove('is-eyedropping');
  if (e.key === 'Control') { contourSnapHeld = false; contourLevel = null; }
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Alt' && (activeTool === 'paint-terrain' || activeTool === 'elevation' || activeTool === 'paint-scatter')) viewport.classList.add('is-eyedropping');
  if (e.key === 'Control') contourSnapHeld = true;
  // Don't fire shortcuts while the user is typing in an input/select
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;

  if (e.key === 'Escape') {
    if (riverWaypointActive) {
      cancelWaypointRiver();
    } else if (isPointerDown && (activeTool === 'paint-road' ||
        (activeTool === 'paint-river' && (riverMode === 'path' || riverMode === 'straight')) ||
        (activeTool === 'elevation' && elevMode === 'slope'))) {
      scene.setPathPreview(null);
      pathStart     = null;
      currentPath   = null;
      isPointerDown = false;
    }
  } else if (e.key === 'Enter') {
    if (activeTool === 'paint-river' && riverMode === 'waypoint') commitWaypointRiver();
  } else if (!e.ctrlKey && !e.metaKey && !e.altKey && TOOL_HOTKEYS[e.key]) {
    document.querySelector<HTMLButtonElement>(`.tool-btn[data-tool="${TOOL_HOTKEYS[e.key]}"]`)?.click();
  } else if (e.key === 'z' && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
    e.preventDefault();
    history.undo();
  } else if (
    (e.key === 'y' && (e.ctrlKey || e.metaKey)) ||
    (e.key === 'z' && (e.ctrlKey || e.metaKey) && e.shiftKey)
  ) {
    e.preventDefault();
    history.redo();
  } else if (e.key === 'n' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    newMapDialog.showModal();
  } else if (e.key === 'o' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    loadInput.click();
  } else if (e.key === 's' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    saveBtn.click();
  }
});

// ---- Create Map ----
createMapBtn.addEventListener('click', async () => {
  if (activePlugin.id === 'heightmap' && !(activeConfig as { image: unknown }).image) {
    alert('Please choose a heightmap image first.');
    return;
  }

  const width  = Math.max(10, parseInt(mapWidthInput.value,  10) || 100);
  const height = Math.max(10, parseInt(mapHeightInput.value, 10) || 100);
  const seed   = parseInt(seedInput.value, 10) >>> 0;

  createMapBtn.disabled    = true;
  createMapBtn.textContent = 'Generating…';

  await new Promise<void>(r => setTimeout(r, 0));

  const newMap = new HexMap({ width, height, featureLayerCount: FEATURE_LAYERS });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  activePlugin.generate(newMap, activeConfig as any, seed);
  scene.replaceMap(newMap);
  history.clear();
  markFresh('untitled');

  createMapBtn.disabled    = false;
  createMapBtn.textContent = 'Create Map';
  newMapDialog.close();
});

// ---- First paint of the chrome ----
updateLeftPanel();
refreshDocStrip();
