import { FbmPlugin, ChunkPlugin, HexMap, deserializeMap, serializeMapJSON, deserializeMapJSON, DEFAULT_TERRAIN_DESCRIPTORS, DEFAULT_WATER_TERRAIN_INDEX, DEFAULT_TERRAIN_LOOKUP, hexToOffset, offsetToHex, findPath, offsetNeighbor, POINTY_TOP, hexRange } from '@loyalj/hex-world';
import { HeightmapPlugin } from './heightmapPlugin.ts';
import type { HexCoord } from '@loyalj/hex-world';
import { initScene } from './scene.ts';
import { CommandHistory } from './history.ts';
import { renderConfigFields } from './configUI.ts';
import { PaintTerrainStrokeCommand, ElevationStrokeCommand, RiverPaintStrokeCommand, RoadPaintStrokeCommand, ScatterPaintStrokeCommand } from './commands.ts';
import type { ConfigObj } from './configUI.ts';

// ---- Terrain names (indexed by TerrainType value) ----
const TERRAIN_NAMES = ['Grassland', 'Desert', 'Snow', 'Mud', 'Rock', 'Water'];

// ---- Generator registry ----
const PLUGINS = [FbmPlugin, ChunkPlugin, HeightmapPlugin];
let activePlugin = PLUGINS[0];
let activeConfig: ConfigObj = structuredClone(activePlugin.defaultConfig) as ConfigObj;

// ---- DOM refs ----
const mapMenuBtn     = document.getElementById('map-menu-btn')     as HTMLButtonElement;
const mapMenuPanel   = document.getElementById('map-menu-panel')   as HTMLDivElement;
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
const terrainBtns    = document.querySelectorAll<HTMLButtonElement>('.terrain-btn');
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
const leftPanel      = document.getElementById('left-panel')       as HTMLElement;

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
const inspScatter = document.getElementById('insp-scatter') as HTMLElement;

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
let elevStep          : number   = 1;
let roadMode          : RoadMode = 'path';
let riverMode         : RoadMode = 'path';

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

toolButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    if (activeTool === 'paint-road' || activeTool === 'paint-river') {
      scene.setPathPreview(null);
      pathStart     = null;
      currentPath   = null;
      isPointerDown = false;
    }
    activeTool = btn.dataset['tool'] as ToolId;
    toolButtons.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    scene.brushRadius = activeBrushRadius();
    updateLeftPanel();
  });
});

terrainBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    paintTerrainType = parseInt(btn.dataset['terrain']!, 10);
    terrainBtns.forEach(b => b.classList.remove('active'));
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

const elevStepBtns = document.querySelectorAll<HTMLButtonElement>('#elev-step-group .brush-btn');
elevStepBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    elevStep = parseInt(btn.dataset['step']!, 10);
    elevStepBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  });
});

const riverModeBtns = document.querySelectorAll<HTMLButtonElement>('#river-mode-group .brush-btn');
riverModeBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    riverMode = btn.dataset['riverMode'] as RoadMode;
    riverModeBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
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

const WATER_TERRAIN = DEFAULT_WATER_TERRAIN_INDEX;

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
        if (scene.map.getTerrain(toOff.col, toOff.row) === WATER_TERRAIN) return Infinity;

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
          const def = DEFAULT_TERRAIN_LOOKUP.get(scene.map.getTerrain(toOff.col, toOff.row));
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
      const prevElev = map.getElevation(col, row);
      let nextElev: number | null = null;
      if (paintTerrainType !== WATER_TERRAIN && prevTerrain === WATER_TERRAIN && prevElev < 0) {
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
      const next = Math.max(-128, Math.min(127, prev + elevStep));
      if (next === prev) return;
      map.setElevation(col, row, next);
      chunks.markDirty(col, row);
      strokeElev.push({ col, row, prev, next });
      break;
    }
    case 'paint-scatter': {
      const layer = 0;
      const prev  = map.getFeatureLevel(col, row, layer);
      if (prev === paintScatterLevel) return;
      map.setFeatureLevel(col, row, layer, paintScatterLevel);
      chunks.markDirty(col, row);
      strokeScatter.push({ col, row, layer, prev, next: paintScatterLevel });
      break;
    }
  }
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
    if (currentPath && currentPath.length >= 2) {
      const edits: RiverPaintEdit[] = [];
      for (let i = 0; i < currentPath.length; i++) {
        const off = hexToOffset(currentPath[i]);
        const prevIncoming = scene.map.getIncomingRiverDir(off.col, off.row);
        const prevOutgoing = scene.map.getOutgoingRiverDir(off.col, off.row);
        let nextIncoming = -1;
        let nextOutgoing = -1;
        if (!pathErasing) {
          if (i > 0) {
            const prev = hexToOffset(currentPath[i - 1]);
            const edge = edgeBetween(prev.col, prev.row, off.col, off.row);
            if (edge !== null) nextIncoming = (edge + 3) % 6;
          }
          if (i < currentPath.length - 1) {
            const next = hexToOffset(currentPath[i + 1]);
            const edge = edgeBetween(off.col, off.row, next.col, next.row);
            if (edge !== null) nextOutgoing = edge;
          }
        }
        edits.push({ col: off.col, row: off.row, prevIncoming, prevOutgoing, nextIncoming, nextOutgoing });
      }
      for (const e of edits) {
        scene.map.clearRiver(e.col, e.row);
        if (e.nextIncoming >= 0) scene.map.setRiverIncoming(e.col, e.row, e.nextIncoming);
        if (e.nextOutgoing >= 0) scene.map.setRiverOutgoing(e.col, e.row, e.nextOutgoing);
        scene.chunks.markDirty(e.col, e.row);
      }
      if (edits.length > 0) history.commit(new RiverPaintStrokeCommand(scene.map, scene.chunks, edits));
    }
    scene.setPathPreview(null);
    pathStart   = null;
    currentPath = null;
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
}

