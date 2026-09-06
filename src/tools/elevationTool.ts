import { hexRange, hexToOffset, offsetNeighbor, offsetToHex } from '@loyalj/hex-world';
import type { HexCoord } from '@loyalj/hex-world';
import { EDGE_DIRS, floodRegion, hexDistance, hexLineDraw } from './hexPath.ts';
import { wireOptionGroup } from '../ui/uiHelpers.ts';
import { wireBrushControls } from '../ui/brushControls.ts';
import type { BrushControls } from '../ui/brushControls.ts';
import { BRUSH_SHAPE_LABELS, brushFootprint, brushReach, expectedCells, solidCells } from './brushFootprint.ts';
import type { WeightedCell } from './brushFootprint.ts';
import { BrushTool } from './brushTool.ts';
import type { CellPos, ToolContext, ToolId } from './tool.ts';

type ElevMode = 'raise-lower' | 'smooth' | 'flatten' | 'noise' | 'set-absolute' | 'terrace' | 'slope' | 'erosion';
/** How a slope ramp climbs from its start height to its end height. */
export type RampProfile = 'linear' | 'smooth' | 'ease-in' | 'ease-out';
/** Whether an op lands under the brush or over a filled region. */
type ElevScope = 'brush' | 'fill';
/** What a fill click counts as "the same ground". */
type ElevFillMatch = 'elevation' | 'terrain' | 'selection';

const ELEV_MODE_LABELS: Record<ElevMode, string> = {
  'raise-lower':  'raise / lower',
  'smooth':       'smooth',
  'flatten':      'flatten',
  'noise':        'noise',
  'set-absolute': 'set absolute',
  'terrace':      'terrace',
  'slope':        'slope ramp',
  'erosion':      'erosion',
};

/** The ramp's climb as a function of line position, 0 → 0 and 1 → 1 in every profile. */
export function rampProfile(profile: RampProfile, t: number): number {
  switch (profile) {
    case 'smooth':   return t * t * (3 - 2 * t);
    case 'ease-in':  return t * t;
    case 'ease-out': return 1 - (1 - t) * (1 - t);
    default:         return t;
  }
}

/**
 * Elevation editing in eight modes. Six are stamps (raise/lower, smooth,
 * flatten, noise, set absolute, terrace — heights snapped to a step); slope
 * is a drag that ramps a band of cells between its endpoints, as wide as
 * the ramp width and climbing along the chosen profile; erosion is a
 * per-click multi-pass slump. Every mode but slope applies either under the
 * brush — solid, ring, or spray at any radius, with a soft rim — or, in fill
 * scope, across a region matching the clicked cell's elevation (within a
 * tolerance) or terrain, contiguous or map-wide, with a hover preview of the
 * region. Ctrl held at stroke start snaps the brush to cells at the starting
 * contour.
 */
export class ElevationTool extends BrushTool {
  readonly id: ToolId = 'elevation';
  readonly title = 'Elevation';
  readonly panel = document.getElementById('elevation-options') as HTMLElement;
  readonly hasEyedropper = true;

  private mode: ElevMode = 'raise-lower';
  private scope: ElevScope = 'brush';
  private step = 1;
  private flattenTarget = 0;
  private setTarget = 0;
  private terraceStep = 4;
  private rampWidth = 0;
  private rampProfile: RampProfile = 'linear';
  private rangeMin = -128;
  private rangeMax = 127;
  private readonly brush: BrushControls;
  private contourSnapHeld = false;
  private contourLevel: number | null = null;
  private readonly modeBtns: NodeListOf<HTMLButtonElement>;

  // Slope-drag state
  private slopeDown = false;
  private pathStart: CellPos | null = null;
  private currentPath: HexCoord[] | null = null;
  /** Whether the ramp band is showing as a selection preview, so it can be cleared. */
  private rampBandShown = false;

  // Fill scope: the match and the hover preview, the terrain fill's mechanic.
  private fillMatch: ElevFillMatch = 'elevation';
  private fillTolerance = 0;
  private fillContiguous = true;
  private fillHover: CellPos | null = null;
  private fillHoverCount = 0;

