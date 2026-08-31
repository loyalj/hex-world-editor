import { hexRange, hexToOffset, offsetNeighbor, offsetToHex } from '@loyalj/hex-world';
import type { HexCoord } from '@loyalj/hex-world';
import { EDGE_DIRS, hexLineDraw } from './hexPath.ts';
import { wireBrushGroup, wireOptionGroup } from '../ui/uiHelpers.ts';
import { BrushTool } from './brushTool.ts';
import { brushCells } from './tool.ts';
import type { CellPos, ToolContext, ToolId } from './tool.ts';

type ElevMode = 'raise-lower' | 'smooth' | 'flatten' | 'noise' | 'set-absolute' | 'slope' | 'erosion';

const ELEV_MODE_LABELS: Record<ElevMode, string> = {
  'raise-lower':  'raise / lower',
  'smooth':       'smooth',
  'flatten':      'flatten',
  'noise':        'noise',
  'set-absolute': 'set absolute',
  'slope':        'slope ramp',
  'erosion':      'erosion',
};

/**
 * Elevation editing in seven modes. Five are brush stamps (raise/lower,
 * smooth, flatten, noise, set absolute); slope is a drag that ramps a line
 * between its endpoints; erosion is a per-click multi-pass slump. Ctrl held at
 * stroke start snaps the brush to cells at the starting contour.
 */
export class ElevationTool extends BrushTool {
  readonly id: ToolId = 'elevation';
  readonly title = 'Elevation';
  readonly panel = document.getElementById('elevation-options') as HTMLElement;
  readonly hasEyedropper = true;

  private mode: ElevMode = 'raise-lower';
  private step = 1;
  private flattenTarget = 0;
  private setTarget = 0;
  private rangeMin = -128;
  private rangeMax = 127;
  private radius = 0;
  private contourSnapHeld = false;
  private contourLevel: number | null = null;
  private readonly modeBtns: NodeListOf<HTMLButtonElement>;

  // Slope-drag state
  private slopeDown = false;
  private pathStart: CellPos | null = null;
  private currentPath: HexCoord[] | null = null;

