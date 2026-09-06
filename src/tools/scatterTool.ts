import type { TerrainDescriptor, ScatterDescriptor } from '@loyalj/hex-world';
import { floodRegion } from './hexPath.ts';
import { wireBrushGroup, wireOptionGroup } from '../ui/uiHelpers.ts';
import { BrushTool } from './brushTool.ts';
import { brushCells } from './tool.ts';
import type { CellPos, ToolContext, ToolId } from './tool.ts';

type ScatterMode = 'brush' | 'fill';

export const DENSITY_LABELS = ['none', 'sparse', 'medium', 'dense'];
export { SCATTER_LAYER_NAMES } from '../scatterRoster.ts';
import { SCATTER_LAYER_NAMES, defaultScatter } from '../scatterRoster.ts';

/**
 * Scatter density paint across the four feature layers, filtered by elevation
 * band and (optionally) terrain type. Density −1 means "random 1–3 per cell";
 * Alt+click samples a cell's density on the active layer.
 */
export class ScatterTool extends BrushTool {
  readonly id: ToolId = 'paint-scatter';
  readonly title = 'Scatter';
  readonly panel = document.getElementById('scatter-options') as HTMLElement;
  readonly hasEyedropper = true;

  private layer = 0;      // Pines
  private level = 1;      // Sparse
  private mode: ScatterMode = 'brush';
  private radius = 0;
  private elevMin = -128;
  private elevMax = 127;
  private readonly terrainFilter = new Set<number>();
  private readonly densityBtns: NodeListOf<HTMLButtonElement>;

  constructor(ctx: ToolContext) {
    super(ctx);
    // A scene that carries no roster (test fakes) gets the editor defaults.
    this.refreshTypes(ctx.scene.scatterDescriptors ?? defaultScatter().descriptors);
    this.densityBtns = wireOptionGroup('#density-group .density-btn', btn => {
      this.level = parseInt(btn.dataset['density']!, 10);
    });
    wireBrushGroup('scatter-brush-group', r => {
      this.radius = r;
      ctx.syncBrushRadius();
    });
    wireOptionGroup('#scatter-mode-group .scatter-type-btn', btn => {
      this.mode = btn.dataset['scatterMode'] as ScatterMode;
      ctx.updateCursor();
    });

    (document.getElementById('scatter-elev-min') as HTMLInputElement).addEventListener('input', e => {
      this.elevMin = Math.max(-128, Math.min(127, parseInt((e.target as HTMLInputElement).value, 10)));
      if (this.elevMin > this.elevMax) this.elevMax = this.elevMin;
    });
    (document.getElementById('scatter-elev-max') as HTMLInputElement).addEventListener('input', e => {
      this.elevMax = Math.max(-128, Math.min(127, parseInt((e.target as HTMLInputElement).value, 10)));
      if (this.elevMax < this.elevMin) this.elevMin = this.elevMax;
    });
  }

  /**
   * Rebuild the type buttons from the roster — one per scatter type, each
   * painting its own layer. Called at start and whenever the builder changes
   * the set; the active layer is kept if a type still paints it.
   */
  refreshTypes(descriptors: readonly ScatterDescriptor[]): void {
    const group = document.getElementById('scatter-type-group')!;
    group.innerHTML = '';
    if (!descriptors.some(d => d.layerIndex === this.layer)) this.layer = descriptors[0]?.layerIndex ?? 0;
    for (const d of descriptors) {
      const btn = document.createElement('button');
      btn.className = 'scatter-type-btn';
      btn.dataset['scatterLayer'] = String(d.layerIndex);
      btn.textContent = d.name;
      btn.title = `Paints density on feature layer ${d.layerIndex}`;
      btn.classList.toggle('active', d.layerIndex === this.layer);
      group.appendChild(btn);
    }
    wireOptionGroup('#scatter-type-group .scatter-type-btn', btn => {
      this.layer = parseInt(btn.dataset['scatterLayer']!, 10);
    });
  }

