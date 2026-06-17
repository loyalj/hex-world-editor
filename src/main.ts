import {
  FbmPlugin, ChunkPlugin, HexMap, deserializeMap, serializeMapJSON, deserializeMapJSON,
  DEFAULT_TERRAIN_DESCRIPTORS, DEFAULT_LIQUID_DESCRIPTORS,
  hexToOffset, offsetToHex, findPath, offsetNeighbor, POINTY_TOP, hexRange,
  exportHexPack,
} from '@loyalj/hex-world';
import { HeightmapPlugin } from './heightmapPlugin.ts';
import type { HexCoord, TerrainDescriptor, TerrainAssetRegistry, ScatterDescriptor } from '@loyalj/hex-world';
import { initScene } from './scene.ts';
import { CommandHistory } from './history.ts';
import { renderConfigFields } from './configUI.ts';
import { PaintTerrainStrokeCommand, ElevationStrokeCommand, RiverPaintStrokeCommand, RoadPaintStrokeCommand, ScatterPaintStrokeCommand } from './commands.ts';
import type { ConfigObj } from './configUI.ts';

// ---- Generator registry ----
const PLUGINS = [FbmPlugin, ChunkPlugin, HeightmapPlugin];
let activePlugin = PLUGINS[0];
let activeConfig: ConfigObj = structuredClone(activePlugin.defaultConfig) as ConfigObj;

const SCATTER_DESCRIPTORS: ScatterDescriptor[] = [
  {
    id: 'pine', name: 'Pine Trees', layerIndex: 0,
    tiers: [
      [{ assetId: 'pine-sparse',  yOffset: 0.5  }],
      [{ assetId: 'pine-medium',  yOffset: 0.75 }],
      [{ assetId: 'pine-dense',   yOffset: 1.0  }],
    ],
  },
  {
    id: 'rock', name: 'Rocks', layerIndex: 1,
    tiers: [
      [{ assetId: 'rock-small',  yOffset: 0.20 }],
      [{ assetId: 'rock-medium', yOffset: 0.30 }],
      [{ assetId: 'rock-large',  yOffset: 0.45 }],
    ],
  },
];

// ---- DOM refs ----
const mapMenuBtn     = document.getElementById('map-menu-btn')     as HTMLButtonElement;
const mapMenuPanel   = document.getElementById('map-menu-panel')   as HTMLDivElement;
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
const scatterTypeBtns = document.querySelectorAll<HTMLButtonElement>('.scatter-type-btn');
const densityBtns    = document.querySelectorAll<HTMLButtonElement>('.density-btn');
const terrainOptions = document.getElementById('terrain-options')  as HTMLElement;
const elevOptions    = document.getElementById('elevation-options') as HTMLElement;
const scatterOptions = document.getElementById('scatter-options')  as HTMLElement;
const riverOptions   = document.getElementById('river-options')    as HTMLElement;
const roadOptions     = document.getElementById('road-options')      as HTMLElement;
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

function updateLeftPanel(): void {
  const showTerrain   = activeTool === 'paint-terrain';
  const showElevation = activeTool === 'elevation';
  const showScatter   = activeTool === 'paint-scatter';
  const showRiver     = activeTool === 'paint-river';
  const showRoad      = activeTool === 'paint-road';
  terrainOptions.classList.toggle('hidden', !showTerrain);
  elevOptions.classList.toggle('hidden', !showElevation);
  scatterOptions.classList.toggle('hidden', !showScatter);
  riverOptions.classList.toggle('hidden', !showRiver);
  roadOptions.classList.toggle('hidden', !showRoad);
  leftPanel.classList.toggle('hidden', !showTerrain && !showElevation && !showScatter && !showRiver && !showRoad);
}

