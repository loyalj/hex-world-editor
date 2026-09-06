import { offsetNeighbor } from '@loyalj/hex-world';
import { buildChipRow, wireBrushGroup, wireOptionGroup } from '../ui/uiHelpers.ts';
import { EDGE_DIRS, floodRegion } from './hexPath.ts';
import { BrushTool } from './brushTool.ts';
import { brushCells, clearMetadataKey } from './tool.ts';
import type { CellPos, ToolContext, ToolId } from './tool.ts';

type TerritoryMode = 'claim' | 'release';
/** Whether a click stamps under the brush or floods a bounded region. */
type TerritoryScope = 'brush' | 'fill';

/** What a fill or a grow refuses to cross. */
interface TerritoryBorders {
  rivers: boolean;
  roads: boolean;
  coast: boolean;
  factions: boolean;
}

const BORDER_KEYS: Array<keyof TerritoryBorders> = ['rivers', 'roads', 'coast', 'factions'];

/**
 * Faction ownership paint. Written through the map transaction rather than
 * TerritoryLayer.claim(), so the metadata snapshot lands in the undo stack
 * with everything else. Beyond the brush: a fill that claims (or releases)
 * the connected region under a click out to the ticked borders — rivers,
 * roads, the coast, other factions' cells — a grow that pushes the faction
 * one ring outward under the same borders, a transfer of the selection to
 * the faction, Alt+click to sample the faction under the cursor, and
 * right-click to release. Per-faction counts live in the Holdings panel.
 */
export class TerritoryTool extends BrushTool {
  readonly id: ToolId = 'paint-territory';
  readonly title = 'Territory';
  readonly panel = document.getElementById('territory-options') as HTMLElement;
  readonly hasEyedropper = true;

  private factionId: string;
  private mode: TerritoryMode = 'claim';
  private scope: TerritoryScope = 'brush';
  private radius = 0;
  private readonly borders: TerritoryBorders = { rivers: true, roads: true, coast: true, factions: true };
  // Fill hover preview: the would-be region shown before the click commits.
  private fillHover: CellPos | null = null;
  private fillHoverCount = 0;
  /** What the last panel action did, for the status strip — cleared by the next click on the map. */
  private lastAction: string | null = null;

  constructor(ctx: ToolContext) {
    super(ctx);
    this.factionId = ctx.scene.factions[0]?.id ?? 'red';
    this.refreshPalette();

    wireBrushGroup('territory-brush-group', r => {
      this.radius = r;
      ctx.syncBrushRadius();
    });
    wireOptionGroup('#territory-mode-group .scatter-type-btn', btn => {
      this.mode = btn.dataset['territoryMode'] as TerritoryMode;
      this.refreshFillPreview();
    });
    const brushSection = document.getElementById('territory-brush-section') as HTMLElement;
    wireOptionGroup('#territory-scope-group .scatter-type-btn', btn => {
      this.scope = btn.dataset['territoryScope'] as TerritoryScope;
      brushSection.classList.toggle('hidden', this.scope === 'fill');
      this.refreshFillPreview();
      ctx.syncBrushRadius();
      ctx.updateCursor();
    });
    for (const key of BORDER_KEYS) {
      const el = document.getElementById(`territory-stop-${key}`) as HTMLInputElement;
      el.addEventListener('change', () => {
        this.borders[key] = el.checked;
        this.refreshFillPreview();
      });
    }

    document.getElementById('territory-grow')!.addEventListener('click', () => this.growFaction());
    document.getElementById('territory-transfer-selection')!.addEventListener('click', () => this.transferSelection());
    document.getElementById('territory-clear-faction')!.addEventListener('click', () => {
      const territory = ctx.scene.territory;
      if (!territory) return;
      clearMetadataKey(ctx, territory.ownerKey, (c, r) => territory.ownerOf(c, r) === this.factionId);
    });
    document.getElementById('territory-clear-all')!.addEventListener('click', () => {
      const territory = ctx.scene.territory;
      if (!territory) return;
      clearMetadataKey(ctx, territory.ownerKey, (c, r) => territory.ownerOf(c, r) !== null);
    });
  }

  /** Rebuild the faction swatches — call after the roster is edited. */
  refreshPalette(): void {
    const factions = this.ctx.scene.factions;
    if (!factions.some(f => f.id === this.factionId)) {
      this.factionId = factions[0]?.id ?? 'red';
    }
    const group = document.getElementById('faction-group')!;
    group.className = 'pal-grid';
    group.innerHTML = '';
    for (const faction of this.ctx.scene.factions) {
      const btn = buildChipRow(faction.id, faction.name, faction.color, faction.id === this.factionId, () => {
        this.setFaction(faction.id);
      });
      group.appendChild(btn);
    }
  }

