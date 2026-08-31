import { hexToOffset, offsetNeighbor, offsetToHex } from '@loyalj/hex-world';
import type { HexCoord, MapTransaction } from '@loyalj/hex-world';
import { EDGE_DIRS, edgeBetween, hexLineDraw } from './hexPath.ts';
import { setInfoTipText } from '../ui/infoTips.ts';
import { wireOptionGroup } from '../ui/uiHelpers.ts';
import { computeCostPath } from './pathing.ts';
import type { PathCostOptions, TerrainView } from './pathing.ts';
import type { CellPos, Tool, ToolContext, ToolId } from './tool.ts';

type RiverMode = 'path' | 'straight' | 'waypoint' | 'downhill' | 'erase';

const RIVER_MODE_LABELS: Record<RiverMode, string> = {
  'path':     'path',
  'straight': 'straight',
  'waypoint': 'waypoints',
  'downhill': 'downhill trace',
  'erase':    'erase',
};

const RIVER_HINTS: Record<RiverMode, string> = {
  path:     'Hold and drag to place. Shift to erase. Esc cancels.',
  straight: 'Hold and drag to place. Shift to erase. Esc cancels.',
  waypoint: 'Click to place waypoints. Double-click or Enter to commit. Esc cancels.',
  downhill: 'Click a cell to auto-trace downhill to nearest water.',
  erase:    'Click or drag to remove rivers from cells.',
};

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
 * River drawing in five modes: cost-pathed or straight drags (Shift erases
 * along the path), clicked waypoints, one-click downhill tracing, and a
 * per-cell erase brush that detaches confluences cleanly.
 */
export class RiverTool implements Tool {
  readonly id: ToolId = 'paint-river';
  readonly title = 'River';
  readonly panel = document.getElementById('river-options') as HTMLElement;

  private readonly ctx: ToolContext;
  /** The road panel's cost checkboxes — path mode shares the road pathfinder. */
  private readonly costOptions: () => PathCostOptions;

  private mode: RiverMode = 'path';
  private down = false;
  private erasing = false;
  private pathStart: CellPos | null = null;
  private currentPath: HexCoord[] | null = null;
  private waypoints: CellPos[] = [];
  private waypointActive = false;
  private eraseTx: MapTransaction | null = null;
  private eraseVisited = new Set<number>();

  constructor(ctx: ToolContext, costOptions: () => PathCostOptions) {
    this.ctx = ctx;
    this.costOptions = costOptions;
    const modeHeader = document.getElementById('river-mode-header')!;
    wireOptionGroup('#river-mode-group .brush-btn', btn => {
      if (this.waypointActive) this.cancelWaypoints();
      this.mode = btn.dataset['riverMode'] as RiverMode;
      setInfoTipText(modeHeader, RIVER_HINTS[this.mode] ?? '');
    });
  }

  brushRadius(): number { return 0; }

  private cellKey(col: number, row: number): number {
    return row * this.ctx.scene.map.width + col;
  }

  pointerDown(cell: CellPos, e: PointerEvent): void {
    const scene = this.ctx.scene;
    if (this.mode === 'path' || this.mode === 'straight') {
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
      scene.setPathPreview(this.computeWaypointPath(null), false);
      return;
    }
    if (this.mode === 'downhill') {
      const path = traceDownhill(scene, cell.col, cell.row);
      if (path.length >= 2) this.applyRiverPath(path, false);
      return;
    }
    // erase
    this.down = true;
    this.eraseTx = null;
    this.eraseVisited = new Set();
    this.eraseRiverAt(cell.col, cell.row);
  }

  pointerMove(cell: CellPos | null, e: PointerEvent): void {
    // Waypoint river preview runs even without pointer down
    if (this.mode === 'waypoint' && this.waypointActive) {
      if (cell) this.ctx.scene.setPathPreview(this.computeWaypointPath(cell), false);
      return;
    }
    if (!this.down) return;
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
      if (this.eraseTx) this.ctx.commitEdit(this.eraseTx.commit());
      this.eraseTx = null;
      this.eraseVisited = new Set();
      return;
    }
    if (this.currentPath) this.applyRiverPath(this.currentPath, this.erasing);
    this.ctx.scene.setPathPreview(null);
    this.pathStart = null;
    this.currentPath = null;
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
    if (this.eraseTx) {
      this.ctx.commitEdit(this.eraseTx.commit());
      this.eraseTx = null;
      this.eraseVisited = new Set();
    }
    this.cancelDrag();
  }

  private cancelDrag(): void {
    this.ctx.scene.setPathPreview(null);
    this.pathStart = null;
    this.currentPath = null;
    this.down = false;
  }

  private updatePreview(): void {
    if (!this.pathStart) return;
    const scene = this.ctx.scene;
    const end = scene.hoveredCell ?? this.pathStart;
    const startHex = offsetToHex(this.pathStart.col, this.pathStart.row);
    const endHex   = offsetToHex(end.col, end.row);
    if (end.col === this.pathStart.col && end.row === this.pathStart.row) {
      this.currentPath = null;
      scene.setPathPreview([startHex], this.erasing);
      return;
    }
    let path = this.mode === 'straight'
      ? hexLineDraw(startHex, endHex)
      : computeCostPath(scene, startHex, endHex, this.costOptions(), endHex);
    if (path && !this.erasing) path = trimRiverPathAtWater(scene, path);
    this.currentPath = path;
    scene.setPathPreview(path ?? [startHex], this.erasing);
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
      this.applyRiverPath(this.computeWaypointPath(null), false);
    }
    this.cancelWaypoints();
  }

  private cancelWaypoints(): void {
    this.waypoints = [];
    this.waypointActive = false;
    this.ctx.scene.setPathPreview(null);
  }

  private applyRiverPath(path: HexCoord[], erasing: boolean): void {
    if (path.length < 2) return;
    const { map, chunks, selection } = this.ctx.scene;
    const tx = map.beginEdit();
    // River channels live on the edges between cells, so like roads a segment
    // is masked unless both of its endpoint cells are selected. Consistency
    // repairs on cells just outside (detaching a replaced downstream edge)
    // still run — they're consequences of an allowed write, and leaving them
    // out would strand half-edges.
    const segmentAllowed = (a: CellPos, b: CellPos): boolean =>
      selection.allows(a.col, a.row) && selection.allows(b.col, b.row);

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
    }

    this.ctx.commitEdit(tx.commit());
  }

  private eraseRiverAt(col: number, row: number): void {
    if (!this.ctx.scene.selection.allows(col, row)) return;
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
    return `River · ${RIVER_MODE_LABELS[this.mode]}`;
  }
}
