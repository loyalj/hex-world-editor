import { DEFAULT_WATER_TERRAIN_INDEX, hexToOffset, offsetNeighbor, offsetToHex } from '@loyalj/hex-world';
import type { HexCoord, MapTransaction } from '@loyalj/hex-world';
import { EDGE_DIRS, edgeBetween, floodRegion, hexLineDraw } from './hexPath.ts';
import { setInfoTipText } from '../ui/infoTips.ts';
import { wireOptionGroup } from '../ui/uiHelpers.ts';
import { selectionOpFor } from '../selection.ts';
import { computeCostPath } from './pathing.ts';
import type { PathCostOptions, TerrainView } from './pathing.ts';
import { reverseStem, riverStem, riverSystem } from './riverGraph.ts';
import type { CellPos, Tool, ToolContext, ToolId } from './tool.ts';

type RiverMode = 'path' | 'straight' | 'waypoint' | 'downhill' | 'reverse' | 'erase';
/** What the erase mode removes per click: the cell under it, or its whole system. */
type EraseScope = 'cell' | 'river';

const RIVER_MODE_LABELS: Record<RiverMode, string> = {
  'path':     'path',
  'straight': 'straight',
  'waypoint': 'waypoints',
  'downhill': 'downhill trace',
  'reverse':  'reverse flow',
  'erase':    'erase',
};

const RIVER_HINTS: Record<RiverMode, string> = {
  path:     'Hold and drag to place. Shift to erase. Esc cancels. Alt+click selects a whole river.',
  straight: 'Hold and drag to place. Shift to erase. Esc cancels. Alt+click selects a whole river.',
  waypoint: 'Click to place waypoints. Double-click or Enter to commit. Esc cancels.',
  downhill: 'Hover to preview, click to trace downhill to the nearest water.',
  reverse:  'Hover to see the main stem through a river cell; click to make it flow the other way.',
  erase:    'Click or drag to remove rivers from cells, or click once to remove a whole river.',
};

/** How many cells a dead-end lake may spread across the basin floor. */
const MAX_LAKE_CELLS = 7;

/**
 * Rivers touch water only at their ends: they may START one cell inside water
 * (a lake outlet) and END one cell into water (the land→water edge forms the
 * estuary), but never continue across it — a straight or waypoint line dragged
 * over a bay stops at the first water cell. Erase paths are NOT trimmed, so
 * rivers that pass through generator lakes stay erasable end to end.
 */