  constructor(ctx: ToolContext) {
    super(ctx);
    this.brush = wireBrushControls('elev', () => ctx.syncBrushRadius());
    wireOptionGroup('#elev-step-group .brush-btn', btn => {
      this.step = parseInt(btn.dataset['step']!, 10);
      this.refreshFillPreview();
    });
    this.modeBtns = wireOptionGroup('#elev-mode-group .density-btn', btn => {
      if (this.mode === 'slope') this.cancelSlope();
      this.mode = btn.dataset['elevMode'] as ElevMode;
      this.updateSectionVisibility();
      this.refreshFillPreview();
      ctx.syncBrushRadius();
    });

    const slopeBtn = this.panel.querySelector<HTMLButtonElement>('[data-elev-mode="slope"]')!;
    wireOptionGroup('#elev-scope-group .scatter-type-btn', btn => {
      this.scope = btn.dataset['elevScope'] as ElevScope;
      const fill = this.scope === 'fill';
      // A slope is a drag between two points — there's no region to fill it
      // over. Fill scope parks it, and the mode falls back to raise/lower.
      slopeBtn.disabled = fill;
      if (fill && this.mode === 'slope') this.setMode('raise-lower');
      this.updateSectionVisibility();
      this.refreshFillPreview();
      ctx.syncBrushRadius();
      ctx.updateCursor();
    });

    (document.getElementById('elev-terrace-step') as HTMLInputElement).addEventListener('input', e => {
      this.terraceStep = Math.max(1, Math.min(64, parseInt((e.target as HTMLInputElement).value, 10) || 1));
      this.refreshFillPreview();
    });
    const rampWidthEl  = document.getElementById('elev-ramp-width')       as HTMLInputElement;
    const rampWidthVal = document.getElementById('elev-ramp-width-value') as HTMLElement;
    rampWidthEl.addEventListener('input', () => {
      this.rampWidth = Math.max(0, parseInt(rampWidthEl.value, 10) || 0);
      const wide = 2 * this.rampWidth + 1;
      rampWidthVal.textContent = wide === 1 ? '1 cell' : `${wide} cells wide`;
      this.refreshSlopePreview();
    });
    wireOptionGroup('#elev-ramp-profile-group .scatter-type-btn', btn => {
      this.rampProfile = btn.dataset['rampProfile'] as RampProfile;
    });

    const toleranceRow  = document.getElementById('elev-fill-tolerance-row') as HTMLElement;
    const contiguousRow = document.getElementById('elev-fill-contiguous-row') as HTMLElement;
    wireOptionGroup('#elev-fill-match-group .scatter-type-btn', btn => {
      this.fillMatch = btn.dataset['fillMatch'] as ElevFillMatch;
      toleranceRow.classList.toggle('hidden', this.fillMatch !== 'elevation');
      // A selection fill is the whole selection wherever the click lands — connectedness doesn't enter into it.
      contiguousRow.classList.toggle('hidden', this.fillMatch === 'selection');
      this.refreshFillPreview();
    });
    (document.getElementById('elev-fill-tolerance') as HTMLInputElement).addEventListener('input', e => {
      this.fillTolerance = Math.max(0, parseInt((e.target as HTMLInputElement).value, 10) || 0);
      this.refreshFillPreview();
    });
    (document.getElementById('elev-fill-contiguous') as HTMLInputElement).addEventListener('change', e => {
      this.fillContiguous = (e.target as HTMLInputElement).checked;
      this.refreshFillPreview();
    });

    (document.getElementById('elev-set-target') as HTMLInputElement).addEventListener('input', e => {
      this.setTarget = Math.max(-128, Math.min(127, parseInt((e.target as HTMLInputElement).value, 10) || 0));
      this.refreshFillPreview();
    });
    (document.getElementById('elev-range-min') as HTMLInputElement).addEventListener('input', e => {
      this.rangeMin = Math.max(-128, Math.min(127, parseInt((e.target as HTMLInputElement).value, 10)));
      if (this.rangeMin > this.rangeMax) this.rangeMax = this.rangeMin;
      this.refreshFillPreview();
    });
    (document.getElementById('elev-range-max') as HTMLInputElement).addEventListener('input', e => {
      this.rangeMax = Math.max(-128, Math.min(127, parseInt((e.target as HTMLInputElement).value, 10)));
      if (this.rangeMax < this.rangeMin) this.rangeMin = this.rangeMax;
      this.refreshFillPreview();
    });

    // Raw window listeners rather than the manager's guarded routing: the snap
    // has to release even when focus sits in a text field, exactly as before.
    window.addEventListener('keydown', e => {
      if (e.key === 'Control') this.contourSnapHeld = true;
    });
    window.addEventListener('keyup', e => {
      if (e.key === 'Control') { this.contourSnapHeld = false; this.contourLevel = null; }
    });
  }

