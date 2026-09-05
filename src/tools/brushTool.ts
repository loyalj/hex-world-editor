import { hexRange, hexToOffset, offsetToHex } from '@loyalj/hex-world';
import type { MapTransaction } from '@loyalj/hex-world';
import { hexLineDraw } from './hexPath.ts';
import type { CellPos, Tool, ToolContext, ToolId } from './tool.ts';
import type { WeightedCell } from './brushFootprint.ts';

/**
 * Base for the stamp-under-the-cursor tools (terrain, elevation, scatter,
 * territory, resources, fog). Owns the stroke lifecycle: one library
 * transaction per stroke, a visited set so a drag touches each cell once,
 * stamps along the hex line between successive pointer positions so a fast
 * drag leaves no gaps, Shift+click to stamp a straight line from where the
 * previous stroke ended, and the commit on pointer-up that turns the stroke
 * into a single undo step.
 *
 * Subclasses implement {@link applyCell} for one cell and may open the shared
 * transaction with `this.tx ??= map.beginEdit()` — a tool that never opens one
 * (fog) simply commits nothing.
 */
export abstract class BrushTool implements Tool {
  abstract readonly id: ToolId;
  abstract readonly title: string;
  abstract readonly panel: HTMLElement;

  protected readonly ctx: ToolContext;
  /** The stroke's transaction, opened lazily by the first cell that changes. */
  protected tx: MapTransaction | null = null;
  private visited = new Set<number>();
  /**
   * Set by applyCell when it writes ownership/resource data or moves ground
   * under the overlays; flushed once per stamp rather than once per cell.
   */
  protected gameplayDirty = false;
  /** Mid-stroke flag — subclasses with hover previews check it to stay quiet while painting. */
  protected down = false;
  /** Where the stroke last stamped — the line to the next pointer position starts here. */
  private lastCell: CellPos | null = null;
  /** Where the previous stroke ended — a Shift+click stamps a line from here. */
  private strokeAnchor: CellPos | null = null;
  /** Source of the paint-probability rolls; tests swap in a deterministic one. */
  protected rng: () => number = Math.random;

  constructor(ctx: ToolContext) {
    this.ctx = ctx;
  }

  brushRadius(): number { return 0; }

  protected cellKey(col: number, row: number): number {
    return row * this.ctx.scene.map.width + col;
  }

  /** Sample targets (flatten/contour) before the first stamp of a stroke. */
  protected beginStroke(_cell: CellPos): void {}

  /** Apply the tool to one in-bounds cell. Runs at most once per cell per stroke. */
  protected abstract applyCell(col: number, row: number): void;

  /**
   * The cells one stamp reaches, with each cell's chance of painting. The
   * default is the filled hex of {@link brushRadius}, every cell certain;
   * shaped and soft brushes override it.
   */
  protected footprint(cell: CellPos): WeightedCell[] {
    return hexRange(offsetToHex(cell.col, cell.row), this.brushRadius())
      .map(hex => ({ ...hexToOffset(hex), weight: 1 }));
  }

  /**
   * Shift+click stamps the straight hex line from the previous stroke's end
   * to this cell, the image-editor convention; the anchor cell is stamped
   * again, which is harmless (a fresh stroke, and applyCell skips no-ops).
   * Without an anchor — first stroke, or after a tool switch — Shift is
   * just a click.
   */
  pointerDown(cell: CellPos, e: PointerEvent): void {
    this.down = true;
    this.tx = null;
    this.visited = new Set();
    this.beginStroke(cell);
    const anchor = e.shiftKey ? this.strokeAnchor : null;
    if (anchor) {
      const line = hexLineDraw(offsetToHex(anchor.col, anchor.row), offsetToHex(cell.col, cell.row));
      for (const hex of line) this.stamp(hexToOffset(hex));
    } else {
      this.stamp(cell);
    }
    this.lastCell = cell;
    this.afterStamps();
  }

  /**
   * Pointer events arrive per frame, so a quick drag can jump several cells
   * between them. Stamping every cell on the hex line from the previous
   * position closes those gaps; the visited set keeps the overlap free.
   */
  pointerMove(cell: CellPos | null, _e: PointerEvent): void {
    if (!this.down || !cell) return;
    const from = this.lastCell;
    if (from && from.col === cell.col && from.row === cell.row) return;
    if (from) {
      const line = hexLineDraw(offsetToHex(from.col, from.row), offsetToHex(cell.col, cell.row));
      for (let i = 1; i < line.length; i++) this.stamp(hexToOffset(line[i]));
    } else {
      this.stamp(cell);
    }
    this.lastCell = cell;
    this.afterStamps();
  }

  /**
   * The per-cell write gate: selection mask plus terrain locks. Tools whose
   * edits aren't map content (fog) override this to drop the lock check.
   */
  protected cellEditable(col: number, row: number): boolean {
    return this.ctx.scene.editable(col, row);
  }

  /**
   * Apply the brush footprint centred on a cell, masked by {@link cellEditable}.
   * A cell with a fractional weight gets one roll per stroke: whether it
   * passes or fails, it's visited, so dragging back and forth over a soft rim
   * doesn't quietly fill it in. Pure map writes — the per-event feedback is
   * {@link afterStamps}, so a line of stamps flushes once.
   */
  protected stamp(cell: CellPos): void {
    const { map } = this.ctx.scene;
    for (const { col, row, weight } of this.footprint(cell)) {
      if (col < 0 || col >= map.width || row < 0 || row >= map.height) continue;
      if (!this.cellEditable(col, row)) continue;
      const key = this.cellKey(col, row);
      if (this.visited.has(key)) continue;
      this.visited.add(key);
      if (weight < 1 && this.rng() >= weight) continue;
      this.applyCell(col, row);
    }
  }

  /** Once per pointer event, after its stamps: overlay refresh and minimap. */
  private afterStamps(): void {
    this.flushGameplay();
    // Mid-stroke feedback: the stroke only commits (and so only reaches
    // history.onChange) on pointer-up. The minimap throttles its own redraws.
    this.ctx.minimapInvalidate();
  }

  protected flushGameplay(): void {
    if (!this.gameplayDirty) return;
    this.gameplayDirty = false;
    this.ctx.scene.refreshGameplayLayers();
  }

  pointerUp(): void {
    if (!this.down) return;
    this.down = false;
    if (this.tx) this.ctx.commitEdit(this.tx.commit());
    this.flushGameplay();
    this.tx = null;
    this.visited = new Set();
    this.strokeAnchor = this.lastCell;
    this.lastCell = null;
    this.endStroke();
  }

  /** Per-tool cleanup after a stroke commits. */
  protected endStroke(): void {}

  deactivate(): void {
    // Finish rather than abandon a half-made stroke: its transaction has
    // already mutated the map live, so committing is what keeps undo honest.
    this.pointerUp();
    // A line back to where another tool session left off would surprise.
    this.strokeAnchor = null;
  }

  abstract statusText(): string;
}
