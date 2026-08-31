import { POINTY_TOP, hexRange, hexToOffset, offsetNeighbor, offsetToHex } from '@loyalj/hex-world';
import type { HexCoord, HexMap, MapTransaction } from '@loyalj/hex-world';
import { EDGE_DIRS, edgeBetween, hexDistance, hexLineDraw } from './hexPath.ts';
import { setInfoTipText } from '../ui/infoTips.ts';
import { wireOptionGroup } from '../ui/uiHelpers.ts';
import { computeCostPath } from './pathing.ts';
import type { PathCostOptions } from './pathing.ts';
import type { CellPos, Tool, ToolContext, ToolId } from './tool.ts';

type RoadMode = 'path' | 'straight' | 'waypoint' | 'edge' | 'erase';

const ROAD_MODE_LABELS: Record<RoadMode, string> = {
  path:     'pathfinding',
  straight: 'straight',
  waypoint: 'waypoints',
  edge:     'single edge',
  erase:    'erase',
};

const ROAD_HINTS: Record<RoadMode, string> = {
  path:     'Hold and drag to place. Shift to erase. Esc cancels.',
  straight: 'Hold and drag to place. Shift to erase. Esc cancels.',
  waypoint: 'Click to place waypoints. Double-click or Enter to commit. Esc cancels.',
  edge:     'Hover near a cell edge and click to add or remove that one road segment.',
  erase:    'Click or drag to remove roads from cells.',
};

/** How far (in hexes) a new road's start reaches for an existing road end. */
const SNAP_RADIUS = 2;

/** Number of road half-edges on a cell — exactly 1 marks a terminus. */
function roadDegree(map: HexMap, col: number, row: number): number {
  let n = 0;
  for (let e = 0; e < 6; e++) {
    if (map.hasRoadThroughEdge(col, row, e)) n++;
  }
  return n;
}

/**
 * Where a new road gesture should really start: the nearest road terminus (a
 * cell with exactly one road edge) within {@link SNAP_RADIUS} of the pressed
 * cell, so extending a network never leaves a one-cell gap. Pressing on a
 * cell that already carries roads never snaps — that press IS connected — and
 * cells the selection mask excludes are not candidates, because snapping
 * there would only move the start somewhere the write is refused.
 */
export function snapRoadStart(
  map: HexMap,
  cell: CellPos,
  allows: (col: number, row: number) => boolean,
): CellPos {
  if (!map.inBounds(cell.col, cell.row) || map.hasRoads(cell.col, cell.row)) return cell;
  const centerHex = offsetToHex(cell.col, cell.row);
  let best: CellPos | null = null;
  let bestDist = Infinity;
  for (const hex of hexRange(centerHex, SNAP_RADIUS)) {
    const off = hexToOffset(hex);
    if (!map.inBounds(off.col, off.row) || !allows(off.col, off.row)) continue;
    if (roadDegree(map, off.col, off.row) !== 1) continue;
    const d = hexDistance(centerHex, hex);
    if (d < bestDist) { bestDist = d; best = off; }
  }
  return best ?? cell;
}

/**
 * Road drawing in four modes: cost-pathed or straight drags (Shift erases
 * along the same line), clicked waypoints routed leg by leg through the
 * pathfinder, and a single-edge precision toggle. New roads snap their start
 * to a nearby road terminus so networks stay connected. Owns the
 * pathfinding-cost checkboxes, which the river tool also reads.
 */
export class RoadTool implements Tool {
  readonly id: ToolId = 'paint-road';
  readonly title = 'Road';
  readonly panel = document.getElementById('road-options') as HTMLElement;

  private readonly ctx: ToolContext;
  private readonly costElev    = document.getElementById('road-cost-elev')    as HTMLInputElement;
  private readonly costTerrain = document.getElementById('road-cost-terrain') as HTMLInputElement;
  private readonly costRoads   = document.getElementById('road-cost-roads')   as HTMLInputElement;
  private readonly snapToggle  = document.getElementById('road-snap')         as HTMLInputElement;

  private mode: RoadMode = 'path';
  private down = false;
  private erasing = false;
  private pathStart: CellPos | null = null;
  private currentPath: HexCoord[] | null = null;
  private waypoints: CellPos[] = [];
  private waypointActive = false;
  private eraseTx: MapTransaction | null = null;
  private eraseVisited = new Set<number>();

