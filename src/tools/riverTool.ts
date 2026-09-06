import { DEFAULT_WATER_TERRAIN_INDEX, hexRange, hexToOffset, offsetNeighbor, offsetToHex } from '@loyalj/hex-world';
import type { HexCoord, HexMap, MapTransaction } from '@loyalj/hex-world';
import { EDGE_DIRS, edgeBetween, floodRegion, hexDistance, hexLineDraw, hexRound } from './hexPath.ts';
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

/** How far (in hexes) a new river's start reaches for an existing river's end. */
const SNAP_RADIUS = 2;

/**
 * Where a new river gesture should really start: the nearest river end — a
 * river cell with no outgoing edge, still on land — within {@link SNAP_RADIUS}
 * of the pressed cell, so extending a river never leaves a one-cell gap and
 * the old river flows on into the new one. Sources aren't candidates (a
 * river drawn from one would turn it around), nor are ends that already
 * reached water (that river is finished), nor cells the mask or locks
 * refuse. Pressing on a river cell never snaps — that press IS connected.
 */
export function snapRiverStart(
  map: HexMap,
  isWater: (terrain: number) => boolean,
  cell: CellPos,
  allows: (col: number, row: number) => boolean,
): CellPos {
  if (!map.inBounds(cell.col, cell.row) || map.hasRiver(cell.col, cell.row)) return cell;
  const centerHex = offsetToHex(cell.col, cell.row);
  let best: CellPos | null = null;
  let bestDist = Infinity;
  for (const hex of hexRange(centerHex, SNAP_RADIUS)) {
    const off = hexToOffset(hex);
    if (!map.inBounds(off.col, off.row) || !allows(off.col, off.row)) continue;
    if (!map.hasRiver(off.col, off.row) || map.getOutgoingRiverDir(off.col, off.row) >= 0) continue;
    if (isWater(map.getTerrain(off.col, off.row))) continue;
    const d = hexDistance(centerHex, hex);
    if (d < bestDist) { bestDist = d; best = off; }
  }
  return best ?? cell;
}

/** A small seeded generator, so one drag's bends hold still while the preview follows the pointer. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Bend a line between two cells: control points every few cells along the
 * straight line, each pushed sideways by between half of `amount` and
 * `amount` cells on alternating sides (the distances rolled from `rng`),
 * then joined leg by leg with `join` — the straight hex line, or the cost
 * pathfinder. A bend that would leave the map stays on the line. Loops the
 * legs fold into are cut, so the result visits each cell once; a line too
 * short for a single bend comes back as `join(start, end)`.
 */