  /** Rebuild the terrain-filter chips. Called whenever the palette changes. */
  refreshTerrainFilter(descriptors: TerrainDescriptor[]): void {
    const group = document.getElementById('scatter-terrain-filter')!;
    group.innerHTML = '';
    for (const desc of descriptors) {
      const btn = document.createElement('button');
      btn.className = 'terrain-filter-btn';
      btn.title = desc.name;
      btn.style.background = `#${desc.color.toString(16).padStart(6, '0')}`;
      if (this.terrainFilter.has(desc.index)) btn.classList.add('active');
      btn.addEventListener('click', () => {
        if (this.terrainFilter.has(desc.index)) {
          this.terrainFilter.delete(desc.index);
          btn.classList.remove('active');
        } else {
          this.terrainFilter.add(desc.index);
          btn.classList.add('active');
        }
      });
      group.appendChild(btn);
    }
  }

  override brushRadius(): number { return this.radius; }
  wantsFillCursor(): boolean { return this.mode === 'fill'; }

  override pointerDown(cell: CellPos, e: PointerEvent): void {
    if (e.altKey) { this.eyedrop(cell, e); return; }
    if (this.mode === 'fill') { this.floodFill(cell.col, cell.row); return; }
    super.pointerDown(cell, e);
  }

  /** Alt+click samples density on the active layer into the density picker. */
  private eyedrop(cell: CellPos, e: PointerEvent): void {
    e.preventDefault();
    const sampled = this.ctx.scene.map.getFeatureLevel(cell.col, cell.row, this.layer);
    this.level = sampled;
    this.densityBtns.forEach(b => {
      b.classList.toggle('active', b.dataset['density'] === String(sampled));
    });
  }

  private nextLevel(): number {
    return this.level < 0 ? (Math.floor(Math.random() * 3) + 1) : this.level;
  }

  protected applyCell(col: number, row: number): void {
    const { map, chunks } = this.ctx.scene;
    const elev = map.getElevation(col, row);
    if (elev < this.elevMin || elev > this.elevMax) return;
    if (this.terrainFilter.size > 0 && !this.terrainFilter.has(map.getTerrain(col, row))) return;
    const next = this.nextLevel();
    const prev = map.getFeatureLevel(col, row, this.layer);
    if (prev === next) return;
    (this.tx ??= map.beginEdit()).setFeatureLevel(col, row, this.layer, next);
    chunks.markDirty(col, row);
  }

  private floodFill(startCol: number, startRow: number): void {
    const scene = this.ctx.scene;
    const { map, chunks } = scene;
    // Same rule as the terrain flood: the mask and lock boundary is a wall.
    if (!scene.editable(startCol, startRow)) return;
    const sourceTerrain = map.getTerrain(startCol, startRow);
    if (this.terrainFilter.size > 0 && !this.terrainFilter.has(sourceTerrain)) return;

    const region = floodRegion(map.width, map.height, startCol, startRow,
      (col, row) => map.getTerrain(col, row) === sourceTerrain && scene.editable(col, row));
    const tx = map.beginEdit();
    for (const { col, row } of region) {
      const elev = map.getElevation(col, row);
      if (elev < this.elevMin || elev > this.elevMax) continue;
      const next = this.nextLevel();
      if (map.getFeatureLevel(col, row, this.layer) === next) continue;
      tx.setFeatureLevel(col, row, this.layer, next);
      chunks.markDirty(col, row);
    }
    this.ctx.commitEdit(tx.commit());
  }

  statusText(): string {
    const layer   = SCATTER_LAYER_NAMES[this.layer] ?? `Layer ${this.layer}`;
    const density = this.level < 0 ? 'random' : DENSITY_LABELS[this.level];
    const footprint = this.mode === 'brush' ? `brush ${brushCells(this.radius)}` : 'fill';
    return `${layer} · ${density} · ${footprint}`;
  }
}