  constructor(ctx: ToolContext) {
    this.ctx = ctx;
    const costPanel  = document.getElementById('road-cost-options') as HTMLElement;
    const snapRow    = document.getElementById('road-snap-row') as HTMLElement;
    const modeHeader = document.getElementById('road-mode-header') as HTMLElement;
    wireOptionGroup('#road-mode-group .brush-btn', btn => {
      if (this.waypointActive) this.cancelWaypoints();
      this.mode = btn.dataset['roadMode'] as RoadMode;
      costPanel.classList.toggle('hidden', this.mode !== 'path' && this.mode !== 'waypoint');
      snapRow.classList.toggle('hidden', this.mode === 'edge' || this.mode === 'erase');
      setInfoTipText(modeHeader, ROAD_HINTS[this.mode]);
      this.ctx.scene.setPathPreview(null);
    });
  }

  /** The cost checkboxes' current state, shared with the river tool's path mode. */
  costOptions(): PathCostOptions {
    return {
      elevation: this.costElev.checked,
      terrain:   this.costTerrain.checked,
      roadBonus: this.costRoads.checked,
    };
  }

  brushRadius(): number { return 0; }

  pointerDown(cell: CellPos, e: PointerEvent): void {
    const scene = this.ctx.scene;
    if (this.mode === 'edge') {
      const hit = this.pickEdge(e);
      if (!hit) return;
      if (!scene.selection.allows(hit.col, hit.row) || !scene.selection.allows(hit.nb.col, hit.nb.row)) return;
      const placing = !scene.map.hasRoadThroughEdge(hit.col, hit.row, hit.edge);
      const tx = scene.map.beginEdit();
      for (const c of tx.setRoadEdge(hit.col, hit.row, hit.edge, placing, POINTY_TOP)) {
        scene.chunks.markDirty(c.col, c.row);
      }
      this.ctx.commitEdit(tx.commit());
      // Refresh the hover so its colour flips to what the NEXT click would do.
      this.previewEdge(hit);
      return;
    }
    if (this.mode === 'waypoint') {
      const start = this.waypoints.length === 0 ? this.snapStart(cell) : cell;
      this.waypoints.push({ col: start.col, row: start.row });
      this.waypointActive = true;
      scene.setPathPreview(this.computeWaypointPath(null), false);
      return;
    }
    if (this.mode === 'erase') {
      this.down = true;
      this.eraseTx = null;
      this.eraseVisited = new Set();
      this.eraseRoadsAt(cell.col, cell.row);
      return;
    }
    this.down = true;
    this.erasing = e.shiftKey;
    // Erase drags never snap — pulling an erase onto a terminus you didn't
    // press would eat the very road end you were working next to.
    this.pathStart = this.erasing ? { col: cell.col, row: cell.row } : this.snapStart(cell);
    this.currentPath = null;
    scene.setPathPreview([offsetToHex(this.pathStart.col, this.pathStart.row)], this.erasing);
  }

