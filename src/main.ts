import { FbmPlugin, ChunkPlugin, hexToWorld, offsetToHex } from '@loyalj/hex-world';
import type { MapEdit } from '@loyalj/hex-world';
import { HeightmapPlugin } from './generators/heightmapPlugin.ts';
import { initScene, FEATURE_LAYERS } from './scene.ts';
import { CommandHistory } from './undo/history.ts';
import { MapEditCommand, SelectionCommand } from './undo/commands.ts';
import { Minimap } from './ui/minimap.ts';
import { initWizard } from './wizard/wizard.ts';
import { hydrateInfoTips } from './ui/infoTips.ts';
import { initPalette, EDITOR_DEFAULT_TERRAINS } from './ui/palette.ts';
import { initLocksPanel } from './ui/locksPanel.ts';
import { initTerrainStatsPanel } from './ui/terrainStatsPanel.ts';
import { initRiverAudit } from './ui/riverAudit.ts';
import { initRosters } from './ui/rosters.ts';
import { initPersistence } from './ui/persistence.ts';
import { initMenus } from './ui/menus.ts';
import { initSettings } from './ui/settings.ts';
import { initReadouts } from './ui/readouts.ts';
import { initToolManager } from './tools/toolManager.ts';
import type { ToolContext } from './tools/tool.ts';
import { TerrainTool } from './tools/terrainTool.ts';
import { ElevationTool } from './tools/elevationTool.ts';
import { RiverTool } from './tools/riverTool.ts';
import { RoadTool } from './tools/roadTool.ts';
import { ScatterTool } from './tools/scatterTool.ts';
import { EnvironmentTool } from './tools/environmentTool.ts';
import { TerritoryTool } from './tools/territoryTool.ts';
import { ResourceTool } from './tools/resourceTool.ts';
import { FogTool } from './tools/fogTool.ts';
import { UnitTool } from './tools/unitTool.ts';
import { SelectionTool } from './tools/selectionTool.ts';

// ---- Generator registry ----
const PLUGINS = [FbmPlugin, ChunkPlugin, HeightmapPlugin];

// The stored theme goes on before the scene load so the chrome never flashes
// the stylesheet defaults; the dialog wiring rides along.
initSettings();

// ---- Scene, history, minimap ----
const viewport = document.getElementById('viewport') as HTMLDivElement;
const scene    = await initScene(viewport, EDITOR_DEFAULT_TERRAINS);
const history  = new CommandHistory();

const minimap = new Minimap(
  document.getElementById('minimap')         as HTMLElement,
  document.getElementById('minimap-base')    as HTMLCanvasElement,
  document.getElementById('minimap-overlay') as HTMLCanvasElement,
  scene,
);

// Selection gestures ride the same undo stack as map edits — a misclick on a
// painstaking selection is one Ctrl+Z, not a rebuild. They're transient
// commands, so they never count as unsaved document changes.
scene.selection.onCommit = (before, after) =>
  history.commit(new SelectionCommand(keys => scene.selection.restoreKeys(keys), before, after));

const undoBtn = document.getElementById('undo-btn') as HTMLButtonElement;
const redoBtn = document.getElementById('redo-btn') as HTMLButtonElement;
undoBtn.addEventListener('click', () => history.undo());
redoBtn.addEventListener('click', () => history.redo());

// ---- First map ----
// The seed a map was generated with is kept for save/export metadata. The
// wizard reports it on create; loading a save restores it.
const initialSeed = Math.floor(Math.random() * 0xffffffff);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
PLUGINS[0].generate(scene.map, PLUGINS[0].defaultConfig as any, initialSeed);
scene.reload();

// ---- Tools ----
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

const ctx: ToolContext = {
  scene,
  commitEdit,
  minimapInvalidate: () => minimap.invalidate(),
  // Filled in by initToolManager / initPersistence; stubs so tools may call
  // them while wiring.
  syncBrushRadius:     () => {},
  updateCursor:        () => {},
  noteSettingsChanged: () => {},
};

const terrainTool     = new TerrainTool(ctx);
const elevationTool   = new ElevationTool(ctx);
const roadTool        = new RoadTool(ctx);
const riverTool       = new RiverTool(ctx, () => roadTool.costOptions());
const scatterTool     = new ScatterTool(ctx);
const environmentTool = new EnvironmentTool(ctx);
const territoryTool   = new TerritoryTool(ctx);
const resourceTool    = new ResourceTool(ctx);
const fogTool         = new FogTool(ctx);
const unitTool        = new UnitTool(ctx);
const selectionTool   = new SelectionTool(ctx);

const drawerTitle = document.getElementById('drawer-title') as HTMLElement;
const toolManager = initToolManager(
  ctx,
  // First entry is the tool active on load — the selection pointer, so a
  // fresh launch starts in a mode that can't accidentally repaint the map.
  [selectionTool, terrainTool, elevationTool, riverTool, roadTool, scatterTool,
   environmentTool, territoryTool, resourceTool, fogTool, unitTool],
  viewport,
  tool => { drawerTitle.textContent = tool.title; },
);

// ---- UI modules ----
// Stubs bound after their modules exist — the palette renders once during its
// own init, and the menus (which own panel visibility) come later still.
let refreshLocksUi = (): void => {};
let showLocksPanel = (): void => {};
let refreshTerrainStats = (): void => {};

const palette = initPalette({
  scene, terrainTool, scatterTool,
  minimapInvalidate: () => minimap.invalidate(),
  onTerrainsChanged: () => { refreshLocksUi(); refreshTerrainStats(); },
});

const locksPanel = initLocksPanel({
  scene,
  terrains: () => palette.terrains,
  previewFor: index => palette.previewFor(index),
  showPanel: () => showLocksPanel(),
});
refreshLocksUi = () => locksPanel.refresh();