  /** Switch the op programmatically (eyedropper, fill parking slope) and sweep the buttons. */
  private setMode(mode: ElevMode): void {
    this.mode = mode;
    this.modeBtns.forEach(b => b.classList.toggle('active', b.dataset['elevMode'] === mode));
    this.updateSectionVisibility();
  }

  /** Show only the controls the mode and scope read: each op's own row, the brush or the fill options, the ramp for slope. */
  private updateSectionVisibility(): void {
    const show = (id: string, on: boolean): void => { document.getElementById(id)!.classList.toggle('hidden', !on); };
    const fill  = this.scope === 'fill';
    const slope = this.mode === 'slope';
    show('elev-step-header',    this.mode === 'raise-lower');
    show('elev-step-group',     this.mode === 'raise-lower');
    show('elev-set-target-row', this.mode === 'set-absolute');
    show('elev-terrace-row',    this.mode === 'terrace');
    show('elev-ramp-group',     slope && !fill);
    show('elev-brush-header',   !fill && !slope);
    show('elev-brush-group',    !fill && !slope);
    show('elev-fill-group',     fill);
  }

  /** The brush radius in cells; the size slider and bracket keys write it. */
  get radius(): number { return this.brush.settings.radius; }
  setRadius(radius: number): void { this.brush.setRadius(radius); }

  /** Only a brush-scope stamp has a footprint; fills and slopes target one cell. */
  private get stamps(): boolean { return this.scope === 'brush' && this.mode !== 'slope'; }

  override brushRadius(): number { return this.stamps ? this.radius : 0; }
  wantsFillCursor(): boolean { return this.scope === 'fill'; }

  /** The hover outline follows the shape: a ring shows only its band. */
  hoverFootprint(cell: CellPos): CellPos[] {
    return this.stamps ? brushReach(cell, this.brush.settings) : [cell];
  }

  protected override footprint(cell: CellPos): WeightedCell[] {
    return brushFootprint(cell, this.brush.settings);
  }

  override pointerDown(cell: CellPos, e: PointerEvent): void {
    if (e.altKey && this.mode !== 'slope' && this.mode !== 'erosion') {
      this.eyedrop(cell, e);
      return;
    }
    if (this.scope === 'fill') {
      this.fillApply(cell);
      return;
    }
    if (this.mode === 'slope') {
      this.slopeDown = true;
      this.pathStart = cell;
      this.currentPath = null;
      this.ctx.scene.setPathPreview([offsetToHex(cell.col, cell.row)], false);
      return;
    }
    if (this.mode === 'erosion') {
      this.applyErosion(this.inBounds(brushReach(cell, this.brush.settings)));
      return;
    }
    super.pointerDown(cell, e);
  }

  /** Alt+click samples the cell's elevation into the flatten/set-absolute targets. */
  private eyedrop(cell: CellPos, e: PointerEvent): void {
    e.preventDefault();
    const sampled = this.ctx.scene.map.getElevation(cell.col, cell.row);
    this.setTarget = sampled;
    this.flattenTarget = sampled;
    (document.getElementById('elev-set-target') as HTMLInputElement).value = String(sampled);
    if (this.mode !== 'set-absolute' && this.mode !== 'flatten') this.setMode('set-absolute');
    this.refreshFillPreview();
  }

  protected override beginStroke(cell: CellPos): void {
    const { map } = this.ctx.scene;
    if (this.mode === 'flatten') this.flattenTarget = map.getElevation(cell.col, cell.row);
    if (this.contourSnapHeld)    this.contourLevel  = map.getElevation(cell.col, cell.row);
  }