const inspPos     = document.getElementById('insp-pos')     as HTMLElement;
const inspTerrain = document.getElementById('insp-terrain') as HTMLElement;
const inspElev    = document.getElementById('insp-elev')    as HTMLElement;
const inspRiver   = document.getElementById('insp-river')   as HTMLElement;
const inspRoad    = document.getElementById('insp-road')    as HTMLElement;
const inspScatterTrees = document.getElementById('insp-scatter-trees') as HTMLElement;
const inspScatterRocks = document.getElementById('insp-scatter-rocks') as HTMLElement;

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
});

// ---- Seed ----
const initialSeed = Math.floor(Math.random() * 0xffffffff);
seedInput.value = String(initialSeed);
newSeedBtn.addEventListener('click', () => {
  seedInput.value = String(Math.floor(Math.random() * 0xffffffff));
});

// ---- Scene init ----
const scene   = await initScene(viewport);
const history = new CommandHistory();

// ---- Terrain descriptor state ----
let terrainDescriptors: TerrainDescriptor[] = [...DEFAULT_TERRAIN_DESCRIPTORS];
const terrainAssetBlobs    = new Map<string, Blob>();
const terrainAssetRegistry: TerrainAssetRegistry = new Map();
let pendingTerrainImage: File | null = null;
let editingTerrainIndex: number | null = null;

history.onChange = () => {
  undoBtn.disabled = !history.canUndo;
  redoBtn.disabled = !history.canRedo;
};
undoBtn.addEventListener('click', () => history.undo());
redoBtn.addEventListener('click', () => history.redo());

// eslint-disable-next-line @typescript-eslint/no-explicit-any
activePlugin.generate(scene.map, activePlugin.defaultConfig as any, initialSeed);
scene.reload();
refreshConfigFields();

// ---- Tool state ----
type ToolId    = 'paint-terrain' | 'elevation' | 'paint-river' | 'paint-road' | 'paint-scatter';
type RoadMode  = 'path' | 'straight';
let activeTool        : ToolId   = 'paint-terrain';
let paintTerrainType  : number   = 0;       // Grassland
let paintScatterLevel : number   = 1;       // Sparse
let paintScatterLayer : number   = 0;       // Trees
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

function activeBrushRadius(): number {
  if (activeTool === 'paint-terrain') return terrainBrushRadius;
  if (activeTool === 'elevation')     return elevBrushRadius;
  if (activeTool === 'paint-scatter') return scatterBrushRadius;
  return 0;
}

function updateViewportCursor(): void {
  viewport.classList.toggle('is-filling', activeTool === 'paint-terrain' && terrainMode === 'fill');
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

function openTerrainDialog(editIndex: number | null): void {
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
    addTerrainLiquid.value = '';
    addTerrainImgSt.textContent = 'No image';
    pendingTerrainImage = null;
  }
  addTerrainDialog.showModal();
}

