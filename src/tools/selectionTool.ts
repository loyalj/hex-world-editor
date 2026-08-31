import { hexRange, hexToWorld, offsetToHex, hexToOffset } from '@loyalj/hex-world';
import { floodRegion, hexLineDraw } from './hexPath.ts';
import { selectionOpFor } from '../selection.ts';
import type { SelectionOp } from '../selection.ts';
import { wireBrushGroup, wireOptionGroup } from '../ui/uiHelpers.ts';
import type { CellPos, Tool, ToolContext, ToolId } from './tool.ts';

type SelectMode = 'pointer' | 'wand' | 'rect' | 'lasso';
type WandMatch = 'terrain' | 'elevation';

/**
 * Builds the selection mask — and only that: this tool never edits the map.
 * Four sub-tools share the modifier convention (Shift adds, Alt subtracts,
 * plain click replaces): a pointer that clicks or drag-paints cells, a magic
 * wand matching the clicked cell's terrain or elevation (contiguous region or
 * map-wide, with an elevation tolerance), a drag-rectangle, and a freehand
 * lasso. Esc cancels a drag in progress, or clears the selection. The
 * selection survives tool switches — it exists to constrain the other tools.
 */
export class SelectionTool implements Tool {
  readonly id: ToolId = 'select';
  readonly title = 'Selection';
  readonly panel = document.getElementById('selection-options') as HTMLElement;
  /** Selecting is how the mask is *made* — its own clicks are never confined. */
  readonly ignoresSelectionMask = true;

  private readonly ctx: ToolContext;
  private mode: SelectMode = 'pointer';
  /** Pointer-mode brush radius (0 = single cell) — other modes ignore it. */
  private pointerRadius = 0;
  private wandMatch: WandMatch = 'terrain';
  /** Wand flood vs map-wide scan. */
  private contiguous = true;
  /** Elevation-mode wand match window: |elev − clicked| ≤ tolerance. */
  private tolerance = 0;
  /** Captured at pointer-down so mid-drag modifier changes don't flip the gesture. */
  private dragOp: SelectionOp = 'replace';
  private dragging = false;
  /** Rectangle corners: where the drag started and the cell under the pointer now. */
  private anchor: CellPos | null = null;
  private dragEnd: CellPos | null = null;
  /** Lasso outline in drag order, gap-bridged so fast moves stay a closed loop. */
  private lassoPath: CellPos[] = [];
  /** Last cell the pointer drag painted, so hover jitter doesn't re-apply it. */
  private lastPainted: CellPos | null = null;
  /**
   * Pointer-mode intersect buffers its stroke here and applies on release —
   * intersecting live with each single cell would collapse the selection to
   * that cell on the first move.
   */
  private strokeCells: CellPos[] = [];
  // Wand hover preview: the would-be region shown before the click commits.
  private wandHover: CellPos | null = null;
  private wandHoverSubtract = false;
  private wandHoverCount = 0;

  constructor(ctx: ToolContext) {
    this.ctx = ctx;
    const wandSection    = document.getElementById('wand-match-section') as HTMLElement;
    const toleranceRow   = document.getElementById('wand-tolerance-row') as HTMLElement;
    const pointerSection = document.getElementById('pointer-brush-section') as HTMLElement;
    wireOptionGroup('#selection-mode-group .brush-btn', btn => {
      this.mode = btn.dataset['selectMode'] as SelectMode;
      pointerSection.classList.toggle('hidden', this.mode !== 'pointer');
      wandSection.classList.toggle('hidden', this.mode !== 'wand');
      this.refreshWandPreview();
      ctx.syncBrushRadius();
      ctx.updateCursor();
    });
    wireBrushGroup('selection-brush-group', radius => {
      this.pointerRadius = radius;
      ctx.syncBrushRadius();
    });
    wireOptionGroup('#wand-match-group .scatter-type-btn', btn => {
      this.wandMatch = btn.dataset['wandMatch'] as WandMatch;
      toleranceRow.classList.toggle('hidden', this.wandMatch !== 'elevation');
      this.refreshWandPreview();
    });
    (document.getElementById('wand-contiguous') as HTMLInputElement)
      .addEventListener('change', e => {
        this.contiguous = (e.target as HTMLInputElement).checked;
        this.refreshWandPreview();
      });
    (document.getElementById('wand-tolerance') as HTMLInputElement)
      .addEventListener('input', e => {
        this.tolerance = Math.max(0, Math.min(127, parseInt((e.target as HTMLInputElement).value, 10) || 0));
        this.refreshWandPreview();
      });

    const sel = () => ctx.scene.selection;
    const map = () => ctx.scene.map;
    (document.getElementById('selection-all-btn') as HTMLButtonElement)
      .addEventListener('click', () => sel().selectAll(map().width, map().height));
    (document.getElementById('selection-invert-btn') as HTMLButtonElement)
      .addEventListener('click', () => sel().invert(map().width, map().height));
    (document.getElementById('selection-grow-btn') as HTMLButtonElement)
      .addEventListener('click', () => sel().grow(map().width, map().height));
    (document.getElementById('selection-shrink-btn') as HTMLButtonElement)
      .addEventListener('click', () => sel().shrink(map().width, map().height));
    (document.getElementById('selection-clear-btn') as HTMLButtonElement)
      .addEventListener('click', () => sel().clear());
  }