export function meanderPath(
  map: { inBounds(col: number, row: number): boolean },
  start: HexCoord, end: HexCoord, amount: number,
  rng: () => number,
  join: (a: HexCoord, b: HexCoord) => HexCoord[],
): HexCoord[] {
  const n = hexDistance(start, end);
  const spacing = Math.max(3, amount * 2 + 1);
  if (amount <= 0 || n < spacing + 2) return join(start, end);
  // Axial → a plain 2D plane, where "sideways" is a perpendicular.
  const SQ = Math.sqrt(3) / 2;
  const toXY = (h: HexCoord): { x: number; y: number } => ({ x: h.q + h.r / 2, y: h.r * SQ });
  const toHex = (x: number, y: number): HexCoord => {
    const r = y / SQ;
    return hexRound(x - r / 2, r);
  };
  const a = toXY(start), b = toXY(end);
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const dir  = { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
  const perp = { x: -dir.y, y: dir.x };
  let side = rng() < 0.5 ? -1 : 1;
  const points: HexCoord[] = [start];
  for (let i = spacing; i <= n - 2; i += spacing) {
    const t = i / n;
    const base = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    const swing = amount * (0.5 + 0.5 * rng()) * side;
    side = -side;
    const bent = toHex(base.x + perp.x * swing, base.y + perp.y * swing);
    const off = hexToOffset(bent);
    points.push(map.inBounds(off.col, off.row) ? bent : toHex(base.x, base.y));
  }
  points.push(end);
  const path: HexCoord[] = [points[0]];
  for (let i = 0; i < points.length - 1; i++) {
    const leg = join(points[i], points[i + 1]);
    for (let k = 1; k < leg.length; k++) path.push(leg[k]);
  }
  return dropLoops(path);
}

/** Cut every loop out of a path so no cell repeats — a river can't cross itself. */
function dropLoops(path: HexCoord[]): HexCoord[] {
  const out: HexCoord[] = [];
  const at = new Map<string, number>();
  for (const h of path) {
    const key = `${h.q},${h.r}`;
    const seen = at.get(key);
    if (seen !== undefined) {
      for (let i = out.length - 1; i > seen; i--) at.delete(`${out[i].q},${out[i].r}`);
      out.length = seen + 1;
      continue;
    }
    at.set(key, out.length);
    out.push(h);
  }
  return out;
}

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
 * cleanly or removes a whole river at once. New rivers snap their start to
 * a nearby river end so extensions join up; the drag modes can bend their
 * line into meanders; every drawing mode can carve a valley under its river
 * and leave a lake where it ends on land. Alt+click in any mode selects the
 * whole river system under the cursor.
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
  private readonly snapToggle = document.getElementById('river-snap') as HTMLInputElement;
  /** How far, in cells, a bend may swing from the straight line; 0 draws it straight. */
  private meander = 0;
  /** Depth to dig along a newly drawn river; 0 leaves the ground alone. */
  private carve = 0;
  /** One drag's bends: a seed rolled at press so the preview holds still under the pointer. */
  private meanderSeed = 0;
  /** Source of the meander seeds; tests swap in a deterministic one. */
  protected rng: () => number = Math.random;
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
    const lakeRow    = document.getElementById('river-lake-row')    as HTMLElement;
    const snapRow    = document.getElementById('river-snap-row')    as HTMLElement;
    const meanderRow = document.getElementById('river-meander-row') as HTMLElement;
    const carveRow   = document.getElementById('river-carve-row')   as HTMLElement;
    wireOptionGroup('#river-mode-group .brush-btn', btn => {
      if (this.waypointActive) this.cancelWaypoints();
      this.clearHover();
      this.mode = btn.dataset['riverMode'] as RiverMode;
      setInfoTipText(modeHeader, RIVER_HINTS[this.mode] ?? '');
      const m = this.mode;
      const draws = m !== 'reverse' && m !== 'erase';
      eraseScopeGroup.classList.toggle('hidden', m !== 'erase');
      lakeRow.classList.toggle('hidden', !draws);
      carveRow.classList.toggle('hidden', !draws);
      snapRow.classList.toggle('hidden', !(m === 'path' || m === 'straight' || m === 'waypoint'));
      meanderRow.classList.toggle('hidden', !(m === 'path' || m === 'straight'));
      ctx.updateCursor();
    });
    const meanderEl  = document.getElementById('river-meander')       as HTMLInputElement;
    const meanderVal = document.getElementById('river-meander-value') as HTMLElement;
    meanderEl.addEventListener('input', () => {
      this.meander = Math.max(0, parseInt(meanderEl.value, 10) || 0);
      meanderVal.textContent = this.meander === 0 ? 'off' : `±${this.meander} cell${this.meander === 1 ? '' : 's'}`;
      if (this.down && this.pathStart) this.updatePreview();
    });
    (document.getElementById('river-carve') as HTMLInputElement).addEventListener('input', e => {
      this.carve = Math.max(0, Math.min(32, parseInt((e.target as HTMLInputElement).value, 10) || 0));
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
      // Erase drags never snap — pulling an erase onto a river end you
      // didn't press would eat the very river you were working next to.
      this.pathStart = this.erasing ? { col: cell.col, row: cell.row } : this.snapStart(cell);
      this.currentPath = null;
      this.meanderSeed = Math.floor(this.rng() * 0x7fffffff);
      scene.setPathPreview([offsetToHex(this.pathStart.col, this.pathStart.row)], this.erasing);
      return;
    }
    if (this.mode === 'waypoint') {
      const start = this.waypoints.length === 0 ? this.snapStart(cell) : cell;
      this.waypoints.push({ col: start.col, row: start.row });
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

  private snapStart(cell: CellPos): CellPos {
    if (!this.snapToggle.checked) return { col: cell.col, row: cell.row };
    const scene = this.ctx.scene;
    return snapRiverStart(scene.map, t => scene.isWater(t), cell, (col, row) => scene.editable(col, row));
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
    let path: HexCoord[] | null;
    if (this.meander > 0 && !this.erasing) {
      // Legs are joined the way the mode would draw the whole line; a path
      // leg that finds no route falls back to the straight hex line, so the
      // preview never lies about what the release would lay.
      const join = this.mode === 'straight'
        ? hexLineDraw
        : (a: HexCoord, b: HexCoord): HexCoord[] =>
          computeCostPath(scene, a, b, this.costOptions(), endHex) ?? hexLineDraw(a, b);
      path = meanderPath(scene.map, startHex, endHex, this.meander, mulberry32(this.meanderSeed), join);
    } else {
      path = this.mode === 'straight'
        ? hexLineDraw(startHex, endHex)
        : computeCostPath(scene, startHex, endHex, this.costOptions(), endHex);
    }
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
      if (this.carve > 0) this.carveValley(tx, path);
      const water = this.lakeTerrain();
      for (const { col, row } of lake) {
        if (!scene.editable(col, row)) continue;
        tx.setTerrain(col, row, water);
        chunks.markDirty(col, row);
      }
    }

    this.ctx.commitEdit(tx.commit());
    // Territory borders and resource icons sit on the cell surface, so a
    // carved valley moves the ground under them.
    if (!erasing && this.carve > 0) scene.refreshGameplayLayers();
  }

  /**
   * Dig the valley under a new river: every land cell on the path drops by
   * the carve depth, and the land beside it — not river, not on the path —
   * by half, so the channel sits in a V rather than a slot. Masked cells
   * keep their height; the range floor is the map's own.
   */
  private carveValley(tx: MapTransaction, path: HexCoord[]): void {
    const scene = this.ctx.scene;
    const { map, chunks } = scene;
    const onPath = new Set<number>();
    const lower = (col: number, row: number, by: number): void => {
      if (!scene.editable(col, row) || scene.isWater(map.getTerrain(col, row))) return;
      const prev = map.getElevation(col, row);
      const next = Math.max(-128, prev - by);
      if (next === prev) return;
      tx.setElevation(col, row, next);
      chunks.markDirty(col, row);
    };
    for (const h of path) {
      const off = hexToOffset(h);
      if (!map.inBounds(off.col, off.row)) continue;
      onPath.add(this.cellKey(off.col, off.row));
      lower(off.col, off.row, this.carve);
    }
    const sides = Math.floor(this.carve / 2);
    if (sides === 0) return;
    const done = new Set<number>();
    for (const h of path) {
      const off = hexToOffset(h);
      for (let e = 0; e < 6; e++) {
        const nb = offsetNeighbor(off.col, off.row, EDGE_DIRS[e]);
        if (!map.inBounds(nb.col, nb.row)) continue;
        const key = this.cellKey(nb.col, nb.row);
        if (onPath.has(key) || done.has(key) || map.hasRiver(nb.col, nb.row)) continue;
        done.add(key);
        lower(nb.col, nb.row, sides);
      }
    }
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
    const shaping = [
      (this.mode === 'path' || this.mode === 'straight') && this.meander > 0 ? ` · meander ±${this.meander}` : '',
      this.mode !== 'reverse' && this.carve > 0 ? ` · carve ${this.carve}` : '',
    ].join('');
    if (this.pendingLake.length > 0) return `${base}${shaping} · ends on land · lake of ${this.pendingLake.length}`;
    return `${base}${shaping}`;
  }
}