function renderTerrainPalette(): void {
  const group = document.getElementById('terrain-type-group')!;
  group.innerHTML = '';
  for (const desc of terrainDescriptors) {
    const btn = document.createElement('button');
    btn.className = 'terrain-btn';
    if (desc.index === paintTerrainType) btn.classList.add('active');
    btn.dataset['terrain'] = String(desc.index);
    btn.style.background = `#${desc.color.toString(16).padStart(6, '0')}`;
    btn.innerHTML = `<span class="terrain-name">${desc.name}</span>`;
    const lockEl = document.createElement('span');
    lockEl.className = 'terrain-lock-icon';
    lockEl.title = 'Lock/unlock — locked terrain cannot be painted over';
    lockEl.textContent = '🔒';
    lockEl.addEventListener('click', e => {
      e.stopPropagation();
      if (lockedTerrains.has(desc.index)) {
        lockedTerrains.delete(desc.index);
        btn.classList.remove('terrain-btn--locked');
      } else {
        lockedTerrains.add(desc.index);
        btn.classList.add('terrain-btn--locked');
      }
    });
    btn.appendChild(lockEl);
    if (lockedTerrains.has(desc.index)) btn.classList.add('terrain-btn--locked');
    const isCustom = !DEFAULT_TERRAIN_IDS.has(desc.id);
    if (isCustom) {
      btn.classList.add('terrain-btn--custom');
      btn.title = `${desc.name} (right-click to edit)`;
      btn.addEventListener('contextmenu', e => { e.preventDefault(); openTerrainDialog(desc.index); });
    } else {
      btn.title = desc.name;
    }
    btn.addEventListener('click', () => {
      paintTerrainType = desc.index;
      group.querySelectorAll('.terrain-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
    group.appendChild(btn);
  }
  const addBtn = document.createElement('button');
  addBtn.className = 'terrain-btn add-terrain-btn';
  addBtn.title = 'Add terrain type';
  addBtn.textContent = '+';
  addBtn.addEventListener('click', () => openTerrainDialog(null));
  group.appendChild(addBtn);
}
renderTerrainPalette();

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

mapMenuBtn.addEventListener('click', e => {
  e.stopPropagation();
  mapMenuPanel.classList.toggle('hidden');
});
document.addEventListener('click', () => mapMenuPanel.classList.add('hidden'));

newMapBtn.addEventListener('click', () => newMapDialog.showModal());
dialogCloseBtn.addEventListener('click', () => newMapDialog.close());
newMapDialog.addEventListener('click', e => { if (e.target === newMapDialog) newMapDialog.close(); });

// ---- Stroke state ----
type PaintEdit     = { col: number; row: number; prevTerrain: number; nextTerrain: number; prevElev: number | null; nextElev: number | null };
type ElevEdit      = { col: number; row: number; prev: number; next: number };
type RiverPaintEdit = { col: number; row: number; prevIncoming: number; prevOutgoing: number; nextIncoming: number; nextOutgoing: number };
type RoadEdit      = { col: number; row: number; edge: number; nCol: number; nRow: number; nEdge: number; prevSet: boolean; prevNSet: boolean };

let isPointerDown  = false;
let strokePaint    : PaintEdit[] = [];
let strokeElev     : ElevEdit[]  = [];
type ScatterEdit   = { col: number; row: number; layer: number; prev: number; next: number };
let strokeScatter  : ScatterEdit[] = [];
let strokeVisited  = new Set<number>();

// Path-tool preview state (shared by paint-road and paint-river)
let pathStart   : { col: number; row: number } | null = null;
let currentPath : HexCoord[] | null = null;
let pathErasing = false;
let strokeRiverErase        : RiverPaintEdit[] = [];
let strokeRiverEraseVisited = new Set<number>();

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
        if (scene.isWater(scene.map.getTerrain(toOff.col, toOff.row))) return Infinity;

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
  currentPath = path;
  scene.setPathPreview(path ?? [startHex], pathErasing);
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
      let nextElev: number | null = null;
      if (!scene.isWater(paintTerrainType) && scene.isWater(prevTerrain) && prevElev < 0) {
        nextElev = 0;
      }
      map.setTerrain(col, row, paintTerrainType);
      if (nextElev !== null) map.setElevation(col, row, nextElev);
      chunks.markDirty(col, row);
      strokePaint.push({ col, row, prevTerrain, nextTerrain: paintTerrainType, prevElev: nextElev !== null ? prevElev : null, nextElev });
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
      map.setElevation(col, row, next);
      chunks.markDirty(col, row);
      strokeElev.push({ col, row, prev, next });
      break;
    }
    case 'paint-scatter': {
      const layer = paintScatterLayer;
      const prev  = map.getFeatureLevel(col, row, layer);
      if (prev === paintScatterLevel) return;
      map.setFeatureLevel(col, row, layer, paintScatterLevel);
      chunks.markDirty(col, row);
      strokeScatter.push({ col, row, layer, prev, next: paintScatterLevel });
      break;
    }
  }
}