  /**
   * The op's result for one cell, clamped to the range lock. Noise is a
   * random step; the preview asks with `forPreview` and gets a value that is
   * simply "different", so the count promises every cell the noise touches.
   */
  private nextElevation(col: number, row: number, prev: number, forPreview = false): number {
    const { map } = this.ctx.scene;
    let next: number;
    if (this.mode === 'raise-lower') {
      next = prev + this.step;
    } else if (this.mode === 'smooth') {
      let sum = prev, count = 1;
      for (let dir = 0; dir < 6; dir++) {
        const nb = offsetNeighbor(col, row, EDGE_DIRS[dir]);
        if (nb.col >= 0 && nb.col < map.width && nb.row >= 0 && nb.row < map.height) {
          sum += map.getElevation(nb.col, nb.row);
          count++;
        }
      }
      next = Math.round(sum / count);
    } else if (this.mode === 'flatten') {
      next = this.flattenTarget;
    } else if (this.mode === 'set-absolute') {
      next = this.setTarget;
    } else if (this.mode === 'terrace') {
      next = Math.round(prev / this.terraceStep) * this.terraceStep;
    } else {
      next = forPreview ? prev + 1 : prev + Math.floor(Math.random() * 5) - 2; // noise
    }
    return Math.max(this.rangeMin, Math.min(this.rangeMax, next));
  }

  protected applyCell(col: number, row: number): void {
    const { map, chunks } = this.ctx.scene;
    const prev = map.getElevation(col, row);
    if (this.contourLevel !== null && prev !== this.contourLevel) return;
    const next = this.nextElevation(col, row, prev);
    if (next === prev) return;
    (this.tx ??= map.beginEdit()).setElevation(col, row, next);
    chunks.markDirty(col, row);
    // Territory borders and resource icons sit on the cell surface, so they
    // have to be rebuilt when the ground moves under them.
    this.gameplayDirty = true;
  }

  override pointerMove(cell: CellPos | null, e: PointerEvent): void {
    if (this.scope === 'fill') {
      if (!this.down) this.updateFillPreview(cell);
      return;
    }
    if (this.mode === 'slope') {
      if (!this.slopeDown || !this.pathStart) return;
      const end = cell ?? this.pathStart;
      this.currentPath = hexLineDraw(
        offsetToHex(this.pathStart.col, this.pathStart.row),
        offsetToHex(end.col, end.row),
      );
      this.refreshSlopePreview();
      return;
    }
    super.pointerMove(cell, e);
  }

  override pointerUp(): void {
    if (this.mode === 'slope' && this.scope === 'brush') {
      if (!this.slopeDown) return;
      this.commitSlope();
      return;
    }
    super.pointerUp();
    this.contourLevel = null;
  }

  // ---- Fill scope ----

  /**
   * The region a fill click at this cell would cover: cells within the
   * tolerance of its elevation, or sharing its terrain, connected to it or
   * map-wide. Mask and locks are walls, as for the terrain fill: a protected
   * start yields nothing and the flood never crosses them.
   */
  private fillRegion(startCol: number, startRow: number): CellPos[] {
    const scene = this.ctx.scene;
    const { map } = scene;
    // A selection fill ignores the clicked cell: it covers every selected
    // cell the locks allow, whatever it holds.
    if (this.fillMatch === 'selection') {
      return scene.selection.cells().filter(c => scene.editable(c.col, c.row));
    }
    if (!scene.editable(startCol, startRow)) return [];
    let matches: (col: number, row: number) => boolean;
    if (this.fillMatch === 'terrain') {
      const terrain = map.getTerrain(startCol, startRow);
      matches = (col, row) => map.getTerrain(col, row) === terrain;
    } else {
      const elev = map.getElevation(startCol, startRow);
      const tolerance = this.fillTolerance;
      matches = (col, row) => Math.abs(map.getElevation(col, row) - elev) <= tolerance;
    }
    if (this.fillContiguous) {
      return floodRegion(map.width, map.height, startCol, startRow,
        (col, row) => matches(col, row) && scene.editable(col, row));
    }
    const cells: CellPos[] = [];
    for (let row = 0; row < map.height; row++) {
      for (let col = 0; col < map.width; col++) {
        if (matches(col, row) && scene.editable(col, row)) cells.push({ col, row });
      }
    }
    return cells;
  }

  /** How many region cells the op would actually move — the range lock and no-op ops drop out. */
  private wouldChange(region: CellPos[], start: CellPos): number {
    const { map } = this.ctx.scene;
    if (this.mode === 'erosion') return region.length;
    // Flatten levels the region to the clicked cell, as a brush stroke does to its first cell.
    const flattenTarget = this.flattenTarget;
    if (this.mode === 'flatten') this.flattenTarget = map.getElevation(start.col, start.row);
    let n = 0;
    for (const { col, row } of region) {
      const prev = map.getElevation(col, row);
      if (this.nextElevation(col, row, prev, true) !== prev) n++;
    }
    this.flattenTarget = flattenTarget;
    return n;
  }

