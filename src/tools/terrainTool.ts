import { floodRegion } from './hexPath.ts';
import { wireOptionGroup } from '../ui/uiHelpers.ts';
import { wireBrushControls } from '../ui/brushControls.ts';
import type { BrushControls } from '../ui/brushControls.ts';
import { BrushTool } from './brushTool.ts';
import { BRUSH_SHAPE_LABELS, brushFootprint, brushReach, expectedCells, solidCells } from './brushFootprint.ts';
import type { BrushSettings, WeightedCell } from './brushFootprint.ts';
import type { CellPos, ToolContext, ToolId } from './tool.ts';
import type { TerrainDescriptor } from '@loyalj/hex-world';

/**
 * Connected components of the map under one fill matcher: every editable
 * cell's component label, each component's cells, and the class (terrain
 * index, or liquid/solid, or in-set) its cells share. Built once per
 * (matcher, scene revision) and served to every hover until either changes.
 */
interface FillIndex {
  key: string;
  labels: Int32Array;
  components: CellPos[][];
  classes: number[];
}

type TerrainMode = 'brush' | 'fill';
/** What a fill click counts as "the same terrain". */
type FillMatch = 'exact' | 'category' | 'set' | 'elevation';

const FILL_MATCH_LABELS: Record<FillMatch, string> = {
  exact:     'exact',
  category:  'category',
  set:       'custom',
  elevation: 'elevation',
};