viewport.addEventListener('pointerdown', e => {
  if (e.button !== 0) return;
  const cell = scene.hoveredCell;
  if (!cell) return;
  isPointerDown = true;

  if (activeTool === 'paint-road' || activeTool === 'paint-river') {
    pathErasing = e.shiftKey;
    pathStart   = { col: cell.col, row: cell.row };
    currentPath = null;
    scene.setPathPreview([offsetToHex(cell.col, cell.row)], pathErasing);
    return;
  }

  strokePaint   = [];
  strokeElev    = [];
  strokeScatter = [];
  strokeVisited = new Set();
  applyBrush(cell.col, cell.row);
});

viewport.addEventListener('pointermove', (e) => {
  if (!isPointerDown) return;
  if (activeTool === 'paint-road' || activeTool === 'paint-river') {
    pathErasing = e.shiftKey;
    updatePathPreview();
    return;
  }
  const cell = scene.hoveredCell;
  if (cell) applyBrush(cell.col, cell.row);
});

viewport.addEventListener('pointerup',     endStroke);
viewport.addEventListener('pointercancel', endStroke);

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

    const scatterLevel  = map.getFeatureLevel(cell.col, cell.row, 0);
    const DENSITY_LABELS = ['none', 'sparse', 'medium', 'dense'];

    inspPos.textContent      = `${cell.col}, ${cell.row}`;
    inspTerrain.textContent  = TERRAIN_NAMES[terrain] ?? String(terrain);
    inspElev.textContent     = String(elev);
    inspRiver.textContent    = riverLabel(cell.col, cell.row);
    inspRoad.textContent     = hasRoad ? 'yes' : 'no';
    inspScatter.textContent  = DENSITY_LABELS[scatterLevel] ?? String(scatterLevel);
  } else {
    inspPos.textContent = inspTerrain.textContent = inspElev.textContent =
      inspRiver.textContent = inspRoad.textContent = inspScatter.textContent = '—';
  }
  requestAnimationFrame(updateInspector);
}
updateInspector();

// ---- Save / Load ----
saveBtn.addEventListener('click', () => {
  const seed = parseInt(seedInput.value, 10) >>> 0;
  const json = serializeMapJSON(scene.map, { generatorId: activePlugin.id, seed }, undefined, DEFAULT_TERRAIN_DESCRIPTORS);
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
    } else {
      loaded = deserializeMap(new Uint8Array(await file.arrayBuffer()));
    }
    scene.replaceMap(loaded);
    history.clear();
  } catch (err) {
    alert(`Failed to load map: ${err instanceof Error ? err.message : String(err)}`);
  }
});

// ---- Keyboard shortcuts ----
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (isPointerDown && (activeTool === 'paint-road' || activeTool === 'paint-river')) {
      scene.setPathPreview(null);
      pathStart     = null;
      currentPath   = null;
      isPointerDown = false;
    }
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

  const newMap = new HexMap({ width, height, featureLayerCount: 1 });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  activePlugin.generate(newMap, activeConfig as any, seed);
  scene.replaceMap(newMap);
  history.clear();

  createMapBtn.disabled    = false;
  createMapBtn.textContent = 'Create Map';
  newMapDialog.close();
});