  /** Apply the current op across the region under a click, as one undo step. */
  private fillApply(cell: CellPos): void {
    const region = this.fillRegion(cell.col, cell.row);
    if (region.length > 0) {
      if (this.mode === 'erosion') {
        this.applyErosion(region);
      } else {
        this.beginStroke(cell);
        for (const { col, row } of region) this.applyCell(col, row);
        if (this.tx) this.ctx.commitEdit(this.tx.commit());
        this.tx = null;
        this.flushGameplay();
        this.contourLevel = null;
      }
    }
    // The region just moved — the preview is stale until the pointer moves again.
    this.clearFillPreview();
  }

  private updateFillPreview(cell: CellPos | null): void {
    if (!cell) {
      this.clearFillPreview();
      return;
    }
    if (this.fillHover && this.fillHover.col === cell.col && this.fillHover.row === cell.row) return;
    const region = this.fillRegion(cell.col, cell.row);
    this.fillHover = cell;
    this.fillHoverCount = this.wouldChange(region, cell);
    this.ctx.scene.setSelectionPreview(region);
  }

  /** An option changed — rebuild the preview under the cursor, or hide it. */
  private refreshFillPreview(): void {
    this.clearFillPreview();
    if (this.scope === 'fill') this.updateFillPreview(this.ctx.scene.hoveredCell);
  }

  private clearFillPreview(): void {
    if (!this.fillHover) return;
    this.fillHover = null;
    this.fillHoverCount = 0;
    this.ctx.scene.setSelectionPreview(null);
  }

  // ---- Slope ----

  /**
   * The ramp's band: every in-bounds cell within the width of the dragged
   * line, each carrying the line position (0 at the start, 1 at the end) of
   * its nearest line cell — so the band's contours run across the line.
   */
  private rampCells(path: HexCoord[]): Array<{ col: number; row: number; t: number }> {
    const { map } = this.ctx.scene;
    const n = Math.max(1, path.length - 1);
    const best = new Map<number, { col: number; row: number; t: number; d: number }>();
    path.forEach((hex, i) => {
      for (const h of hexRange(hex, this.rampWidth)) {
        const off = hexToOffset(h);
        if (!map.inBounds(off.col, off.row)) continue;
        const d = hexDistance(hex, h);
        const key = off.row * map.width + off.col;
        const cur = best.get(key);
        if (!cur || d < cur.d) best.set(key, { col: off.col, row: off.row, t: i / n, d });
      }
    });
    return [...best.values()];
  }

  /** The line as a path preview and, when the ramp is wider than the line, its band as a selection preview. */
  private refreshSlopePreview(): void {
    if (!this.slopeDown || !this.currentPath) return;
    const scene = this.ctx.scene;
    scene.setPathPreview(this.currentPath, false);
    if (this.rampWidth > 0) {
      scene.setSelectionPreview(this.rampCells(this.currentPath));
      this.rampBandShown = true;
    } else if (this.rampBandShown) {
      scene.setSelectionPreview(null);
      this.rampBandShown = false;
    }
  }

  /** Ramp the band along the dragged line between its endpoint elevations. */
  private commitSlope(): void {
    const scene = this.ctx.scene;
    if (this.pathStart && this.currentPath && this.currentPath.length >= 2) {
      const startOff  = hexToOffset(this.currentPath[0]);
      const endOff    = hexToOffset(this.currentPath[this.currentPath.length - 1]);
      const startElev = scene.map.getElevation(startOff.col, startOff.row);
      const endElev   = scene.map.getElevation(endOff.col,   endOff.row);
      const tx = scene.map.beginEdit();
      for (const { col, row, t } of this.rampCells(this.currentPath)) {
        // The ramp is computed over the whole band; mask/locks only gate writes.
        if (!scene.editable(col, row)) continue;
        const prev = scene.map.getElevation(col, row);
        const next = Math.max(this.rangeMin, Math.min(this.rangeMax,
          Math.round(startElev + (endElev - startElev) * rampProfile(this.rampProfile, t))));
        if (prev === next) continue;
        tx.setElevation(col, row, next);
        scene.chunks.markDirty(col, row);
      }
      this.ctx.commitEdit(tx.commit());
    }
    this.cancelSlope();
  }