export function trimRiverPathAtWater(scene: TerrainView, path: HexCoord[]): HexCoord[] {
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

/** Follow the terrain downhill from a cell to the nearest water or local minimum. */
export function traceDownhill(scene: TerrainView, startCol: number, startRow: number): HexCoord[] {
  const { map } = scene;
  const cellKey = (col: number, row: number): number => row * map.width + col;
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

/**
 * The lake a river that ends on land would leave: the floor around its last
 * cell — the connected cells at that elevation, river cells included, since
 * a basin floods evenly — capped so a wide plain doesn't drown. Empty when
 * the path already reached water, or when its last cell joins an existing
 * river that carries the flow onward.
 */
export function lakeAtSink(scene: TerrainView, path: HexCoord[]): CellPos[] {
  if (path.length === 0) return [];
  const { map } = scene;
  const end = hexToOffset(path[path.length - 1]);
  if (!map.inBounds(end.col, end.row) || scene.isWater(map.getTerrain(end.col, end.row))) return [];
  if (map.getOutgoingRiverDir(end.col, end.row) >= 0) return [];
  const floor = map.getElevation(end.col, end.row);
  const cells = floodRegion(map.width, map.height, end.col, end.row,
    (col, row) => map.getElevation(col, row) === floor && !scene.isWater(map.getTerrain(col, row)));
  return cells.slice(0, MAX_LAKE_CELLS);
}

/**
 * River drawing in six modes: cost-pathed or straight drags (Shift erases
 * along the path), clicked waypoints, downhill tracing with a hover preview,
 * reversing a stem's flow, and an erase brush that detaches confluences
 * cleanly or removes a whole river at once. Every drawing mode can leave a
 * lake where its river ends on land. Alt+click in any mode selects the whole
 * river system under the cursor.
 */
export class RiverTool implements Tool {
  readonly id: ToolId = 'paint-river';
  readonly title = 'River';
  readonly panel = document.getElementById('river-options') as HTMLElement;
  /** Alt+click picks a whole river into the selection — the crosshair cursor fits. */
  readonly hasEyedropper = true;

  private readonly ctx: ToolContext;
  /** The road panel's cost checkboxes — path mode shares the road pathfinder. */
  private readonly costOptions: () => PathCostOptions;

  private mode: RiverMode = 'path';
  private eraseScope: EraseScope = 'cell';
  private lakeAtSinks = false;
  private down = false;
  private erasing = false;
  private pathStart: CellPos | null = null;
  private currentPath: HexCoord[] | null = null;
  private waypoints: CellPos[] = [];
  private waypointActive = false;
  private eraseTx: MapTransaction | null = null;
  private eraseVisited = new Set<number>();
  /** The lake previewed under a live drag or waypoint path, so it can be cleared. */
  private pendingLake: CellPos[] = [];
  // Hover previews for the click modes: the traced path (plus its lake), the
  // stem a reverse would flip, and the system an Alt+click would select.
  private hoverCell: CellPos | null = null;
  private hoverPath: HexCoord[] | null = null;
  private hoverLake: CellPos[] = [];
  private hoverSystemCount = 0;

  constructor(ctx: ToolContext, costOptions: () => PathCostOptions) {
    this.ctx = ctx;
    this.costOptions = costOptions;
    const modeHeader = document.getElementById('river-mode-header')!;
    const eraseScopeGroup = document.getElementById('river-erase-scope-group') as HTMLElement;
    const lakeRow = document.getElementById('river-lake-row') as HTMLElement;
    wireOptionGroup('#river-mode-group .brush-btn', btn => {
      if (this.waypointActive) this.cancelWaypoints();
      this.clearHover();
      this.mode = btn.dataset['riverMode'] as RiverMode;
      setInfoTipText(modeHeader, RIVER_HINTS[this.mode] ?? '');
      eraseScopeGroup.classList.toggle('hidden', this.mode !== 'erase');
      lakeRow.classList.toggle('hidden', this.mode === 'reverse' || this.mode === 'erase');
      ctx.updateCursor();
    });
    wireOptionGroup('#river-erase-scope-group .scatter-type-btn', btn => {
      this.eraseScope = btn.dataset['eraseScope'] as EraseScope;
    });
    (document.getElementById('river-lake-at-sinks') as HTMLInputElement).addEventListener('change', e => {
      this.lakeAtSinks = (e.target as HTMLInputElement).checked;
      this.refreshPreviews();
    });
    (document.getElementById('river-clear-btn') as HTMLButtonElement)
      .addEventListener('click', () => this.clearRivers());
  }

  brushRadius(): number { return 0; }
  wantsFillCursor(): boolean { return this.mode === 'downhill' || this.mode === 'reverse'; }

  private cellKey(col: number, row: number): number {
    return row * this.ctx.scene.map.width + col;
  }

  pointerDown(cell: CellPos, e: PointerEvent): void {
    const scene = this.ctx.scene;
    if (e.altKey && this.mode !== 'waypoint') {
      this.selectSystem(cell, e);
      return;
    }
    if (this.mode === 'path' || this.mode === 'straight') {
      this.clearHover();
      this.down = true;
      this.erasing = e.shiftKey;
      this.pathStart = { col: cell.col, row: cell.row };
      this.currentPath = null;
      scene.setPathPreview([offsetToHex(cell.col, cell.row)], this.erasing);
      return;
    }
    if (this.mode === 'waypoint') {
      this.waypoints.push({ col: cell.col, row: cell.row });
      this.waypointActive = true;
      this.previewWaypoints(null);
      return;
    }
    if (this.mode === 'downhill') {
      this.clearHover();
      const path = traceDownhill(scene, cell.col, cell.row);
      const lake = this.lakeFor(path);
      if (path.length >= 2 || lake.length > 0) this.applyRiverPath(path, false, lake);
      return;
    }
    if (this.mode === 'reverse') {
      this.clearHover();
      this.reverseAt(cell);
      return;
    }
    // erase
    if (this.eraseScope === 'river') {
      this.beginErase();
      for (const c of riverSystem(scene.map, cell.col, cell.row)) this.eraseRiverAt(c.col, c.row);
      this.commitErase();
      return;
    }
    this.down = true;
    this.beginErase();
    this.eraseRiverAt(cell.col, cell.row);
  }

  pointerMove(cell: CellPos | null, e: PointerEvent): void {
    // Waypoint river preview runs even without pointer down
    if (this.mode === 'waypoint' && this.waypointActive) {
      if (cell) this.previewWaypoints(cell);
      return;
    }
    if (!this.down) {
      this.updateHover(cell, e.altKey);
      return;
    }
    if (this.mode === 'path' || this.mode === 'straight') {
      this.erasing = e.shiftKey;
      this.updatePreview();
      return;
    }
    if (this.mode === 'erase' && cell) this.eraseRiverAt(cell.col, cell.row);
  }

  pointerUp(): void {
    if (!this.down) return;
    this.down = false;
    if (this.mode === 'erase') {
      this.commitErase();
      return;
    }
    if (this.currentPath) {
      const lake = this.erasing ? [] : this.lakeFor(this.currentPath);
      this.applyRiverPath(this.currentPath, this.erasing, lake);
    }
    this.cancelDrag();
  }

  doubleClick(): void {
    if (this.mode === 'waypoint') this.commitWaypoints();
  }

  keyDown(e: KeyboardEvent): boolean {
    if (e.key === 'Escape') {
      if (this.waypointActive) { this.cancelWaypoints(); return true; }
      if (this.down && (this.mode === 'path' || this.mode === 'straight')) {
        this.cancelDrag();
        return true;
      }
      return false;
    }
    if (e.key === 'Enter' && this.mode === 'waypoint') {
      this.commitWaypoints();
      return true;
    }
    return false;
  }

  deactivate(): void {
    if (this.waypointActive) this.cancelWaypoints();
    // A half-done erase stroke has already mutated the map — commit it so the
    // cells it cleared stay undoable.
    this.commitErase();
    this.cancelDrag();
    this.clearHover();
  }

  private cancelDrag(): void {
    if (!this.pathStart) return;
    this.ctx.scene.setPathPreview(null);
    this.previewLake(null);
    this.pathStart = null;
    this.currentPath = null;
    this.down = false;
  }

  // ---- Lakes ----

  /** The lake this path would leave at its end, if the option is on. */
  private lakeFor(path: HexCoord[]): CellPos[] {
    return this.lakeAtSinks ? lakeAtSink(this.ctx.scene, path) : [];
  }

  /** Show (or clear) the lake a live drag or waypoint path would leave. */
  private previewLake(path: HexCoord[] | null): void {
    const lake = path ? this.lakeFor(path) : [];
    if (lake.length === 0 && this.pendingLake.length === 0) return;
    this.pendingLake = lake;
    this.ctx.scene.setSelectionPreview(lake.length > 0 ? lake : null);
  }

  /** The option changed under a live preview — hover, drag, or waypoints — so rebuild it. */
  private refreshPreviews(): void {
    if (this.waypointActive) this.previewWaypoints(this.ctx.scene.hoveredCell);
    else if (this.down && this.pathStart) this.updatePreview();
    else this.refreshHover();
  }

  // ---- Hover previews ----

  /**
   * What a click here would do, before it's clicked: with Alt, the river
   * system that would be selected; in trace mode, the traced path and any
   * lake it would leave; in reverse mode, the stem that would flip.
   */
  private updateHover(cell: CellPos | null, alt: boolean): void {
    if (!cell) { this.clearHover(); return; }
    const kind = alt ? 'select' : this.mode;
    if (kind !== 'select' && kind !== 'downhill' && kind !== 'reverse') { this.clearHover(); return; }
    if (this.hoverCell && this.hoverCell.col === cell.col && this.hoverCell.row === cell.row
      && this.hoverKind === kind) return;
    this.clearHover();
    this.hoverCell = cell;
    this.hoverKind = kind;
    const scene = this.ctx.scene;
    if (kind === 'select') {
      const system = riverSystem(scene.map, cell.col, cell.row);
      this.hoverSystemCount = system.length;
      scene.setSelectionPreview(system);
    } else if (kind === 'downhill') {
      this.hoverPath = traceDownhill(scene, cell.col, cell.row);
      this.hoverLake = this.lakeAtSinks ? lakeAtSink(scene, this.hoverPath) : [];
      scene.setPathPreview(this.hoverPath, false);
      scene.setSelectionPreview(this.hoverLake);
    } else {
      const stem = riverStem(scene.map, cell.col, cell.row);
      this.hoverPath = stem.map(c => offsetToHex(c.col, c.row));
      scene.setPathPreview(this.hoverPath.length > 0 ? this.hoverPath : null, false);
    }
  }
  private hoverKind: 'select' | RiverMode | null = null;

  /** An option changed under a live hover — rebuild it. */
  private refreshHover(): void {
    const cell = this.hoverCell;
    const alt = this.hoverKind === 'select';
    this.clearHover();
    this.updateHover(cell ?? this.ctx.scene.hoveredCell, alt);
  }

  private clearHover(): void {
    if (!this.hoverCell) return;
    const scene = this.ctx.scene;
    if (this.hoverKind === 'select' || this.hoverLake.length > 0) scene.setSelectionPreview(null);
    if (this.hoverPath) scene.setPathPreview(null);
    this.hoverCell = null;
    this.hoverKind = null;
    this.hoverPath = null;
    this.hoverLake = [];
    this.hoverSystemCount = 0;
  }

  // ---- Whole-river actions ----

  /** Alt+click: the whole river system into the selection, with the usual modifier convention. */
  private selectSystem(cell: CellPos, e: PointerEvent): void {
    e.preventDefault();
    const system = riverSystem(this.ctx.scene.map, cell.col, cell.row);
    if (system.length === 0) return;
    // Alt is the trigger here, not "subtract": Shift adds, plain replaces.
    const op = selectionOpFor({ shiftKey: e.shiftKey, altKey: false });
    this.ctx.scene.selection.apply(system, op);
    this.clearHover();
  }

  /** Reverse the main stem through a river cell, as one undo step. */
  private reverseAt(cell: CellPos): void {
    const scene = this.ctx.scene;
    const stem = riverStem(scene.map, cell.col, cell.row);
    if (stem.length < 2) return;
    const tx = scene.map.beginEdit();
    const flipped = reverseStem(tx, scene.map, stem,
      (col, row) => scene.editable(col, row),
      (col, row) => scene.chunks.markDirty(col, row));
    const edit = tx.commit();
    if (flipped > 0) this.ctx.commitEdit(edit);
  }

  /**
   * Remove every river in the selection, or on the whole map with nothing
   * selected — each cell through the same detach-then-clear as the brush so
   * nothing outside the selection is left dangling.
   */
  private clearRivers(): void {
    const { map } = this.ctx.scene;
    this.beginErase();
    for (let row = 0; row < map.height; row++) {
      for (let col = 0; col < map.width; col++) {
        if (map.hasRiver(col, row)) this.eraseRiverAt(col, row);
      }
    }
    this.commitErase();
    this.clearHover();
  }

  /** Start an erase gesture: eraseRiverAt opens the transaction on first use. */
  private beginErase(): void {
    this.eraseTx = null;
    this.eraseVisited = new Set();
  }

  /** Commit whatever an erase gesture cleared (nothing, if it touched no river). */
  private commitErase(): void {
    const tx = this.eraseTx;
    if (tx) this.ctx.commitEdit(tx.commit());
    this.eraseTx = null;
    this.eraseVisited = new Set();
  }

  // ---- Drag and waypoint paths ----

  private updatePreview(): void {
    if (!this.pathStart) return;
    const scene = this.ctx.scene;
    const end = scene.hoveredCell ?? this.pathStart;
    const startHex = offsetToHex(this.pathStart.col, this.pathStart.row);
    const endHex   = offsetToHex(end.col, end.row);
    if (end.col === this.pathStart.col && end.row === this.pathStart.row) {
      this.currentPath = null;
      scene.setPathPreview([startHex], this.erasing);
      this.previewLake(null);
      return;
    }
    let path = this.mode === 'straight'
      ? hexLineDraw(startHex, endHex)
      : computeCostPath(scene, startHex, endHex, this.costOptions(), endHex);
    if (path && !this.erasing) path = trimRiverPathAtWater(scene, path);
    this.currentPath = path;
    scene.setPathPreview(path ?? [startHex], this.erasing);
    this.previewLake(path && !this.erasing ? path : null);
  }

  /** Preview the waypoint river through the cursor, plus the lake it would leave. */
  private previewWaypoints(cursor: CellPos | null): void {
    const path = this.computeWaypointPath(cursor);
    this.ctx.scene.setPathPreview(path, false);
    this.previewLake(path);
  }

  private computeWaypointPath(cursor: CellPos | null): HexCoord[] {
    const waypoints = this.waypoints;
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
    return trimRiverPathAtWater(this.ctx.scene, result);
  }

  private commitWaypoints(): void {
    if (!this.waypointActive) return;
    const wps = [...this.waypoints];
    // dblclick fires a second pointerdown before dblclick, so the last waypoint is a duplicate — remove it
    if (wps.length >= 2) {
      const last = wps[wps.length - 1], prev = wps[wps.length - 2];
      if (last.col === prev.col && last.row === prev.row) wps.pop();
    }
    if (wps.length >= 2) {
      this.waypoints = wps;
      const path = this.computeWaypointPath(null);
      this.applyRiverPath(path, false, this.lakeFor(path));
    }
    this.cancelWaypoints();
  }

  private cancelWaypoints(): void {
    this.waypoints = [];
    this.waypointActive = false;
    this.ctx.scene.setPathPreview(null);
    this.previewLake(null);
  }

  /** The roster's water terrain for a new lake: the lowest liquid index, else the library default. */
  private lakeTerrain(): number {
    const scene = this.ctx.scene;
    let best = -1;
    for (const index of scene.terrainLookup.keys()) {
      if (scene.isWater(index) && (best < 0 || index < best)) best = index;
    }
    return best >= 0 ? best : DEFAULT_WATER_TERRAIN_INDEX;
  }

  /**
   * Write a river along a path — or erase along it — as one undo step. `lake`
   * cells (the floor around a land terminus) turn to water in the same edit,
   * so the path's last cell becomes the estuary the river was reaching for.
   */
  private applyRiverPath(path: HexCoord[], erasing: boolean, lake: CellPos[] = []): void {
    if (path.length < 2 && lake.length === 0) return;
    const scene = this.ctx.scene;
    const { map, chunks } = scene;
    const tx = map.beginEdit();
    // River channels live on the edges between cells, so like roads a segment
    // is gated unless both of its endpoint cells are editable (selection mask
    // and terrain locks alike). Consistency repairs on cells just outside
    // (detaching a replaced downstream edge) still run — they're consequences
    // of an allowed write, and leaving them out would strand half-edges.
    const segmentAllowed = (a: CellPos, b: CellPos): boolean =>
      scene.editable(a.col, a.row) && scene.editable(b.col, b.row);

    if (erasing) {
      // Partial detach: remove only the half-edges the drawn path follows, so
      // tributaries joining the erased river at a confluence stay intact.
      for (let i = 0; i < path.length - 1; i++) {
        const a = hexToOffset(path[i]);
        const b = hexToOffset(path[i + 1]);
        if (!map.inBounds(a.col, a.row) || !map.inBounds(b.col, b.row)) continue;
        if (!segmentAllowed(a, b)) continue;
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
          if (edge !== null && segmentAllowed(prev, off)) {
            tx.setRiverIncoming(off.col, off.row, (edge + 3) % 6);
          }
        }
        if (i < path.length - 1) {
          const next = hexToOffset(path[i + 1]);
          const edge = edgeBetween(off.col, off.row, next.col, next.row);
          if (edge !== null && segmentAllowed(off, next)) {
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
      const water = this.lakeTerrain();
      for (const { col, row } of lake) {
        if (!scene.editable(col, row)) continue;
        tx.setTerrain(col, row, water);
        chunks.markDirty(col, row);
      }
    }

    this.ctx.commitEdit(tx.commit());
  }

  private eraseRiverAt(col: number, row: number): void {
    if (!this.ctx.scene.editable(col, row)) return;
    const key = this.cellKey(col, row);
    if (this.eraseVisited.has(key)) return;
    this.eraseVisited.add(key);
    const { map, chunks } = this.ctx.scene;
    if (!map.hasRiver(col, row)) return;
    const tx = (this.eraseTx ??= map.beginEdit());

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

  statusText(): string {
    const base = `River · ${RIVER_MODE_LABELS[this.mode]}`;
    if (this.hoverKind === 'select') {
      return this.hoverSystemCount > 0 ? `${base} · Alt+click selects ${this.hoverSystemCount} river cells` : base;
    }
    if (this.hoverKind === 'downhill' && this.hoverPath) {
      const scene = this.ctx.scene;
      const end = hexToOffset(this.hoverPath[this.hoverPath.length - 1]);
      const reachesWater = scene.map.inBounds(end.col, end.row) && scene.isWater(scene.map.getTerrain(end.col, end.row));
      const outcome = reachesWater ? 'reaches water'
        : this.hoverLake.length > 0 ? `dead end · lake of ${this.hoverLake.length}` : 'dead end';
      return `${base} · ${this.hoverPath.length} cells · ${outcome}`;
    }
    if (this.hoverKind === 'reverse' && this.hoverPath && this.hoverPath.length > 0) {
      return `${base} · stem of ${this.hoverPath.length} cells`;
    }
    if (this.mode === 'erase' && this.eraseScope === 'river') return `${base} · whole river`;
    if (this.pendingLake.length > 0) return `${base} · ends on land · lake of ${this.pendingLake.length}`;
    return base;
  }
}