/**
 * Terrain paint: brush or flood fill, with an Alt+click eyedropper. The brush
 * comes in three shapes (solid, ring, spray) at any radius up to
 * MAX_BRUSH_RADIUS, sized by a slider or the bracket keys; solid brushes can
 * soften their rim with the hardness slider. The fill matches the clicked
 * terrain exactly, its whole category (solid or liquid), a custom set of
 * terrains, or the clicked cell's elevation within a tolerance, over the
 * connected region or the whole map. Painting land over underwater
 * cells lifts them to elevation 0 so the shoreline doesn't keep a drowned
 * hole. Terrain locks are the editor-wide concern in scene.locks — this tool
 * only feels them through the shared editable() gate.
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
  private readonly brushControls: BrushControls;
  private _paintTerrain = 0;
  // Fill hover preview: the would-be flooded region shown before the click,
  // same mechanic as the selection wand's.
  private fillHover: CellPos | null = null;
  private fillHoverCount = 0;
  private fillMatch: FillMatch = 'exact';
  private fillContiguous = true;
  /** Elevation match: |elev − clicked| ≤ tolerance. */
  private fillTolerance = 0;
  /** Terrains the custom match fills; empty falls back to the clicked terrain. */
  private readonly fillSet = new Set<number>();
  private fillIndex: FillIndex | null = null;
  /** Bumped when the custom set or the roster changes — part of the index key. */
  private fillSetGeneration = 0;
  /** How many times the fill index was (re)built — a diagnostic the tests read. */
  private fillIndexBuilds = 0;

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
    this.brushControls = wireBrushControls('terrain', () => ctx.syncBrushRadius());

    const fillSetGrid  = document.getElementById('terrain-fill-set') as HTMLElement;
    const toleranceRow = document.getElementById('terrain-fill-tolerance-row') as HTMLElement;
    wireOptionGroup('#terrain-fill-match-group .scatter-type-btn', btn => {
      this.fillMatch = btn.dataset['fillMatch'] as FillMatch;
      fillSetGrid.classList.toggle('hidden', this.fillMatch !== 'set');
      toleranceRow.classList.toggle('hidden', this.fillMatch !== 'elevation');
      this.refreshFillPreview();
    });
    (document.getElementById('terrain-fill-tolerance') as HTMLInputElement).addEventListener('input', e => {
      this.fillTolerance = Math.max(0, parseInt((e.target as HTMLInputElement).value, 10) || 0);
      this.refreshFillPreview();
    });
    (document.getElementById('terrain-fill-contiguous') as HTMLInputElement)
      .addEventListener('change', e => {
        this.fillContiguous = (e.target as HTMLInputElement).checked;
        this.refreshFillPreview();
      });

    const brushHeader = document.getElementById('terrain-brush-header') as HTMLElement;
    const brushGroup  = document.getElementById('terrain-brush-group') as HTMLElement;
    const fillGroup   = document.getElementById('terrain-fill-group') as HTMLElement;
    wireOptionGroup('#terrain-mode-group .scatter-type-btn', btn => {
      this.mode = btn.dataset['terrainMode'] as TerrainMode;
      const fill = this.mode === 'fill';
      brushHeader.classList.toggle('hidden', fill);
      brushGroup.classList.toggle('hidden', fill);
      fillGroup.classList.toggle('hidden', !fill);
      this.refreshFillPreview();
      ctx.syncBrushRadius();
      ctx.updateCursor();
    });
  }

  /**
   * Rebuild the custom-set chips from the roster. The palette calls this
   * whenever the descriptors change; ticks survive for terrains that still
   * exist.
   */
  refreshFillSet(descriptors: TerrainDescriptor[]): void {
    const group = document.getElementById('terrain-fill-set') as HTMLElement;
    group.innerHTML = '';
    const live = new Set(descriptors.map(d => d.index));
    for (const index of [...this.fillSet]) if (!live.has(index)) this.fillSet.delete(index);
    for (const desc of descriptors) {
      const btn = document.createElement('button');
      btn.className = 'terrain-filter-btn';
      btn.title = desc.name;
      btn.style.background = `#${desc.color.toString(16).padStart(6, '0')}`;
      btn.classList.toggle('active', this.fillSet.has(desc.index));
      btn.addEventListener('click', () => {
        if (this.fillSet.has(desc.index)) this.fillSet.delete(desc.index);
        else this.fillSet.add(desc.index);
        btn.classList.toggle('active', this.fillSet.has(desc.index));
        this.fillSetGeneration++;
        this.refreshFillPreview();
      });
      group.appendChild(btn);
    }
    this.fillSetGeneration++;
  }

  /** The live brush settings — shape, radius, hardness, density. */
  private get brush(): BrushSettings { return this.brushControls.settings; }

  /** The brush radius in cells (0 = single cell). The size slider writes this. */
  get radius(): number { return this.brush.radius; }
  setRadius(radius: number): void { this.brushControls.setRadius(radius); }

  /** Fill clicks target a single cell, so the hover footprint shrinks with it. */
  override brushRadius(): number { return this.mode === 'fill' ? 0 : this.brush.radius; }
  wantsFillCursor(): boolean { return this.mode === 'fill'; }

  /** The hover outline follows the shape: a ring shows only its band. */
  hoverFootprint(cell: CellPos): CellPos[] {
    if (this.mode === 'fill') return [cell];
    return brushReach(cell, this.brush);
  }

  protected override footprint(cell: CellPos): WeightedCell[] {
    return brushFootprint(cell, this.brush);
  }

  /** `[` and `]` step the brush size while brushing. */
  keyDown(e: KeyboardEvent): boolean {
    return this.mode === 'brush' && this.brushControls.keyDown(e);
  }

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
   * The class a fill treats as "the same ground": the terrain index for an
   * exact fill (or a custom fill with nothing ticked), liquid-or-solid for a
   * category fill, in-set-or-not for a custom fill, the elevation for an
   * elevation fill. Every class partitions the map, so connected components
   * of equal class can be indexed once and looked up per hover.
   */
  private fillClass(): (col: number, row: number) => number {
    const scene = this.ctx.scene;
    const { map } = scene;
    if (this.fillMatch === 'elevation') return (col, row) => map.getElevation(col, row);
    if (this.fillMatch === 'category') return (col, row) => (scene.isWater(map.getTerrain(col, row)) ? 1 : 0);
    if (this.fillMatch === 'set' && this.fillSet.size > 0) {
      return (col, row) => (this.fillSet.has(map.getTerrain(col, row)) ? 1 : 0);
    }
    return (col, row) => map.getTerrain(col, row);
  }

  /**
   * The connected components under the current matcher, rebuilt only when
   * the matcher or the scene revision changes. Mask and locks are walls: a
   * protected cell belongs to no component and the traversal never crosses
   * it. A hover then costs one lookup instead of one flood.
   */
  private fillComponents(): FillIndex {
    const scene = this.ctx.scene;
    const { map } = scene;
    const key = `${this.fillMatch}|${this.fillSetGeneration}|${scene.revision}|${map.width}x${map.height}`;
    if (this.fillIndex?.key === key) return this.fillIndex;
    const cls = this.fillClass();
    const labels = new Int32Array(map.width * map.height).fill(-1);
    const components: CellPos[][] = [];
    const classes: number[] = [];
    for (let row = 0; row < map.height; row++) {
      for (let col = 0; col < map.width; col++) {
        if (labels[row * map.width + col] >= 0 || !scene.editable(col, row)) continue;
        const c = cls(col, row);
        const label = components.length;
        const cells = floodRegion(map.width, map.height, col, row, (cc, rr) =>
          labels[rr * map.width + cc] < 0 && cls(cc, rr) === c && scene.editable(cc, rr));
        for (const cell of cells) labels[cell.row * map.width + cell.col] = label;
        components.push(cells);
        classes.push(c);
      }
    }
    this.fillIndexBuilds++;
    return (this.fillIndex = { key, labels, components, classes });
  }

  /**
   * The region a fill click at this cell would paint: the clicked cell's
   * component, or map-wide every component of its class. Cells already
   * holding the paint terrain still carry the flood (they join two lakes in a
   * category fill) but drop out of the result: the click wouldn't change
   * them, and the preview shouldn't promise otherwise. A custom fill needs
   * the clicked cell in the set — the cells outside it form components too,
   * but they're what the fill flows around, not what it paints. An elevation
   * fill with a tolerance is a band around the clicked height rather than a
   * class, so it floods directly instead of reading the index.
   */
  private fillRegion(startCol: number, startRow: number): CellPos[] {
    const scene = this.ctx.scene;
    const { map } = scene;
    const notPaint = ({ col, row }: CellPos): boolean => map.getTerrain(col, row) !== this.paintTerrain;
    if (this.fillMatch === 'elevation' && this.fillTolerance > 0) {
      return this.elevationBand(startCol, startRow).filter(notPaint);
    }
    const index = this.fillComponents();
    const custom = this.fillMatch === 'set' && this.fillSet.size > 0;
    const clicked = this.fillClass()(startCol, startRow);
    // A custom fill's class is "in the set" — map-wide that's what it paints
    // wherever the click lands; contiguous it must start on a set cell.
    const c = custom ? 1 : clicked;
    let region: CellPos[];
    if (this.fillContiguous) {
      if (clicked !== c) return [];
      const label = index.labels[startRow * map.width + startCol];
      if (label < 0) return [];
      region = index.components[label];
    } else {
      region = [];
      index.components.forEach((cells, i) => { if (index.classes[i] === c) region.push(...cells); });
    }
    return region.filter(notPaint);
  }

  /** Cells within the tolerance of the clicked cell's elevation, connected to it or map-wide. */
  private elevationBand(startCol: number, startRow: number): CellPos[] {
    const scene = this.ctx.scene;
    const { map } = scene;
    if (!scene.editable(startCol, startRow)) return [];
    const elev = map.getElevation(startCol, startRow);
    const matches = (col: number, row: number): boolean =>
      Math.abs(map.getElevation(col, row) - elev) <= this.fillTolerance && scene.editable(col, row);
    if (this.fillContiguous) return floodRegion(map.width, map.height, startCol, startRow, matches);
    const cells: CellPos[] = [];
    for (let row = 0; row < map.height; row++) {
      for (let col = 0; col < map.width; col++) if (matches(col, row)) cells.push({ col, row });
    }
    return cells;
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
      const scope = this.fillContiguous ? 'fill' : 'fill all';
      const tolerance = this.fillMatch === 'elevation' && this.fillTolerance > 0 ? ` ±${this.fillTolerance}` : '';
      const match = this.fillMatch === 'exact' ? '' : ` · ${FILL_MATCH_LABELS[this.fillMatch]}${tolerance}`;
      return `${name} · ${scope}${match}${would}`;
    }
    const n = expectedCells(this.brush);
    const count = this.brush.shape === 'spray' ? `~${n} of ${solidCells(this.brush.radius)}` : String(n);
    const hovered = this.ctx.scene.hoveredCell;
    const would = hovered
      ? ` · would paint ${this.brush.shape === 'spray' ? 'up to ' : ''}${this.wouldPaint(hovered)}`
      : '';
    return `${name} · ${BRUSH_SHAPE_LABELS[this.brush.shape]} ${count}${would}`;
  }

  /**
   * How many cells a click here would actually change: the footprint less
   * what's off the map, masked, locked, or already the paint terrain. The
   * fill's "would paint" made the same promise; the brush's count shouldn't
   * quote a footprint the mask then swallows.
   */
  private wouldPaint(center: CellPos): number {
    const scene = this.ctx.scene;
    const { map } = scene;
    let n = 0;
    for (const { col, row } of brushReach(center, this.brush)) {
      if (!map.inBounds(col, row) || !scene.editable(col, row)) continue;
      if (map.getTerrain(col, row) !== this.paintTerrain) n++;
    }
    return n;
  }
}