  private cancelSlope(): void {
    this.ctx.scene.setPathPreview(null);
    if (this.rampBandShown) {
      this.ctx.scene.setSelectionPreview(null);
      this.rampBandShown = false;
    }
    this.pathStart    = null;
    this.currentPath  = null;
    this.slopeDown    = false;
    this.contourLevel = null;
  }

  // ---- Erosion ----

  private inBounds(cells: CellPos[]): CellPos[] {
    const { map } = this.ctx.scene;
    return cells.filter(o => o.col >= 0 && o.col < map.width && o.row >= 0 && o.row < map.height);
  }

  /**
   * A few passes of "any cell with a lower neighbour slumps by one" across
   * the given cells — the brush footprint, or a filled region — carving
   * talus off peaks without touching the basins.
   */
  private applyErosion(cells: CellPos[]): void {
    const { map, chunks } = this.ctx.scene;
    const working = new Map<number, number>();
    for (const { col, row } of cells) working.set(this.cellKey(col, row), map.getElevation(col, row));
    const prevMap = new Map(working);

    for (let pass = 0; pass < 3; pass++) {
      const snapshot = new Map(working);
      for (const { col, row } of cells) {
        const cur = snapshot.get(this.cellKey(col, row))!;
        for (let dir = 0; dir < 6; dir++) {
          const nb = offsetNeighbor(col, row, EDGE_DIRS[dir]);
          if (nb.col < 0 || nb.col >= map.width || nb.row < 0 || nb.row >= map.height) continue;
          const nbElev = snapshot.get(this.cellKey(nb.col, nb.row)) ?? map.getElevation(nb.col, nb.row);
          if (nbElev < cur) {
            working.set(this.cellKey(col, row), Math.max(this.rangeMin, cur - 1));
            break;
          }
        }
      }
    }

    const tx = map.beginEdit();
    for (const { col, row } of cells) {
      // The slump simulates across the whole footprint (reads are unmasked);
      // only the resulting writes honour the selection.
      if (!this.ctx.scene.editable(col, row)) continue;
      const p = prevMap.get(this.cellKey(col, row))!;
      const n = working.get(this.cellKey(col, row))!;
      if (p === n) continue;
      tx.setElevation(col, row, n);
      chunks.markDirty(col, row);
    }
    this.ctx.commitEdit(tx.commit());
  }

  keyDown(e: KeyboardEvent): boolean {
    if (e.key === 'Escape' && this.mode === 'slope' && this.slopeDown) {
      this.cancelSlope();
      return true;
    }
    return this.stamps && this.brush.keyDown(e);
  }

  override deactivate(): void {
    this.cancelSlope();
    super.deactivate();
    this.clearFillPreview();
  }

  statusText(): string {
    const mode = ELEV_MODE_LABELS[this.mode];
    const step = this.mode === 'raise-lower' ? ` ${this.step > 0 ? '+' : ''}${this.step}`
      : this.mode === 'terrace' ? ` every ${this.terraceStep}` : '';
    if (this.scope === 'fill') {
      const scope = this.fillContiguous || this.fillMatch === 'selection' ? 'fill' : 'fill all';
      const match = this.fillMatch === 'terrain' ? ' · same terrain'
        : this.fillMatch === 'selection' ? ' · selection'
        : this.fillTolerance > 0 ? ` · ±${this.fillTolerance}` : '';
      const would = this.fillHoverCount > 0 ? ` · would change ${this.fillHoverCount}` : '';
      return `Elevation · ${mode}${step} · ${scope}${match}${would}`;
    }
    if (this.mode === 'slope') {
      const wide = 2 * this.rampWidth + 1;
      const width = wide === 1 ? '1 cell' : `${wide} cells`;
      return `Elevation · ${mode} · ${this.rampProfile.replace('-', ' ')} · ${width} wide`;
    }
    const { settings } = this.brush;
    const n = expectedCells(settings);
    const count = settings.shape === 'spray' ? `~${n} of ${solidCells(settings.radius)}` : String(n);
    return `Elevation · ${mode}${step} · ${BRUSH_SHAPE_LABELS[settings.shape]} ${count}`;
  }
}