const terrainStats = initTerrainStatsPanel({
  scene,
  terrains: () => palette.terrains,
  previewFor: index => palette.previewFor(index),
});
refreshTerrainStats = () => terrainStats.refresh();
// Locks are saved-file state outside the undo history, like fog exploration —
// a change marks the document unsaved and schedules the autosave.
scene.locks.onChange = () => {
  locksPanel.refresh();
  scene.bumpRevision();
  ctx.noteSettingsChanged();
};

// Faction and resource-type rosters: the Edit-menu dialogs, and what a save
// file or pack records for them.
const rosters = initRosters({
  ctx, territoryTool, resourceTool, unitTool,
  terrains: () => palette.terrains,
});
// The river check dialog: its rows fly the camera to the offending cell.
const riverAudit = initRiverAudit({
  scene,
  focusCell: cell => {
    const p = hexToWorld(scene.layout, offsetToHex(cell.col, cell.row));
    scene.focusWorld(p.x, p.z);
  },
});
document.getElementById('river-audit-btn')!.addEventListener('click', () => riverAudit.open());

hydrateInfoTips();

const persistence = initPersistence({
  scene, history, palette, rosters,
  environment: environmentTool,
  fog:         fogTool,
  pluginIds:          PLUGINS.map(p => p.id),
  initialGeneratorId: PLUGINS[0].id,
  initialSeed,
});
ctx.noteSettingsChanged = persistence.noteSettingsChanged;

// Environment tweaks and palette edits live outside the undo history but in
// the save file — count them as unsaved changes. The dispatches inside
// snapshot restores don't bubble, so a load never re-dirties itself this way
// (and applyLoadedJSON clears the flag afterwards regardless).
const environmentPanel = document.getElementById('environment-options')!;
environmentPanel.addEventListener('input',  () => persistence.noteSettingsChanged());
environmentPanel.addEventListener('change', () => persistence.noteSettingsChanged());
environmentPanel.addEventListener('click', e => {
  if ((e.target as HTMLElement).closest('button')) persistence.noteSettingsChanged();
});
document.getElementById('add-terrain-confirm-btn')!
  .addEventListener('click', () => persistence.noteSettingsChanged());
document.getElementById('liquid-apply-btn')!
  .addEventListener('click', () => persistence.noteSettingsChanged());

const menus = initMenus({
  scene,
  minimapInvalidate: () => minimap.invalidate(),
  // The Terrains panel skips its recount while hidden; showing it catches up.
  onPanelToggle: (panel, visible) => { if (panel === 'terrains' && visible) terrainStats.refresh(); },
});
showLocksPanel = () => menus.setPanelVisible('locks', true);

initReadouts({ scene, minimap, tools: toolManager, terrainTool, environmentTool, terrains: () => palette.terrains });

// Every map mutation funnels through the history, so one invalidate here
// covers paints, floods, undo, and redo. The handful of things that never
// reach the undo stack — fog, overlay visibility, palette swaps — invalidate
// at their own call sites.
history.onChange = () => {
  undoBtn.disabled = !history.canUndo;
  redoBtn.disabled = !history.canRedo;
  // Anything caching a view of the map (the fill preview's component index,
  // the Terrains panel) re-derives from here.
  scene.bumpRevision();
  terrainStats.refresh();
  // Refreshes the doc strip (dirty asterisk) and schedules the autosave.
  persistence.noteMapChanged();
  minimap.invalidate();
  // Same reasoning as the minimap: every mutation funnels through the history,
  // and recutting the perimeter is cheap enough not to be worth deciding
  // whether this particular edit reached a boundary cell.
  scene.refreshSkirt();
  // And again for the View-menu analysis overlays — a no-op while they're off.
  scene.refreshAnalysisOverlays();
  // The selection highlight sits at surface height — an elevation edit (or its
  // undo) moves the ground under it. No-op while nothing is selected.
  scene.refreshSelectionHighlight();
};

// ---- New-map wizard ----
const wizard = initWizard({
  dialog:             document.getElementById('wizard-dialog') as HTMLDialogElement,
  layout:             scene.layout,
  terrainDefinitions: () => scene.terrainDefinitions,
  plugins:            PLUGINS,
  featureLayerCount:  FEATURE_LAYERS,
  initialSeed,
  onCreate({ map, pluginId, seed }) {
    persistence.setGenerator(pluginId, seed);
    scene.replaceMap(map);
    history.clear();
    persistence.markFresh('untitled');
  },
});

(document.getElementById('new-map-btn') as HTMLButtonElement)
  .addEventListener('click', () => {
    if (persistence.confirmDiscard('start a new map')) wizard.open();
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

// ---- App-level keyboard shortcuts ----
// Tool hotkeys and per-tool keys (Escape, Enter, Ctrl contour snap) live in
// the tool manager and the tools themselves.
window.addEventListener('keydown', (e) => {
  // Don't fire shortcuts while the user is typing in an input/select
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;

  if (e.key === 'z' && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
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
    if (persistence.confirmDiscard('start a new map')) wizard.open();
  } else if (e.key === 'o' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    void persistence.openLoadPicker();
  } else if ((e.key === 's' || e.key === 'S') && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    if (e.shiftKey) void persistence.saveAs();
    else void persistence.save();
  } else if (e.key === 'a' && (e.ctrlKey || e.metaKey)) {
    // Selection shortcuts live here, not on the selection tool: the mask
    // constrains every tool, so it should be reachable from any of them.
    e.preventDefault();
    scene.selection.selectAll(scene.map.width, scene.map.height);
  } else if (e.key === 'i' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    scene.selection.invert(scene.map.width, scene.map.height);
  }
});

// ---- Session restore ----
// Last: the restore needs every module live so a restored save applies fully.
await persistence.restoreSession();