  /** Pick the paint faction and sweep the swatches to match. */
  private setFaction(id: string): void {
    this.factionId = id;
    document.querySelectorAll<HTMLButtonElement>('#faction-group .swatch-row')
      .forEach(b => b.classList.toggle('active', b.dataset['id'] === id));
    this.refreshFillPreview();
  }

  override brushRadius(): number { return this.scope === 'brush' ? this.radius : 0; }
  wantsFillCursor(): boolean { return this.scope === 'fill'; }

  override pointerDown(cell: CellPos, e: PointerEvent): void {
    this.lastAction = null;
    if (e.altKey) {
      this.eyedrop(cell, e);
      return;
    }
    if (this.scope === 'fill') {
      this.fillApply(cell);
      return;
    }
    super.pointerDown(cell, e);
  }

  override pointerMove(cell: CellPos | null, e: PointerEvent): void {
    if (this.scope === 'fill') {
      if (!this.down) this.updateFillPreview(cell);
      return;
    }
    super.pointerMove(cell, e);
  }

  /**
   * A stationary right click releases what a left click would claim — the
   * brush footprint, or the region in fill scope — whatever mode is picked.
   */
  rightClick(cell: CellPos, e: PointerEvent): void {
    const mode = this.mode;
    this.mode = 'release';
    try {
      if (this.scope === 'fill') {
        this.fillApply(cell);
      } else {
        super.pointerDown(cell, e);
        this.pointerUp();
      }
    } finally {
      this.mode = mode;
    }
  }

  /** Alt+click samples the faction under the cursor into the palette; an unowned cell samples nothing. */
  private eyedrop(cell: CellPos, e: PointerEvent): void {
    e.preventDefault();
    const owner = this.ctx.scene.territory?.ownerOf(cell.col, cell.row) ?? null;
    if (owner === null || !this.ctx.scene.factions.some(f => f.id === owner)) return;
    this.setFaction(owner);
  }

  override deactivate(): void {
    super.deactivate();
    this.clearFillPreview();
  }

  protected applyCell(col: number, row: number): void {
    const territory = this.ctx.scene.territory;
    if (!territory) return;
    const next = this.mode === 'claim' ? this.factionId : undefined;
    if (territory.ownerOf(col, row) === (next ?? null)) return;
    (this.tx ??= this.ctx.scene.map.beginEdit()).setCellData(col, row, territory.ownerKey, next);
    this.gameplayDirty = true;
  }

  // ---- Borders, fill, grow ----

  /**
   * Whether a fill or a grow may take this cell: editable, and not one of
   * the ticked walls — water, a river cell, a road cell, or a cell held by
   * a faction other than `allowOwner`.
   */
  private passable(col: number, row: number, allowOwner: string | null): boolean {
    const scene = this.ctx.scene;
    const { map } = scene;
    const b = this.borders;
    if (!scene.editable(col, row)) return false;
    if (b.coast && scene.isWater(map.getTerrain(col, row))) return false;
    if (b.rivers && map.hasRiver(col, row)) return false;
    if (b.roads && map.hasRoads(col, row)) return false;
    if (b.factions) {
      const owner = scene.territory?.ownerOf(col, row) ?? null;
      if (owner !== null && owner !== allowOwner) return false;
    }
    return true;
  }

  /**
   * The region a fill click here would cover. Claim: the connected cells not
   * held by anyone else (or, with the faction border off, held by anyone),
   * out to the walls. Release: the connected cells of the clicked cell's
   * own faction, out to the same walls. Nothing when the clicked cell is
   * itself refused.
   */
  private fillRegion(start: CellPos): CellPos[] {
    const scene = this.ctx.scene;
    const territory = scene.territory;
    if (!territory) return [];
    const { map } = scene;
    let matches: (col: number, row: number) => boolean;
    if (this.mode === 'claim') {
      matches = (col, row) => this.passable(col, row, this.factionId);
    } else {
      const owner = territory.ownerOf(start.col, start.row);
      if (owner === null) return [];
      matches = (col, row) => territory.ownerOf(col, row) === owner && this.passable(col, row, owner);
    }
    if (!matches(start.col, start.row)) return [];
    return floodRegion(map.width, map.height, start.col, start.row, matches);
  }

  /** How many region cells the click would actually change hands. */
  private wouldChange(region: CellPos[]): number {
    const territory = this.ctx.scene.territory;
    if (!territory) return 0;
    if (this.mode === 'release') return region.length;
    let n = 0;
    for (const { col, row } of region) if (territory.ownerOf(col, row) !== this.factionId) n++;
    return n;
  }

