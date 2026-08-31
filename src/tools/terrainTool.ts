import { floodRegion } from './hexPath.ts';
import { wireBrushGroup, wireOptionGroup } from '../ui/uiHelpers.ts';
import { BrushTool } from './brushTool.ts';
import { brushCells } from './tool.ts';
import type { CellPos, ToolContext, ToolId } from './tool.ts';

type TerrainMode = 'brush' | 'fill';

/**
 * Terrain paint: brush or flood fill, with per-swatch locks and an Alt+click
 * eyedropper. Painting land over underwater cells lifts them to elevation 0 so
 * the shoreline doesn't keep a drowned hole.
 */
export class TerrainTool extends BrushTool {
  readonly id: ToolId = 'paint-terrain';
  readonly title = 'Terrain';
  readonly panel = document.getElementById('terrain-options') as HTMLElement;
  readonly hasEyedropper = true;

  /** Terrain index the brush lays down. The palette UI reads and writes this. */
  paintTerrain = 0;
  /** Locked terrain indices cannot be painted over. Shared with the palette UI. */
  readonly lockedTerrains = new Set<number>();

  private mode: TerrainMode = 'brush';
  private radius = 0;

  constructor(ctx: ToolContext) {
    super(ctx);
    wireBrushGroup('terrain-brush-group', r => {
      this.radius = r;
      ctx.syncBrushRadius();
    });
    wireOptionGroup('#terrain-mode-group .scatter-type-btn', btn => {
      this.mode = btn.dataset['terrainMode'] as TerrainMode;
      ctx.updateCursor();
    });
  }

  override brushRadius(): number { return this.radius; }
  wantsFillCursor(): boolean { return this.mode === 'fill'; }

  override pointerDown(cell: CellPos, e: PointerEvent): void {
    if (e.altKey) { this.eyedrop(cell, e); return; }
    if (this.mode === 'fill') { this.floodFill(cell.col, cell.row); return; }
    super.pointerDown(cell, e);
  }

  /** Alt+click samples the cell's terrain into the palette selection. */
  private eyedrop(cell: CellPos, e: PointerEvent): void {
    e.preventDefault();
    const sampled = this.ctx.scene.map.getTerrain(cell.col, cell.row);
    this.paintTerrain = sampled;
    document.querySelectorAll<HTMLElement>('#terrain-type-group .swatch-row').forEach(b => {
      b.classList.toggle('active', b.dataset['terrain'] === String(sampled));
    });
  }

  protected applyCell(col: number, row: number): void {
    const { map, chunks } = this.ctx.scene;
    const prevTerrain = map.getTerrain(col, row);
    if (prevTerrain === this.paintTerrain) return;
    if (this.lockedTerrains.has(prevTerrain)) return;
    const prevElev = map.getElevation(col, row);
    const tx = (this.tx ??= map.beginEdit());
    tx.setTerrain(col, row, this.paintTerrain);
    if (!this.ctx.scene.isWater(this.paintTerrain) && this.ctx.scene.isWater(prevTerrain) && prevElev < 0) {
      tx.setElevation(col, row, 0);
    }
    chunks.markDirty(col, row);
  }

  private floodFill(startCol: number, startRow: number): void {
    const { map, chunks, selection } = this.ctx.scene;
    // The selection mask is a wall to the flood: clicking outside it is a
    // no-op, and the traversal never crosses the boundary.
    if (!selection.allows(startCol, startRow)) return;
    const sourceTerrain = map.getTerrain(startCol, startRow);
    if (sourceTerrain === this.paintTerrain) return;
    if (this.lockedTerrains.has(sourceTerrain)) return;

    const region = floodRegion(map.width, map.height, startCol, startRow,
      (col, row) => map.getTerrain(col, row) === sourceTerrain && selection.allows(col, row));
    const tx = map.beginEdit();
    for (const { col, row } of region) {
      const prevElev = map.getElevation(col, row);
      tx.setTerrain(col, row, this.paintTerrain);
      if (!this.ctx.scene.isWater(this.paintTerrain) && this.ctx.scene.isWater(sourceTerrain) && prevElev < 0) {
        tx.setElevation(col, row, 0);
      }
      chunks.markDirty(col, row);
    }
    this.ctx.commitEdit(tx.commit());
  }

  statusText(): string {
    const name = this.ctx.scene.terrainLookup.get(this.paintTerrain)?.name ?? String(this.paintTerrain);
    const footprint = this.mode === 'brush' ? `brush ${brushCells(this.radius)}` : 'fill';
    return `${name} · ${footprint}`;
  }
}