  pointerMove(cell: CellPos | null, e: PointerEvent): void {
    if (this.mode === 'edge') {
      const hit = cell ? this.pickEdge(e) : null;
      if (hit) this.previewEdge(hit);
      else this.ctx.scene.setPathPreview(null);
      return;
    }
    if (this.mode === 'waypoint') {
      if (this.waypointActive && cell) {
        this.ctx.scene.setPathPreview(this.computeWaypointPath(cell), false);
      }
      return;
    }
    if (!this.down) return;
    if (this.mode === 'erase') {
      if (cell) this.eraseRoadsAt(cell.col, cell.row);
      return;
    }
    this.erasing = e.shiftKey;
    this.updatePreview();
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
    if (this.currentPath && this.currentPath.length >= 2) {
      this.applyRoadPath(this.currentPath, !this.erasing);
    }
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
      if (this.down) { this.cancelDrag(); return true; }
      return false;
    }
    if (e.key === 'Enter' && this.mode === 'waypoint' && this.waypointActive) {
      this.commitWaypoints();
      return true;
    }
    return false;
  }

  deactivate(): void {
    if (this.waypointActive) this.cancelWaypoints();
    // A half-done erase stroke has already mutated the map — commit it so the
    // edges it cleared stay undoable.
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

  private snapStart(cell: CellPos): CellPos {
    if (!this.snapToggle.checked) return { col: cell.col, row: cell.row };
    const { map, selection } = this.ctx.scene;
    return snapRoadStart(map, cell, (col, row) => selection.allows(col, row));
  }

  /**
   * The pointer's nearest edge of the hovered cell, with its neighbour
   * resolved. Boundary edges (neighbour off-map) come back null — the drag
   * modes can't produce them either, and a half-edge stub isn't a road.
   */
  private pickEdge(e: PointerEvent): { col: number; row: number; edge: number; nb: CellPos } | null {
    const scene = this.ctx.scene;
    const hit = scene.pickEdge(e.clientX, e.clientY);
    if (!hit) return null;
    const nb = offsetNeighbor(hit.col, hit.row, EDGE_DIRS[hit.edge]);
    if (!scene.map.inBounds(nb.col, nb.row)) return null;
    return { ...hit, nb };
  }

  /**
   * Highlight one edge as the two-cell segment the click would write — red
   * (the erase tint) when the edge already carries a road and the click
   * would remove it.
   */
  private previewEdge(hit: { col: number; row: number; edge: number; nb: CellPos }): void {
    const scene = this.ctx.scene;
    const removing = scene.map.hasRoadThroughEdge(hit.col, hit.row, hit.edge);
    scene.setPathPreview(
      [offsetToHex(hit.col, hit.row), offsetToHex(hit.nb.col, hit.nb.row)],
      removing,
    );
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
    const path = this.mode === 'straight'
      ? hexLineDraw(startHex, endHex)
      : computeCostPath(scene, startHex, endHex, this.costOptions(), null);
    this.currentPath = path;
    scene.setPathPreview(path ?? [startHex], this.erasing);
  }

  /**
   * The full route through every placed waypoint (plus the cursor while it
   * hovers): each leg is cost-pathed like a drag in path mode, falling back
   * to the straight hex line when no route exists, so the preview never lies
   * about what a commit would place. Zero-length legs (repeated clicks on one
   * cell — a double-click's second press included) contribute nothing.
   */
  private computeWaypointPath(cursor: CellPos | null): HexCoord[] {
    const points = cursor ? [...this.waypoints, cursor] : [...this.waypoints];
    if (points.length === 0) return [];
    const hexes = points.map(p => offsetToHex(p.col, p.row));
    const result: HexCoord[] = [hexes[0]];
    for (let i = 0; i < hexes.length - 1; i++) {
      const a = hexes[i], b = hexes[i + 1];
      if (a.q === b.q && a.r === b.r) continue;
      const seg = computeCostPath(this.ctx.scene, a, b, this.costOptions(), null)
        ?? hexLineDraw(a, b);
      result.push(...seg.slice(1));
    }
    return result;
  }

  private commitWaypoints(): void {
    if (!this.waypointActive) return;
    const path = this.computeWaypointPath(null);
    if (path.length >= 2) this.applyRoadPath(path, true);
    this.cancelWaypoints();
  }

  private cancelWaypoints(): void {
    this.waypoints = [];
    this.waypointActive = false;
    this.ctx.scene.setPathPreview(null);
  }

  /**
   * Strip every road edge from one cell of an erase stroke. Edges lie between
   * two cells, so each is masked unless its far cell is also selected — same
   * rule as the drag modes. The whole stroke accumulates in one transaction,
   * committed at pointer-up.
   */
  private eraseRoadsAt(col: number, row: number): void {
    const scene = this.ctx.scene;
    if (!scene.selection.allows(col, row)) return;
    const key = row * scene.map.width + col;
    if (this.eraseVisited.has(key)) return;
    this.eraseVisited.add(key);
    if (!scene.map.hasRoads(col, row)) return;
    const tx = (this.eraseTx ??= scene.map.beginEdit());
    for (let e = 0; e < 6; e++) {
      if (!scene.map.hasRoadThroughEdge(col, row, e)) continue;
      const nb = offsetNeighbor(col, row, EDGE_DIRS[e]);
      if (scene.map.inBounds(nb.col, nb.row) && !scene.selection.allows(nb.col, nb.row)) continue;
      // Paired write keeps both half-edges in agreement.
      for (const c of tx.setRoadEdge(col, row, e, false, POINTY_TOP)) {
        scene.chunks.markDirty(c.col, c.row);
      }
    }
  }

  private applyRoadPath(path: HexCoord[], placing: boolean): void {
    const scene = this.ctx.scene;
    const tx = scene.map.beginEdit();
    for (let i = 0; i < path.length - 1; i++) {
      const a = hexToOffset(path[i]);
      const b = hexToOffset(path[i + 1]);
      // A straight fallback leg can zigzag one cell past the map border.
      if (!scene.map.inBounds(a.col, a.row) || !scene.map.inBounds(b.col, b.row)) continue;
      // An edge lies between two cells — masked unless both are selected.
      if (!scene.selection.allows(a.col, a.row) || !scene.selection.allows(b.col, b.row)) continue;
      const edge = edgeBetween(a.col, a.row, b.col, b.row);
      if (edge === null) continue;
      // Paired write keeps both half-edges in agreement.
      for (const c of tx.setRoadEdge(a.col, a.row, edge, placing, POINTY_TOP)) {
        scene.chunks.markDirty(c.col, c.row);
      }
    }
    this.ctx.commitEdit(tx.commit());
  }

  statusText(): string {
    return `Road · ${ROAD_MODE_LABELS[this.mode]}`;
  }
}