function floodFill(startCol: number, startRow: number): void {
  const { map, chunks } = scene;
  const sourceTerrain = map.getTerrain(startCol, startRow);
  if (sourceTerrain === paintTerrainType) return;
  if (lockedTerrains.has(sourceTerrain)) return;

  const edits: PaintEdit[] = [];
  const visited = new Set<number>();
  let head = 0;
  const queue: Array<{ col: number; row: number }> = [{ col: startCol, row: startRow }];
  visited.add(cellKey(startCol, startRow));

  while (head < queue.length) {
    const { col, row } = queue[head++];
    const prevElev = map.getElevation(col, row);
    let nextElev: number | null = null;
    if (!scene.isWater(paintTerrainType) && scene.isWater(sourceTerrain) && prevElev < 0) {
      nextElev = 0;
    }
    map.setTerrain(col, row, paintTerrainType);
    if (nextElev !== null) map.setElevation(col, row, nextElev);
    chunks.markDirty(col, row);
    edits.push({ col, row, prevTerrain: sourceTerrain, nextTerrain: paintTerrainType, prevElev: nextElev !== null ? prevElev : null, nextElev });

    for (let dir = 0; dir < 6; dir++) {
      const nb = offsetNeighbor(col, row, EDGE_DIRS[dir]);
      if (nb.col < 0 || nb.col >= map.width || nb.row < 0 || nb.row >= map.height) continue;
      const key = cellKey(nb.col, nb.row);
      if (visited.has(key)) continue;
      visited.add(key);
      if (map.getTerrain(nb.col, nb.row) === sourceTerrain) queue.push({ col: nb.col, row: nb.row });
    }
  }

  if (edits.length > 0) history.commit(new PaintTerrainStrokeCommand(scene.map, scene.chunks, edits));
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

  const edits: ElevEdit[] = [];
  for (const { col, row } of cells) {
    const p = prevMap.get(cellKey(col, row))!;
    const n = working.get(cellKey(col, row))!;
    if (p === n) continue;
    map.setElevation(col, row, n);
    chunks.markDirty(col, row);
    edits.push({ col, row, prev: p, next: n });
  }
  if (edits.length > 0) history.commit(new ElevationStrokeCommand(scene.map, scene.chunks, edits));
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
  return result;
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
  const edits: RiverPaintEdit[] = [];
  for (let i = 0; i < path.length; i++) {
    const off = hexToOffset(path[i]);
    if (off.col < 0 || off.col >= map.width || off.row < 0 || off.row >= map.height) continue;
    const prevIncoming = map.getIncomingRiverDir(off.col, off.row);
    const prevOutgoing = map.getOutgoingRiverDir(off.col, off.row);
    let nextIncoming = -1, nextOutgoing = -1;
    if (!erasing) {
      if (i > 0) {
        const prev = hexToOffset(path[i - 1]);
        const edge = edgeBetween(prev.col, prev.row, off.col, off.row);
        if (edge !== null) nextIncoming = (edge + 3) % 6;
      }
      if (i < path.length - 1) {
        const next = hexToOffset(path[i + 1]);
        const edge = edgeBetween(off.col, off.row, next.col, next.row);
        if (edge !== null) nextOutgoing = edge;
      }
    }
    edits.push({ col: off.col, row: off.row, prevIncoming, prevOutgoing, nextIncoming, nextOutgoing });
  }
  for (const e of edits) {
    map.clearRiver(e.col, e.row);
    if (e.nextIncoming >= 0) map.setRiverIncoming(e.col, e.row, e.nextIncoming);
    if (e.nextOutgoing >= 0) map.setRiverOutgoing(e.col, e.row, e.nextOutgoing);
    chunks.markDirty(e.col, e.row);
  }
  if (edits.length > 0) history.commit(new RiverPaintStrokeCommand(map, chunks, edits));
}