  constructor(ctx: ToolContext) {
    super(ctx);
    wireBrushGroup('elev-brush-group', r => {
      this.radius = r;
      ctx.syncBrushRadius();
    });
    wireOptionGroup('#elev-step-group .brush-btn', btn => {
      this.step = parseInt(btn.dataset['step']!, 10);
    });
    this.modeBtns = wireOptionGroup('#elev-mode-group .density-btn', btn => {
      if (this.mode === 'slope') this.cancelSlope();
      this.mode = btn.dataset['elevMode'] as ElevMode;
      this.updateStepVisibility();
    });

    (document.getElementById('elev-set-target') as HTMLInputElement).addEventListener('input', e => {
      this.setTarget = Math.max(-128, Math.min(127, parseInt((e.target as HTMLInputElement).value, 10) || 0));
    });
    (document.getElementById('elev-range-min') as HTMLInputElement).addEventListener('input', e => {
      this.rangeMin = Math.max(-128, Math.min(127, parseInt((e.target as HTMLInputElement).value, 10)));
      if (this.rangeMin > this.rangeMax) this.rangeMax = this.rangeMin;
    });
    (document.getElementById('elev-range-max') as HTMLInputElement).addEventListener('input', e => {
      this.rangeMax = Math.max(-128, Math.min(127, parseInt((e.target as HTMLInputElement).value, 10)));
      if (this.rangeMax < this.rangeMin) this.rangeMin = this.rangeMax;
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

  private updateStepVisibility(): void {
    const isRaiseLower = this.mode === 'raise-lower';
    const isSetAbs     = this.mode === 'set-absolute';
    document.getElementById('elev-step-header')!.classList.toggle('hidden', !isRaiseLower);
    document.getElementById('elev-step-group')!.classList.toggle('hidden', !isRaiseLower);
    document.getElementById('elev-set-target-row')!.classList.toggle('hidden', !isSetAbs);
  }

  override brushRadius(): number { return this.radius; }

  override pointerDown(cell: CellPos, e: PointerEvent): void {
    if (e.altKey && this.mode !== 'slope' && this.mode !== 'erosion') {
      this.eyedrop(cell, e);
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
      this.applyErosion(cell);
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
    if (this.mode !== 'set-absolute' && this.mode !== 'flatten') {
      this.mode = 'set-absolute';
      this.modeBtns.forEach(b => b.classList.toggle('active', b.dataset['elevMode'] === 'set-absolute'));
      this.updateStepVisibility();
    }
  }

  protected override beginStroke(cell: CellPos): void {
    const { map } = this.ctx.scene;
    if (this.mode === 'flatten') this.flattenTarget = map.getElevation(cell.col, cell.row);
    if (this.contourSnapHeld)    this.contourLevel  = map.getElevation(cell.col, cell.row);
  }

  protected applyCell(col: number, row: number): void {
    const { map, chunks } = this.ctx.scene;
    const prev = map.getElevation(col, row);
    if (this.contourLevel !== null && prev !== this.contourLevel) return;
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
    } else {
      next = prev + Math.floor(Math.random() * 5) - 2; // noise
    }
    next = Math.max(this.rangeMin, Math.min(this.rangeMax, next));
    if (next === prev) return;
    (this.tx ??= map.beginEdit()).setElevation(col, row, next);
    chunks.markDirty(col, row);
    // Territory borders and resource icons sit on the cell surface, so they
    // have to be rebuilt when the ground moves under them.
    this.gameplayDirty = true;
  }

  override pointerMove(cell: CellPos | null, e: PointerEvent): void {
    if (this.mode === 'slope') {
      if (!this.slopeDown || !this.pathStart) return;
      const end = cell ?? this.pathStart;
      this.currentPath = hexLineDraw(
        offsetToHex(this.pathStart.col, this.pathStart.row),
        offsetToHex(end.col, end.row),
      );
      this.ctx.scene.setPathPreview(this.currentPath, false);
      return;
    }
    super.pointerMove(cell, e);
  }

  override pointerUp(): void {
    if (this.mode === 'slope') {
      if (!this.slopeDown) return;
      this.commitSlope();
      return;
    }
    super.pointerUp();
    this.contourLevel = null;
  }

  /** Ramp every cell on the dragged line between its endpoint elevations. */
  private commitSlope(): void {
    const scene = this.ctx.scene;
    if (this.pathStart && this.currentPath && this.currentPath.length >= 2) {
      const startOff  = hexToOffset(this.currentPath[0]);
      const endOff    = hexToOffset(this.currentPath[this.currentPath.length - 1]);
      const startElev = scene.map.getElevation(startOff.col, startOff.row);
      const endElev   = scene.map.getElevation(endOff.col,   endOff.row);
      const n = this.currentPath.length - 1;
      const tx = scene.map.beginEdit();
      for (let i = 0; i <= n; i++) {
        const off = hexToOffset(this.currentPath[i]);
        if (off.col < 0 || off.col >= scene.map.width || off.row < 0 || off.row >= scene.map.height) continue;
        // The ramp is computed over the whole line; the mask only gates writes.
        if (!scene.selection.allows(off.col, off.row)) continue;
        const prev = scene.map.getElevation(off.col, off.row);
        const next = Math.max(this.rangeMin, Math.min(this.rangeMax,
          Math.round(startElev + (endElev - startElev) * (i / n))));
        if (prev === next) continue;
        tx.setElevation(off.col, off.row, next);
        scene.chunks.markDirty(off.col, off.row);
      }
      this.ctx.commitEdit(tx.commit());
    }
    this.cancelSlope();
  }

  private cancelSlope(): void {
    this.ctx.scene.setPathPreview(null);
    this.pathStart    = null;
    this.currentPath  = null;
    this.slopeDown    = false;
    this.contourLevel = null;
  }

  /**
   * A few passes of "any cell with a lower neighbour slumps by one" across the
   * brush footprint — carves talus off peaks without touching the basins.
   */
  private applyErosion(cell: CellPos): void {
    const { map, chunks } = this.ctx.scene;
    const cells = hexRange(offsetToHex(cell.col, cell.row), this.radius)
      .map(h => hexToOffset(h))
      .filter(o => o.col >= 0 && o.col < map.width && o.row >= 0 && o.row < map.height);

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
      if (!this.ctx.scene.selection.allows(col, row)) continue;
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
    return false;
  }

  override deactivate(): void {
    this.cancelSlope();
    super.deactivate();
  }

  statusText(): string {
    const mode = ELEV_MODE_LABELS[this.mode];
    const step = this.mode === 'raise-lower' ? ` ${this.step > 0 ? '+' : ''}${this.step}` : '';
    return `Elevation · ${mode}${step} · brush ${brushCells(this.radius)}`;
  }
}
