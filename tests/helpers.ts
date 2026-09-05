import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { HexMap, DEFAULT_WATER_TERRAIN_INDEX } from '@loyalj/hex-world';
import type { MapEdit, TerrainDefinition } from '@loyalj/hex-world';
import type { SceneApi } from '../src/scene.ts';
import type { ToolContext } from '../src/tools/tool.ts';
import { SelectionModel } from '../src/selection.ts';
import { LockModel } from '../src/locks.ts';

/** The editor's water terrain index — the fake scene's isWater rule. */
export const WATER = DEFAULT_WATER_TERRAIN_INDEX;

let cachedBody: string | null = null;

/**
 * Load the real index.html body into the test DOM (scripts stripped) so tool
 * constructors find every panel, button, and input they wire. Requires a
 * `@vitest-environment happy-dom` test file.
 */
export function loadEditorDom(): void {
  if (cachedBody === null) {
    // Not import.meta.url-relative: happy-dom rewrites module URLs to http.
    const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');
    cachedBody = (html.match(/<body[^>]*>([\s\S]*)<\/body>/)?.[1] ?? html)
      .replace(/<script[\s\S]*?<\/script>/g, '');
  }
  document.body.innerHTML = cachedBody;
}

/**
 * A scene stand-in around a real HexMap: real map data and transactions,
 * recorders in place of rendering. Tools touch only this slice of SceneApi.
 */
export function makeScene(width = 12, height = 12) {
  const map = new HexMap({ width, height, featureLayerCount: 4 });
  const s = {
    map,
    chunks: { markDirty() {}, markDirtyCells() {} },
    hoveredCell: null as { col: number; row: number } | null,
    brushRadius: 0,
    brushFootprint: null as unknown,
    revision: 0,
    bumpRevision() { s.revision++; },
    hoverMaskFeedback: true,
    isWater: (t: number) => t === WATER,
    terrainLookup: new Map<number, TerrainDefinition>(),
    gameplayRefreshes: 0,
    refreshGameplayLayers() { s.gameplayRefreshes++; },
    previews: [] as unknown[],
    setPathPreview(path: unknown) { s.previews.push(path); },
    // Edge picking is camera math the fake can't do — tests preset the answer.
    pickEdgeResult: null as { col: number; row: number; edge: number } | null,
    pickEdge() { return s.pickEdgeResult; },
    // A real SelectionModel: it's pure state, and the mask checks are real logic.
    selection: new SelectionModel(() => {}),
    // Real locks too, and the same editable() gate the real scene exposes.
    locks: new LockModel(),
    hoverLockFeedback: true,
    editable(col: number, row: number): boolean {
      return s.selection.allows(col, row) && !s.locks.isLocked(s.map.getTerrain(col, row));
    },
    selectionPreviews: [] as unknown[],
    setSelectionPreview(cells: unknown) { s.selectionPreviews.push(cells); },
    territory: null as unknown,
    resources: null as unknown,
    factions: [] as unknown[],
    resourceDescriptors: [] as unknown[],
    setFactions(f: unknown[]) { s.factions = f; },
    setResourceDescriptors(d: unknown[]) { s.resourceDescriptors = d; },
    fogEnabled: false,
    get fog() { return s.fogEnabled ? {} : null; },
    fogPaints: [] as Array<{ cells: Array<{ col: number; row: number }>; reveal: boolean }>,
    paintFog(cells: Array<{ col: number; row: number }>, reveal: boolean) {
      s.fogPaints.push({ cells, reveal });
      return true;
    },
    setFogEnabled() {}, setHideUnexplored() {}, setDimExplored() {}, setAllFog() {},
    fogStats: { explored: 0, total: width * height },
    fogExplored: null as string | null,
    fogExploredBase64() { return s.fogExplored; },
    setFogExplored(b64: string) { s.fogExplored = b64; },
    replaceMap(newMap: HexMap) { s.map = newMap; },
    // Environment panel surface — no-ops plus the bits snapshots read back.
    seasonScopeValue: 'continental' as 'continental' | 'local',
    setSeasonScope(scope: 'continental' | 'local') { s.seasonScopeValue = scope; },
    get seasonScope() { return s.seasonScopeValue; },
    get seasonLabel() { return 'midsummer'; },
    get seasonPhase() { return 0.5; },
    get timeOfDay() { return 0.5; },
    setTimeOfDay() {}, setDayCycle() {}, setWeather() {}, setWeatherIntensity() {},
    setWind() {}, setGustiness() {}, setScatterTexture() {},
    setSeasonsEnabled() {}, setSeasonPhase() {}, setSeasonCycle() {},
  };
  return s;
}
export type FakeScene = ReturnType<typeof makeScene>;

/** A ToolContext over a fake scene, recording committed edits and settings pings. */
export function makeCtx(s: FakeScene): { ctx: ToolContext; edits: MapEdit[]; settingsChanges: () => number } {
  const edits: MapEdit[] = [];
  let settingsChanges = 0;
  const ctx: ToolContext = {
    scene: s as unknown as SceneApi,
    // The app bumps the scene revision from history.onChange; the fake does
    // it here, the moment an edit lands.
    commitEdit(edit) { if (!edit.isEmpty) { edits.push(edit); s.bumpRevision(); } },
    minimapInvalidate() {},
    syncBrushRadius() {},
    updateCursor() {},
    noteSettingsChanged() { settingsChanges++; },
  };
  return { ctx, edits, settingsChanges: () => settingsChanges };
}

/** A minimal pointer-event stand-in for Tool.pointerDown/pointerMove. */
export function pev(
  over: {
    altKey?: boolean; shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean;
    clientX?: number; clientY?: number;
  } = {},
): PointerEvent {
  return {
    altKey: false, shiftKey: false, ctrlKey: false, metaKey: false,
    clientX: 0, clientY: 0, preventDefault() {}, ...over,
  } as unknown as PointerEvent;
}

/** Count cells matching a predicate — for asserting brush footprints. */
export function countCells(map: HexMap, match: (col: number, row: number) => boolean): number {
  let n = 0;
  for (let row = 0; row < map.height; row++) {
    for (let col = 0; col < map.width; col++) if (match(col, row)) n++;
  }
  return n;
}

/** Click the option button carrying a given data attribute value. */
export function clickOption(selector: string): void {
  const btn = document.querySelector<HTMLButtonElement>(selector);
  if (!btn) throw new Error(`no button matches ${selector}`);
  btn.click();
}

/** Set an input's value and fire the input event the tools listen for. */
export function setInput(id: string, value: string): void {
  const el = document.getElementById(id) as HTMLInputElement;
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