function eraseRiverAt(col: number, row: number): void {
  const key = cellKey(col, row);
  if (strokeRiverEraseVisited.has(key)) return;
  strokeRiverEraseVisited.add(key);
  if (!scene.map.hasRiver(col, row)) return;
  const prevIncoming = scene.map.getIncomingRiverDir(col, row);
  const prevOutgoing = scene.map.getOutgoingRiverDir(col, row);
  scene.map.clearRiver(col, row);
  scene.chunks.markDirty(col, row);
  strokeRiverErase.push({ col, row, prevIncoming, prevOutgoing, nextIncoming: -1, nextOutgoing: -1 });
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
      const edits: RoadEdit[] = [];
      for (let i = 0; i < currentPath.length - 1; i++) {
        const a    = hexToOffset(currentPath[i]);
        const b    = hexToOffset(currentPath[i + 1]);
        const edge = edgeBetween(a.col, a.row, b.col, b.row);
        if (edge === null) continue;
        const nEdge    = (edge + 3) % 6;
        const prevSet  = scene.map.hasRoadThroughEdge(a.col, a.row, edge);
        const prevNSet = scene.map.hasRoadThroughEdge(b.col, b.row, nEdge);
        scene.map.setRoad(a.col, a.row, edge, placing);
        scene.map.setRoad(b.col, b.row, nEdge, placing);
        scene.chunks.markDirty(a.col, a.row);
        scene.chunks.markDirty(b.col, b.row);
        edits.push({ col: a.col, row: a.row, edge, nCol: b.col, nRow: b.row, nEdge, prevSet, prevNSet });
      }
      if (edits.length > 0) history.commit(new RoadPaintStrokeCommand(scene.map, scene.chunks, edits, placing));
    }
    scene.setPathPreview(null);
    pathStart   = null;
    currentPath = null;
    return;
  }

  if (activeTool === 'paint-river') {
    if (riverMode === 'erase') {
      if (strokeRiverErase.length > 0) history.commit(new RiverPaintStrokeCommand(scene.map, scene.chunks, strokeRiverErase));
      strokeRiverErase        = [];
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
      const edits: ElevEdit[] = [];
      for (let i = 0; i <= n; i++) {
        const off = hexToOffset(currentPath[i]);
        if (off.col < 0 || off.col >= scene.map.width || off.row < 0 || off.row >= scene.map.height) continue;
        const prev = scene.map.getElevation(off.col, off.row);
        const next = Math.max(elevRangeMin, Math.min(elevRangeMax,
          Math.round(startElev + (endElev - startElev) * (i / n))));
        if (prev === next) continue;
        scene.map.setElevation(off.col, off.row, next);
        scene.chunks.markDirty(off.col, off.row);
        edits.push({ col: off.col, row: off.row, prev, next });
      }
      if (edits.length > 0) history.commit(new ElevationStrokeCommand(scene.map, scene.chunks, edits));
    }
    scene.setPathPreview(null);
    pathStart    = null;
    currentPath  = null;
    contourLevel = null;
    return;
  }

  if (strokePaint.length > 0) {
    history.commit(new PaintTerrainStrokeCommand(scene.map, scene.chunks, strokePaint));
  } else if (strokeElev.length > 0) {
    history.commit(new ElevationStrokeCommand(scene.map, scene.chunks, strokeElev));
  } else if (strokeScatter.length > 0) {
    history.commit(new ScatterPaintStrokeCommand(scene.map, scene.chunks, strokeScatter));
  }

  strokePaint   = [];
  strokeElev    = [];
  strokeScatter = [];
  strokeVisited = new Set();
  contourLevel  = null;
}