  brushRadius(): number { return this.mode === 'pointer' ? this.pointerRadius : 0; }
  wantsFillCursor(): boolean { return this.mode === 'wand'; }

  pointerDown(cell: CellPos, e: PointerEvent): void {
    const op = selectionOpFor(e);
    switch (this.mode) {
      case 'pointer':
        // A plain drag paints a fresh selection: the first cell replaced it,
        // the rest of the stroke adds. Modified drags keep their operation.
        this.dragging = true;
        this.dragOp = op === 'replace' ? 'add' : op;
        this.lastPainted = cell;
        if (op === 'intersect') {
          this.strokeCells = this.footprint(cell);
          this.preview(this.strokeCells);
        } else {
          // One gesture per stroke: the whole drag is a single undo step.
          this.ctx.scene.selection.beginGesture();
          this.ctx.scene.selection.apply(this.footprint(cell), op);
        }
        break;
      case 'wand':
        this.ctx.scene.selection.apply(this.wandRegion(cell), op);
        // The committed selection now shows the region — drop the preview
        // until the pointer moves again.
        this.clearWandPreview();
        break;
      case 'rect':
        this.dragging = true;
        this.dragOp = op;
        this.anchor = cell;
        this.dragEnd = cell;
        this.preview(this.rectCells());
        break;
      case 'lasso':
        this.dragging = true;
        this.dragOp = op;
        this.lassoPath = [cell];
        this.preview(this.lassoPath);
        break;
    }
  }

  pointerMove(cell: CellPos | null, e: PointerEvent): void {
    if (!this.dragging) {
      // Hover preview: show what the wand would select before the click, so
      // tuning the match options doesn't take trial-and-error clicks.
      if (this.mode === 'wand') this.updateWandPreview(cell, e.altKey && !e.shiftKey);
      return;
    }
    if (!cell) return;
    if (this.mode === 'pointer') {
      if (this.lastPainted && this.lastPainted.col === cell.col && this.lastPainted.row === cell.row) return;
      this.lastPainted = cell;
      if (this.dragOp === 'intersect') {
        this.strokeCells.push(...this.footprint(cell));
        this.preview(this.strokeCells);
      } else {
        this.ctx.scene.selection.apply(this.footprint(cell), this.dragOp);
      }
    } else if (this.mode === 'rect') {
      this.dragEnd = cell;
      this.preview(this.rectCells());
    } else if (this.mode === 'lasso') {
      const last = this.lassoPath[this.lassoPath.length - 1];
      if (last.col === cell.col && last.row === cell.row) return;
      // Bridge the hex line between samples so a fast pointer sweep still
      // leaves a connected outline for the fill test to close.
      const bridge = hexLineDraw(offsetToHex(last.col, last.row), offsetToHex(cell.col, cell.row));
      for (let i = 1; i < bridge.length; i++) this.lassoPath.push(hexToOffset(bridge[i]));
      this.preview(this.lassoPath);
    }
  }

  pointerUp(): void {
    if (!this.dragging) return;
    if (this.mode === 'pointer') {
      // Add/subtract strokes applied as they went; intersect commits now.
      const op = this.dragOp;
      const stroke = this.strokeCells;
      this.cancelDrag();
      if (op === 'intersect') this.ctx.scene.selection.apply(stroke, op);
      return;
    }
    const op = this.dragOp;
    const cells = this.mode === 'rect' ? this.rectCells() : this.lassoCells();
    this.cancelDrag();
    this.ctx.scene.selection.apply(cells, op);
  }

  keyDown(e: KeyboardEvent): boolean {
    if (e.key !== 'Escape') return false;
    if (this.dragging) {
      this.cancelDrag();
      return true;
    }
    if (this.ctx.scene.selection.size > 0) {
      this.ctx.scene.selection.clear();
      return true;
    }
    return false;
  }

  deactivate(): void {
    // Abandon any half-made gesture; the committed selection itself stays —
    // it is the mask the other tools work under.
    this.cancelDrag();
  }

  private cancelDrag(): void {
    this.dragging = false;
    this.anchor = null;
    this.dragEnd = null;
    this.lassoPath = [];
    this.lastPainted = null;
    this.strokeCells = [];
    this.wandHover = null;
    this.wandHoverCount = 0;
    // Close any open stroke gesture — every drag exit (release, Escape, tool
    // switch) funnels through here, so a part-done stroke still commits its
    // one undo step rather than being lost.
    this.ctx.scene.selection.endGesture();
    this.ctx.scene.setSelectionPreview(null);
  }

