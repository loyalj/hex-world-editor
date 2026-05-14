import { FbmPlugin, ChunkPlugin, serializeMap, deserializeMap } from 'hex-world';
import { initScene } from './scene.ts';
import { CommandHistory } from './history.ts';
import { renderConfigFields } from './configUI.ts';
import { PaintTerrainStrokeCommand, ElevationStrokeCommand, RiverClearStrokeCommand } from './commands.ts';
import type { ConfigObj } from './configUI.ts';

// ---- Terrain names (indexed by TerrainType value) ----
const TERRAIN_NAMES = ['Grassland', 'Desert', 'Snow', 'Mud', 'Rock', 'Water'];

// ---- Generator registry ----
const PLUGINS = [FbmPlugin, ChunkPlugin];
let activePlugin = PLUGINS[0];
let activeConfig: ConfigObj = structuredClone(activePlugin.defaultConfig) as ConfigObj;

// ---- DOM refs ----
const saveBtn       = document.getElementById('save-btn')         as HTMLButtonElement;
const loadBtn       = document.getElementById('load-btn')         as HTMLButtonElement;
const loadInput     = document.getElementById('load-input')       as HTMLInputElement;
const seedInput     = document.getElementById('seed-input')       as HTMLInputElement;
const genSelect     = document.getElementById('generator-select') as HTMLSelectElement;
const newSeedBtn    = document.getElementById('new-seed-btn')     as HTMLButtonElement;
const regenerateBtn = document.getElementById('regenerate-btn')   as HTMLButtonElement;
const configFields  = document.getElementById('config-fields')    as HTMLDivElement;
const viewport      = document.getElementById('viewport')         as HTMLDivElement;

const toolButtons      = document.querySelectorAll<HTMLButtonElement>('.tool-btn');
const terrainTypeField = document.getElementById('terrain-type-field') as HTMLElement;
const terrainSelect    = document.getElementById('terrain-select')     as HTMLSelectElement;

const inspPos     = document.getElementById('insp-pos')     as HTMLElement;
const inspTerrain = document.getElementById('insp-terrain') as HTMLElement;
const inspElev    = document.getElementById('insp-elev')    as HTMLElement;
const inspRiver   = document.getElementById('insp-river')   as HTMLElement;
const inspRoad    = document.getElementById('insp-road')    as HTMLElement;

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

activePlugin.generate(scene.map, activePlugin.defaultConfig, initialSeed);
scene.reload();
refreshConfigFields();

// ---- Tool state ----
type ToolId = 'paint-terrain' | 'raise-elevation' | 'lower-elevation' | 'clear-river';
let activeTool      : ToolId = 'paint-terrain';
let paintTerrainType: number = 0; // Grassland

toolButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    activeTool = btn.dataset['tool'] as ToolId;
    toolButtons.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    terrainTypeField.classList.toggle('hidden', activeTool !== 'paint-terrain');
  });
});

terrainSelect.addEventListener('change', () => {
  paintTerrainType = parseInt(terrainSelect.value, 10);
});

// ---- Stroke state ----
type PaintEdit = { col: number; row: number; prevTerrain: number; nextTerrain: number; prevElev: number | null; nextElev: number | null };
type ElevEdit  = { col: number; row: number; prev: number; next: number };
type RiverEdit = { col: number; row: number; prevIncoming: number; prevOutgoing: number };

const WATER_TERRAIN = 5;

let isPointerDown = false;
let strokePaint   : PaintEdit[] = [];
let strokeElev    : ElevEdit[]  = [];
let strokeRiver   : RiverEdit[] = [];
let strokeVisited = new Set<number>();

function cellKey(col: number, row: number): number {
  return row * scene.map.width + col;
}

function applyTool(col: number, row: number): void {
  const key = cellKey(col, row);
  if (strokeVisited.has(key)) return;
  strokeVisited.add(key);

  const { map, chunks } = scene;

  switch (activeTool) {
    case 'paint-terrain': {
      const prevTerrain = map.getTerrain(col, row);
      if (prevTerrain === paintTerrainType) return;
      const prevElev = map.getElevation(col, row);
      let nextElev: number | null = null;
      if (paintTerrainType !== WATER_TERRAIN && prevElev < 0) {
        nextElev = 0;
      }
      map.setTerrain(col, row, paintTerrainType);
      if (nextElev !== null) map.setElevation(col, row, nextElev);
      chunks.markDirty(col, row);
      strokePaint.push({ col, row, prevTerrain, nextTerrain: paintTerrainType, prevElev: nextElev !== null ? prevElev : null, nextElev });
      break;
    }
    case 'raise-elevation': {
      const prev = map.getElevation(col, row);
      const next = Math.min(prev + 1, 127); // Int8 max
      if (next === prev) return;
      map.setElevation(col, row, next);
      chunks.markDirty(col, row);
      strokeElev.push({ col, row, prev, next });
      break;
    }
    case 'lower-elevation': {
      const prev = map.getElevation(col, row);
      const next = Math.max(prev - 1, -128); // Int8 min
      if (next === prev) return;
      map.setElevation(col, row, next);
      chunks.markDirty(col, row);
      strokeElev.push({ col, row, prev, next });
      break;
    }
    case 'clear-river': {
      if (!map.hasRiver(col, row)) return;
      const prevIncoming = map.getIncomingRiverDir(col, row);
      const prevOutgoing = map.getOutgoingRiverDir(col, row);
      map.clearRiver(col, row);
      chunks.markDirty(col, row);
      strokeRiver.push({ col, row, prevIncoming, prevOutgoing });
      break;
    }
  }
}