viewport.addEventListener('pointerdown', e => {
  if (e.button !== 0) return;
  const cell = scene.hoveredCell;
  if (!cell) return;

  // Eyedropper: Alt+click samples terrain without painting
  if (e.altKey && activeTool === 'paint-terrain') {
    e.preventDefault();
    const sampled = scene.map.getTerrain(cell.col, cell.row);
    paintTerrainType = sampled;
    document.querySelectorAll<HTMLElement>('.terrain-btn').forEach(b => {
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
    strokeRiverErase        = [];
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
  strokePaint   = [];
  strokeElev    = [];
  strokeScatter = [];
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

function updateInspector(): void {
  const cell = scene.hoveredCell;
  if (cell) {
    const { map } = scene;
    const terrain = map.getTerrain(cell.col, cell.row);
    const elev    = map.getElevation(cell.col, cell.row);
    const hasRoad = map.hasRoads(cell.col, cell.row);

    const DENSITY_LABELS = ['none', 'sparse', 'medium', 'dense'];
    const label = (l: number) => DENSITY_LABELS[map.getFeatureLevel(cell.col, cell.row, l)] ?? '—';

    inspPos.textContent          = `${cell.col}, ${cell.row}`;
    inspTerrain.textContent      = scene.terrainLookup.get(terrain)?.name ?? String(terrain);
    inspElev.textContent         = String(elev);
    inspRiver.textContent        = riverLabel(cell.col, cell.row);
    inspRoad.textContent         = hasRoad ? 'yes' : 'no';
    inspScatterTrees.textContent = label(0);
    inspScatterRocks.textContent = label(1);
  } else {
    inspPos.textContent = inspTerrain.textContent = inspElev.textContent =
      inspRiver.textContent = inspRoad.textContent =
      inspScatterTrees.textContent = inspScatterRocks.textContent = '—';
  }
  requestAnimationFrame(updateInspector);
}
updateInspector();

// ---- Save / Load ----
saveBtn.addEventListener('click', () => {
  const seed = parseInt(seedInput.value, 10) >>> 0;
  const json = serializeMapJSON(scene.map, { generatorId: activePlugin.id, seed }, SCATTER_DESCRIPTORS, terrainDescriptors, DEFAULT_LIQUID_DESCRIPTORS);
  const url  = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  const a    = document.createElement('a');
  a.href     = url;
  a.download = 'map.hexmap.json';
  a.click();
  URL.revokeObjectURL(url);
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
        : [...DEFAULT_TERRAIN_DESCRIPTORS];
      terrainAssetBlobs.clear();
      terrainAssetRegistry.clear();
      await scene.rebuildTerrainFromDescriptors(terrainDescriptors, terrainAssetRegistry);
      renderTerrainPalette();
    } else {
      loaded = deserializeMap(new Uint8Array(await file.arrayBuffer()));
    }
    scene.replaceMap(loaded);
    history.clear();
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
    liquidDescriptors:  DEFAULT_LIQUID_DESCRIPTORS,
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
  a.download = 'map.hexpack';
  a.click();
  URL.revokeObjectURL(url);
});

openPackBtn.addEventListener('click', () => openPackInput.click());
openPackInput.addEventListener('change', async () => {
  const file = openPackInput.files?.[0];
  if (!file) return;
  openPackInput.value = '';
  try {
    const { terrainDescriptors: pkgDescs, maps } = await scene.loadAndApplyHexPack(file);
    terrainDescriptors = pkgDescs;
    terrainAssetBlobs.clear();
    terrainAssetRegistry.clear();
    renderTerrainPalette();
    if (maps.size > 0) {
      scene.replaceMap([...maps.values()][0]);
      history.clear();
    }
  } catch (err) {
    alert(`Failed to load pack: ${err instanceof Error ? err.message : String(err)}`);
  }
});

// ---- Keyboard shortcuts ----
const TOOL_HOTKEYS: Record<string, ToolId> = {
  '1': 'paint-terrain',
  '2': 'elevation',
  '3': 'paint-river',
  '4': 'paint-road',
  '5': 'paint-scatter',
};

window.addEventListener('keyup', (e) => {
  if (e.key === 'Alt') viewport.classList.remove('is-eyedropping');
  if (e.key === 'Control') { contourSnapHeld = false; contourLevel = null; }
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Alt' && (activeTool === 'paint-terrain' || activeTool === 'elevation')) viewport.classList.add('is-eyedropping');
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

  const newMap = new HexMap({ width, height, featureLayerCount: 2 });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  activePlugin.generate(newMap, activeConfig as any, seed);
  scene.replaceMap(newMap);
  history.clear();

  createMapBtn.disabled    = false;
  createMapBtn.textContent = 'Create Map';
  newMapDialog.close();
});