  /** Recompute the wand hover preview for a cell; null hides it. */
  private updateWandPreview(cell: CellPos | null, subtract: boolean): void {
    if (!cell) {
      this.clearWandPreview();
      return;
    }
    if (this.wandHover && this.wandHover.col === cell.col && this.wandHover.row === cell.row
      && this.wandHoverSubtract === subtract) return;
    const region = this.wandRegion(cell);
    this.wandHover = cell;
    this.wandHoverSubtract = subtract;
    this.wandHoverCount = region.length;
    this.ctx.scene.setSelectionPreview(region, subtract);
  }

  /** A wand option changed — rebuild the preview under the cursor, or hide it. */
  private refreshWandPreview(): void {
    this.clearWandPreview();
    if (this.mode === 'wand') this.updateWandPreview(this.ctx.scene.hoveredCell, this.wandHoverSubtract);
  }

  private clearWandPreview(): void {
    if (!this.wandHover) return;
    this.wandHover = null;
    this.wandHoverCount = 0;
    this.ctx.scene.setSelectionPreview(null);
  }

  private preview(cells: CellPos[]): void {
    this.ctx.scene.setSelectionPreview(cells, this.dragOp === 'subtract');
  }

  /** The pointer brush's cells around a center, clipped to the map. */
  private footprint(cell: CellPos): CellPos[] {
    if (this.pointerRadius === 0) return [cell];
    const { map } = this.ctx.scene;
    return hexRange(offsetToHex(cell.col, cell.row), this.pointerRadius)
      .map(hexToOffset)
      .filter(c => map.inBounds(c.col, c.row));
  }

  private wandRegion(cell: CellPos): CellPos[] {
    const { map } = this.ctx.scene;
    const matches = this.wandPredicate(cell);
    if (this.contiguous) {
      return floodRegion(map.width, map.height, cell.col, cell.row, matches);
    }
    // Map-wide: every matching cell, connected or not.
    const cells: CellPos[] = [];
    for (let row = 0; row < map.height; row++) {
      for (let col = 0; col < map.width; col++) {
        if (matches(col, row)) cells.push({ col, row });
      }
    }
    return cells;
  }

  private wandPredicate(cell: CellPos): (col: number, row: number) => boolean {
    const { map } = this.ctx.scene;
    if (this.wandMatch === 'terrain') {
      const terrain = map.getTerrain(cell.col, cell.row);
      return (col, row) => map.getTerrain(col, row) === terrain;
    }
    const elev = map.getElevation(cell.col, cell.row);
    const tolerance = this.tolerance;
    return (col, row) => Math.abs(map.getElevation(col, row) - elev) <= tolerance;
  }

  /** Every cell in the offset-space rectangle spanned by anchor and dragEnd. */
  private rectCells(): CellPos[] {
    if (!this.anchor || !this.dragEnd) return [];
    const c0 = Math.min(this.anchor.col, this.dragEnd.col);
    const c1 = Math.max(this.anchor.col, this.dragEnd.col);
    const r0 = Math.min(this.anchor.row, this.dragEnd.row);
    const r1 = Math.max(this.anchor.row, this.dragEnd.row);
    const cells: CellPos[] = [];
    for (let row = r0; row <= r1; row++) {
      for (let col = c0; col <= c1; col++) cells.push({ col, row });
    }
    return cells;
  }

  /** The outline cells plus every cell whose center falls inside the closed loop. */
  private lassoCells(): CellPos[] {
    const { map, layout } = this.ctx.scene;
    // Too short to enclose anything — treat the stroke as a painted path.
    if (this.lassoPath.length < 3) return this.lassoPath.slice();
    const poly = this.lassoPath.map(c => hexToWorld(layout, offsetToHex(c.col, c.row)));
    const outline = new Set(this.lassoPath.map(c => (c.row << 16) | c.col));
    const cells: CellPos[] = [];
    for (let row = 0; row < map.height; row++) {
      for (let col = 0; col < map.width; col++) {
        if (outline.has((row << 16) | col)) {
          cells.push({ col, row });
          continue;
        }
        const p = hexToWorld(layout, offsetToHex(col, row));
        if (pointInPolygon(p.x, p.z, poly)) cells.push({ col, row });
      }
    }
    return cells;
  }

  statusText(): string {
    const n = this.ctx.scene.selection.size;
    const count = n === 0 ? 'no selection' : n === 1 ? '1 cell' : `${n} cells`;
    const wand = this.mode === 'wand' && this.wandHoverCount > 0
      ? ` · wand would ${this.wandHoverSubtract ? 'remove' : 'select'} ${this.wandHoverCount}`
      : '';
    return `${count}${wand} · Shift adds · Alt removes · Shift+Alt intersects`;
  }
}

/** Even-odd ray cast on the ground plane (x, z). */
function pointInPolygon(x: number, z: number, poly: Array<{ x: number; z: number }>): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if ((a.z > z) !== (b.z > z) && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}
