import { hexRange, hexToOffset, offsetToHex } from '@loyalj/hex-world';
import type { MapTransaction } from '@loyalj/hex-world';
import type { CellPos, Tool, ToolContext, ToolId } from './tool.ts';

/**
 * Base for the stamp-under-the-cursor tools (terrain, elevation, scatter,
 * territory, resources, fog). Owns the stroke lifecycle: one library
 * transaction per stroke, a visited set so a drag touches each cell once, and
 * the commit on pointer-up that turns the stroke into a single undo step.
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
  private down = false;

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

  pointerDown(cell: CellPos, _e: PointerEvent): void {
    this.down = true;
    this.tx = null;
    this.visited = new Set();
    this.beginStroke(cell);
    this.stamp(cell);
  }

  pointerMove(cell: CellPos | null, _e: PointerEvent): void {
    if (!this.down || !cell) return;
    this.stamp(cell);
  }

  /** Apply the brush footprint centred on a cell, masked by the selection. */
  protected stamp(cell: CellPos): void {
    const { map, selection } = this.ctx.scene;
    for (const hex of hexRange(offsetToHex(cell.col, cell.row), this.brushRadius())) {
      const off = hexToOffset(hex);
      if (off.col < 0 || off.col >= map.width || off.row < 0 || off.row >= map.height) continue;
      if (!selection.allows(off.col, off.row)) continue;
      const key = this.cellKey(off.col, off.row);
      if (this.visited.has(key)) continue;
      this.visited.add(key);
      this.applyCell(off.col, off.row);
    }
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
    this.endStroke();
  }

  /** Per-tool cleanup after a stroke commits. */
  protected endStroke(): void {}

  deactivate(): void {
    // Finish rather than abandon a half-made stroke: its transaction has
    // already mutated the map live, so committing is what keeps undo honest.
    this.pointerUp();
  }

  abstract statusText(): string;
}