function endStroke(): void {
  if (!isPointerDown) return;
  isPointerDown = false;

  if (strokePaint.length > 0) {
    history.commit(new PaintTerrainStrokeCommand(scene.map, scene.chunks, strokePaint));
  } else if (strokeElev.length > 0) {
    history.commit(new ElevationStrokeCommand(scene.map, scene.chunks, strokeElev));
  } else if (strokeRiver.length > 0) {
    history.commit(new RiverClearStrokeCommand(scene.map, scene.chunks, strokeRiver));
  }

  strokePaint   = [];
  strokeElev    = [];
  strokeRiver   = [];
  strokeVisited = new Set();
}

viewport.addEventListener('pointerdown', e => {
  if (e.button !== 0) return; // left button only
  const cell = scene.hoveredCell;
  if (!cell) return;
  isPointerDown = true;
  strokePaint   = [];
  strokeElev    = [];
  strokeRiver   = [];
  strokeVisited = new Set();
  applyTool(cell.col, cell.row);
});

viewport.addEventListener('pointermove', () => {
  if (!isPointerDown) return;
  const cell = scene.hoveredCell;
  if (cell) applyTool(cell.col, cell.row);
});

viewport.addEventListener('pointerup',     endStroke);
viewport.addEventListener('pointercancel', endStroke);

// ---- Inspector update loop ----
const TERRAIN_NAMES_RIVER = ['none', 'incoming', 'outgoing', 'both'];

function updateInspector(): void {
  const cell = scene.hoveredCell;
  if (cell) {
    const { map } = scene;
    const terrain  = map.getTerrain(cell.col, cell.row);
    const elev     = map.getElevation(cell.col, cell.row);
    const hasIn    = map.hasIncomingRiver(cell.col, cell.row);
    const hasOut   = map.hasOutgoingRiver(cell.col, cell.row);
    const riverIdx = (hasIn ? 1 : 0) + (hasOut ? 2 : 0);
    const hasRoad  = map.hasRoads(cell.col, cell.row);

    inspPos.textContent     = `${cell.col}, ${cell.row}`;
    inspTerrain.textContent = TERRAIN_NAMES[terrain] ?? String(terrain);
    inspElev.textContent    = String(elev);
    inspRiver.textContent   = TERRAIN_NAMES_RIVER[riverIdx];
    inspRoad.textContent    = hasRoad ? 'yes' : 'no';
  } else {
    inspPos.textContent = inspTerrain.textContent = inspElev.textContent =
      inspRiver.textContent = inspRoad.textContent = '—';
  }
  requestAnimationFrame(updateInspector);
}
updateInspector();

// ---- Save / Load ----
saveBtn.addEventListener('click', () => {
  const bytes = serializeMap(scene.map);
  const url   = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
  const a     = document.createElement('a');
  a.href     = url;
  a.download = 'map.hxmp';
  a.click();
  URL.revokeObjectURL(url);
});

loadBtn.addEventListener('click', () => loadInput.click());

loadInput.addEventListener('change', async () => {
  const file = loadInput.files?.[0];
  if (!file) return;
  loadInput.value = '';
  const loaded = deserializeMap(new Uint8Array(await file.arrayBuffer()));
  scene.replaceMap(loaded);
  history.clear();
});

// ---- Keyboard shortcuts ----
window.addEventListener('keydown', (e) => {
  if (e.key === 'z' && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
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

// ---- Regenerate ----
regenerateBtn.addEventListener('click', async () => {
  const seed = (parseInt(seedInput.value, 10) >>> 0);

  regenerateBtn.disabled    = true;
  regenerateBtn.textContent = 'Generating…';

  await new Promise<void>(r => setTimeout(r, 0));

  scene.map.clear();
  activePlugin.generate(scene.map, activeConfig, seed);
  scene.reload();
  history.clear();

  regenerateBtn.disabled    = false;
  regenerateBtn.textContent = 'Regenerate';
});