  /** Claim or release the region under a click, as one undo step. */
  private fillApply(cell: CellPos): void {
    const region = this.fillRegion(cell);
    if (region.length > 0) {
      // No stroke is open here (the base class closes its own), so applyCell
      // opens the transaction on the first cell that changes hands.
      for (const { col, row } of region) this.applyCell(col, row);
      const tx = this.tx;
      if (tx) this.ctx.commitEdit(tx.commit());
      this.tx = null;
      this.flushGameplay();
    }
    // The region just changed hands — the preview is stale until the pointer moves again.
    this.clearFillPreview();
  }

  private updateFillPreview(cell: CellPos | null): void {
    if (!cell) {
      this.clearFillPreview();
      return;
    }
    if (this.fillHover && this.fillHover.col === cell.col && this.fillHover.row === cell.row) return;
    const region = this.fillRegion(cell);
    this.fillHover = cell;
    this.fillHoverCount = this.wouldChange(region);
    this.ctx.scene.setSelectionPreview(region.length > 0 ? region : null, this.mode === 'release');
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

  /**
   * Push the faction one ring outward: every neighbour of a held cell that
   * the borders allow changes hands, as one undo step. With the faction
   * border ticked that means unclaimed land only; with it off, the ring
   * takes from the neighbours too.
   */
  private growFaction(): void {
    const scene = this.ctx.scene;
    const territory = scene.territory;
    if (!territory) return;
    const { map } = scene;
    const ring = new Map<number, CellPos>();
    for (let row = 0; row < map.height; row++) {
      for (let col = 0; col < map.width; col++) {
        if (territory.ownerOf(col, row) !== this.factionId) continue;
        for (let e = 0; e < 6; e++) {
          const nb = offsetNeighbor(col, row, EDGE_DIRS[e]);
          if (!map.inBounds(nb.col, nb.row)) continue;
          const key = this.cellKey(nb.col, nb.row);
          if (ring.has(key) || territory.ownerOf(nb.col, nb.row) === this.factionId) continue;
          if (!this.passable(nb.col, nb.row, this.factionId)) continue;
          ring.set(key, nb);
        }
      }
    }
    if (ring.size === 0) {
      // Nothing to say why in the map itself, so say it in the status strip:
      // every neighbour is a ticked border, another faction's, or outside
      // the selection mask — or the faction holds nothing yet.
      let held = 0;
      for (let row = 0; row < map.height; row++) {
        for (let col = 0; col < map.width; col++) if (territory.ownerOf(col, row) === this.factionId) held++;
      }
      this.lastAction = held === 0
        ? 'nothing to grow from — the faction holds no cells'
        : 'nothing to grow into — every neighbour is a border, held, or outside the selection';
      return;
    }
    const tx = map.beginEdit();
    for (const { col, row } of ring.values()) tx.setCellData(col, row, territory.ownerKey, this.factionId);
    this.ctx.commitEdit(tx.commit());
    scene.refreshGameplayLayers();
    this.lastAction = `grew by ${ring.size} cell${ring.size === 1 ? '' : 's'}`;
  }

  /** Give every selected cell to the faction, as one undo step — redrawing a border without repainting. */
  private transferSelection(): void {
    const scene = this.ctx.scene;
    const territory = scene.territory;
    if (!territory) return;
    if (scene.selection.size === 0) {
      this.lastAction = 'nothing to transfer — select some cells first';
      return;
    }
    const tx = scene.map.beginEdit();
    let n = 0;
    for (const { col, row } of scene.selection.cells()) {
      if (!scene.editable(col, row) || territory.ownerOf(col, row) === this.factionId) continue;
      tx.setCellData(col, row, territory.ownerKey, this.factionId);
      n++;
    }
    this.ctx.commitEdit(tx.commit());
    this.lastAction = n === 0
      ? 'nothing to transfer — the selection is already the faction\'s, or locked'
      : `transferred ${n} cell${n === 1 ? '' : 's'}`;
    if (n === 0) return;
    scene.refreshGameplayLayers();
  }

  statusText(): string {
    const name = this.ctx.scene.factions.find(f => f.id === this.factionId)?.name ?? this.factionId;
    const who = this.mode === 'release' ? 'Territory · release' : `${name} · claim`;
    const note = this.lastAction ? ` · ${this.lastAction}` : '';
    if (this.scope === 'fill') {
      const would = this.fillHoverCount > 0 ? ` · would change ${this.fillHoverCount}` : '';
      return `${who} · fill${would}${note}`;
    }
    return `${who} · brush ${brushCells(this.radius)}${note}`;
  }
}
