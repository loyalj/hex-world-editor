import { floodRegion } from './hexPath.ts';
import { wireBrushGroup, wireOptionGroup } from '../ui/uiHelpers.ts';
import { BrushTool } from './brushTool.ts';
import { brushCells } from './tool.ts';
import type { CellPos, ToolContext, ToolId } from './tool.ts';

type TerrainMode = 'brush' | 'fill';

/**
 * Terrain paint: brush or flood fill, with an Alt+click eyedropper. Painting
 * land over underwater cells lifts them to elevation 0 so the shoreline
 * doesn't keep a drowned hole. Terrain locks are the editor-wide concern in
 * scene.locks — this tool only feels them through the shared editable() gate.
 */
export class TerrainTool extends BrushTool {
  readonly id: ToolId = 'paint-terrain';
  readonly title = 'Terrain';
  readonly panel = document.getElementById('terrain-options') as HTMLElement;
  readonly hasEyedropper = true;

  /**
   * Reflect an eyedropped terrain into the palette's swatch highlight. The
   * palette assigns this when it initializes; the tool never touches its DOM.
   */
  onTerrainSampled: (index: number) => void = () => {};

  private mode: TerrainMode = 'brush';
  private radius = 0;
  private _paintTerrain = 0;
  // Fill hover preview: the would-be flooded region shown before the click,
  // same mechanic as the selection wand's.
  private fillHover: CellPos | null = null;
  private fillHoverCount = 0;

  /** Terrain index the brush lays down. The palette UI reads and writes this. */
  get paintTerrain(): number { return this._paintTerrain; }
  set paintTerrain(index: number) {
    this._paintTerrain = index;
    // The palette is only clickable while this tool's panel is showing, so a
    // refresh here can't paint a preview over another tool's viewport.
    this.refreshFillPreview();
  }

  constructor(ctx: ToolContext) {
    super(ctx);
    wireBrushGroup('terrain-brush-group', r => {
      this.radius = r;
      ctx.syncBrushRadius();
    });
    const brushHeader = document.getElementById('terrain-brush-header') as HTMLElement;
    const brushGroup  = document.getElementById('terrain-brush-group') as HTMLElement;
    wireOptionGroup('#terrain-mode-group .scatter-type-btn', btn => {
      this.mode = btn.dataset['terrainMode'] as TerrainMode;
      const fill = this.mode === 'fill';
      brushHeader.classList.toggle('hidden', fill);
      brushGroup.classList.toggle('hidden', fill);
      this.refreshFillPreview();
      ctx.syncBrushRadius();
      ctx.updateCursor();
    });
  }

  /** Fill clicks target a single cell, so the hover footprint shrinks with it. */
  override brushRadius(): number { return this.mode === 'fill' ? 0 : this.radius; }
  wantsFillCursor(): boolean { return this.mode === 'fill'; }

  override pointerDown(cell: CellPos, e: PointerEvent): void {
    if (e.altKey) { this.eyedrop(cell, e); return; }
    if (this.mode === 'fill') { this.floodFill(cell.col, cell.row); return; }
    super.pointerDown(cell, e);
  }

  override pointerMove(cell: CellPos | null, e: PointerEvent): void {
    super.pointerMove(cell, e);
    if (this.mode === 'fill' && !this.down) this.updateFillPreview(cell);
  }

  override deactivate(): void {
    super.deactivate();
    this.clearFillPreview();
  }

  /** Alt+click samples the cell's terrain into the palette selection. */
  private eyedrop(cell: CellPos, e: PointerEvent): void {
    e.preventDefault();
    this.paintTerrain = this.ctx.scene.map.getTerrain(cell.col, cell.row);
    this.onTerrainSampled(this.paintTerrain);
  }

  protected applyCell(col: number, row: number): void {
    const { map, chunks } = this.ctx.scene;
    const prevTerrain = map.getTerrain(col, row);
    if (prevTerrain === this.paintTerrain) return;
    const prevElev = map.getElevation(col, row);
    const tx = (this.tx ??= map.beginEdit());
    tx.setTerrain(col, row, this.paintTerrain);
    if (!this.ctx.scene.isWater(this.paintTerrain) && this.ctx.scene.isWater(prevTerrain) && prevElev < 0) {
      tx.setElevation(col, row, 0);
    }
    chunks.markDirty(col, row);
  }

  /**
   * The region a fill click at this cell would paint. Mask and locks are a
   * wall to the flood: a protected start cell yields nothing, and the
   * traversal never crosses the boundary. Every region cell shares the source
   * terrain, so one editable() covers the lock for all. Empty too when the
   * region is already the paint terrain — the click would be a no-op, and the
   * preview shouldn't promise otherwise.
   */
  private fillRegion(startCol: number, startRow: number): CellPos[] {
    const scene = this.ctx.scene;
    const { map } = scene;
    if (!scene.editable(startCol, startRow)) return [];
    const sourceTerrain = map.getTerrain(startCol, startRow);
    if (sourceTerrain === this.paintTerrain) return [];
    return floodRegion(map.width, map.height, startCol, startRow,
      (col, row) => map.getTerrain(col, row) === sourceTerrain && scene.editable(col, row));
  }

  private floodFill(startCol: number, startRow: number): void {
    // Painting a cell means the same thing in both modes: applyCell carries
    // the drowned-cell elevation lift for the whole region.
    for (const { col, row } of this.fillRegion(startCol, startRow)) this.applyCell(col, row);
    if (this.tx) this.ctx.commitEdit(this.tx.commit());
    this.tx = null;
    // The region just took the paint terrain — the preview is stale until the
    // pointer moves again.
    this.clearFillPreview();
  }

  /** Recompute the fill hover preview for a cell; null hides it. */
  private updateFillPreview(cell: CellPos | null): void {
    if (!cell) {
      this.clearFillPreview();
      return;
    }
    if (this.fillHover && this.fillHover.col === cell.col && this.fillHover.row === cell.row) return;
    const region = this.fillRegion(cell.col, cell.row);
    this.fillHover = cell;
    this.fillHoverCount = region.length;
    this.ctx.scene.setSelectionPreview(region);
  }

  /** The mode or paint terrain changed — rebuild the preview under the cursor, or hide it. */
  private refreshFillPreview(): void {
    this.clearFillPreview();
    if (this.mode === 'fill') this.updateFillPreview(this.ctx.scene.hoveredCell);
  }

  private clearFillPreview(): void {
    if (!this.fillHover) return;
    this.fillHover = null;
    this.fillHoverCount = 0;
    this.ctx.scene.setSelectionPreview(null);
  }

  statusText(): string {
    const name = this.ctx.scene.terrainLookup.get(this.paintTerrain)?.name ?? String(this.paintTerrain);
    if (this.mode === 'fill') {
      const would = this.fillHoverCount > 0 ? ` · would paint ${this.fillHoverCount}` : '';
      return `${name} · fill${would}`;
    }
    return `${name} · brush ${brushCells(this.radius)}`;
  }
}
